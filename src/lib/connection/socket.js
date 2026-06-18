/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/connection/socket.js
    --> Description: Core Baileys Socket Initialization & Extension. Wraps the raw Baileys
                     socket with utility methods (decodeJid, getName), binds the MessageUI
                     factory, and integrates the Event & Connection managers. Uses centralized
                     config and JID utilities for consistency.
*/

import {
    makeWASocket,
    fetchLatestBaileysVersion,
    Browsers,
    makeInMemoryStore
} from "@innovatorssoft/baileys";
import pino from "pino";

// ---====================< INTERNAL IMPORTS START >====================---

import config from "../config.js";
import { useRedisAuthState } from "./auth.js";
import { ConnectionManager, EventManager } from "./manager.js";
import { serializeMessage } from "../messaging/serializer.js";
import { normalizeJid, isSameJid, isGroupJid } from "../utils/jid.js";
import { initPlugins } from "../loaders/pluginLoader.js";
import { initMiddlewares } from "../loaders/middlewareLoader.js";

// ---====================< INTERNAL IMPORTS END >====================---

// ----------> Path for dynamic handler import (enables hot-reload) <----------
const HANDLER_PATH = "../../handler.js";

// ---====================< STATE HYDRATION QUEUE START >====================---

// ----------> Non-blocking background queue for group metadata prefetching <----------
class StateHydrationQueue {
    constructor() {
        this.tasks = [];
        this.running = false;
        this.batchSize = 10;
        this.disposed = false;
    }

    add(task) {
        if (this.disposed) return;
        this.tasks.push(task);
        if (!this.running) {
            this.running = true;
            setImmediate(() => this.process());
        }
    }

    async process() {
        while (this.tasks.length > 0 && !this.disposed) {
            const batch = this.tasks.splice(0, this.batchSize);
            await Promise.all(batch.map((task) => task().catch(() => {})));
        }
        this.running = false;
    }

    dispose() {
        this.disposed = true;
        this.tasks = [];
        this.running = false;
    }
}

const stateQueue = new StateHydrationQueue();

// ----------> Baileys in-memory message store (needed for poll decryption & getMessage) <----------
let baileysStore = null;

/** @returns {Object|null} The Baileys in-memory store instance */
export function getBaileysStore() {
    return baileysStore;
}

// ---====================< STATE HYDRATION QUEUE END >====================---

// ----------> Custom logger wrapper to filter and intercept raw Baileys JSON logs <----------

const createBaileysLogger = (name = "Baileys") => {

    // Track sender key errors to avoid repetitive logging
    let senderKeyErrorCount = 0;
    let senderKeyFlushTimer = null;
    const flushSenderKeyCount = () => {
        if (senderKeyErrorCount > 0) {
            global.Print?.info(`[${name}] Skipped ${senderKeyErrorCount} additional sender key sync error(s).`);
            senderKeyErrorCount = 0;
        }
        senderKeyFlushTimer = null;
    };

    const logger = {
        level: "error",
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (obj, msg) => {
            const message = msg || (typeof obj === "string" ? obj : obj?.msg || "");
            if (message) {
                global.Print?.warn(`[${name}] ${message}`);
            }
        },
        error: (obj, msg) => {
            const message = msg || (typeof obj === "string" ? obj : obj?.msg || "");
            const error = obj?.err || obj?.error || obj;
            // Catch non-critical 'init queries' timeouts and log them as soft warnings
            if (message && message.includes("unexpected error in 'init queries'")) {
                const errMessage = error?.message || "Timed Out";
                global.Print?.warn(`[${name}] Non-critical sync warning: ${message} (${errMessage})`);
            return;
            }
            //    WhatsApp server explicitly requests a stream restart.
            //    This is already handled by ConnectionManager.handleDisconnectReason().
            //    Printing the raw XML node object here is redundant noise.
            if (message && message.includes("stream errored out")) {
                // Silently suppress — ConnectionManager will log the clean status line
                return;
            }
            //    Signal Protocol sender key errors during group message sync.
            //    Causes: "No session found to decrypt message" (new login, missing keys),
            //            "Received message with old counter" (stale keys after restart).
            //    Self-healing — WhatsApp will re-distribute sender keys automatically.
            if (message && message.includes("sender key distribution")) {
                if (senderKeyErrorCount === 0) {
                    const reason = error?.message || "unknown";
                    global.Print?.info(`[${name}] Group key sync in progress (${reason}) — this is normal after login/restart.`);
                }
                senderKeyErrorCount++;
                // Batch subsequent errors and log a summary after 3 seconds of silence
                if (senderKeyFlushTimer) clearTimeout(senderKeyFlushTimer);
                senderKeyFlushTimer = setTimeout(flushSenderKeyCount, 3000);
                return;
            }
            // 4. All other errors — log normally
            if (message) {
                global.Print?.error(`[${name}] ${message}`, error instanceof Error ? error.stack : error);
            } else {
                global.Print?.error(`[${name}] Unexpected Error`, error);
            }
        },
        fatal: (obj, msg) => {
            const message = msg || (typeof obj === "string" ? obj : obj?.msg || "");
            const error = obj?.err || obj?.error || obj;
            global.Print?.error(`[${name} FATAL] ${message || ""}`, error);
        },
        child: (attrs) => {
            const childName = attrs?.class ? `${name}:${attrs.class}` : name;
            return createBaileysLogger(childName);
        }
    };
    return logger;
};

// ---====================< SOCKET FACTORY START >====================---

// ----------> Initializes and extends the Baileys socket <----------
export async function initializeSocket(storeClient, mainDb) {
    // 1. Fetch Latest WhatsApp Web Version
    const { version, isLatest } = await fetchLatestBaileysVersion();
    global.Print.info(`[Socket] Using WA v${version.join(".")} (Latest: ${isLatest})`);

    // 2. Mount Auth State using unified store client
    const authState = await useRedisAuthState(storeClient, config.SESSION_NAME);

    // 3. Pre-load Plugin Loader, Middleware Loader, and the Handler Module
    // This avoids race conditions where connection.update opens before loaders/handlers are bound.
    try {
        await initPlugins();
        global.Print.success("[Socket] Plugin system initialized.");
    } catch (error) {
        global.Print.warn(`[Socket] Plugin loader initialization failed: ${error.message}`);
    }

    try {
        await initMiddlewares();
        global.Print.success("[Socket] Middleware system initialized.");
    } catch (error) {
        global.Print.warn(`[Socket] Middleware loader initialization failed: ${error.message}`);
    }

    let handlerDefault = null;
    try {
        const handlerModule = await import(`${HANDLER_PATH}?update=${Date.now()}`);
        handlerDefault = handlerModule.default;
        global.Print.success("[Socket] Handler module imported.");
    } catch (error) {
        global.Print.error("[Socket] Failed to import Handler. Ensure src/handler.js exists.", error);
    }

    // 4. Pairing Code Configuration — from config, not process.env
    const pairingNumber = config.PAIRING_NUMBER ? config.PAIRING_NUMBER.replace(/[^0-9]/g, "") : null;
    const usePairingCode = !!pairingNumber;

    // 5. Initialize Baileys in-memory store for message history & poll decryption
    const storeLogger = createBaileysLogger("Store");
    baileysStore = makeInMemoryStore({ logger: storeLogger });

    // 6. Socket Options
    const socketOptions = {
        version,
        logger: createBaileysLogger(),
        printQRInTerminal: !usePairingCode,
        mobile: false,
        auth: authState.state,
        browser: Browsers.macOS("Safari"),
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        getMessage: async (key) => {
            if (baileysStore) {
                const msg = await baileysStore.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
            return undefined;
        }
    };

    // 7. Create Socket
    const sock = makeWASocket(socketOptions);

    // Bind the in-memory store to the socket's event emitter
    baileysStore.bind(sock.ev);

    // Mount the dispose method for graceful shutdowns
    sock.authDispose = authState._dispose;

    // 7. Pairing Code Trigger (Only if not registered and number is provided)
    if (usePairingCode && !authState.state.creds.registered) {
        global.Print.info(`[Socket] Unregistered session. Requesting pairing code for +${pairingNumber}...`);
        setTimeout(async () => {
            try {
                // Use custom code from .env if set, otherwise let Baileys generate one
                const customCode = config.PAIRING_CODE || undefined;
                const code = await sock.requestPairingCode(pairingNumber, customCode);
                const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                global.Print.box("ACTION REQUIRED", [
                    "Pairing Code Generated Successfully:",
                    `>>  ${formattedCode}  <<`,
                    customCode ? "(Using custom code from .env)" : "(Auto-generated code)",
                    "Enter this code in your WhatsApp Linked Devices."
                ]);
            } catch (error) {
                global.Print.error("[Socket] Failed to request pairing code", error);
            }
        }, 3000);
    }

    // ---====================< EXTENSION METHODS START >====================---

    // ----------> Use centralized JID normalizer <----------
    sock.decodeJid = normalizeJid;

    // ----------> Resolve aesthetic display name for a JID <----------
    sock.getName = async (jid = "") => {
        jid = normalizeJid(jid);
        if (!jid) return "";

        if (isGroupJid(jid)) {
            try {
                const md = await sock.groupMetadata(jid);
                if (md?.subject) return md.subject;
            } catch {
                return "Unknown Group";
            }
        }

        if (isSameJid(jid, sock.user?.id)) {
            return sock.user?.name || config.BOT_NAME;
        }

        return jid.split("@")[0];
    };

    // ---====================< EXTENSION METHODS END >====================---

    // ---====================< EVENT BINDING START >====================---

    const eventManager = new EventManager();

    // ----------> Reconnect callback for ConnectionManager <----------
    const onReconnectRequired = async () => {
        global.Print.system("[Lifecycle] Rebuilding Socket Connection...");
        eventManager.removeAll(sock);
        stateQueue.dispose();
        sock.ws?.close();
        await new Promise((r) => setTimeout(r, 1000));

        const newSock = await initializeSocket(storeClient, mainDb);
        global.sock = newSock;
        return newSock;
    };

    const connectionManager = new ConnectionManager(onReconnectRequired);

    // ----------> Bind core Baileys events <----------
    sock.ev.on("connection.update", async (update) => {
        await connectionManager.handleUpdate(update, storeClient);
        if (update.connection === "open") {
            try {
                const { createQueueEngine } = await import("../messaging/queue.js");
                const queueEngine = createQueueEngine(sock);
                await queueEngine.init(mainDb);
            } catch (error) {
                global.Print?.error("[Socket] Failed to restore enqueued tasks on startup", error.message);
            }
        }
    });

    sock.ev.on("creds.update", async () => {
        await authState.saveCreds();
    });

    // ----------> Bind the handler <----------
    if (handlerDefault) {
        eventManager.bindAll(sock, mainDb, handlerDefault);
        global.Print.success("[Socket] Event routing & Handler successfully bound.");
    }

    // ---====================< EVENT BINDING END >====================---

    // ---====================< STATE HYDRATION START >====================---

    // ----------> Prefetch group metadata in background for faster handler responses <----------
    sock.ev.on("messages.upsert", (upsert) => {
        if (!upsert || !upsert.messages) return;

        upsert.messages.forEach((rawMsg) => {
            stateQueue.add(async () => {
                const m = serializeMessage(sock, rawMsg);
                if (!m || m.isBaileys) return;

                if (m.isGroup) {
                    try {
                        await sock.groupMetadata(m.chat);
                    } catch {
                        // Silent fail — non-critical prefetch
                    }
                }
            });
        });
    });

    // ---====================< STATE HYDRATION END >====================---

    return sock;
}

// ---====================< SOCKET FACTORY END >====================---
