/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/loaders/pluginLoader.js
    --> Description: Hot-reload plugin loader with chokidar file watching. Supports both
                     new-format plugins (name, description, pattern, handler) and legacy
                     format (command, execute). Provides pattern matching for command
                     dispatch with string, regex, and array support.
*/

import { readdir } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import chokidar from "chokidar";
import config from "../config.js";

// ---====================< PLUGIN LOADER START >====================---

// ----------> Private state <----------
const plugins = new Map();
let watcher = null;
const debounceTimers = new Map();

// ----------> Resolve absolute plugin directory <----------
const pluginDirAbsolute = resolve(config.PLUGIN_DIR);

// ----------> Load a single plugin from file path <----------
async function loadPlugin(filePath) {
    const fileName = basename(filePath, ".js");

    try {
        const modulePath = `file://${filePath}?v=${Date.now()}`;
        const mod = await import(modulePath);
        const exported = mod.default || mod;

        if (!exported) {
            global.Print.warn(`[PluginLoader] Skipping ${fileName}: no default export found.`);
            return;
        }

        let plugin;

        // --- New format detection ---
        if (typeof exported.handler === "function") {
            plugin = {
                name: exported.name || fileName,
                description: exported.description || "",
                pattern: exported.pattern || fileName,
                isGroup: exported.isGroup ?? false,
                isPersonal: exported.isPersonal ?? false,
                isEnabled: exported.isEnabled ?? true,
                handler: exported.handler
            };
        }
        // --- Legacy format adaptation ---
        else if (typeof exported.execute === "function") {
            plugin = {
                name: exported.command || fileName,
                description: exported.description || "",
                pattern: exported.command || fileName,
                isGroup: exported.group ?? false,
                isPersonal: exported.private ?? false,
                isEnabled: true,
                handler: exported.execute,
                legacy: true,
                legacyMeta: {
                    admin: exported.admin ?? false,
                    owner: exported.owner ?? false,
                    botAdmin: exported.botAdmin ?? false
                }
            };
        } else {
            global.Print.warn(`[PluginLoader] Skipping ${fileName}: no handler or execute function found.`);
            return;
        }

        plugins.set(fileName, plugin);
        global.Print.success(`[PluginLoader] Loaded plugin: ${plugin.name} (${fileName})`);
    } catch (error) {
        global.Print.error(`[PluginLoader] Failed to load ${fileName}:`, error.message);
    }
}

// ----------> Load all plugins from plugin directory <----------
async function loadAll() {
    try {
        const files = await readdir(pluginDirAbsolute);
        const pluginFiles = files.filter((f) => f.endsWith(".js") && !f.startsWith("_"));

        global.Print.info(`[PluginLoader] Found ${pluginFiles.length} plugin file(s) in ${config.PLUGIN_DIR}`);

        for (const file of pluginFiles) {
            await loadPlugin(join(pluginDirAbsolute, file));
        }

        global.Print.success(`[PluginLoader] ${plugins.size} plugin(s) loaded successfully.`);
    } catch (error) {
        global.Print.error(`[PluginLoader] Failed to read plugin directory:`, error.message);
    }
}

// ----------> Match a command name against loaded plugins <----------
function matchPlugin(cmdName) {
    if (!cmdName) return null;

    for (const [pluginName, plugin] of plugins) {
        if (!plugin.isEnabled) continue;

        const { pattern } = plugin;

        // String match (exact, case-insensitive)
        if (typeof pattern === "string" && pattern.toLowerCase() === cmdName.toLowerCase()) {
            return { plugin, pluginName };
        }

        // RegExp match
        if (pattern instanceof RegExp && pattern.test(cmdName)) {
            return { plugin, pluginName };
        }

        // Array match (any element matches)
        if (Array.isArray(pattern) && pattern.some((p) => {
            if (typeof p === "string") return p.toLowerCase() === cmdName.toLowerCase();
            if (p instanceof RegExp) return p.test(cmdName);
            return false;
        })) {
            return { plugin, pluginName };
        }
    }

    return null;
}

// ----------> Debounced plugin file reload <----------
function debouncedReload(filePath) {
    const fileName = basename(filePath);

    if (debounceTimers.has(fileName)) {
        clearTimeout(debounceTimers.get(fileName));
    }

    debounceTimers.set(fileName, setTimeout(async () => {
        debounceTimers.delete(fileName);
        global.Print.info(`[PluginLoader] Hot-reloading plugin: ${fileName}`);
        await loadPlugin(filePath);
    }, config.HOT_RELOAD_DEBOUNCE_MS));
}

// ----------> Initialize plugin system with file watcher <----------
async function initPlugins() {
    await loadAll();

    watcher = chokidar.watch(pluginDirAbsolute, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200 }
    });

    watcher.on("add", (filePath) => {
        const fileName = basename(filePath);
        if (!fileName.endsWith(".js") || fileName.startsWith("_")) return;
        global.Print.info(`[PluginLoader] New plugin detected: ${fileName}`);
        debouncedReload(filePath);
    });

    watcher.on("change", (filePath) => {
        const fileName = basename(filePath);
        if (!fileName.endsWith(".js") || fileName.startsWith("_")) return;
        debouncedReload(filePath);
    });

    watcher.on("unlink", (filePath) => {
        const fileName = basename(filePath, ".js");
        if (plugins.has(fileName)) {
            plugins.delete(fileName);
            global.Print.warn(`[PluginLoader] Plugin removed: ${fileName}`);
        }
    });

    watcher.on("error", (error) => {
        global.Print.error(`[PluginLoader] Watcher error:`, error.message);
    });

    global.Print.success(`[PluginLoader] File watcher active on ${config.PLUGIN_DIR}`);
}

// ----------> Dispose plugin system <----------
async function disposePlugins() {
    if (watcher) {
        await watcher.close();
        watcher = null;
    }

    for (const [key, timer] of debounceTimers) {
        clearTimeout(timer);
    }
    debounceTimers.clear();
    plugins.clear();

    global.Print.info(`[PluginLoader] Plugin system disposed.`);
}

// ----------> Get all loaded plugins <----------
function getPlugins() {
    return plugins;
}

// ---====================< PLUGIN LOADER END >====================---

export { initPlugins, disposePlugins, getPlugins, matchPlugin, loadPlugin };
