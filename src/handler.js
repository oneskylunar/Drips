/*
    --> Author: ONESKYLUNAR
    --> File: src/handler.js
    --> Description: Slimmed-down message router and execution engine. Delegates queue management,
        plugin/middleware loading, and message serialization to extracted core modules. Retains
        inline SecurityManager for permission resolution and context augmentation.
*/

import config from './lib/config.js';
import { serializeMessage } from './lib/messaging/serializer.js';
import { normalizeJid, isSameJid, isGroupJid, isStatusJid } from './lib/utils/jid.js';
import { matchPlugin } from './lib/loaders/pluginLoader.js';
import { runMiddlewares } from './lib/loaders/middlewareLoader.js';
import { createQueueEngine } from './lib/messaging/queue.js';
import { sendDelayedReadReceipt } from './lib/messaging/humanizer.js';
import { getContentType, getAggregateVotesInPollMessage } from '@innovatorssoft/baileys';
import { getBaileysStore } from './lib/connection/socket.js';

// ---====================< IMPORTS END >====================---

// ---====================< SINGLETON STATE START >====================---

// ----------> Lazy-initialized queue engine singleton <----------
let queueEngine = null;

// ---====================< SINGLETON STATE END >====================---

// ---====================< SECURITY MANAGER START >====================---

// ----------> Inline permission and context resolver <----------
const SecurityManager = {

    // ----------> Resolve user/group permissions for a given message <----------
    async resolveContext(sock, m) {
        const ownerRaw = config.OWNER_NUMBERS || '';
        const ownerJids = ownerRaw
            .split(',')
            .map(num => num.trim())
            .filter(Boolean)
            .map(num => normalizeJid(num));

        const senderNormalized = normalizeJid(m.sender);
        const isOwner = m.fromMe || ownerJids.some(oj => isSameJid(senderNormalized, oj));

        let isAdmin = false;
        let isBotAdmin = false;
        let isSuperAdmin = false;
        let groupMetadata = null;
        let participants = [];

        if (m.isGroup) {
            try {
                groupMetadata = await sock.groupMetadata(m.chat);
                participants = groupMetadata.participants || [];

                const botJid = normalizeJid(sock.user?.id);

                const userObj = participants.find(p => isSameJid(p.id, senderNormalized));
                const botObj = participants.find(p => isSameJid(p.id, botJid));

                isSuperAdmin = userObj?.admin === 'superadmin';
                isAdmin = isSuperAdmin || userObj?.admin === 'admin' || isOwner;
                isBotAdmin = botObj?.admin === 'admin' || botObj?.admin === 'superadmin';
            } catch (error) {
                global.Print.warn(`[Security] Failed to fetch group metadata for ${m.chat}: ${error.message}`);
            }
        } else {
            isAdmin = true;
            isBotAdmin = true;
        }

        return { isOwner, isAdmin, isBotAdmin, isSuperAdmin, groupMetadata, participants };
    }
};

// ---====================< SECURITY MANAGER END >====================---

// ---====================< HANDLER CLASS START >====================---

// ----------> Production message handler — routes upserts and updates <----------
export default class Handler {

    // ----------> Process incoming message upserts from Baileys <----------
    static async processUpsert(sock, upsert, db) {
        if (!upsert?.messages) return;

        // Lazy-initialize singleton queue engine on first invocation
        if (!queueEngine) {
            queueEngine = createQueueEngine(sock);
            await queueEngine.init(db);
        }

        for (const rawMessage of upsert.messages) {
            try {
                // Guard: skip protocol-only messages
                if (!rawMessage.message) continue;

                // Guard: skip WhatsApp status broadcast messages
                if (isStatusJid(rawMessage.key.remoteJid)) continue;

                // Serialize raw Baileys message into normalized structure
                const m = serializeMessage(sock, rawMessage);
                if (!m) continue;

                // Guard: skip Baileys internal messages (BAE5 prefix or 16-char IDs)
                if (m.isBaileys) continue;

                // Guard: skip messages sent by the bot itself
                if (m.fromMe) continue;

                // Fire-and-forget: send delayed read receipt (humanized timing)
                sendDelayedReadReceipt(sock, m).catch(err => {
                    global.Print.warn(`[Handler] Read receipt failed: ${err.message}`);
                });

                // Augment message with queue-backed reply function
                m.reply = async (text, options = {}) => {
                    try {
                        // Build a clean quoted reference — only the fields Baileys needs
                        // NEVER pass the full serialized `m` (it has `sock` with timers → circular JSON)
                        const quotedRef = {
                            key: m.key,
                            message: rawMessage.message
                        };

                        await queueEngine.enqueue(m.chat, {
                            text,
                            ...options
                        }, { quoted: quotedRef });
                    } catch (err) {
                        global.Print.error(`[Handler] Reply enqueue failed: ${err.message}`);
                    }
                };

                // Run middleware pipeline — if any middleware consumes the message, skip further processing
                try {
                    const consumed = await runMiddlewares(m, sock, db);
                    if (consumed === true) continue;
                } catch (err) {
                    global.Print.error(`[Handler] Middleware pipeline error: ${err.message}`);
                }

                // Command parsing — match against configured prefix pattern
                if (!m.text) continue;

                const prefixRegex = new RegExp(config.BOT_PREFIX || '^[.!/]');
                const match = m.text.match(prefixRegex);

                if (!match) continue;

                const prefix = match[0];
                const args = m.text.slice(prefix.length).trim().split(/\s+/);
                const cmdName = args.shift().toLowerCase();
                const fullText = args.join(' ');

                // Log the incoming command
                global.Print.chat(m.chat, m.sender, `${prefix}${cmdName} ${fullText}`);

                // Match command to a loaded plugin
                const matched = matchPlugin(cmdName);
                if (!matched) continue;

                const { plugin, pluginName } = matched;

                // Resolve security context for permission checks
                const ctx = await SecurityManager.resolveContext(sock, m);

                // Permission gates
                if (plugin.isGroup && !m.isGroup) {
                    await m.reply('⚠️ This command can only be used in Groups.');
                    continue;
                }

                if (plugin.isPersonal && m.isGroup) {
                    await m.reply('⚠️ This command can only be used in Private Messages (DMs).');
                    continue;
                }

                // Check legacy permission flags
                const permFlags = plugin.legacyMeta || plugin;

                if (permFlags.owner && !ctx.isOwner) {
                    await m.reply('❌ Access Denied: Owner only feature.');
                    continue;
                }

                if (permFlags.admin && !ctx.isAdmin) {
                    await m.reply('🛡️ Access Denied: Admin privileges required.');
                    continue;
                }

                if (permFlags.botAdmin && !ctx.isBotAdmin) {
                    await m.reply('🤖 I need to be an Admin in this group to execute this command.');
                    continue;
                }

                // Execute the matched plugin handler
                try {
                    const execContext = {
                        args,
                        text: fullText,
                        prefix,
                        cmdName,
                        ...ctx,
                        db
                    };

                    await plugin.handler(sock, m, execContext);
                } catch (error) {
                    global.Print.error(`[Handler] Plugin "${pluginName}" crashed: ${error.stack || error.message}`);
                    await m.reply('⚠️ An internal error occurred while executing this command.');
                }

            } catch (outerError) {
                global.Print.error(`[Handler] Fatal error processing message: ${outerError.stack || outerError.message}`);
            }
        }
    }

    // ----------> Process message status updates (edits, deletes, reactions, polls) <----------
    static async processUpdate(sock, updates, db) {
        if (!updates?.length) return;

        // Stub types that are just noise — presence changes, group add/remove/promote/demote
        // (group actions are already handled by EventManager via group-participants.update)
        const IGNORED_STUB_TYPES = new Set([
            1,   // CIPHERTEXT (presence/status change)
            27,  // GROUP_PARTICIPANT_ADD
            28,  // GROUP_PARTICIPANT_REMOVE
            29,  // GROUP_PARTICIPANT_PROMOTE
            30,  // GROUP_PARTICIPANT_DEMOTE
            32,  // GROUP_PARTICIPANT_INVITE
        ]);

        for (const update of updates) {
            try {
                const { key, update: changes } = update;
                if (!key?.remoteJid) continue;

                // Skip status broadcast JID updates entirely
                if (isStatusJid(key.remoteJid)) continue;

                // --- Poll Vote Aggregation ---
                if (changes?.pollUpdates) {
                    try {
                        const store = getBaileysStore();
                        if (store) {
                            const pollCreation = await store.loadMessage(key.remoteJid, key.id);
                            if (pollCreation?.message) {
                                const pollUpdate = getAggregateVotesInPollMessage({
                                    message: pollCreation.message,
                                    pollUpdates: changes.pollUpdates,
                                });

                                if (pollUpdate?.length) {
                                    const votedOptions = pollUpdate.filter(v => v.voters.length > 0);
                                    if (votedOptions.length) {
                                        const summary = votedOptions
                                            .map(v => `${v.name}: ${v.voters.length} vote(s)`)
                                            .join(", ");
                                        global.Print.info(`[Poll] Votes in ${key.remoteJid}: ${summary}`);
                                    }
                                }
                            }
                        }
                    } catch (pollError) {
                        global.Print.warn(`[Poll] Failed to aggregate poll votes: ${pollError.message}`);
                    }
                }

                // Log message edits
                if (changes?.message) {
                    global.Print.info(`[Update] Message edited in ${key.remoteJid} (ID: ${key.id})`);
                }

                // Log meaningful stub type changes only (skip noise like presence updates and group actions)
                if (changes?.messageStubType !== undefined && !IGNORED_STUB_TYPES.has(changes.messageStubType)) {
                    global.Print.info(`[Update] Status change in ${key.remoteJid} — stub: ${changes.messageStubType}`);
                }

                // Log status changes (star, pin, etc.)
                if (changes?.starred !== undefined) {
                    global.Print.info(`[Update] Message ${changes.starred ? 'starred' : 'unstarred'} in ${key.remoteJid}`);
                }

            } catch (error) {
                global.Print.error(`[Update] Error processing update: ${error.message}`);
            }
        }
    }
}

// ---====================< HANDLER CLASS END >====================---
