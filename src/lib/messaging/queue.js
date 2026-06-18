/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/messaging/queue.js
    --> Description: In-memory per-JID FIFO message queue backed by database persistence.
                     Serializes sends to the same chat while allowing cross-JID parallelism.
                     Queue tasks are stored in the database on enqueue, removed on completion,
                     and recovered automatically upon startup to prevent message loss.
*/

import crypto from "node:crypto";
import config from "../config.js";
import { beginTyping, endTyping, postSendBreather } from "./humanizer.js";

// ---====================< QUEUE ENGINE START >====================---

let _instance = null;

export class QueueEngine {
    constructor(sock) {
        this.sock = sock;
        this.db = null;

        // ----------> In-memory per-JID queues <----------
        // Map<chatId, Array<{ taskId, payload, options, createdAt, ttl }>>
        this.queues = new Map();
        this.activeQueues = new Set();
        this.concurrentSends = 0;
    }

    // ----------> Initialize and recover queue tasks from database <----------
    async init(db) {
        if (this.db) return; // Only initialize once
        this.db = db;

        global.Print?.info("[Queue] Initializing persistent queue recovery...");
        try {
            const queueTable = this.db.table("queue");
            if (!queueTable) {
                global.Print?.warn("[Queue] Database table 'queue' not registered.");
                return;
            }

            const storedTasks = await queueTable.all();
            if (!storedTasks || storedTasks.length === 0) {
                global.Print?.info("[Queue] No pending tasks found in database.");
                return;
            }

            let recoveredCount = 0;
            let expiredCount = 0;

            for (const task of storedTasks) {
                // Check if the task has expired
                if (Date.now() - task.createdAt > task.ttl) {
                    await queueTable.delete(task.id);
                    expiredCount++;
                    continue;
                }

                // Re-hydrate the memory queue
                const chatId = task.chatId;
                if (!this.queues.has(chatId)) {
                    this.queues.set(chatId, []);
                }

                this.queues.get(chatId).push({
                    taskId: task.id,
                    payload: task.payload,
                    options: task.options,
                    createdAt: task.createdAt,
                    ttl: task.ttl
                });

                recoveredCount++;
            }

            if (expiredCount > 0) {
                global.Print?.warn(`[Queue] Cleaned up ${expiredCount} expired task(s) from database.`);
            }

            if (recoveredCount > 0) {
                global.Print?.success(`[Queue] Successfully recovered ${recoveredCount} pending task(s) from database.`);
                // Trigger queue processors for JIDs with recovered tasks
                for (const chatId of this.queues.keys()) {
                    this.processQueue(chatId).catch((err) =>
                        global.Print?.error(`[Queue] Recovery processor error for ${chatId}`, err.message)
                    );
                }
            }
        } catch (error) {
            global.Print?.error("[Queue] Failed to recover enqueued tasks", error.message);
        }
    }

    // ----------> Enqueue a message for a specific chat <----------
    async enqueue(chatId, payload, options = {}) {
        try {
            const taskId = crypto.randomUUID();
            const task = {
                taskId,
                payload,
                options,
                createdAt: Date.now(),
                ttl: config.QUEUE_JOB_TTL_MS
            };

            // 1. Save task to database first to ensure persistence
            if (this.db) {
                try {
                    const queueTable = this.db.table("queue");
                    if (queueTable) {
                        await queueTable.set(taskId, {
                            id: taskId,
                            chatId,
                            payload,
                            options,
                            createdAt: task.createdAt,
                            ttl: task.ttl
                        });
                    }
                } catch (dbError) {
                    global.Print?.error(`[Queue] Failed to write task ${taskId.slice(0, 8)} to database`, dbError.message);
                }
            }

            // 2. Add to in-memory queue
            if (!this.queues.has(chatId)) {
                this.queues.set(chatId, []);
            }
            this.queues.get(chatId).push(task);

            global.Print.info(`[Queue] Task ${taskId.slice(0, 8)} enqueued for ${chatId}`);

            // 3. Fire processor (non-blocking)
            this.processQueue(chatId).catch((err) =>
                global.Print.error(`[Queue] Processor error for ${chatId}`, err.message)
            );
        } catch (error) {
            global.Print.error(`[Queue] Enqueue failed for ${chatId}`, error.message);
            // Fallback: send directly without queue
            try {
                await this.sock.sendMessage(chatId, payload, options);
            } catch (e) {
                global.Print.error(`[Queue] Direct fallback send failed`, e.message);
            }
        }
    }

    // ----------> Process the queue for a specific chat <----------
    async processQueue(chatId) {
        if (this.activeQueues.has(chatId)) return;
        this.activeQueues.add(chatId);

        try {
            const queue = this.queues.get(chatId);
            let messagesSentInBurst = 0;

            while (queue && queue.length > 0) {
                const task = queue[0];

                // 1. TTL Check — discard expired tasks
                if (Date.now() - task.createdAt > task.ttl) {
                    if (this.db) {
                        try {
                            const queueTable = this.db.table("queue");
                            if (queueTable) await queueTable.delete(task.taskId);
                        } catch (_) {}
                    }
                    queue.shift();
                    global.Print.warn(`[Queue] Task ${task.taskId.slice(0, 8)} expired, skipping.`);
                    continue;
                }

                // 2. Concurrency Slot Check
                while (this.concurrentSends >= config.QUEUE_CONCURRENCY) {
                    await new Promise((r) => setTimeout(r, 100));
                }
                this.concurrentSends++;

                try {
                    // naturaliized typing presence delays
                    if (messagesSentInBurst > 0) {
                        await postSendBreather();
                    }

                    // Phase 1: Begin composing indicator
                    const text = task.payload?.text || "";
                    await beginTyping(this.sock, chatId, text);

                    // Phase 2: Send message
                    await this.sock.sendMessage(chatId, task.payload, task.options);

                    // 3. Remove task from database
                    if (this.db) {
                        try {
                            const queueTable = this.db.table("queue");
                            if (queueTable) await queueTable.delete(task.taskId);
                        } catch (dbError) {
                            global.Print?.error(`[Queue] Failed to remove task ${task.taskId.slice(0, 8)} from database`, dbError.message);
                        }
                    }

                    queue.shift();
                    messagesSentInBurst++;

                    global.Print.success(`[Queue] Task ${task.taskId.slice(0, 8)} successfully sent.`);
                } catch (sendError) {
                    global.Print.error(`[Queue] Send failed for task ${task.taskId.slice(0, 8)}`, sendError.message);
                    
                    // Remove failed tasks from database to prevent infinite retry loops
                    if (this.db) {
                        try {
                            const queueTable = this.db.table("queue");
                            if (queueTable) await queueTable.delete(task.taskId);
                        } catch (_) {}
                    }
                    queue.shift();
                } finally {
                    this.concurrentSends--;
                }
            }

            // Clean up JID queues
            if (queue && queue.length === 0) {
                this.queues.delete(chatId);
            }
            await endTyping(this.sock, chatId);

        } catch (error) {
            global.Print.error(`[Queue] Processing error for ${chatId}`, error.message);
        } finally {
            this.activeQueues.delete(chatId);
        }
    }

    // ----------> Dispose queue engine <----------
    async dispose() {
        if (this.sock && this.activeQueues.size > 0) {
            global.Print?.info(`[Queue] Clearing typing presence for ${this.activeQueues.size} active chat(s)...`);
            for (const chatId of this.activeQueues) {
                try {
                    await this.sock.sendPresenceUpdate("paused", chatId).catch(() => {});
                } catch (_) {}
            }
        }
        this.activeQueues.clear();
        this.queues.clear();
        this.concurrentSends = 0;
        this.db = null;
        global.Print?.info("[Queue] Queue engine disposed.");
    }
}

// ----------> Singleton factory <----------
export function createQueueEngine(sock) {
    if (!_instance) {
        _instance = new QueueEngine(sock);
    } else {
        if (sock) _instance.sock = sock;
    }
    return _instance;
}

// ---====================< QUEUE ENGINE END >====================---
