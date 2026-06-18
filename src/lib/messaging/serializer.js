/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/messaging/serializer.js
    --> Description: Production-grade Message Serializer and Device Detector for Drips.
                     Decorates raw Baileys WebMessageInfo with normalized JIDs, device heuristics,
                     content extraction (text, media, reactions, viewOnce, edits), quoted message
                     resolution, and bound network helpers (reply, download, react, delete, forward).
                     Attaches the socket reference to enable downstream UI modules.
*/

import {
    getContentType,
    extractMessageContent,
    downloadContentFromMessage,
    getDevice,
    areJidsSameUser,
    proto
} from "@innovatorssoft/baileys";

import { normalizeJid, isGroupJid, isStatusJid, isNewsletterJid } from "../utils/jid.js";

// ---====================< MESSAGE SERIALIZER START >====================---

// ----------> Known media message types <----------
const MEDIA_TYPES = new Set([
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "stickerMessage",
    "documentMessage"
]);

// ----------> Extract media envelope from message tree <----------
function getMediaEnvelope(root, msgContent) {
    if (!msgContent) return null;
    if (msgContent?.url || msgContent?.directPath) return root;
    return extractMessageContent(root) || null;
}

// ----------> Robust device detection from message ID heuristics <----------
function detectDevice(msgId) {
    if (!msgId) return "unknown";

    // Attempt Baileys native helper first
    try {
        const device = getDevice(msgId);
        if (device && device !== "unknown" && device !== "baileys") return device;
    } catch {
        // Baileys helper unavailable or errored — fall through to heuristics
    }

    // Fallback heuristics based on WhatsApp message ID patterns
    if (msgId.length > 21) return "android";
    if (msgId.length === 18) return "desktop";
    if (msgId.startsWith("3EB0") && msgId.length === 12) return "web";
    if (msgId.startsWith("3EB0") && msgId.length === 20) return "web";
    if (msgId.startsWith("3EB0") && msgId.length === 22) return "web";
    if (msgId.startsWith("BAE5") && msgId.length === 16) return "baileys";
    if (msgId.substring(0, 2) === "3A") return "ios";

    // Default assumption for standard 20-char IDs not matching above patterns
    return "ios";
}

// ----------> Serialize quoted message to match main message structure <----------
function serializeQuoted(sock, parentMsg, quotedMsg) {
    if (!quotedMsg) return null;

    try {
        const type = getContentType(quotedMsg);
        const rawNode = type ? quotedMsg[type] : null;
        const ctx = parentMsg.msg?.contextInfo || {};

        const q = {
            key: {
                remoteJid: ctx.remoteJid || parentMsg.chat,
                fromMe: areJidsSameUser(sock.user?.id, ctx.participant),
                id: ctx.stanzaId,
                participant: ctx.participant ? normalizeJid(ctx.participant) : undefined
            },
            message: quotedMsg,
            mtype: type,
            msg: rawNode,
            chat: normalizeJid(ctx.remoteJid || parentMsg.chat),
            id: ctx.stanzaId,
            sender: normalizeJid(ctx.participant || parentMsg.chat)
        };

        q.device = detectDevice(q.id);
        q.isBaileys = q.device === "baileys";

        // Extract text from quoted content
        q.text = typeof rawNode === "string" ? rawNode : (
            rawNode?.text ||
            rawNode?.caption ||
            rawNode?.contentText ||
            rawNode?.selectedDisplayText ||
            ""
        );

        // Resolve media envelope
        q.mediaMessage = getMediaEnvelope(quotedMsg, rawNode);
        q.mediaType = q.mediaMessage ? Object.keys(q.mediaMessage)[0] : null;

        // ----------> Download helper for quoted media <----------
        q.download = async () => {
            if (!q.mediaType) return Buffer.alloc(0);
            try {
                const stream = await downloadContentFromMessage(
                    q.mediaMessage[q.mediaType],
                    q.mediaType.replace("Message", "")
                );
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                return buffer;
            } catch (error) {
                global.Print.error(`[Message] Failed to download quoted media`, error.message);
                return Buffer.alloc(0);
            }
        };

        return q;
    } catch (error) {
        global.Print.error("[Message] Failed to serialize quoted message", error.message);
        return null;
    }
}

// ----------> Unwrap viewOnce message containers <----------
function unwrapViewOnce(message) {
    if (!message) return { message, isViewOnce: false };

    // viewOnceMessage wrapper (images)
    if (message.viewOnceMessage?.message) {
        return { message: message.viewOnceMessage.message, isViewOnce: true };
    }
    // viewOnceMessageV2 wrapper (videos)
    if (message.viewOnceMessageV2?.message) {
        return { message: message.viewOnceMessageV2.message, isViewOnce: true };
    }

    return { message, isViewOnce: false };
}

// ----------> Main message serializer <----------
/**
 * Enhances a raw Baileys WebMessageInfo with normalized properties,
 * device detection, content extraction, and bound network helpers.
 * @param {Object} sock - The Baileys socket connection.
 * @param {Object} m - The raw message object from Baileys.
 * @returns {Object} The decorated message object.
 */
export function serializeMessage(sock, m) {
    if (!m || !m.message) return m;

    // Shallow clone to prevent mutating internal Baileys state
    const M = { ...m };

    // ---====================< CORE PROPERTIES START >====================---

    M.id = M.key.id;
    M.chat = M.key.remoteJid;
    M.fromMe = M.key.fromMe;

    // ----------> JID type detection <----------
    M.isGroup = isGroupJid(M.chat);
    M.isChannel = isNewsletterJid(M.chat);
    M.isStatus = isStatusJid(M.chat);

    // ----------> Accurate sender JID resolution <----------
    if (M.fromMe) {
        M.sender = normalizeJid(sock.user?.id);
    } else if (M.isGroup) {
        M.sender = normalizeJid(M.key.participant);
    } else {
        M.sender = normalizeJid(M.chat);
    }

    // Normalize chat JID (only if it exists)
    if (M.chat) {
        M.chat = normalizeJid(M.chat);
    }

    // ---====================< CORE PROPERTIES END >====================---

    // ---====================< DEVICE DETECTION START >====================---

    M.device = detectDevice(M.id);
    M.isBaileys = M.device === "baileys";

    // UI Capability Flag: Web and Desktop clients cannot render Native Flow (buttons/lists)
    M.supportsUI = !["web", "desktop"].includes(M.device);

    // ---====================< DEVICE DETECTION END >====================---

    // ---====================< CONTENT PARSING START >====================---

    // ----------> Unwrap viewOnce containers before content extraction <----------
    const { message: unwrappedMessage, isViewOnce } = unwrapViewOnce(M.message);
    M.isViewOnce = isViewOnce;

    // ----------> Determine message type using Baileys' getContentType <----------
    M.mtype = getContentType(unwrappedMessage) || "";
    M.msg = M.mtype ? (unwrappedMessage[M.mtype] || null) : null;

    // ----------> Reaction detection <----------
    M.isReaction = M.mtype === "reactionMessage";

    // ----------> Smart text extractor <----------
    M.text = "";
    if (typeof M.msg === "string") {
        M.text = M.msg;
    } else if (M.msg) {
        M.text = M.msg.text || M.msg.caption || M.msg.contentText || M.msg.selectedDisplayText || "";

        // Handle Interactive/Native Flow responses (button/list selections)
        if (M.msg.nativeFlowResponseMessage?.paramsJson) {
            try {
                const parsed = JSON.parse(M.msg.nativeFlowResponseMessage.paramsJson);
                if (parsed?.id) M.text = String(parsed.id);
            } catch {
                // Malformed JSON in native flow response — keep existing text
            }
        }

        // Handle reaction messages — extract the emoji text
        if (M.isReaction && M.msg.text !== undefined) {
            M.text = M.msg.text;
        }

        // Handle protocol messages (edits)
        if (M.mtype === "protocolMessage" && M.msg.editedMessage) {
            const editedContent = extractMessageContent(M.msg.editedMessage);
            if (editedContent) {
                const editType = getContentType(editedContent);
                if (editType && editedContent[editType]) {
                    const editMsg = editedContent[editType];
                    M.text = editMsg.text || editMsg.caption || M.text;
                }
            }
        }
    }

    // ---====================< CONTENT PARSING END >====================---

    // ---====================< MEDIA HANDLING START >====================---

    M.mediaMessage = getMediaEnvelope(unwrappedMessage, M.msg);
    M.mediaType = M.mediaMessage ? Object.keys(M.mediaMessage)[0] : null;

    // ---====================< MEDIA HANDLING END >====================---

    // ---====================< QUOTED MESSAGE START >====================---

    const contextInfo = M.msg?.contextInfo;
    M.mentionedJid = contextInfo?.mentionedJid || [];
    M.quoted = contextInfo?.quotedMessage
        ? serializeQuoted(sock, M, contextInfo.quotedMessage)
        : null;

    // ---====================< QUOTED MESSAGE END >====================---

    // ---====================< SOCKET REFERENCE START >====================---

    // CRITICAL: Attach socket reference so downstream modules (ui.js, queue.js)
    // can access it from the message object without separate parameter threading
    M.sock = sock;

    // ---====================< SOCKET REFERENCE END >====================---

    // ---====================< NETWORK HELPERS START >====================---

    // ----------> Download media attached to this message <----------
    M.download = async () => {
        if (!M.mediaType) return Buffer.alloc(0);
        try {
            const stream = await downloadContentFromMessage(
                M.mediaMessage[M.mediaType],
                M.mediaType.replace("Message", "")
            );
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            return buffer;
        } catch (error) {
            global.Print.error(`[Message] Failed to download media for ${M.id}`, error.message);
            return Buffer.alloc(0);
        }
    };

    // ----------> Reply to this message <----------
    M.reply = async (text, options = {}) => {
        if (!sock) throw new Error("Socket connection not available.");
        try {
            return await sock.sendMessage(M.chat, { text, ...options }, { quoted: M, ...options });
        } catch (error) {
            global.Print.error(`[Message] Failed to reply in ${M.chat}`, error.message);
            throw error;
        }
    };

    // ----------> React to this message with an emoji <----------
    M.react = async (emoji) => {
        if (!sock) return;
        try {
            return await sock.sendMessage(M.chat, { react: { text: emoji, key: M.key } });
        } catch (error) {
            global.Print.error(`[Message] Failed to react to ${M.id}`, error.message);
        }
    };

    // ----------> Delete this message for everyone <----------
    M.delete = async () => {
        if (!sock) return;
        try {
            return await sock.sendMessage(M.chat, { delete: M.key });
        } catch (error) {
            global.Print.error(`[Message] Failed to delete ${M.id}`, error.message);
        }
    };

    // ----------> Forward this message to another JID <----------
    M.forward = async (targetJid, force = false, options = {}) => {
        if (!sock) return;
        try {
            return await sock.sendMessage(targetJid, { forward: M, force, ...options }, options);
        } catch (error) {
            global.Print.error(`[Message] Failed to forward ${M.id} to ${targetJid}`, error.message);
        }
    };

    // ---====================< NETWORK HELPERS END >====================---

    return M;
}

// ---====================< MESSAGE SERIALIZER END >====================---
