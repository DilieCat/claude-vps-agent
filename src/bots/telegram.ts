/**
 * Telegram bot for Claude Code — Living Agent mode.
 *
 * Forwards messages to Claude via LivingBridge (brain-aware, session-persistent).
 * Falls back to stateless ClaudeBridge if LivingBridge fails to initialise.
 * Configure via environment variables (see README.md).
 */

import fs from "node:fs";
import path from "node:path";
import { Telegraf, Context } from "telegraf";
import dotenv from "dotenv";
import {
  ClaudeBridge,
  LivingBridge,
  NotificationQueue,
  splitMessage,
  loadNotifyPrefs,
  saveNotifyPrefs,
} from "../lib/index.js";
import type { ClaudeResponse, Notification } from "../lib/index.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "..",
  ".."
);

const BOT_TOKEN: string = process.env["TELEGRAM_BOT_TOKEN"] ?? "";

const ALLOWED_USERS: Set<number> = new Set();
const rawUsers = process.env["TELEGRAM_ALLOWED_USERS"] ?? "";
if (rawUsers.trim()) {
  for (const uid of rawUsers.split(",")) {
    const trimmed = uid.trim();
    if (/^\d+$/.test(trimmed)) {
      ALLOWED_USERS.add(Number(trimmed));
    }
  }
}

const TELEGRAM_MAX_LEN = 4096;
const NOTIFY_PREFS_PATH = path.join(PROJECT_ROOT, "data", "telegram_notify_prefs.json");
const NOTIFICATION_CHECK_INTERVAL = 60_000; // ms

const ALLOWED_PROJECT_BASE: string = fs.realpathSync(
  process.env["ALLOWED_PROJECT_BASE"] ?? process.env["HOME"] ?? "/"
);

// Per-user settings
interface UserSettings {
  projectDir?: string;
  model?: string;
}
const userSettings = new Map<string, UserSettings>();

// ---------------------------------------------------------------------------
// Bridge instance — try LivingBridge first, fall back to ClaudeBridge
// ---------------------------------------------------------------------------
let bridge: ClaudeBridge;
let livingMode = false;

try {
  bridge = new LivingBridge({
    projectDir: process.env["CLAUDE_PROJECT_DIR"],
    model: process.env["CLAUDE_MODEL"],
  });
  livingMode = true;
  console.log("LivingBridge initialised — brain + sessions active");
} catch {
  bridge = new ClaudeBridge({
    projectDir: process.env["CLAUDE_PROJECT_DIR"],
    model: process.env["CLAUDE_MODEL"],
  });
  console.log("Running in stateless mode (LivingBridge not available)");
}

// Notification queue (only in living mode)
let notificationQueue: NotificationQueue | null = null;
if (livingMode) {
  try {
    notificationQueue = new NotificationQueue();
  } catch {
    console.warn("NotificationQueue init failed, notifications disabled");
  }
}

// ---------------------------------------------------------------------------
// Notification preferences helpers
// ---------------------------------------------------------------------------
function toggleNotify(userId: number): boolean {
  const prefs = loadNotifyPrefs(NOTIFY_PREFS_PATH);
  const key = String(userId);
  const newState = !prefs[key];
  prefs[key] = newState;
  saveNotifyPrefs(NOTIFY_PREFS_PATH, prefs);
  return newState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isAllowed(userId: number): boolean {
  if (ALLOWED_USERS.size === 0) return true;
  return ALLOWED_USERS.has(userId);
}

function validateProjectPath(p: string): string | null {
  const resolved = path.resolve(p);
  if (resolved !== ALLOWED_PROJECT_BASE && !resolved.startsWith(ALLOWED_PROJECT_BASE + path.sep)) {
    return null;
  }
  return resolved;
}

function getUserBridge(userId: number): ClaudeBridge {
  const settings = userSettings.get(String(userId));
  if (!settings) return bridge;

  // Create a bridge with per-user overrides
  const BridgeClass = livingMode ? LivingBridge : ClaudeBridge;
  const overridden = new BridgeClass({
    projectDir: settings.projectDir ?? bridge.projectDir,
    model: settings.model ?? bridge.model,
  });

  // For LivingBridge, share the same brain and sessions
  if (livingMode && overridden instanceof LivingBridge && bridge instanceof LivingBridge) {
    Object.defineProperty(overridden, "brain", { value: bridge.brain });
    Object.defineProperty(overridden, "sessions", { value: bridge.sessions });
  }

  return overridden;
}

async function sendLong(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text, TELEGRAM_MAX_LEN)) {
    await ctx.reply(chunk);
  }
}

// ---------------------------------------------------------------------------
// Core prompt handling
// ---------------------------------------------------------------------------
async function handlePrompt(ctx: Context, prompt: string): Promise<void> {
  const userId = ctx.from!.id;

  // Send typing indicator
  await ctx.sendChatAction("typing");

  const userBridge = getUserBridge(userId);
  let response: ClaudeResponse;

  try {
    if (livingMode && userBridge instanceof LivingBridge) {
      response = await userBridge.askAs("telegram", String(userId), prompt);
    } else {
      response = await userBridge.askAsync(prompt);
    }
  } catch (err) {
    console.error("Bridge call failed:", err);
    await ctx.reply(
      "Sorry, something went wrong while contacting Claude. Please try again later."
    );
    return;
  }

  if (response.isError) {
    await ctx.reply(`Error: ${response.text}`);
    return;
  }

  const text = response.text || "(empty response)";
  const footer = `\n\n[cost=$${response.costUsd.toFixed(4)} | turns=${response.numTurns}]`;

  await sendLong(ctx, text + footer);
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------
function main(): void {
  if (!BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Exiting.");
    process.exit(1);
  }

  const bot = new Telegraf(BOT_TOKEN);

  // /start
  bot.command("start", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;
    const mode = livingMode ? "living agent" : "stateless";
    await ctx.reply(
      `Hello! I'm a Claude Code bot (${mode} mode).\n\n` +
        "Send me a message or use /ask <prompt> to interact with Claude.\n" +
        "Type /help to see all commands."
    );
  });

  // /help
  bot.command("help", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    const lines = [
      "Available commands:\n",
      "/start  - Welcome message",
      "/ask <prompt>  - Ask Claude a question",
      "/project <path>  - Switch Claude's working directory",
      "/model <model>  - Switch Claude model",
    ];
    if (livingMode) {
      lines.push(
        "/reset  - Clear your session (start fresh)",
        "/brain  - Show current brain summary",
        "/notify  - Toggle proactive notifications"
      );
    }
    lines.push(
      "/help  - Show this help message",
      "",
      "You can also send a plain text message and it will be forwarded to Claude as a prompt."
    );
    await ctx.reply(lines.join("\n"));
  });

  // /ask <prompt>
  bot.command("ask", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    const prompt = ctx.message.text.replace(/^\/ask\s*/, "").trim();
    if (!prompt) {
      await ctx.reply("Usage: /ask <your prompt>");
      return;
    }

    await handlePrompt(ctx, prompt);
  });

  // /project <path>
  bot.command("project", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    const userId = ctx.from.id;
    const p = ctx.message.text.replace(/^\/project\s*/, "").trim();

    if (!p) {
      const userBridge = getUserBridge(userId);
      await ctx.reply(
        `Current project directory: ${userBridge.projectDir}\n\nUsage: /project <path>`
      );
      return;
    }

    const validated = validateProjectPath(p);
    if (validated === null) {
      await ctx.reply(`Path rejected: must be inside ${ALLOWED_PROJECT_BASE}`);
      return;
    }

    if (!fs.existsSync(validated) || !fs.statSync(validated).isDirectory()) {
      await ctx.reply(`Directory not found: ${validated}`);
      return;
    }

    const key = String(userId);
    const existing = userSettings.get(key) ?? {};
    existing.projectDir = validated;
    userSettings.set(key, existing);
    await ctx.reply(`Project directory set to: ${validated}`);
  });

  // /model <model>
  bot.command("model", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    const userId = ctx.from.id;
    const model = ctx.message.text.replace(/^\/model\s*/, "").trim();

    if (!model) {
      const userBridge = getUserBridge(userId);
      const current = userBridge.model ?? "(default)";
      await ctx.reply(`Current model: ${current}\n\nUsage: /model <model-name>`);
      return;
    }

    const key = String(userId);
    const existing = userSettings.get(key) ?? {};
    existing.model = model;
    userSettings.set(key, existing);
    await ctx.reply(`Model set to: ${model}`);
  });

  // /reset
  bot.command("reset", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    if (!livingMode || !(bridge instanceof LivingBridge)) {
      await ctx.reply("Reset is only available in living agent mode.");
      return;
    }

    bridge.sessions.clear("telegram", String(ctx.from.id));
    await ctx.reply("Session cleared. Your next message will start a fresh conversation.");
  });

  // /brain
  bot.command("brain", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    if (!livingMode || !(bridge instanceof LivingBridge)) {
      await ctx.reply("Brain is only available in living agent mode.");
      return;
    }

    const brainContent = bridge.brain.getContext();
    if (!brainContent.trim()) {
      await ctx.reply("Brain is empty.");
      return;
    }

    await sendLong(ctx, brainContent);
  });

  // /notify
  bot.command("notify", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;

    if (!livingMode) {
      await ctx.reply("Notifications are only available in living agent mode.");
      return;
    }

    const newState = toggleNotify(ctx.from.id);
    if (newState) {
      await ctx.reply("Proactive notifications enabled. I'll message you when I have updates.");
    } else {
      await ctx.reply("Proactive notifications disabled.");
    }
  });

  // Plain text messages
  bot.on("text", async (ctx) => {
    if (!isAllowed(ctx.from.id)) return;
    const prompt = ctx.message.text;
    if (!prompt) return;
    await handlePrompt(ctx, prompt);
  });

  // ---------------------------------------------------------------------------
  // Periodic notification check
  // ---------------------------------------------------------------------------
  if (livingMode && notificationQueue) {
    setInterval(async () => {
      try {
        if (!notificationQueue) return;

        const pending: Notification[] = notificationQueue.popAll("telegram");
        if (pending.length === 0) return;

        const prefs = loadNotifyPrefs(NOTIFY_PREFS_PATH);
        const optedIn = Object.entries(prefs)
          .filter(([, enabled]) => enabled)
          .map(([uid]) => uid);

        for (const note of pending) {
          const message = note.message;
          if (!message) continue;

          // Determine recipients: specific user or all opted-in (broadcast)
          let recipients: string[];
          if (note.user_id !== null) {
            recipients = prefs[note.user_id] ? [note.user_id] : [];
          } else {
            recipients = optedIn;
          }

          for (const recipient of recipients) {
            try {
              await bot.telegram.sendMessage(
                Number(recipient),
                `[Notification]\n${message}`
              );
              console.log(`Sent notification to user ${recipient}`);
            } catch (err) {
              console.error(`Failed to send notification to user ${recipient}:`, err);
            }
          }
        }
      } catch (err) {
        console.error("Notification poller error:", err);
      }
    }, NOTIFICATION_CHECK_INTERVAL);
    console.log(`Notification check scheduled every ${NOTIFICATION_CHECK_INTERVAL / 1000}s`);
  }

  // ---------------------------------------------------------------------------
  // Launch
  // ---------------------------------------------------------------------------
  console.log(
    `Telegram bot starting (${livingMode ? "living" : "stateless"} mode, allowed users: ${
      ALLOWED_USERS.size > 0 ? [...ALLOWED_USERS].join(", ") : "ALL"
    })`
  );

  bot.launch();

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main();
