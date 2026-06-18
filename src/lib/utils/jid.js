/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/utils/jid.js
    --> Description: Centralized JID/LID utility module for Drips v4. Wraps all Baileys
                     JID functions with null-safe guards. Every JID comparison or
                     normalization in the project MUST import from this module.
*/

import {
    jidNormalizedUser,
    areJidsSameUser,
    jidDecode as _jidDecode,
    isJidUser,
    isJidGroup,
    isJidBroadcast,
    isJidStatusBroadcast,
    isJidNewsletter
} from "@innovatorssoft/baileys";

// ---====================< JID UTILITIES START >====================---

// ----------> Safely normalize a JID — strips device suffixes <----------
export function normalizeJid(raw) {
    if (!raw || typeof raw !== "string") return raw || null;
    try {
        return jidNormalizedUser(raw);
    } catch {
        return raw;
    }
}

// ----------> Safely compare two JIDs for identity <----------
export function isSameJid(a, b) {
    if (!a || !b) return false;
    try {
        return areJidsSameUser(a, b);
    } catch {
        return false;
    }
}

// ----------> Determine JID type <----------
export function getJidType(jid) {
    if (!jid || typeof jid !== "string") return "unknown";
    if (jid.endsWith("@lid")) return "lid";
    if (isJidStatusBroadcast(jid)) return "status";
    if (isJidNewsletter(jid)) return "newsletter";
    if (isJidGroup(jid)) return "group";
    if (isJidBroadcast(jid)) return "broadcast";
    if (isJidUser(jid)) return "user";
    return "unknown";
}

// ----------> Null-safe type checks <----------
export function isGroupJid(jid) {
    if (!jid) return false;
    try { return isJidGroup(jid); } catch { return false; }
}

export function isStatusJid(jid) {
    if (!jid) return false;
    try { return isJidStatusBroadcast(jid); } catch { return jid === "status@broadcast"; }
}

export function isNewsletterJid(jid) {
    if (!jid) return false;
    try { return isJidNewsletter(jid); } catch { return false; }
}

export function isBroadcastJid(jid) {
    if (!jid) return false;
    try { return isJidBroadcast(jid); } catch { return false; }
}

// ----------> Extract phone number from any JID format <----------
export function extractPhoneNumber(jid) {
    if (!jid || typeof jid !== "string") return null;
    try {
        const decoded = _jidDecode(jid);
        return decoded?.user || null;
    } catch {
        // Fallback: strip @server and :device
        const cleaned = jid.split("@")[0].split(":")[0];
        return /^\d+$/.test(cleaned) ? cleaned : null;
    }
}

// ----------> Re-export jidDecode from Baileys for convenience <----------
export const jidDecode = _jidDecode;

// ---====================< JID UTILITIES END >====================---
