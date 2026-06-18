/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/connection/auth.js
    --> Description: High-performance Redis-based authentication state management for Baileys.
                     Implements Redis pipelining for batch operations, makeCacheableSignalKeyStore
                     for performance caching, async-mutex for transaction safety, and BufferJSON
                     serialization for cryptographic keys. Accepts a generic store client
                     (Redis or MapStore) for environment-agnostic operation.
*/

import { initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore } from "@innovatorssoft/baileys";
import { Mutex } from "async-mutex";
import pino from "pino";

// ---====================< AUTH STATE MANAGEMENT START >====================---

// ----------> Baileys-compatible signal key logger <----------
const authLogger = pino({ level: "error" });

// ----------> Deserialize raw JSON to Baileys key objects <----------
function deserializeKey(raw, type) {
    if (!raw) return null;
    try {
        let parsed = JSON.parse(raw, BufferJSON.reviver);
        // Baileys requires AppStateSyncKeys to be instantiated as Proto objects
        // rather than plain JS objects — fromObject() handles this conversion
        if (type === "app-state-sync-key" && parsed) {
            parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed);
        }
        return parsed;
    } catch (error) {
        global.Print.error(`[Auth] Failed to deserialize key type: ${type}`, error.message);
        return null;
    }
}

// ----------> Initialize and manage Redis-backed auth state <----------
/**
 * Creates a Baileys-compatible auth state backed by a store client.
 * @param {Object} storeClient - A connected store client (Redis or MapStore from store.js).
 * @param {string} sessionName - The Redis Hash key to store the session under.
 * @returns {Promise<{state, saveCreds, transaction, _dispose}>}
 */
export async function useRedisAuthState(storeClient, sessionName = "drips_v4_session") {
    // Transaction Lock: Ensures Baileys doesn't encounter race conditions during rapid key syncing
    const txMutex = new Mutex();

    // ----------> Internal read helper <----------
    const readData = async (key) => {
        try {
            return await storeClient.hGet(sessionName, key);
        } catch (error) {
            global.Print.error(`[Auth] Store read error for key: ${key}`, error.message);
            return null;
        }
    };

    // ----------> Internal write helper <----------
    const writeData = async (data, key) => {
        try {
            const payload = JSON.stringify(data, BufferJSON.replacer);
            await storeClient.hSet(sessionName, key, payload);
        } catch (error) {
            global.Print.error(`[Auth] Store write error for key: ${key}`, error.message);
        }
    };

    // ----------> Load or initialize core credentials <----------
    let creds;
    try {
        const credsRaw = await readData("creds");
        if (credsRaw) {
            creds = JSON.parse(credsRaw, BufferJSON.reviver);
            global.Print.info("[Auth] Existing credentials loaded from store.");
        } else {
            global.Print.system("[Auth] No existing credentials found. Generating new keys...");
            creds = initAuthCreds();
            await writeData(creds, "creds");
        }
    } catch (error) {
        global.Print.error("[Auth] Failed to load/init credentials. Generating fresh keys.", error.message);
        creds = initAuthCreds();
        await writeData(creds, "creds");
    }

    // ----------> Raw key operations before caching layer <----------
    const rawKeys = {
        /**
         * Retrieves an array of keys from the store.
         * Uses hmGet pipeline to fetch multiple keys in a single network round-trip.
         */
        get: async (type, ids) => {
            const result = {};
            if (!ids || ids.length === 0) return result;

            // Construct the precise field keys Baileys is requesting
            const fields = ids.map(id => `${type}-${id}`);

            try {
                // Pipeline fetch: gets all requested fields at once
                const rawValues = await storeClient.hmGet(sessionName, fields);

                // Map the returned array back to the expected { id: value } format
                ids.forEach((id, index) => {
                    const raw = rawValues[index];
                    result[id] = deserializeKey(raw, type);
                });
            } catch (error) {
                global.Print.error(`[Auth] HMGET error for type: ${type}`, error.message);
            }

            return result;
        },

        /**
         * Sets or deletes multiple keys in the store.
         * Uses multi() pipeline for atomic batch operations.
         */
        set: async (data) => {
            if (!data || typeof data !== "object") return;

            const pipeline = storeClient.multi();
            let operationsCount = 0;

            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    const key = `${category}-${id}`;

                    if (value) {
                        // Serialize and queue for insertion
                        const payload = JSON.stringify(value, BufferJSON.replacer);
                        pipeline.hSet(sessionName, key, payload);
                    } else {
                        // Null/undefined means Baileys wants us to delete this key
                        pipeline.hDel(sessionName, key);
                    }
                    operationsCount++;
                }
            }

            if (operationsCount > 0) {
                try {
                    await pipeline.exec();
                } catch (error) {
                    global.Print.error("[Auth] Pipeline execution failed during keys.set", error.message);
                }
            }
        }
    };

    // ----------> Wrap keys with Baileys performance cache <----------
    const cachedKeys = makeCacheableSignalKeyStore(rawKeys, authLogger);

    // ----------> Assemble the core state object Baileys expects <----------
    const state = {
        creds,
        keys: cachedKeys
    };

    return {
        state,

        // ----------> Save credentials on connection.update <----------
        saveCreds: async () => {
            try {
                await writeData(creds, "creds");
            } catch (error) {
                global.Print.error("[Auth] Failed to persist credentials", error.message);
            }
        },

        // ----------> Mutex-guarded transaction handler <----------
        transaction: async (work) => {
            if (typeof work !== "function") return null;

            // Acquire lock to prevent race conditions across parallel events
            const release = await txMutex.acquire();
            try {
                return await work();
            } catch (error) {
                global.Print.error("[Auth] Transaction logic failed", error.message);
                throw error;
            } finally {
                release();
            }
        },

        // ----------> Safe cleanup for graceful shutdowns <----------
        _dispose: async () => {
            global.Print.info("[Auth] Disposing auth state...");
            // Only release the mutex if it is currently locked AND we can safely cancel.
            // Direct mutex.release() is unsafe — it throws if the caller doesn't own the lock.
            // Instead, we cancel any waiters and let the current holder finish naturally.
            if (txMutex.isLocked()) {
                try {
                    txMutex.cancel();
                    global.Print.info("[Auth] Cancelled pending mutex waiters.");
                } catch (error) {
                    global.Print.warn("[Auth] Mutex cancel during dispose (non-critical)", error.message);
                }
            }
            // We do NOT quit the store client here — it may be shared across modules
        }
    };
}

// ---====================< AUTH STATE MANAGEMENT END >====================---
