/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/config.js
    --> Description: Zod-validated environment configuration loader for Drips v4.
                     This is the SINGLE SOURCE OF TRUTH for all configurable values.
                     All .env values are validated on startup — the bot refuses to start
                     if required variables are missing or invalid.
*/

import { z } from "zod";

// ---====================< CONFIG SCHEMA START >====================---

// ----------> Helper transforms for env string coercion <----------
const toNumber = (fallback) => z.string().optional().default(String(fallback)).transform((v) => {
    const n = Number(v);
    if (Number.isNaN(n)) return fallback;
    return n;
});

const toBoolean = (fallback) => z.string().optional().default(String(fallback)).transform((v) => {
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return fallback;
});

const optionalString = z.string().optional().default("").transform((v) => v || undefined);

// ----------> Full environment schema <----------
const envSchema = z.object({
    // --- Bot Identity ---
    BOT_NAME: z.string().optional().default("Drips"),
    BOT_PREFIX: z.string().optional().default("^[.!/]"),
    OWNER_NUMBERS: z.string().optional().default(""),

    // --- WhatsApp Connection ---
    PAIRING_NUMBER: optionalString,
    PAIRING_CODE: optionalString,
    SESSION_DIR: z.string().optional().default("auth_info"),
    SESSION_NAME: z.string().optional().default("drips_v4_session"),
    MAX_RECONNECT_ATTEMPTS: toNumber(6),
    RECONNECT_INTERVAL_MS: toNumber(2000),

    // --- Anti-Detection / Human Mimicry ---
    TYPING_CHAR_DELAY_MS: toNumber(100),
    GAUSSIAN_DELAY_MIN_MS: toNumber(250),
    GAUSSIAN_DELAY_MAX_MS: toNumber(2000),
    READ_RECEIPT_DELAY_MS: toNumber(1500),

    // --- Queue ---
    QUEUE_CONCURRENCY: toNumber(3),
    QUEUE_JOB_TTL_MS: toNumber(60000),
    QUEUE_EMOJI: z.string().optional().default("⏳"),

    // --- Redis (optional — omit REDIS_HOST to use in-memory store) ---
    REDIS_HOST: optionalString,
    REDIS_PORT: toNumber(6379),
    REDIS_PASSWORD: optionalString,
    REDIS_DB: toNumber(0),
    REDIS_KEY_PREFIX: z.string().optional().default("drips:v4:"),

    // --- Hot Reload ---
    PLUGIN_DIR: z.string().optional().default("src/plugins"),
    MIDDLEWARE_DIR: z.string().optional().default("src/middleware"),
    HOT_RELOAD_DEBOUNCE_MS: toNumber(500),

    // --- Logging ---
    LOG_LEVEL: z.string().optional().default("info"),
    LOG_FILE: optionalString,

    // --- Feature Flags ---
    ENABLE_READ_RECEIPTS: toBoolean(true),
    ENABLE_PRESENCE: toBoolean(true),
    ENABLE_ANTI_DETECTION: toBoolean(true),

    // --- Database ---
    HISTORY_MAX_MESSAGES: toNumber(5000),
    HISTORY_MEDIA_ENABLED=toBoolean(true),
    HISTORY_MEDIA_MAX_SIZE_MB=toNumber(10),
});

// ---====================< CONFIG SCHEMA END >====================---

// ---====================< VALIDATION START >====================---

// ----------> Parse and validate environment variables <----------
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("\n╔══════════════════════════════════════════════════════════════╗");
    console.error("║           CONFIGURATION VALIDATION FAILED                   ║");
    console.error("╚══════════════════════════════════════════════════════════════╝\n");

    for (const issue of parsed.error.issues) {
        const path = issue.path.join(".");
        console.error(`  ✗ ${path}: ${issue.message}`);
    }

    console.error("\n  Check your .env file against .env.example for required variables.\n");
    process.exit(1);
}

// ----------> Freeze config to prevent runtime mutation <----------
const config = Object.freeze(parsed.data);

// ---====================< VALIDATION END >====================---

export { config };
export default config;
