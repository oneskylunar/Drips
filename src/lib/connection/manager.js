/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/connection/manager.js
    --> Description: Advanced Connection Lifecycle & Event Manager for Drips. Handles
                     exponential backoff reconnection with exhaustive disconnect reason coverage,
                     hard cooldown after max attempts, keepalive management, and routes incoming
                     Baileys events (upserts, updates, group participants) securely to handlers.
*/

import { DisconnectReason } from "@innovatorssoft/baileys";
import config from "../config.js";

// ---====================< CONNECTION MANAGER START >====================---

// ----------> Connection lifecycle and reconnect engine <----------
export class ConnectionManager {
    constructor(reconnectCallback) {
        this.reconnectCallback = reconnectCallback;

        // ----------> Stateful connection memory <----------
        this.state = {
            attempts: 0,
            cooldownUntil: 0,
            inFlight: false,
            keepAliveTimer: null,
            lastDisconnectMs: 0
        };
    }

    // ----------> Exponential backoff with ±20% jitter <----------
    calculateBackoff(baseMs = 2000, maxMs = 60000, factor = 1.5) {
        const attempts = Math.max(0, this.state.attempts - 1);
        const rawDelay = Math.min(maxMs, Math.round(baseMs * Math.pow(factor, attempts)));
        // Add ±20% jitter to prevent thundering herd against WhatsApp servers
        const jitter = rawDelay * 0.2 * (Math.random() * 2 - 1);
        return Math.max(1000, Math.round(rawDelay + jitter));
    }

    // ----------> Handle connection.update event from Baileys <----------
    async handleUpdate(update) {
        const { connection, lastDisconnect, isNewLogin } = update;

        if (isNewLogin) {
            global.Print.system("[Connection] New login detected. Resetting connection state.");
            this.resetState();
        }

        switch (connection) {
            case "connecting":
                global.Print.info("[Connection] Connecting to WhatsApp Web WebSocket...");
                break;

            case "open":
                this.resetState();
                global.Print.success("[Connection] WebSocket connected. Drips is online and synced.");
                this.startKeepAlive();
                break;

            case "close":
                this.stopKeepAlive();
                await this.handleDisconnectReason(lastDisconnect);
                break;
        }
    }

    // ----------> Exhaustive disconnect reason router <----------
    async handleDisconnectReason(lastDisconnect) {
        if (this.state.inFlight) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reasonStr = lastDisconnect?.error?.message || "Unknown Error";

        global.Print.warn(`[Connection] Socket closed. Status: ${statusCode} | Reason: ${reasonStr}`);

        let baseDelay = 2000;

        switch (statusCode) {
            // ----------> FATAL: Logged out (401) <----------
            // Session invalidated on WhatsApp servers. User must re-pair manually.
            // We do NOT auto-delete auth — let the user decide how to handle it.
            case DisconnectReason.loggedOut:
                global.Print.error("[Connection] FATAL: Session logged out (401). Session invalidated on WhatsApp servers.");
                try {
                    global.Print.info("[Connection] Clearing dead session credentials from store...");
                    if (global.storeClient) {
                        await global.storeClient.del(config.SESSION_NAME);
                        if (typeof global.storeClient.quit === "function") {
                            await global.storeClient.quit();
                        }
                    }
                    global.Print.success("[Connection] Dead session successfully cleared. Restart the bot to pair again.");
                } catch (error) {
                    global.Print.error(`[Connection] Failed to clear dead session: ${error.message}`);
                }
                process.exit(1);
                return;

            // ----------> RECOVERABLE: Bad session (500) — OR WebSocket timeout <----------
            // Status 500 is shared between actual bad sessions AND WebSocket handshake
            // timeouts. We MUST check the error message to distinguish them.
            // A real bad session has corrupted auth. A handshake timeout is a network issue.
            case DisconnectReason.badSession: {
                const isHandshakeTimeout = reasonStr.toLowerCase().includes("handshake")
                    || reasonStr.toLowerCase().includes("timed out")
                    || reasonStr.toLowerCase().includes("timeout");

                if (isHandshakeTimeout) {
                    global.Print.warn("[Connection] WebSocket handshake timed out (500). Network issue — reconnecting...");
                    baseDelay = 5000;
                    break;
                }

                // Genuine bad session — still don't exit immediately, try reconnecting first
                // Only after MAX_RECONNECT_ATTEMPTS should we give up
                global.Print.error("[Connection] Bad session detected (500). Attempting recovery reconnect...");
                baseDelay = 3000;
                break;
            }

            // ----------> FATAL: Forbidden (403) <----------
            // Possible account ban or restriction. Extremely critical.
            case DisconnectReason.forbidden:
                global.Print.error("[Connection] CRITICAL: Forbidden (403). Possible account ban or restriction.");
                global.Print.error("[Connection] DO NOT auto-reconnect. Investigate immediately.");
                process.exit(1);
                return;

            // ----------> Restart required (515) <----------
            // WhatsApp server explicitly requests a restart. Reconnect quickly.
            case DisconnectReason.restartRequired:
                global.Print.info("[Connection] Restart required (515). Reconnecting immediately...");
                baseDelay = 1000;
                break;

            // ----------> Connection replaced (440) <----------
            // Another device/session took over. Quick reconnect.
            case DisconnectReason.connectionReplaced:
                global.Print.warn("[Connection] Connection replaced (440). Another session took over.");
                baseDelay = 1000;
                break;

            // ----------> Connection closed (428) <----------
            // Normal/generic close. Standard backoff reconnect.
            case DisconnectReason.connectionClosed:
                global.Print.info("[Connection] Connection closed (428). Standard reconnect with backoff.");
                baseDelay = 2000;
                break;

            // ----------> Connection lost (408) <----------
            // Network interruption. Give the network breathing room.
            case DisconnectReason.connectionLost:
                global.Print.info("[Connection] Connection lost (408). Network issue, backing off.");
                baseDelay = 5000;
                break;

            // ----------> Timed out (408) <----------
            // WebSocket handshake or keep-alive timed out.
            case DisconnectReason.timedOut:
                global.Print.info("[Connection] Timed out (408). Reconnecting with delay.");
                baseDelay = 5000;
                break;

            // ----------> Multidevice mismatch (411) <----------
            // Linked device protocol version mismatch. Brief delay.
            case DisconnectReason.multideviceMismatch:
                global.Print.warn("[Connection] Multidevice mismatch (411). Reconnecting shortly.");
                baseDelay = 3000;
                break;

            // ----------> Unavailable service (503) <----------
            // WhatsApp servers are down or under maintenance. Wait longer.
            case DisconnectReason.unavailableService:
                global.Print.warn("[Connection] WhatsApp unavailable (503). Servers may be down. Waiting longer.");
                baseDelay = 10000;
                break;

            // ----------> Unknown / unhandled status code <----------
            default:
                global.Print.warn(`[Connection] Unhandled disconnect code: ${statusCode}. Standard reconnect.`);
                baseDelay = 2000;
                break;
        }

        // ----------> Hard cooldown check <----------
        if (Date.now() < this.state.cooldownUntil) {
            const waitSecs = Math.ceil((this.state.cooldownUntil - Date.now()) / 1000);
            global.Print.warn(`[Connection] In hard cooldown. Waiting ${waitSecs}s before retrying...`);
            setTimeout(() => this.executeReconnect(), waitSecs * 1000);
            return;
        }

        // ----------> Max attempts gate <----------
        const maxAttempts = config.MAX_RECONNECT_ATTEMPTS || 6;
        if (this.state.attempts >= maxAttempts) {
            global.Print.error(`[Connection] Max reconnect attempts (${maxAttempts}) reached. Entering 5-minute cooldown.`);
            this.state.cooldownUntil = Date.now() + (5 * 60 * 1000);
            this.state.attempts = 0;
            return;
        }

        // ----------> Schedule reconnect with backoff <----------
        const delayMs = this.calculateBackoff(baseDelay);
        global.Print.info(`[Connection] Scheduling reconnect in ${(delayMs / 1000).toFixed(1)}s (Attempt ${this.state.attempts + 1}/${maxAttempts})...`);
        setTimeout(() => this.executeReconnect(), delayMs);
    }

    // ----------> Execute the reconnect callback <----------
    async executeReconnect() {
        this.state.inFlight = true;
        try {
            this.state.attempts++;
            this.state.lastDisconnectMs = Date.now();
            await this.reconnectCallback();
        } catch (error) {
            global.Print.error("[Connection] Failed to execute reconnect callback", error.message);
        } finally {
            this.state.inFlight = false;
        }
    }

    // ----------> Reset state on successful connection <----------
    resetState() {
        this.state.attempts = 0;
        this.state.cooldownUntil = 0;
        this.state.inFlight = false;
    }

    // ----------> Start keepalive interval <----------
    startKeepAlive() {
        if (this.state.keepAliveTimer) return;
        this.state.keepAliveTimer = setInterval(() => {
            if (global.timestamp) global.timestamp.lastTick = Date.now();
        }, 45000);
    }

    // ----------> Stop keepalive interval <----------
    stopKeepAlive() {
        if (this.state.keepAliveTimer) {
            clearInterval(this.state.keepAliveTimer);
            this.state.keepAliveTimer = null;
        }
    }
}

// ---====================< CONNECTION MANAGER END >====================---

// ---====================< EVENT MANAGER START >====================---

// ----------> Baileys event binding and routing manager <----------
export class EventManager {
    constructor() {
        this.boundHandlers = new Map();
    }

    // ----------> Bind all Baileys events to handler module <----------
    /**
     * Safely binds all necessary Baileys events. Unbinds previous events first
     * to prevent memory leaks during reconnects or hot-reloads.
     * @param {Object} sock - The Baileys socket instance.
     * @param {Object} db - The database/store instance.
     * @param {Object} handlerModule - The imported Handler.js module with processUpsert/processUpdate.
     */
    bindAll(sock, db, handlerModule) {
        this.removeAll(sock);

        // ----------> Message upsert routing <----------
        const onMessageUpsert = async (upsert) => {
            try {
                if (handlerModule && typeof handlerModule.processUpsert === "function") {
                    await handlerModule.processUpsert(sock, upsert, db);
                }
            } catch (error) {
                global.Print.error("[EventManager] Error in messages.upsert handler", error.message);
            }
        };

        // ----------> Message update routing <----------
        const onMessageUpdate = async (updates) => {
            try {
                if (handlerModule && typeof handlerModule.processUpdate === "function") {
                    await handlerModule.processUpdate(sock, updates, db);
                }
            } catch (error) {
                global.Print.error("[EventManager] Error in messages.update handler", error.message);
            }
        };

        // ----------> Group participant update routing <----------
        const onGroupParticipantsUpdate = async (event) => {
            try {
                const { id: groupJid, participants, action } = event;

                if (action === "add") {
                    this.handleGroupAdd(sock, groupJid, participants);
                } else if (action === "remove") {
                    this.handleGroupRemove(sock, groupJid, participants);
                }
            } catch (error) {
                global.Print.error("[EventManager] Error handling group participant update", error.message);
            }
        };

        // ----------> Bind events to socket <----------
        sock.ev.on("messages.upsert", onMessageUpsert);
        sock.ev.on("messages.update", onMessageUpdate);
        sock.ev.on("group-participants.update", onGroupParticipantsUpdate);

        // ----------> Map handlers for later cleanup <----------
        this.boundHandlers.set("messages.upsert", onMessageUpsert);
        this.boundHandlers.set("messages.update", onMessageUpdate);
        this.boundHandlers.set("group-participants.update", onGroupParticipantsUpdate);

        global.Print.info("[EventManager] All Baileys event handlers bound.");
    }

    // ----------> Remove all event handlers to prevent memory leaks <----------
    removeAll(sock) {
        if (!sock || !sock.ev) return;
        for (const [eventName, handlerFunction] of this.boundHandlers.entries()) {
            try {
                sock.ev.off(eventName, handlerFunction);
            } catch (error) {
                global.Print.warn(`[EventManager] Failed to unbind ${eventName}`, error.message);
            }
        }
        this.boundHandlers.clear();
    }

    // ----------> Handle new group member join <----------
    async handleGroupAdd(sock, groupJid, participants) {
        try {
            const botId = sock.user.id.split(":")[0];

            for (const rawJid of participants) {
                const jid = typeof rawJid === "string" ? rawJid : (rawJid?.id || rawJid?.jid);
                if (!jid) continue;

                const userNum = jid.split("@")[0].split(":")[0];
                if (userNum === botId) continue;

                global.Print.info(`[EventManager] New member joined: ${userNum} in ${groupJid}`);

                // Onboarding middleware can be dynamically loaded here:
                // e.g., await import("#lib/middleware/onboarding.js").then(m => m.welcome(sock, jid, groupJid));
            }
        } catch (error) {
            global.Print.error("[EventManager] Error in group add handler", error.message);
        }
    }

    // ----------> Handle group member leave <----------
    async handleGroupRemove(sock, groupJid, participants) {
        try {
            for (const rawJid of participants) {
                const jid = typeof rawJid === "string" ? rawJid : (rawJid?.id || rawJid?.jid);
                if (!jid) continue;

                const userNum = jid.split("@")[0].split(":")[0];
                global.Print.info(`[EventManager] Member left: ${userNum} from ${groupJid}`);

                // Goodbye middleware can be dynamically loaded here:
                // e.g., await import("#lib/middleware/goodbye.js").then(m => m.farewell(sock, jid, groupJid));
            }
        } catch (error) {
            global.Print.error("[EventManager] Error in group remove handler", error.message);
        }
    }
}

// ---====================< EVENT MANAGER END >====================---
