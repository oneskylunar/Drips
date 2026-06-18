/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/storage/store.js
    --> Description: Unified storage client factory for Drips. Provides Redis client
                     when REDIS_HOST is configured, otherwise uses a file-backed MapStore
                     that persists all data to data/ at the project root as JSON files.
                     Session, database tables, and queue state survive restarts.
                     Singleton pattern ensures one client instance across the application.
*/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import config from "../config.js";

// ---====================< CONSTANTS >====================---

const DATA_DIR = join(process.cwd(), "data", "store");

// ---====================< MAP STORE START >====================---

// ----------> File-backed store that mimics the Redis client interface <----------
// All mutations are auto-saved to disk with debounced writes.
// On startup, data is restored from JSON files in data/store/.
class MapStore {
    #saveTimer = null;

    constructor() {
        this.data = new Map();
        this.hashes = new Map();
        this.lists = new Map();

        // Ensure the data directory exists
        try {
            mkdirSync(DATA_DIR, { recursive: true });
        } catch (err) {
            global.Print?.error(`[Store] Failed to create data directory: ${err.message}`);
        }

        // Load persisted state from disk
        this.#loadFromDisk();
    }

    // ----------> Disk persistence: file paths <----------
    #savePath(type) {
        return join(DATA_DIR, `${type}.json`);
    }

    // ----------> Disk persistence: load all data from JSON files <----------
    #loadFromDisk() {
        // Load simple key-value data
        try {
            const dataPath = this.#savePath("data");
            if (existsSync(dataPath)) {
                const raw = readFileSync(dataPath, "utf-8");
                const parsed = JSON.parse(raw);
                for (const [key, value] of Object.entries(parsed)) {
                    this.data.set(key, value);
                }
                global.Print?.info(`[Store] Loaded ${this.data.size} key(s) from data.json`);
            }
        } catch (err) {
            global.Print?.warn(`[Store] Failed to load data.json (may be corrupted): ${err.message}`);
        }

        // Load hash data (nested objects → Map of Maps)
        try {
            const hashPath = this.#savePath("hashes");
            if (existsSync(hashPath)) {
                const raw = readFileSync(hashPath, "utf-8");
                const parsed = JSON.parse(raw);
                for (const [key, fields] of Object.entries(parsed)) {
                    const fieldMap = new Map();
                    for (const [field, value] of Object.entries(fields)) {
                        fieldMap.set(field, value);
                    }
                    this.hashes.set(key, fieldMap);
                }
                global.Print?.info(`[Store] Loaded ${this.hashes.size} hash(es) from hashes.json`);
            }
        } catch (err) {
            global.Print?.warn(`[Store] Failed to load hashes.json (may be corrupted): ${err.message}`);
        }

        // Load list data (object of arrays → Map of Arrays)
        try {
            const listPath = this.#savePath("lists");
            if (existsSync(listPath)) {
                const raw = readFileSync(listPath, "utf-8");
                const parsed = JSON.parse(raw);
                for (const [key, arr] of Object.entries(parsed)) {
                    this.lists.set(key, Array.isArray(arr) ? arr : []);
                }
                global.Print?.info(`[Store] Loaded ${this.lists.size} list(s) from lists.json`);
            }
        } catch (err) {
            global.Print?.warn(`[Store] Failed to load lists.json (may be corrupted): ${err.message}`);
        }
    }

    // ----------> Disk persistence: save all data to JSON files <----------
    #saveToDisk() {
        try {
            // Ensure directory still exists (might have been deleted externally)
            mkdirSync(DATA_DIR, { recursive: true });

            // Save simple key-value data
            const dataObj = Object.fromEntries(this.data);
            writeFileSync(this.#savePath("data"), JSON.stringify(dataObj, null, 2), "utf-8");

            // Save hashes (Map of Maps → nested plain objects)
            const hashObj = {};
            for (const [key, fieldMap] of this.hashes) {
                hashObj[key] = Object.fromEntries(fieldMap);
            }
            writeFileSync(this.#savePath("hashes"), JSON.stringify(hashObj, null, 2), "utf-8");

            // Save lists (Map of Arrays → plain object of arrays)
            const listObj = {};
            for (const [key, arr] of this.lists) {
                listObj[key] = arr;
            }
            writeFileSync(this.#savePath("lists"), JSON.stringify(listObj, null, 2), "utf-8");
        } catch (err) {
            global.Print?.error(`[Store] Failed to save data to disk: ${err.message}`);
        }
    }

    // ----------> Debounced auto-save — batches rapid writes into one disk flush <----------
    #scheduleSave() {
        if (this.#saveTimer) clearTimeout(this.#saveTimer);
        this.#saveTimer = setTimeout(() => {
            this.#saveToDisk();
        }, 1000);
    }

    // ----------> String operations <----------
    async get(key) {
        return this.data.get(key) || null;
    }

    async set(key, value) {
        this.data.set(key, value);
        this.#scheduleSave();
        return "OK";
    }

    async del(key) {
        const had = this.data.has(key) || this.hashes.has(key) || this.lists.has(key);
        this.data.delete(key);
        this.hashes.delete(key);
        this.lists.delete(key);
        this.#scheduleSave();
        return had ? 1 : 0;
    }

    // ----------> Hash operations <----------
    async hGet(key, field) {
        const hash = this.hashes.get(key);
        return hash?.get(field) || null;
    }

    async hSet(key, field, value) {
        if (!this.hashes.has(key)) this.hashes.set(key, new Map());
        this.hashes.get(key).set(field, value);
        this.#scheduleSave();
        return 1;
    }

    async hDel(key, field) {
        const hash = this.hashes.get(key);
        if (!hash) return 0;
        const had = hash.delete(field);
        this.#scheduleSave();
        return had ? 1 : 0;
    }

    async hGetAll(key) {
        const hash = this.hashes.get(key);
        if (!hash) return {};
        return Object.fromEntries(hash.entries());
    }

    async hmGet(key, fields) {
        const hash = this.hashes.get(key);
        return fields.map((f) => hash?.get(f) || null);
    }

    // ----------> Key scanning <----------
    async keys(pattern) {
        const allKeys = [
            ...this.data.keys(),
            ...this.hashes.keys(),
            ...this.lists.keys()
        ];
        if (!pattern || pattern === "*") return allKeys;
        const prefix = pattern.replace(/\*$/, "");
        return allKeys.filter((k) => k.startsWith(prefix));
    }

    async mGet(keys) {
        return keys.map((k) => this.data.get(k) || null);
    }

    // ----------> List operations <----------
    async rPush(key, value) {
        if (!this.lists.has(key)) this.lists.set(key, []);
        this.lists.get(key).push(value);
        this.#scheduleSave();
        return this.lists.get(key).length;
    }

    async lIndex(key, index) {
        const list = this.lists.get(key);
        if (!list || index < 0 || index >= list.length) return null;
        return list[index];
    }

    async lPop(key) {
        const list = this.lists.get(key);
        if (!list || list.length === 0) return null;
        const val = list.shift();
        this.#scheduleSave();
        return val;
    }

    // ----------> Pipeline / Transaction support <----------
    multi() {
        const operations = [];
        const self = this;

        const pipeline = {
            hSet(key, field, value) {
                operations.push(() => self.hSet(key, field, value));
                return pipeline;
            },
            hDel(key, field) {
                operations.push(() => self.hDel(key, field));
                return pipeline;
            },
            set(key, value) {
                operations.push(() => self.set(key, value));
                return pipeline;
            },
            del(key) {
                operations.push(() => self.del(key));
                return pipeline;
            },
            async exec() {
                const results = [];
                for (const op of operations) {
                    results.push(await op());
                }
                // Single save after entire pipeline executes
                self.#scheduleSave();
                return results;
            }
        };

        return pipeline;
    }

    // ----------> Lifecycle methods <----------
    async connect() { return; }

    async quit() {
        // Flush any pending debounced save immediately
        if (this.#saveTimer) {
            clearTimeout(this.#saveTimer);
            this.#saveTimer = null;
        }
        // Final synchronous save to ensure nothing is lost
        this.#saveToDisk();
        global.Print?.info("[Store] MapStore data flushed to disk.");
        this.data.clear();
        this.hashes.clear();
        this.lists.clear();
    }

    async disconnect() { return this.quit(); }
    on() { return this; }
}

// ---====================< MAP STORE END >====================---

// ---====================< STORE FACTORY START >====================---

let _instance = null;

// ----------> Creates or returns the singleton store client <----------
export async function createStoreClient() {
    if (_instance) return _instance;

    if (config.REDIS_HOST) {
        // ----------> Redis mode <----------
        try {
            const { createClient } = await import("redis");

            const clientOptions = {
                socket: {
                    host: config.REDIS_HOST,
                    port: config.REDIS_PORT,
                    reconnectStrategy: (retries) => Math.min(retries * 50, 2000)
                },
                database: config.REDIS_DB
            };

            if (config.REDIS_PASSWORD) {
                clientOptions.password = config.REDIS_PASSWORD;
            }

            const client = createClient(clientOptions);
            client.on("error", (err) => global.Print?.error("[Store] Redis Client Error", err.message));

            await client.connect();
            global.Print?.success("[Store] Connected to Redis successfully.");

            _instance = client;
            return _instance;
        } catch (error) {
            global.Print?.warn(`[Store] Redis connection failed: ${error.message}. Falling back to local file store.`);
        }
    }

    // ----------> Local file-backed mode (default) <----------
    global.Print?.info("[Store] Using local file-backed MapStore. Data persists to data/store/");
    _instance = new MapStore();
    return _instance;
}

export { MapStore };

// ---====================< STORE FACTORY END >====================---
