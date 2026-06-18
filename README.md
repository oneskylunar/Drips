# 🤖 Drips — WhatsApp Automation Engine

> Production-grade WhatsApp bot framework powered by [Baileys](https://github.com/innovatorssoft/Baileys).
> Built for scale, designed for stealth.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![ESM](https://img.shields.io/badge/Module-ESM-blue)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔌 **Hot-Reload Plugin System** | Add, edit, or remove plugins without restarting — chokidar watches for file changes and reloads instantly |
| 🛡️ **Middleware Pipeline** | Pre-process every message before plugins — logging, rate-limiting, content filtering, and more |
| 🧠 **Anti-Detection** | Box-Muller Gaussian typing delays, presence simulation (`composing`/`paused`), delayed read receipts with jitter |
| 📦 **Dual Storage** | Redis for production, in-memory MapStore for development — identical API, zero code changes to switch |
| 🔄 **Auto-Reconnect** | Exponential backoff with ±20% jitter, exhaustive disconnect-reason handling, 5-minute hard cooldown after max attempts |
| ⚡ **Message Queue** | Per-chat FIFO queue with global concurrency control, TTL expiration, and direct-send fallback |
| 🗄️ **Schema Database** | Hot-reloadable table definitions with auto-timestamps, legacy JSON migration, and `where()` queries |
| 🔐 **Permission System** | Owner, admin, bot admin, super admin, group-only, and DM-only gates per plugin |
| ✅ **Zod Config** | Every `.env` variable is validated at startup with Zod — the bot refuses to start on misconfiguration |
| 🎨 **Terminal Styler** | Branded, color-coded terminal output with `global.Print` — boxes, success, warn, error, chat logs |

---

## 📁 Project Structure

```
dripsv4/
├── main.js                              # Entry point — bootstrap, shutdown, process handlers
├── package.json                         # Dependencies & scripts (ESM, "type": "module")
├── .env                                 # Your configuration (create from .env.example)
├── .env.example                         # Configuration template with all variables
├── .gitignore                           # Ignores node_modules, .env, auth_info*, data/, logs
├── README.md                            # You are here
│
├── database/
│   ├── index.js                         # Database engine — Table class, hot-reload watcher, migration
│   └── tables/
│       └── users.js                     # User schema (id, name, xp, isBanned, role)
│
├── src/
│   ├── handler.js                       # Message router, SecurityManager, command dispatcher
│   │
│   ├── lib/
│   │   ├── config.js                    # Zod-validated environment config (single source of truth)
│   │   │
│   │   ├── connection
│   │   │   ├── manager.js               # Advanced Connection Lifecycle & Event Manager
│   │   │   ├── socket.js                # Baileys socket factory & pairing code flow
│   │   │   └── auth.js                  # Multi-auth state management for sessions
│   │   │
│   │   ├── loaders
│   │   │   ├── middlewareLoader.js      # Hot-reload middleware manager with chokidar
│   │   │   └── pluginLoader.js          # Hot-reload plugin manager with chokidar
│   │   │
│   │   ├── messaging
│   │   │   ├── serializer.js            # Production-grade Message Serializer and Device Detector
│   │   │   ├── humanizer.js             # Anti-detection: Gaussian delays, typing sim, read receipts
│   │   │   ├── queue.js                 # Per-chat FIFO message queue with concurrency control
│   │   │   └── ui.js                    # Device-aware message UI builder
│   │   │
│   │   ├── storage
│   │   │   └── store.js                 # Redis / MapStore unified storage factory
│   │   │
│   │   └── utils/
│   │       ├── jid.js                   # JID normalization & comparison helpers
│   │       └── terminalStyler.js        # Branded terminal output (global.Print)
│   │
│   ├── plugins/
│   │   ├── _template.js                 # Plugin boilerplate (ignored by loader)
│   │   └── ping.js                      # Built-in: latency check & uptime report
│   │
│   └── middleware/
│       └── _template.js                 # Middleware boilerplate (ignored by loader)
│
└── data/                                # Auto-created at runtime
    └── store/                           # MapStore JSON persistence (dev mode)
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** v18+ (v20+ recommended)
- **npm** (bundled with Node.js)
- **Redis** (optional — only for production deployments)

### Step 1: Clone & Install

```bash
git clone https://github.com/oneskylunar/drips
cd drips
npm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings. The essential variables:

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `OWNER_NUMBERS` | ✅ | — | Comma-separated owner phone numbers (with country code, no `+`) |
| `BOT_NAME` | — | `Drips` | Display name used in terminal output |
| `BOT_PREFIX` | — | `^[.!/]` | Regex pattern for command prefixes |
| `PAIRING_NUMBER` | — | *(empty)* | Phone number for code-based pairing (leave empty for QR) |
| `SESSION_DIR` | — | `auth_info` | Directory for session state files |
| `REDIS_HOST` | — | *(empty)* | Redis hostname (leave empty for in-memory MapStore) |

> 💡 See [Configuration Reference](#️-configuration-reference) for the full list of 25+ environment variables.

### Step 3: Start the Bot

```bash
npm start
```

**QR Code Mode** *(default)*: A QR code appears in the terminal. Scan it with WhatsApp → **Linked Devices** → **Link a Device**.

**Pairing Code Mode**: Set `PAIRING_NUMBER=12xxxxxxxxxx` in `.env`, start the bot, and enter the displayed 8-character code in WhatsApp → **Linked Devices** → **Link with Phone Number**.

### Step 4: Test It

Send `.ping` to the bot's WhatsApp number. You should receive a latency response:

```
🏓 Pong!

⚡ Latency: 127ms
🤖 Bot: Online
📡 Runtime: 1.3 min
```

---

## 🔌 Creating Plugins

Plugins live in `src/plugins/`. Any `.js` file *(not starting with `_`)* is auto-loaded on startup and hot-reloaded on save.

### Basic Plugin Example

```javascript
/*
    --> Author: ONESKYLUNAR
    --> File: src/plugins/greet.js
    --> Description: Sends a greeting message with user info.
*/

export default {
    name: "greet",
    description: "Sends a personalized greeting.",
    pattern: "greet",         // Triggers on .greet, !greet, /greet
    isGroup: false,            // false = works everywhere
    isPersonal: false,         // false = works everywhere
    isEnabled: true,

    async handler(sock, m, ctx) {
        const { args, text, isOwner, db } = ctx;

        // Get or create user in database
        const users = db.table("users");
        let user = await users.get(m.sender);

        if (!user) {
            await users.set(m.sender, { id: m.sender, name: m.pushName || "Friend" });
            user = await users.get(m.sender);
        }

        await m.reply(`Hello *${user.name}*! 👋\n\nYour XP: ${user.xp}\nRole: ${user.role}`);
    }
};
```

### Advanced Plugin (Group Admin Only)

```javascript
/*
    --> Author: ONESKYLUNAR
    --> File: src/plugins/kick.js
    --> Description: Removes a member from the group. Requires both sender and bot to be admins.
*/

export default {
    name: "kick",
    description: "Removes a member from the group.",
    pattern: ["kick", "remove"],    // Multiple trigger words
    isGroup: true,                   // Group-only command
    admin: true,                     // Requires sender to be admin
    botAdmin: true,                  // Requires bot to be admin
    isEnabled: true,

    async handler(sock, m, ctx) {
        const { args, groupMetadata } = ctx;
        const target = m.mentionedJid?.[0] || (args[0] ? args[0] + "@s.whatsapp.net" : null);

        if (!target) return m.reply("❌ Tag or specify a user to kick.");

        await sock.groupParticipantsUpdate(m.chat, [target], "remove");
        await m.reply(`✅ Removed @${target.split("@")[0]}`, { mentions: [target] });
    }
};
```

### Plugin API Reference

#### Plugin Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | filename | Display name for logging |
| `description` | `string` | `""` | What the plugin does |
| `pattern` | `string` \| `RegExp` \| `string[]` | filename | Command trigger(s) — matched case-insensitively |
| `isGroup` | `boolean` | `false` | Restrict to groups only |
| `isPersonal` | `boolean` | `false` | Restrict to DMs only |
| `isEnabled` | `boolean` | `true` | Toggle without deleting the file |
| `admin` | `boolean` | `false` | Require sender to be a group admin |
| `botAdmin` | `boolean` | `false` | Require bot to be a group admin |
| `owner` | `boolean` | `false` | Require sender to be a bot owner |
| `handler` | `async function` | — | `(sock, m, ctx) => {}` |

#### Handler Context (`ctx`)

| Key | Type | Description |
|-----|------|-------------|
| `args` | `string[]` | Command arguments (space-split, after command name) |
| `text` | `string` | Full text after the command name |
| `prefix` | `string` | The prefix character used (`.`, `!`, or `/`) |
| `cmdName` | `string` | The matched command name (lowercase) |
| `isOwner` | `boolean` | Is the sender a bot owner (or `fromMe`)? |
| `isAdmin` | `boolean` | Is the sender a group admin? (always `true` in DMs) |
| `isBotAdmin` | `boolean` | Is the bot a group admin? (always `true` in DMs) |
| `isSuperAdmin` | `boolean` | Is the sender the group creator? |
| `db` | `Database` | Database instance — call `db.table("name")` |
| `groupMetadata` | `object \| null` | Group info from Baileys (null in DMs) |
| `participants` | `array` | Group member list (empty in DMs) |

#### Serialized Message (`m`)

| Key | Description |
|-----|-------------|
| `m.chat` | Chat JID (group or individual) |
| `m.sender` | Sender's JID |
| `m.pushName` | Sender's WhatsApp display name |
| `m.text` | Extracted text content |
| `m.isGroup` | Whether the message is from a group |
| `m.fromMe` | Whether the bot sent this message |
| `m.key` | Original Baileys message key |
| `m.mentionedJid` | Array of mentioned JIDs |
| `m.reply(text, opts)` | Queue-backed reply (auto-humanized) |
| `m.react(emoji)` | React to the message |

---

## 🛡️ Creating Middleware

Middleware runs **before** plugins on every incoming message. Use it for logging, filtering, rate-limiting, spam detection, or any cross-cutting concern.

Files in `src/middleware/` are loaded in **alphabetical order**. Prefix with numbers (`01-`, `02-`) to control execution order. Files starting with `_` are ignored.

### Middleware Example

```javascript
/*
    --> Author: ONESKYLUNAR
    --> File: src/middleware/01-antispam.js
    --> Description: Rate-limits messages per user (max 5 per 10 seconds).
*/

const cooldowns = new Map();

export default async function antispam(m, sock, db) {
    const key = m.sender;
    const now = Date.now();
    const window = 10000; // 10 seconds
    const maxMessages = 5;

    if (!cooldowns.has(key)) cooldowns.set(key, []);

    const timestamps = cooldowns.get(key).filter(t => now - t < window);
    timestamps.push(now);
    cooldowns.set(key, timestamps);

    if (timestamps.length > maxMessages) {
        await m.reply("⚠️ Slow down! You're sending too many commands.");
        return true;  // ← Consume the message — stops further processing
    }

    return false;     // ← Continue to next middleware → plugins
};
```

### Middleware Signature

```javascript
export default async function name(m, sock, db) {
    // m    → Serialized message object
    // sock → Baileys socket instance
    // db   → Database instance

    return false;  // false/undefined = pass through
    return true;   // true = consume (stops pipeline)
}
```

---

## 🗄️ Database System

The database engine provides schema-enforced tables backed by the same store client (Redis or MapStore). Schemas are hot-reloadable — edit a table file and it updates without restart.

### Defining a Table Schema

Create a new file in `database/tables/`:

```javascript
/*
    --> Author: ONESKYLUNAR
    --> File: database/tables/groups.js
    --> Description: Group settings schema.
*/

export default {
    name: "groups",
    primaryKey: "id",
    storage: "individual",   // "individual" = one key per record, "hash" = Redis hash
    timestamps: true,        // Auto-manages createdAt / updatedAt
    columns: {
        id: { type: "string", default: null },
        welcome: { type: "boolean", default: false },
        welcomeMsg: { type: "string", default: "Welcome!" },
        antiLink: { type: "boolean", default: false }
    }
};
```

### Table API

```javascript
const users = db.table("users");

// CRUD operations
await users.get("123456789012@s.whatsapp.net");          // Get by primary key
await users.set("123456789012@s.whatsapp.net", { ... }); // Create/overwrite (applies defaults + timestamps)
await users.update("123456789012@s.whatsapp.net", {      // Partial update (merges with existing)
    xp: 100,
    role: "premium"
});
await users.delete("123456789012@s.whatsapp.net");       // Delete by primary key

// Queries
const allUsers = await users.all();                      // Get all records
const banned   = await users.where({ isBanned: true });  // Filter by field values

// Events
users.on("set", ({ id, record }) => { /* ... */ });
users.on("update", ({ id, record }) => { /* ... */ });
users.on("delete", ({ id }) => { /* ... */ });
```

---

## ⚙️ Configuration Reference

All variables are defined in `.env` and validated by Zod on startup. The bot **will not start** if validation fails.

### Bot Identity

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_NAME` | `Drips` | Display name in terminal logs |
| `BOT_PREFIX` | `^[.!/]` | Regex for command prefixes |
| `OWNER_NUMBERS` | *(empty)* | Comma-separated phone numbers with country code |

### WhatsApp Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `PAIRING_NUMBER` | *(empty)* | Phone number for pairing code mode (leave empty for QR) |
| `SESSION_DIR` | `auth_info` | Directory for session credentials |
| `SESSION_NAME` | `drips_v4_session` | Session identifier |
| `MAX_RECONNECT_ATTEMPTS` | `6` | Max reconnect tries before 5-minute cooldown |
| `RECONNECT_INTERVAL_MS` | `2000` | Base delay for exponential backoff |

### Anti-Detection / Human Mimicry

| Variable | Default | Description |
|----------|---------|-------------|
| `TYPING_CHAR_DELAY_MS` | `100` | Per-character typing delay (ms) |
| `GAUSSIAN_DELAY_MIN_MS` | `250` | Min jitter from Box-Muller distribution |
| `GAUSSIAN_DELAY_MAX_MS` | `2000` | Max jitter from Box-Muller distribution |
| `READ_RECEIPT_DELAY_MS` | `1500` | Base delay before sending read receipts (±25% jitter) |

### Message Queue

| Variable | Default | Description |
|----------|---------|-------------|
| `QUEUE_CONCURRENCY` | `3` | Max simultaneous cross-chat sends |
| `QUEUE_JOB_TTL_MS` | `60000` | Time-to-live for queued messages (ms) |
| `QUEUE_EMOJI` | `⏳` | Emoji displayed for queued state |

### Redis (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | *(empty)* | Redis hostname — leave empty for in-memory MapStore |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | *(empty)* | Redis auth password |
| `REDIS_DB` | `0` | Redis database index |
| `REDIS_KEY_PREFIX` | `drips:v4:` | Key prefix for all Redis keys |

### Hot Reload

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_DIR` | `src/plugins` | Plugin directory to watch |
| `MIDDLEWARE_DIR` | `src/middleware` | Middleware directory to watch |
| `HOT_RELOAD_DEBOUNCE_MS` | `500` | Debounce delay for file change events |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_READ_RECEIPTS` | `true` | Send blue ticks after reading messages |
| `ENABLE_PRESENCE` | `true` | Show "typing..." and "online" indicators |
| `ENABLE_ANTI_DETECTION` | `true` | Master switch for all humanizer features |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `LOG_FILE` | *(empty)* | Optional log file path |


---

## 🔀 Storage Modes

Both modes implement an **identical API** — your plugins and middleware work the same regardless of backend.

| Mode | Trigger | Persistence | Best For |
|------|---------|-------------|----------|
| 🗂️ **MapStore** | `REDIS_HOST` is empty | Local File-backed (persists to `data/store/`) | Default, simple setup, offline usage |
| 🔴 **Redis** | `REDIS_HOST` is set | Redis server | Production, multi-instance, cloud scaling |

### MapStore Capabilities

The local file-backed MapStore implements the full Redis client interface:

- **String ops**: `get`, `set`, `del`, `mGet`, `keys`
- **Hash ops**: `hGet`, `hSet`, `hDel`, `hGetAll`, `hmGet`
- **List ops**: `rPush`, `lIndex`, `lPop`
- **Transactions**: `multi()` pipeline with `exec()`
- **Lifecycle**: `connect()`, `quit()`, `disconnect()`

Switch storage by setting/unsetting `REDIS_HOST` in `.env` — no code changes needed.

---

## 🧠 Anti-Detection System

Drips includes a sophisticated human-mimicry system to reduce the risk of WhatsApp flagging the bot as automated.

### How It Works

1. **Gaussian Typing Delay** — Uses the Box-Muller transform to generate naturally distributed random delays before each reply. Delay scales with message length (`100ms × character_count`, clamped to 500ms–15s).

2. **Presence Simulation** — Sends `composing` presence → waits → sends `paused` presence before each message, mimicking real human typing behavior.

3. **Delayed Read Receipts** — Blue tick delivery is delayed by `READ_RECEIPT_DELAY_MS ± 25%` jitter after receiving each message.

4. **Reconnect Jitter** — All reconnect delays include ±20% random jitter to prevent synchronized reconnect storms against WhatsApp servers.

All features are individually toggleable via `ENABLE_ANTI_DETECTION`, `ENABLE_PRESENCE`, and `ENABLE_READ_RECEIPTS`.

---

## 🔄 Reconnect Strategy

The `ConnectionManager` handles disconnects with exhaustive status-code coverage:

| Code | Reason | Action |
|------|--------|--------|
| 401 | Logged out | **Fatal** — exits process, preserves auth for manual re-pair |
| 403 | Forbidden | **Fatal** — possible ban, exits immediately |
| 408 | Connection lost / Timed out | Reconnect with 5s base backoff |
| 411 | Multidevice mismatch | Reconnect with 3s base backoff |
| 428 | Connection closed | Reconnect with 2s standard backoff |
| 440 | Connection replaced | Quick reconnect (1s) |
| 500 | Bad session / Handshake timeout | Distinguishes by error message, 3–5s backoff |
| 503 | Unavailable service | Long wait (10s base) — servers may be down |
| 515 | Restart required | Immediate reconnect (1s) |

After `MAX_RECONNECT_ATTEMPTS` (default: 6) failures, the bot enters a **5-minute hard cooldown** before resetting the counter and retrying.

---

## 📐 Architecture Overview

```
┌──────────────┐    ┌──────────────┐    ┌─────────────────┐
│   WhatsApp   │◄──►│   Baileys    │◄──►│   socket.js     │
│   Servers    │    │   WebSocket  │    │   (factory)     │
└──────────────┘    └──────────────┘    └────────┬────────┘
                                                 │
                    ┌────────────────────────────►│
                    │                             ▼
           ┌────────┴────────┐          ┌──────────────────┐
           │  connection.js  │          │    handler.js     │
           │  (reconnect &   │          │  (SecurityMgr +   │
           │   event mgr)    │          │   command router) │
           └─────────────────┘          └────────┬─────────┘
                                                 │
                                    ┌────────────┼────────────┐
                                    ▼            ▼            ▼
                            ┌────────────┐ ┌──────────┐ ┌──────────┐
                            │ middleware  │ │ plugins  │ │  queue   │
                            │ pipeline   │ │ (match & │ │ (FIFO +  │
                            │ (consume?) │ │  execute) │ │ humanize)│
                            └────────────┘ └──────────┘ └────┬─────┘
                                                              │
                                                ┌─────────────┼──────────────┐
                                                ▼             ▼              ▼
                                        ┌────────────┐ ┌────────────┐ ┌──────────┐
                                        │ humanizer  │ │  database  │ │  store   │
                                        │ (Gaussian  │ │  (Table +  │ │ (Redis / │
                                        │  delays)   │ │  schemas)  │ │ MapStore)│
                                        └────────────┘ └────────────┘ └──────────┘
```

---

## 🧰 Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| [`@innovatorssoft/baileys`](https://github.com/innovatorssoft/Baileys) | `7.x` | WhatsApp Web API (multi-device) |
| [`zod`](https://zod.dev) | `4.x` | Runtime schema validation for config |
| [`chokidar`](https://github.com/paulmillr/chokidar) | `5.x` | Cross-platform file watching (hot-reload) |
| [`redis`](https://github.com/redis/node-redis) | `6.x` | Redis client for production storage |
| [`dotenv`](https://github.com/motdotla/dotenv) | `17.x` | Environment variable loading |
| [`pino`](https://getpino.io) | `10.x` | High-performance JSON logger |
| [`async-mutex`](https://github.com/DirtyHairy/async-mutex) | `0.5.x` | Mutex locks for concurrency control |

---

### Logging

Always use `global.Print` — never `console.log`:

```javascript
global.Print.info("Information message");
global.Print.success("Something worked");
global.Print.warn("Warning message");
global.Print.error("Error title", errorDetails);
global.Print.system("System-level message");
global.Print.chat(chatJid, senderJid, messageText);
global.Print.box("TITLE", ["line 1", "line 2"]);
```

---

## 📜 License

ISC © [ONESKYLUNAR](https://github.com/oneskylunar)
