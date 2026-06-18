/*
    --> Author: ONESKYLUNAR
    --> File: database/index.js
    --> Description: Redis-backed database engine for Drips. Provides schema-enforced
                     Table instances backed by the unified store client (Redis or in-memory
                     MapStore). Supports hot-reloading of table schemas, automatic timestamps,
                     legacy JSON migration, and graceful lifecycle management.
*/

import { EventEmitter } from "node:events";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { createStoreClient } from "../src/lib/storage/store.js";

// ---====================< HELPERS START >====================---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TABLES_DIR = join(__dirname, "tables");

// ----------> Apply schema defaults and timestamps to raw data <----------
function conform(raw, schema, isNew = false) {
    const record = { ...raw };
    const now = new Date().toISOString();

    // Apply column defaults for any missing fields
    for (const [col, def] of Object.entries(schema.columns)) {
        if (record[col] === undefined || record[col] === null) {
            record[col] = def.default;
        }
    }

    // Auto-manage timestamps when the schema opts in
    if (schema.timestamps) {
        if (isNew) {
            record.createdAt = record.createdAt || now;
        }
        record.updatedAt = now;
    }

    return record;
}

// ---====================< HELPERS END >====================---

// ---====================< TABLE CLASS START >====================---

// ----------> Schema-enforced table backed by the store client <----------
class Table extends EventEmitter {
    #name;
    #schema;
    #pk;
    #storageMode;
    #store;

    constructor(name, schema, storeClient) {
        super();
        this.#name = name;
        this.#schema = schema;
        this.#pk = schema.primaryKey || "id";
        this.#storageMode = schema.storage || "individual";
        this.#store = storeClient;
    }

    // ----------> Build the store key for a record <----------
    #getKey(id) {
        if (this.#storageMode === "individual") {
            return `drips:db:${this.#name}:${id}`;
        }
        return `drips:db:${this.#name}`;
    }

    // ----------> Retrieve a single record by primary key <----------
    async get(id) {
        try {
            if (this.#storageMode === "individual") {
                const raw = await this.#store.get(this.#getKey(id));
                return raw ? JSON.parse(raw) : null;
            }
            const raw = await this.#store.hGet(this.#getKey(), String(id));
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            global.Print.error(`[DB] Failed to GET ${this.#name}:${id}`, error.message);
            return null;
        }
    }

    // ----------> Create or overwrite a record <----------
    async set(id, data) {
        try {
            const record = conform({ ...data, [this.#pk]: id }, this.#schema, true);
            const serialized = JSON.stringify(record);

            if (this.#storageMode === "individual") {
                await this.#store.set(this.#getKey(id), serialized);
            } else {
                await this.#store.hSet(this.#getKey(), String(id), serialized);
            }

            this.emit("set", { id, record });
            return record;
        } catch (error) {
            global.Print.error(`[DB] Failed to SET ${this.#name}:${id}`, error.message);
            return null;
        }
    }

    // ----------> Partially update an existing record <----------
    async update(id, patch) {
        try {
            const existing = await this.get(id);
            if (!existing) {
                global.Print.warn(`[DB] Cannot update non-existent record ${this.#name}:${id}`);
                return null;
            }

            const merged = conform({ ...existing, ...patch }, this.#schema, false);
            const serialized = JSON.stringify(merged);

            if (this.#storageMode === "individual") {
                await this.#store.set(this.#getKey(id), serialized);
            } else {
                await this.#store.hSet(this.#getKey(), String(id), serialized);
            }

            this.emit("update", { id, record: merged });
            return merged;
        } catch (error) {
            global.Print.error(`[DB] Failed to UPDATE ${this.#name}:${id}`, error.message);
            return null;
        }
    }

    // ----------> Delete a record by primary key <----------
    async delete(id) {
        try {
            if (this.#storageMode === "individual") {
                await this.#store.del(this.#getKey(id));
            } else {
                await this.#store.hDel(this.#getKey(), String(id));
            }

            this.emit("delete", { id });
            return true;
        } catch (error) {
            global.Print.error(`[DB] Failed to DELETE ${this.#name}:${id}`, error.message);
            return false;
        }
    }

    // ----------> Retrieve all records in this table <----------
    async all() {
        try {
            if (this.#storageMode === "individual") {
                const keys = await this.#store.keys(`drips:db:${this.#name}:*`);
                if (!keys || keys.length === 0) return [];

                const values = await this.#store.mGet(keys);
                return values
                    .filter((v) => v !== null)
                    .map((v) => JSON.parse(v));
            }

            const hash = await this.#store.hGetAll(this.#getKey());
            return Object.values(hash).map((v) => JSON.parse(v));
        } catch (error) {
            global.Print.error(`[DB] Failed to fetch ALL from ${this.#name}`, error.message);
            return [];
        }
    }

    // ----------> Query records with a filter predicate <----------
    async where(query) {
        try {
            const records = await this.all();
            return records.filter((record) => {
                for (const [key, value] of Object.entries(query)) {
                    if (record[key] !== value) return false;
                }
                return true;
            });
        } catch (error) {
            global.Print.error(`[DB] Failed to query WHERE on ${this.#name}`, error.message);
            return [];
        }
    }

    // ----------> Hot-update the schema without losing data <----------
    updateSchema(newSchema) {
        this.#schema = newSchema;
        this.#pk = newSchema.primaryKey || "id";
        this.#storageMode = newSchema.storage || "individual";
        global.Print.info(`[DB] Schema updated for table: ${this.#name}`);
    }

    get name() { return this.#name; }
    get schema() { return this.#schema; }
}

// ---====================< TABLE CLASS END >====================---

// ---====================< DATABASE CLASS START >====================---

// ----------> Database engine — manages table lifecycle and hot-reloading <----------
class Database extends EventEmitter {
    #tables;
    #watcher;
    #store;
    #ready;
    #ownsStore;

    constructor() {
        super();
        this.#tables = new Map();
        this.#watcher = null;
        this.#store = null;
        this.#ready = false;
        this.#ownsStore = false;
    }

    // ----------> Initialize the database engine <----------
    async init(storeClient) {
        try {
            // Resolve the store client — prefer injected, otherwise create one
            if (storeClient) {
                this.#store = storeClient;
                this.#ownsStore = false;
            } else {
                global.Print.warn("[DB] No store client provided — creating dedicated instance.");
                this.#store = await createStoreClient();
                this.#ownsStore = true;
            }

            // Ensure the tables directory exists
            await mkdir(TABLES_DIR, { recursive: true });

            // Load all table schemas
            await this.#loadAll();

            // Start the file watcher for hot-reloading
            this.#watch();

            this.#ready = true;
            global.Print.success(`[DB] Database engine online — ${this.#tables.size} table(s) loaded.`);
            this.emit("ready");
        } catch (error) {
            global.Print.error("[DB] Failed to initialize database engine", error.message);
            throw error;
        }
    }

    // ----------> Load all .js table schemas from the tables directory <----------
    async #loadAll() {
        try {
            const entries = await readdir(TABLES_DIR);
            const jsFiles = entries.filter((f) => extname(f) === ".js");

            for (const file of jsFiles) {
                const filePath = join(TABLES_DIR, file);
                await this.#loadTable(filePath);
            }
        } catch (error) {
            if (error.code === "ENOENT") {
                global.Print.warn("[DB] Tables directory is empty — no schemas to load.");
                return;
            }
            throw error;
        }
    }

    // ----------> Import a single table schema and register it <----------
    async #loadTable(filePath) {
        try {
            // Cache-bust the dynamic import for hot-reload support
            const cacheBuster = `?t=${Date.now()}`;
            const moduleUrl = `file://${filePath}${cacheBuster}`;
            const mod = await import(moduleUrl);
            const schema = mod.default;

            if (!schema || !schema.name) {
                global.Print.warn(`[DB] Skipping invalid schema at ${basename(filePath)} (missing name).`);
                return;
            }

            // Update existing table or create a new one
            if (this.#tables.has(schema.name)) {
                this.#tables.get(schema.name).updateSchema(schema);
                global.Print.info(`[DB] Hot-reloaded schema: ${schema.name}`);
            } else {
                const table = new Table(schema.name, schema, this.#store);
                this.#tables.set(schema.name, table);
                global.Print.info(`[DB] Registered table: ${schema.name}`);
            }

            this.emit("table:loaded", schema.name);
        } catch (error) {
            global.Print.error(`[DB] Failed to load table from ${basename(filePath)}`, error.message);
        }
    }

    // ----------> Watch tables directory for schema changes <----------
    #watch() {
        try {
            this.#watcher = chokidar.watch(TABLES_DIR, {
                ignoreInitial: true,
                awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 }
            });

            this.#watcher.on("change", (filePath) => {
                if (extname(filePath) === ".js") {
                    global.Print.info(`[DB] Schema change detected: ${basename(filePath)}`);
                    this.#loadTable(filePath);
                }
            });

            this.#watcher.on("add", (filePath) => {
                if (extname(filePath) === ".js") {
                    global.Print.info(`[DB] New schema detected: ${basename(filePath)}`);
                    this.#loadTable(filePath);
                }
            });

            this.#watcher.on("error", (error) => {
                global.Print.error("[DB] Watcher error", error.message);
            });
        } catch (error) {
            global.Print.error("[DB] Failed to start schema watcher", error.message);
        }
    }

    // ----------> Retrieve a registered table by name <----------
    table(name) {
        const t = this.#tables.get(name);
        if (!t) {
            global.Print.warn(`[DB] Table not found: ${name}`);
        }
        return t || null;
    }

    // ----------> Migrate legacy JSON file data into a table <----------
    async migrateFromLegacy(tableName, oldJsonFilePath) {
        try {
            const table = this.table(tableName);
            if (!table) {
                global.Print.error(`[DB] Migration failed — table "${tableName}" does not exist.`);
                return false;
            }

            const raw = await readFile(oldJsonFilePath, "utf-8");
            const data = JSON.parse(raw);

            let migrated = 0;
            if (Array.isArray(data)) {
                for (const record of data) {
                    const pk = record[table.schema.primaryKey || "id"];
                    if (pk !== undefined && pk !== null) {
                        await table.set(String(pk), record);
                        migrated++;
                    }
                }
            } else if (typeof data === "object") {
                for (const [key, value] of Object.entries(data)) {
                    await table.set(key, typeof value === "object" ? value : { value });
                    migrated++;
                }
            }

            global.Print.success(`[DB] Migrated ${migrated} record(s) into "${tableName}" from ${basename(oldJsonFilePath)}.`);
            return true;
        } catch (error) {
            global.Print.error(`[DB] Migration failed for "${tableName}"`, error.message);
            return false;
        }
    }

    // ----------> Shut down the database engine <----------
    async dispose() {
        try {
            // Close the file watcher
            if (this.#watcher) {
                await this.#watcher.close();
                this.#watcher = null;
            }

            // Only quit the store if we created it ourselves
            if (this.#ownsStore && this.#store?.quit) {
                await this.#store.quit();
                this.#store = null;
            }

            this.#tables.clear();
            this.#ready = false;
            global.Print.info("[DB] Database engine disposed.");
        } catch (error) {
            global.Print.error("[DB] Error during disposal", error.message);
        }
    }

    get ready() { return this.#ready; }
    get size() { return this.#tables.size; }
}

// ---====================< DATABASE CLASS END >====================---

// ---====================< SINGLETON EXPORT START >====================---

// ----------> Singleton database instance <----------
const db = new Database();
export default db;

// ---====================< SINGLETON EXPORT END >====================---
