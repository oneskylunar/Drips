/*
    --> Author: ONESKYLUNAR
    --> File: src/plugins/ping.js
    --> Description: Responds to the ping command with bot latency measurement.
*/


import { META_AI_JID, isJidMetaAI } from '@innovatorssoft/baileys'
// ---====================< PING PLUGIN START >====================---

export default {
    name: "ping",
    description: "Responds with bot latency to verify the bot is online.",
    pattern: "ping",
    isGroup: false,
    isPersonal: false,
    isEnabled: true,

    // ----------> Ping handler <----------
    async handler(sock, m, ctx) {

        const latency = `${Date.now() - (m.messageTimestamp * 1000)}ms`;
        const status = ctx.db ? 'Online' : 'Degraded';
        const uptime = `${(process.uptime() / 60).toFixed(1)} min`;

        await sock.sendMessage(
            m,
            {
                text: '🏓 Pong! Select an option below to view details.',
                footer: 'Drips Bot Uptime & Status',
                title: '🏓 Pong! Bot Status',
                buttonText: 'View Status Info',
                sections: [
                    {
                        title: 'Performance & Status',
                        rows: [
                            { title: '⚡ Latency', rowId: '.ping_latency', description: `Current latency: ${latency}` },
                            { title: '🤖 Bot Status', rowId: '.ping_status', description: `Status: ${status}` },
                            { title: '📡 Runtime Uptime', rowId: '.ping_uptime', description: `Runtime: ${uptime}` }
                        ]
                    }
                ]
            }
        );
    }
};

// ---====================< PING PLUGIN END >====================---
