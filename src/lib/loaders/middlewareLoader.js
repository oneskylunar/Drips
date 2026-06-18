/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/loaders/middlewareLoader.js
    --> Description: Hot-reload middleware loader with chokidar file watching. Middlewares
                     are loaded alphabetically and executed in order as a pipeline. Each
                     middleware can short-circuit processing by returning true. Errors in
                     individual middlewares are isolated and logged without breaking the chain.
*/

import { readdir } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import chokidar from "chokidar";
import config from "../config.js";

// ---====================< MIDDLEWARE LOADER START >====================---

// ----------> Private state <----------
let middlewares = [];
let watcher = null;
const debounceTimers = new Map();

// ----------> Resolve absolute middleware directory <----------
const middlewareDirAbsolute = resolve(config.MIDDLEWARE_DIR);

// ----------> Load a single middleware from file path <----------
async function loadMiddleware(filePath) {
    const fileName = basename(filePath, ".js");

    try {
        const modulePath = `file://${filePath}?v=${Date.now()}`;
        const mod = await import(modulePath);
        const exec = mod.default || mod;

        if (typeof exec !== "function") {
            global.Print.warn(`[MiddlewareLoader] Skipping ${fileName}: default export is not a function.`);
            return;
        }

        // Remove existing entry if reloading
        middlewares = middlewares.filter((mw) => mw.name !== fileName);

        middlewares.push({ name: fileName, exec });

        // Re-sort alphabetically to maintain deterministic order
        middlewares.sort((a, b) => a.name.localeCompare(b.name));

        global.Print.success(`[MiddlewareLoader] Loaded middleware: ${fileName}`);
    } catch (error) {
        global.Print.error(`[MiddlewareLoader] Failed to load ${fileName}:`, error.message);
    }
}

// ----------> Load all middlewares from middleware directory <----------
async function loadAll() {
    try {
        const files = await readdir(middlewareDirAbsolute);
        const mwFiles = files
            .filter((f) => f.endsWith(".js") && !f.startsWith("_"))
            .sort((a, b) => a.localeCompare(b));

        global.Print.info(`[MiddlewareLoader] Found ${mwFiles.length} middleware file(s) in ${config.MIDDLEWARE_DIR}`);

        for (const file of mwFiles) {
            await loadMiddleware(join(middlewareDirAbsolute, file));
        }

        global.Print.success(`[MiddlewareLoader] ${middlewares.length} middleware(s) loaded successfully.`);
    } catch (error) {
        global.Print.error(`[MiddlewareLoader] Failed to read middleware directory:`, error.message);
    }
}

// ----------> Run middleware pipeline <----------
async function runMiddlewares(m, sock, db) {
    for (const mw of middlewares) {
        try {
            const result = await mw.exec(m, sock, db);
            if (result === true) {
                global.Print.info(`[MiddlewareLoader] Pipeline halted by middleware: ${mw.name}`);
                return true;
            }
        } catch (error) {
            global.Print.error(`[MiddlewareLoader] Error in middleware ${mw.name}:`, error.message);
            // Continue to next middleware — do not break the chain
        }
    }

    return false;
}

// ----------> Debounced middleware file reload <----------
function debouncedReload(filePath) {
    const fileName = basename(filePath);

    if (debounceTimers.has(fileName)) {
        clearTimeout(debounceTimers.get(fileName));
    }

    debounceTimers.set(fileName, setTimeout(async () => {
        debounceTimers.delete(fileName);
        global.Print.info(`[MiddlewareLoader] Hot-reloading middleware: ${fileName}`);
        await loadMiddleware(filePath);
    }, config.HOT_RELOAD_DEBOUNCE_MS));
}

// ----------> Initialize middleware system with file watcher <----------
async function initMiddlewares() {
    await loadAll();

    watcher = chokidar.watch(middlewareDirAbsolute, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200 }
    });

    watcher.on("add", (filePath) => {
        const fileName = basename(filePath);
        if (!fileName.endsWith(".js") || fileName.startsWith("_")) return;
        global.Print.info(`[MiddlewareLoader] New middleware detected: ${fileName}`);
        debouncedReload(filePath);
    });

    watcher.on("change", (filePath) => {
        const fileName = basename(filePath);
        if (!fileName.endsWith(".js") || fileName.startsWith("_")) return;
        debouncedReload(filePath);
    });

    watcher.on("unlink", (filePath) => {
        const fileName = basename(filePath, ".js");
        const before = middlewares.length;
        middlewares = middlewares.filter((mw) => mw.name !== fileName);
        if (middlewares.length < before) {
            global.Print.warn(`[MiddlewareLoader] Middleware removed: ${fileName}`);
        }
    });

    watcher.on("error", (error) => {
        global.Print.error(`[MiddlewareLoader] Watcher error:`, error.message);
    });

    global.Print.success(`[MiddlewareLoader] File watcher active on ${config.MIDDLEWARE_DIR}`);
}

// ----------> Dispose middleware system <----------
async function disposeMiddlewares() {
    if (watcher) {
        await watcher.close();
        watcher = null;
    }

    for (const [key, timer] of debounceTimers) {
        clearTimeout(timer);
    }
    debounceTimers.clear();
    middlewares = [];

    global.Print.info(`[MiddlewareLoader] Middleware system disposed.`);
}

// ----------> Get all loaded middlewares <----------
function getMiddlewares() {
    return middlewares;
}

// ---====================< MIDDLEWARE LOADER END >====================---

export { initMiddlewares, disposeMiddlewares, getMiddlewares, runMiddlewares };
