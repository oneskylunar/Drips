/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/messaging/ui.js
    --> Description: Device-aware message UI factory for Drips v4. Provides comprehensive
                     message type constants, per-device capability detection, native flow
                     relay for interactive messages (buttons, lists), and aesthetic text
                     fallback formatters for unsupported clients (Web, Desktop).
*/

import { proto, generateWAMessageFromContent } from "@innovatorssoft/baileys";
import config from "../config.js";

// ---====================< MESSAGE TYPE CONSTANTS START >====================---

// ----------> Comprehensive WhatsApp message type registry <----------
export const MSG_TYPES = {
    TEXT: "text",
    EXTENDED_TEXT: "extendedTextMessage",
    IMAGE: "imageMessage",
    VIDEO: "videoMessage",
    AUDIO: "audioMessage",
    DOCUMENT: "documentMessage",
    STICKER: "stickerMessage",
    LOCATION: "locationMessage",
    LIVE_LOCATION: "liveLocationMessage",
    CONTACT: "contactMessage",
    CONTACT_ARRAY: "contactsArrayMessage",
    BUTTONS: "buttonsMessage",
    TEMPLATE: "templateMessage",
    LIST: "listMessage",
    REACTION: "reactionMessage",
    POLL_CREATE: "pollCreationMessage",
    POLL_UPDATE: "pollUpdateMessage",
    ORDER: "orderMessage",
    PRODUCT: "productMessage",
    NATIVE_FLOW: "interactiveMessage",
    VIEW_ONCE_IMAGE: "viewOnceMessage",
    VIEW_ONCE_VIDEO: "viewOnceMessageV2",
    FORWARDED: "forwardedMessage",
    EDIT: "editMessage",
    PIN: "pinMessage"
};

// ---====================< MESSAGE TYPE CONSTANTS END >====================---

// ---====================< DEVICE CAPABILITY CHECK START >====================---

// ----------> Determine message rendering style based on device type <----------
/**
 * Checks if a device type supports the preferred interactive message type.
 * Returns the preferred type if supported, or 'text_fallback' if not.
 *
 * To modify device capabilities:
 * - Add/remove types from the `unsupported` Set in each device block.
 * - Add new device blocks with an else-if for new platforms.
 *
 * @param {string} preferredType - The desired message style (e.g., 'buttons', 'list', 'nativeFlow', 'poll').
 * @param {string} deviceType - The detected device type (e.g., 'web', 'ios', 'android', 'desktop').
 * @returns {string} The resolved message style or 'text_fallback'.
 */
export function getMessageStyle(preferredType, deviceType) {
    // ----------> Web Device Capabilities <----------
    // Web clients cannot render native flow messages (buttons, lists).
    // To add/remove support: add/remove the type from the unsupported set.
    if (deviceType === "web") {
        const unsupported = new Set(["buttons", "list", "nativeFlow", "poll"]);
        if (unsupported.has(preferredType)) return "text_fallback";
        return preferredType;
    }
    // ----------> iOS Device Capabilities <----------
    // iOS supports all interactive message types.
    else if (deviceType === "ios") {
        return preferredType;
    }
    // ----------> Android Device Capabilities <----------
    // Android supports all interactive message types.
    else if (deviceType === "android") {
        return preferredType;
    }
    // ----------> Desktop Device Capabilities <----------
    // Desktop clients share the same rendering limitations as Web.
    else if (deviceType === "desktop") {
        const unsupported = new Set(["buttons", "list", "nativeFlow", "poll"]);
        if (unsupported.has(preferredType)) return "text_fallback";
        return preferredType;
    }
    // ----------> Default (Unknown/Conservative) <----------
    // Unknown devices get text fallback to ensure message is always readable.
    else {
        return "text_fallback";
    }
}

// ---====================< DEVICE CAPABILITY CHECK END >====================---

// ---====================< FALLBACK FORMATTERS START >====================---

// ----------> Format buttons as numbered text choices <----------
/**
 * Produces an aesthetic text representation of interactive buttons.
 * @param {Object} content - { header, body, footer }
 * @param {Array} buttons - Array of { display_text, id }
 * @returns {string} Formatted fallback text.
 */
export function formatButtonsFallback(content, buttons) {
    let text = "";

    if (content.header) {
        text += `*${content.header}*\n\n`;
    }

    text += `${content.body || ""}\n\n`;
    text += `╭─⟡ *Available Actions*\n`;

    buttons.forEach((btn, index) => {
        text += `│ ${index + 1}. ${btn.display_text} (command: ${btn.id})\n`;
    });

    text += `╰─────────────⟡`;

    if (content.footer) {
        text += `\n_${content.footer}_`;
    }

    return text;
}

// ----------> Format list sections as numbered text <----------
/**
 * Produces an aesthetic text representation of list/menu sections.
 * @param {Object} content - { header, body, footer }
 * @param {Array} sections - Array of { title, rows: [{ title, id, description }] }
 * @returns {string} Formatted fallback text.
 */
export function formatListFallback(content, sections) {
    let text = "";

    if (content.header) {
        text += `*${content.header}*\n\n`;
    }

    text += `${content.body || ""}\n\n`;

    let globalIndex = 1;
    sections.forEach((section) => {
        text += `┌─[ *${section.title.toUpperCase()}* ]\n`;
        section.rows.forEach((row) => {
            text += `│ ${globalIndex}. ${row.title}\n`;
            if (row.description) {
                text += `│    _${row.description}_\n`;
            }
            globalIndex++;
        });
        text += `└───────⟡\n\n`;
    });

    text += `*Reply with the exact command to proceed.*`;

    if (content.footer) {
        text += `\n_${content.footer}_`;
    }

    return text;
}

// ----------> Format poll as numbered options <----------
/**
 * Produces an aesthetic text representation of a poll.
 * @param {string} pollName - The poll question/title.
 * @param {Array} options - Array of option strings.
 * @returns {string} Formatted fallback text.
 */
export function formatPollFallback(pollName, options) {
    const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

    let text = `📊 *Poll: ${pollName}*\n\n`;

    options.forEach((option, index) => {
        const emoji = numberEmojis[index] || `${index + 1}.`;
        text += `${emoji} ${option}\n`;
    });

    text += `\n_Reply with the number of your choice._`;

    return text;
}

// ----------> Format location as Google Maps link <----------
/**
 * Produces a text representation of a location with a map link.
 * @param {number} lat - Latitude.
 * @param {number} lon - Longitude.
 * @param {string|null} name - Location name (optional).
 * @param {string|null} address - Location address (optional).
 * @returns {string} Formatted fallback text.
 */
export function formatLocationFallback(lat, lon, name, address) {
    let text = `📍 *Location*\n`;

    if (name) {
        text += `${name}\n`;
    }
    if (address) {
        text += `${address}\n`;
    }

    text += `\n🗺️ https://maps.google.com/maps?q=${lat},${lon}`;
    text += `\n📐 Coordinates: ${lat}, ${lon}`;

    return text;
}

// ----------> Format contact vCard as labeled text <----------
/**
 * Produces a text representation of one or more contacts.
 * @param {Array} contacts - Array of { displayName, vcard } objects.
 * @returns {string} Formatted fallback text.
 */
export function formatContactFallback(contacts) {
    if (!contacts || contacts.length === 0) return "👤 *No contact information available.*";

    let text = "";

    contacts.forEach((contact, index) => {
        if (index > 0) text += "\n\n";

        const name = contact.displayName || "Unknown";
        text += `👤 *Contact: ${name}*`;

        if (contact.vcard) {
            // Extract phone numbers from vCard TEL fields
            const telMatches = contact.vcard.match(/TEL[^:]*:([^\r\n]+)/gi);
            if (telMatches) {
                telMatches.forEach((match) => {
                    const number = match.split(":").pop().trim();
                    text += `\n📱 Phone: ${number}`;
                });
            }

            // Extract email addresses from vCard EMAIL fields
            const emailMatches = contact.vcard.match(/EMAIL[^:]*:([^\r\n]+)/gi);
            if (emailMatches) {
                emailMatches.forEach((match) => {
                    const email = match.split(":").pop().trim();
                    text += `\n📧 Email: ${email}`;
                });
            }

            // Extract organization from vCard ORG field
            const orgMatch = contact.vcard.match(/ORG[^:]*:([^\r\n]+)/i);
            if (orgMatch) {
                const org = orgMatch[1].trim();
                text += `\n🏢 Organization: ${org}`;
            }
        }
    });

    return text;
}

// ---====================< FALLBACK FORMATTERS END >====================---

// ---====================< MESSAGE UI CLASS START >====================---

// ----------> Device-aware interactive message factory <----------
export class MessageUI {

    // ----------> Internal native flow relay helper <----------
    /**
     * Wraps and relays an interactive message through WhatsApp's native flow system.
     * Injects required 'biz' XML nodes to bypass UI rendering blocks on mobile clients.
     * @param {Object} m - The decorated message object (must have m.sock attached).
     * @param {Object} interactiveMessage - The proto InteractiveMessage payload.
     * @returns {Promise<boolean>} True if relay succeeded, false otherwise.
     */
    static async #relayNativeFlow(m, interactiveMessage) {
        if (!m.sock) {
            global.Print.error("[MessageUI] Socket reference missing on message object. Cannot relay native flow.");
            return false;
        }

        try {
            const msg = generateWAMessageFromContent(m.chat, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadataVersion: 2,
                            deviceListMetadata: {}
                        },
                        interactiveMessage: interactiveMessage
                    }
                }
            }, { userJid: m.sock.user.id, quoted: m });

            // Required XML nodes to force UI rendering on Android/iOS
            const additionalNodes = [
                {
                    tag: "biz",
                    attrs: {},
                    content: [{
                        tag: "interactive",
                        attrs: { type: "native_flow", v: "1" },
                        content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }]
                    }]
                }
            ];

            await m.sock.relayMessage(m.chat, msg.message, {
                messageId: msg.key.id,
                additionalNodes
            });

            return true;
        } catch (error) {
            global.Print.error(`[MessageUI] Failed to relay native flow to ${m.chat}`, error.message);
            return false;
        }
    }

    // ----------> Send interactive buttons <----------
    /**
     * Sends a message with interactive quick-reply buttons.
     * Automatically falls back to formatted text on unsupported devices.
     * @param {Object} m - The decorated message object.
     * @param {Object} content - { body, footer, header }
     * @param {Array} buttons - Array of { display_text, id } (max 3).
     * @returns {Promise<boolean|Object>} Relay result or sent message info.
     */
    static async sendButtons(m, content, buttons) {
        const safeButtons = buttons.slice(0, 3);
        const style = getMessageStyle("buttons", m.device);

        if (style === "text_fallback") {
            const fallbackText = formatButtonsFallback(content, safeButtons);
            try {
                return await m.reply(fallbackText);
            } catch (error) {
                global.Print.error("[MessageUI] Failed to send button text fallback", error.message);
                return false;
            }
        }

        // Native flow generation for supported devices
        const formattedButtons = safeButtons.map(btn => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: btn.display_text,
                id: btn.id
            })
        }));

        const interactiveMessage = proto.Message.InteractiveMessage.create({
            body: { text: content.body || "" },
            footer: { text: content.footer || config.BOT_NAME || "Drips" },
            header: content.header
                ? { title: content.header, hasMediaAttachment: false }
                : undefined,
            nativeFlowMessage: { buttons: formattedButtons }
        });

        return await this.#relayNativeFlow(m, interactiveMessage);
    }

    // ----------> Send dropdown list / menu <----------
    /**
     * Sends a dropdown menu/list message.
     * Automatically falls back to formatted text on unsupported devices.
     * @param {Object} m - The decorated message object.
     * @param {Object} content - { body, footer, header, buttonText }
     * @param {Array} sections - Array of { title, rows: [{ title, id, description }] }
     * @returns {Promise<boolean|Object>} Relay result or sent message info.
     */
    static async sendList(m, content, sections) {
        const style = getMessageStyle("list", m.device);

        if (style === "text_fallback") {
            const fallbackText = formatListFallback(content, sections);
            try {
                return await m.reply(fallbackText);
            } catch (error) {
                global.Print.error("[MessageUI] Failed to send list text fallback", error.message);
                return false;
            }
        }

        // Native flow generation for supported devices
        const interactiveMessage = proto.Message.InteractiveMessage.create({
            body: { text: content.body || "" },
            footer: { text: content.footer || config.BOT_NAME || "Drips" },
            header: content.header
                ? { title: content.header, hasMediaAttachment: false }
                : undefined,
            nativeFlowMessage: {
                buttons: [{
                    name: "single_select",
                    buttonParamsJson: JSON.stringify({
                        title: content.buttonText || "Tap to View",
                        sections: sections
                    })
                }]
            }
        });

        return await this.#relayNativeFlow(m, interactiveMessage);
    }
}

// ---====================< MESSAGE UI CLASS END >====================---
