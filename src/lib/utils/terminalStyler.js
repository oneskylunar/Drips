/*
    --> Author: ONESKYLUNAR
    --> File: src/lib/utils/terminalStyler.js
    --> Description: Terminal styling engine for Drips v4. Provides colorized, timestamped
                     console output with ANSI escape codes. Bound to global.Print for
                     universal access across all modules.
*/

import pino from "pino";

const ANSI = {

    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    colors: {
        primary: "\x1b[38;2;0;255;255m",   // Cyan/Aqua
        success: "\x1b[38;2;0;255;128m",   // Neon Green
        warning: "\x1b[38;2;255;165;0m",   // Orange
        error: "\x1b[38;2;255;50;50m",     // Red
        info: "\x1b[38;2;100;150;255m",    // Soft Blue
        system: "\x1b[38;2;200;100;255m",  // Purple
        white: "\x1b[37m",
        gray: "\x1b[90m"
        },
    bg: {
        error: "\x1b[48;2;255;0;0m\x1b[37m", // Red BG, White Text
        primary: "\x1b[48;2;0;100;200m\x1b[37m" // Blue BG, White Text
        }
};

class TerminalStyler {
    constructor() {
        this.pinoLogger = pino({ level: process.env.LOG_LEVEL || "silent" });
    }


    #getTimestamp() {
        const now = new Date();
        const time = now.toTimeString().split(" ")[0];
        const ms = String(now.getMilliseconds()).padStart(3, "0");
        return `${ANSI.dim}[${time}.${ms}]${ANSI.reset}`;
    }

    #format(prefix, color, message, context = null) {
        let out = `${this.#getTimestamp()} ${color}${ANSI.bold} ${prefix} ${ANSI.reset} ${message}`;
        if (context) {
            const ctxStr = typeof context === "object" ? JSON.stringify(context, null, 2) : String(context);
            out += `\n${ANSI.dim}${ctxStr}${ANSI.reset}`;
        }
        return out;
    }

    log(msg, ctx)     { console.log(this.#format("›", ANSI.colors.white, msg, ctx)); }
    info(msg, ctx)    { console.log(this.#format("i", ANSI.colors.info, msg, ctx)); }
    success(msg, ctx) { console.log(this.#format("✓", ANSI.colors.success, msg, ctx)); }
    warn(msg, ctx)    { console.warn(this.#format("⚠", ANSI.colors.warning, msg, ctx)); }
    error(msg, ctx)   { console.error(this.#format("✗", ANSI.colors.error, msg, ctx)); }
    system(msg, ctx)  { console.log(this.#format("❖", ANSI.colors.system, msg, ctx)); }

    // Specifically for WhatsApp Message routing styling
    chat(chatId, sender, message) {
        const id = `${ANSI.colors.primary}[${chatId}]${ANSI.reset}`;
        const usr = `${ANSI.colors.success}${sender}${ANSI.reset}`;
        console.log(`${this.#getTimestamp()} 💬 ${id} ${usr}: ${ANSI.dim}${message}${ANSI.reset}`);
    }

    // Boxed printing for critical boot logs
    box(title, lines) {
        const width = 60;
        const top = `\n${ANSI.colors.primary}┌─ ${ANSI.bold}${title}${ANSI.reset}${ANSI.colors.primary} ${"─".repeat(width - title.length - 5)}┐${ANSI.reset}`;
        const bottom = `${ANSI.colors.primary}└${"─".repeat(width - 2)}┘${ANSI.reset}\n`;

        console.log(top);
        lines.forEach(line => {
            console.log(`${ANSI.colors.primary}│${ANSI.reset} ${line.padEnd(width - 4)} ${ANSI.colors.primary}│${ANSI.reset}`);
        });
        console.log(bottom);
    }

}

// Bind to global scope so ANY file can use `global.Print.success(...)`
global.Print = new TerminalStyler();
