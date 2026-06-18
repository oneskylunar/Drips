/*
    --> Author: ONESKYLUNAR
    --> File: main.js
    --> Description: Master entry point for Drips. Boots the storage client, connects
                     databases, initializes the socket factory, and manages graceful
                     process lifecycle with plugin and middleware disposal.
*/

import "dotenv/config";
import "./src/lib/utils/terminalStyler.js";
import config from "./src/lib/config.js";
import db from "./database/index.js";
import { createStoreClient } from "./src/lib/storage/store.js";
import { initializeSocket } from "./src/lib/connection/socket.js";
import { disposePlugins } from "./src/lib/loaders/pluginLoader.js";
import { disposeMiddlewares } from "./src/lib/loaders/middlewareLoader.js";
import { createQueueEngine } from "./src/lib/messaging/queue.js";

// ---====================< BOOTSTRAP START >====================---

let isShuttingDown = false;

// ----------> Core boot sequence — wires every subsystem together <----------
async function bootstrap() {
    global.Print.box("DRIPS ENGINE", [
        "Booting Production Architecture...",
        `Store: ${config.REDIS_HOST ? "Redis" : "Local File-backed (data/)"}`,
        "Protocol: Baileys WebSocket"
    ]);

    // 1. Initialize storage client (Redis or in-memory MapStore)
    global.Print.system("[Boot] Initializing storage client...");
    const storeClient = await createStoreClient();

    // 2. Connect database engine with the storage client
    global.Print.system("[Boot] Connecting database engine...");
    await db.init(storeClient);

    // 3. Spawn the core WhatsApp socket
    global.Print.system("[Boot] Spawning socket factory...");
    global.sock = await initializeSocket(storeClient, db);

    // 4. Attach to global scope for shutdown access
    global.storeClient = storeClient;
}

// ---====================< BOOTSTRAP END >====================---

// ---====================< SHUTDOWN START >====================---

// ----------> Graceful shutdown — tears down every subsystem in reverse order <----------
async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    global.Print.warn(`\n[System] Initiating graceful shutdown (${signal})...`);

    // 1. Dispose queue engine and clear typing presence while socket is still active
    try {
        const queueEngine = createQueueEngine();
        if (queueEngine) await queueEngine.dispose();
    } catch (_) { /* swallow */ }

    // 2. Terminate WhatsApp socket connection
    if (global.sock) {
        try {
            global.sock.ws?.close();
            if (typeof global.sock.authDispose === "function") {
                await global.sock.authDispose();
            }
        } catch (_) { /* swallow — best-effort teardown */ }
    }

    // 3. Dispose plugins and middleware registries
    global.Print.info("Disposing plugins and middleware...");
    try { await disposePlugins(); } catch (_) { /* swallow */ }
    try { await disposeMiddlewares(); } catch (_) { /* swallow */ }

    // 4. Flush and close databases
    global.Print.info("Flushing databases...");
    try {
        if (db && typeof db.dispose === "function") await db.dispose();
    } catch (_) { /* swallow */ }

    try {
        if (global.storeClient?.quit) await global.storeClient.quit();
    } catch (_) { /* swallow */ }

    global.Print.box("OFFLINE", ["Drips successfully shut down."]);
    process.exit(0);
}

// ---====================< SHUTDOWN END >====================---

// ---====================< PROCESS HANDLERS START >====================---

// ----------> OS signal handlers <----------
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ----------> Crash catchers — log but do not kill process <----------
process.on("uncaughtException", (err) => {
    global.Print.error("UNCAUGHT EXCEPTION", err.stack || err);
});

process.on("unhandledRejection", (reason) => {
    global.Print.error("UNHANDLED REJECTION", reason);
});

// ----------> Ignite the engine <----------
bootstrap().catch((error) => {
    global.Print.error("Fatal during bootstrap", error);
    shutdown("FATAL_BOOTSTRAP");
});

// ---====================< PROCESS HANDLERS END >====================---
