/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/messaging/humanizer.js
    --> Description: Anti-detection and human-mimicry system for Drips. Implements
                     Box-Muller transform for Gaussian random delays, character-rate
                     typing simulation, presence management, and delayed read receipts.
                     All timing parameters are configurable via environment variables.
*/

import config from "../config.js";

// ---====================< DELAY HELPERS START >====================---

// ----------> Promise-based delay <----------
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------> Box-Muller transform for true Gaussian distribution <----------
export function gaussianRandom(min, max) {
    let u = 0, v = 0;
    // Ensure u and v are in (0, 1) exclusive — zero would break Math.log
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();

    // Standard Box-Muller transform
    let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

    // Normalize from standard normal to [0, 1] range
    num = num / 10.0 + 0.5;

    // Resample if out of [0, 1] bounds (tail clipping)
    if (num > 1 || num < 0) return gaussianRandom(min, max);

    // Scale to desired range
    return num * (max - min) + min;
}

// ---====================< DELAY HELPERS END >====================---

// ---====================< TYPING SIMULATION START >====================---

// ----------> Calculate typing delay based on message length <----------
export function calculateTypingDelay(text) {
    if (!text) return 500;
    const delay = config.TYPING_CHAR_DELAY_MS * text.length;
    return Math.max(500, Math.min(delay, 15000)); // Clamp between 500ms and 15s
}

// ----------> Calculate random jitter using Gaussian distribution <----------
export function calculateJitter() {
    return gaussianRandom(config.GAUSSIAN_DELAY_MIN_MS, config.GAUSSIAN_DELAY_MAX_MS);
}

// ----------> Phase 1: Start composing indicator + delay (call BEFORE sending) <----------
// The 'composing' state stays active until the message is sent or endTyping is called.
// This ensures the user always sees the typing indicator right up until the message arrives.
export async function beginTyping(sock, jid, text) {
    if (!config.ENABLE_ANTI_DETECTION || !config.ENABLE_PRESENCE) return;
    if (!sock || !jid) return;

    const typingDelay = calculateTypingDelay(text);
    const jitter = calculateJitter();
    const totalDelay = typingDelay + jitter;

    try {
        await sock.sendPresenceUpdate("composing", jid);
        await sleep(totalDelay);
        // NOTE: We intentionally do NOT send 'paused' here.
        // The message send that follows will naturally clear the typing indicator.
    } catch (error) {
        global.Print?.warn(`[Humanizer] Begin typing failed for ${jid}: ${error.message}`);
    }
}

// ----------> Phase 2: Explicitly clear typing indicator (optional cleanup) <----------
export async function endTyping(sock, jid) {
    if (!config.ENABLE_PRESENCE || !sock || !jid) return;
    try {
        await sock.sendPresenceUpdate("paused", jid);
    } catch (_) {
        // Non-critical
    }
}

// ----------> Inter-message breathing gap for multi-reply commands <----------
// Adds a natural pause between consecutive messages so WhatsApp's UI has time
// to render the previous message before the next typing indicator appears.
export async function postSendBreather() {
    if (!config.ENABLE_ANTI_DETECTION) return;
    // 400-800ms gap — fast enough to feel responsive, slow enough to look natural
    const gap = 400 + Math.floor(Math.random() * 400);
    await sleep(gap);
}

// ----------> Legacy: Full typing simulation (composing → delay → paused) <----------
// Kept for backward compatibility with direct callers outside the queue.
export async function simulateTyping(sock, jid, text) {
    await beginTyping(sock, jid, text);
    await endTyping(sock, jid);
}

// ---====================< TYPING SIMULATION END >====================---

// ---====================< READ RECEIPTS START >====================---

// ----------> Send read receipt with randomized delay <----------
export async function sendDelayedReadReceipt(sock, m) {
    if (!config.ENABLE_READ_RECEIPTS) return;
    if (!sock || !m?.key) return;

    try {
        // Add ±25% random jitter to the base delay
        const jitterFactor = 0.75 + Math.random() * 0.5;
        const delay = Math.round(config.READ_RECEIPT_DELAY_MS * jitterFactor);

        await sleep(delay);
        await sock.readMessages([m.key]);
    } catch (error) {
        // Read receipt errors are non-critical
        global.Print?.warn(`[Humanizer] Read receipt failed: ${error.message}`);
    }
}

// ---====================< READ RECEIPTS END >====================---
