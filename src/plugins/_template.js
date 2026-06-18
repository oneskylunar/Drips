/*
    --> Author: ONESKYLUNAR
    --> File: src/plugins/_template.js
    --> Description: Plugin template. Copy this file and rename to create a new plugin.
                     Files starting with _ are ignored by the plugin loader.
*/

export default {
    name: "template",
    description: "A template plugin — copy and modify.",
    pattern: "template",       // String, RegExp, or Array of strings
    isGroup: false,             // true = group only
    isPersonal: false,          // true = DM only
    isEnabled: true,            // false to disable without deleting
    // Permission flags (optional)
    admin: false,               // Require group admin
    botAdmin: false,            // Require bot to be admin
    owner: false,               // Require bot owner

    async handler(sock, m, ctx) {
        // sock    = Baileys socket instance
        // m       = Serialized message object (with .reply, .react, .download, .sock)
        // ctx     = { args, text, prefix, cmdName, isOwner, isAdmin, isBotAdmin, isSuperAdmin, db, groupMetadata, participants }

        await m.reply("Hello from the template plugin!");
    }
};
