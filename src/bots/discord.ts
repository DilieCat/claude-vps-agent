/**
 * Discord bot for Claude Code — relay messages to Claude via LivingBridge (or ClaudeBridge fallback).
 *
 * Supports persistent sessions, brain memory, proactive notifications, and slash commands.
 *
 * Usage:
 *    npx tsx src/bots/discord.ts      # reads config from .env / environment
 */

import "dotenv/config";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type TextChannel,
  type ThreadChannel,
  type DMChannel,
} from "discord.js";
import { ClaudeBridge, LivingBridge, NotificationQueue, splitMessage, loadNotifyPrefs, saveNotifyPrefs, logCost, getCosts, getTotalCost } from "../lib/index.js";
import type { Notification, StreamEvent } from "../lib/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DISCORD_BOT_TOKEN = process.env["DISCORD_BOT_TOKEN"] ?? "";
const DISCORD_ALLOWED_USERS = new Set(
  (process.env["DISCORD_ALLOWED_USERS"] ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
);
const CLAUDE_PROJECT_DIR = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
const CLAUDE_MODEL = process.env["CLAUDE_MODEL"];
const CLAUDE_ALLOWED_TOOLS = process.env["CLAUDE_ALLOWED_TOOLS"] ?? "";

const DISCORD_MAX_LEN = 2000;
const NOTIFICATION_POLL_INTERVAL = 60_000; // ms

// Code Mode config
const CODE_MODE_ENABLED = (process.env["CODE_MODE_ENABLED"] ?? "false").toLowerCase() === "true";
const CODE_MODE_DEFAULT_PROJECT = process.env["CODE_MODE_DEFAULT_PROJECT"] ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
const CODE_MODE_MAX_BUDGET_USD = parseFloat(process.env["CODE_MODE_MAX_BUDGET_USD"] ?? "5.00");
const CODE_MODE_TOOLS = (process.env["CODE_MODE_TOOLS"] ?? "Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch")
  .split(",").map((t) => t.trim()).filter(Boolean);
const CODE_MODE_MCP_CONFIG = process.env["CODE_MODE_MCP_CONFIG"];

const ALLOWED_PROJECT_BASE: string = fs.realpathSync(
  process.env["ALLOWED_PROJECT_BASE"] ?? (process.env["HOME"] ?? "."),
);

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "..");

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",  // images
  ".pdf", ".txt", ".md", ".ts", ".js", ".py", // documents
]);

// Per-user settings
interface UserSettings {
  projectDir?: string;
  model?: string;
}
const userSettings = new Map<string, UserSettings>();

// Concurrency control — single-user environment, one request at a time
let isProcessing = false;

// ---------------------------------------------------------------------------
// Code session tracking (Claude Code IDE through Discord threads)
// ---------------------------------------------------------------------------
interface CodeSession {
  sessionId: string | null;   // Claude session ID (null = first message)
  projectDir: string;         // working directory
  userId: string;             // session owner
  createdAt: number;
  isProcessing: boolean;      // per-session concurrency lock
}
const codeSessions = new Map<string, CodeSession>();
const CODE_SESSIONS_PATH = path.join(PROJECT_ROOT, "data", "discord_code_sessions.json");

function loadCodeSessions(): void {
  try {
    if (!fs.existsSync(CODE_SESSIONS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(CODE_SESSIONS_PATH, "utf-8")) as Array<{
      threadId: string;
      sessionId: string | null;
      projectDir: string;
      userId: string;
      createdAt: number;
    }>;
    for (const entry of data) {
      codeSessions.set(entry.threadId, {
        sessionId: entry.sessionId,
        projectDir: entry.projectDir,
        userId: entry.userId,
        createdAt: entry.createdAt,
        isProcessing: false,
      });
    }
    console.log(`[discord] Loaded ${codeSessions.size} code sessions from disk.`);
  } catch (err) {
    console.warn(`[discord] Could not load code sessions: ${err}`);
  }
}

function saveCodeSessions(): void {
  try {
    fs.mkdirSync(path.dirname(CODE_SESSIONS_PATH), { recursive: true });
    const data = [...codeSessions.entries()].map(([threadId, s]) => ({
      threadId,
      sessionId: s.sessionId,
      projectDir: s.projectDir,
      userId: s.userId,
      createdAt: s.createdAt,
    }));
    fs.writeFileSync(CODE_SESSIONS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[discord] Could not save code sessions: ${err}`);
  }
}

// Load persisted sessions at startup
loadCodeSessions();

// ---------------------------------------------------------------------------
// Bridge instance — try LivingBridge, fall back to ClaudeBridge
// ---------------------------------------------------------------------------
const _parsedTools = CLAUDE_ALLOWED_TOOLS.split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const allowedTools = _parsedTools.length > 0 ? _parsedTools : undefined;

let bridge: ClaudeBridge | LivingBridge;
let livingMode = false;

try {
  bridge = new LivingBridge({
    projectDir: CLAUDE_PROJECT_DIR,
    model: CLAUDE_MODEL,
    allowedTools,
  });
  livingMode = true;
  console.log("[discord] LivingBridge initialized — living agent mode active.");
} catch (exc) {
  console.warn(`[discord] LivingBridge init failed (${exc}), falling back to ClaudeBridge.`);
  bridge = new ClaudeBridge({
    projectDir: CLAUDE_PROJECT_DIR,
    model: CLAUDE_MODEL,
    allowedTools,
  });
}

// ---------------------------------------------------------------------------
// Notification queue (optional — only in living mode)
// ---------------------------------------------------------------------------
let notificationQueue: NotificationQueue | null = null;
if (livingMode) {
  try {
    notificationQueue = new NotificationQueue();
    console.log("[discord] NotificationQueue loaded.");
  } catch (exc) {
    console.warn(`[discord] NotificationQueue init failed (${exc}), notifications disabled.`);
  }
}

// ---------------------------------------------------------------------------
// Notification prefs (persisted to disk)
// ---------------------------------------------------------------------------
const NOTIFY_PREFS_PATH = path.join(PROJECT_ROOT, "data", "discord_notify_prefs.json");

// ---------------------------------------------------------------------------
// Respond prefs (persisted to disk)
// ---------------------------------------------------------------------------
const RESPOND_PREFS_PATH = path.join(PROJECT_ROOT, "data", "discord_respond_prefs.json");

function loadRespondPrefs(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(RESPOND_PREFS_PATH, "utf-8")); }
  catch { return {}; }
}
function saveRespondPrefs(prefs: Record<string, string>): void {
  fs.mkdirSync(path.dirname(RESPOND_PREFS_PATH), { recursive: true });
  fs.writeFileSync(RESPOND_PREFS_PATH, JSON.stringify(prefs, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllowed(userId: string, userTag: string): boolean {
  if (DISCORD_ALLOWED_USERS.size === 0) return true;
  return DISCORD_ALLOWED_USERS.has(userId) || DISCORD_ALLOWED_USERS.has(userTag);
}

function validateProjectPath(rawPath: string): string | null {
  const resolved = path.resolve(rawPath.replace(/^~/, process.env["HOME"] ?? "."));
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const real = fs.realpathSync(resolved);
  if (real !== ALLOWED_PROJECT_BASE && !real.startsWith(ALLOWED_PROJECT_BASE + path.sep)) {
    return null;
  }
  return real;
}

function getUserBridge(userId: string): ClaudeBridge | LivingBridge {
  const settings = userSettings.get(userId);
  if (!settings) return bridge;

  // Create a bridge with user-specific overrides
  const BridgeClass = livingMode ? LivingBridge : ClaudeBridge;
  const overridden = new BridgeClass({
    projectDir: settings.projectDir ?? bridge.projectDir,
    model: settings.model ?? bridge.model,
    allowedTools: bridge.allowedTools,
  });

  // For LivingBridge, share the same brain and sessions
  if (livingMode && overridden instanceof LivingBridge && bridge instanceof LivingBridge) {
    Object.defineProperty(overridden, "brain", { value: bridge.brain });
    Object.defineProperty(overridden, "sessions", { value: bridge.sessions });
  }

  return overridden;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", (err) => { file.close(); reject(err); });
    }).on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Claude Code a question")
    .addStringOption((opt) => opt.setName("prompt").setDescription("Your question or instruction for Claude").setRequired(true)),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear your conversation session (start fresh)"),
  new SlashCommandBuilder()
    .setName("brain")
    .setDescription("Show the agent's current brain/memory summary"),
  new SlashCommandBuilder()
    .setName("notify")
    .setDescription("Toggle proactive notifications on/off"),
  new SlashCommandBuilder()
    .setName("project")
    .setDescription("View or change the active project directory")
    .addStringOption((opt) => opt.setName("path").setDescription("New project directory path (leave empty to view current)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("View or change the Claude model")
    .addStringOption((opt) => opt.setName("name").setDescription("Model name (leave empty to view current)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("respond")
    .setDescription("Set how the bot responds to your messages")
    .addStringOption((opt) =>
      opt.setName("mode")
        .setDescription("Response mode")
        .setRequired(true)
        .addChoices(
          { name: "all — respond to all my messages", value: "all" },
          { name: "mentions — only respond when @mentioned", value: "mentions" },
        )),
  new SlashCommandBuilder()
    .setName("costs")
    .setDescription("Show usage costs")
    .addStringOption((opt) =>
      opt.setName("period")
        .setDescription("Time period")
        .setRequired(false)
        .addChoices(
          { name: "today", value: "today" },
          { name: "week", value: "week" },
          { name: "month", value: "month" },
          { name: "all time", value: "all" },
        )),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show help for the Claude Discord bot"),
  new SlashCommandBuilder()
    .setName("claudecode")
    .setDescription("Start a Claude Code session in a new thread")
    .addStringOption((opt) =>
      opt.setName("project")
        .setDescription("Project directory (optional)")
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName("endcode")
    .setDescription("End the current Claude Code session"),
];

// ---------------------------------------------------------------------------
// Ask Claude helper
// ---------------------------------------------------------------------------

async function askClaude(prompt: string, interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const channel = interaction.channel;
  if (!channel || !("send" in channel)) return;

  if (isProcessing) {
    await interaction.followUp({ content: "Ik ben nog bezig met je vorige vraag, even geduld...", ephemeral: true });
    return;
  }
  isProcessing = true;

  try {
    // Create a thread for the conversation if we're in a text channel
    let target: TextChannel | ThreadChannel | DMChannel;
    if (channel.type === ChannelType.GuildText) {
      const threadName = prompt.length <= 100 ? prompt : prompt.slice(0, 97) + "...";
      target = await (channel as TextChannel).threads.create({
        name: threadName,
        autoArchiveDuration: 60,
      });
    } else {
      // Already in a thread, DM, or other sendable channel — reply in place
      target = channel as TextChannel | ThreadChannel | DMChannel;
    }

    // Show typing indicator (repeating every 8s since Discord typing expires after ~10s)
    await target.sendTyping();
    const typingInterval = setInterval(() => {
      target.sendTyping().catch(() => {});
    }, 8_000);

    const userBridge = getUserBridge(userId);
    let response;
    try {
      if (livingMode && userBridge instanceof LivingBridge) {
        response = await userBridge.askAs("discord", userId, prompt);
      } else {
        response = await userBridge.askAsync(prompt);
      }
    } catch {
      clearInterval(typingInterval);
      await target.send(
        "Sorry, something went wrong while contacting Claude. Please try again later.",
      );
      return;
    }

    clearInterval(typingInterval);

    if (response.isError) {
      await target.send(`**Error:** ${response.text}`);
      return;
    }

    // Send the response, splitting if necessary
    const chunks = splitMessage(response.text, DISCORD_MAX_LEN);
    for (const chunk of chunks) {
      await target.send(chunk);
    }

    // Footer with cost info
    if (response.costUsd > 0) {
      const footer = `-# Cost: $${response.costUsd.toFixed(4)} | Turns: ${response.numTurns}`;
      await target.send(footer);
    }

    // Log cost
    logCost(response.costUsd, response.numTurns, response.durationMs, prompt);
  } finally {
    isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// Notification poller
// ---------------------------------------------------------------------------

function startNotificationPoller(): ReturnType<typeof setInterval> | null {
  if (!notificationQueue) return null;

  return setInterval(async () => {
    try {
      const notifications: Notification[] = notificationQueue!.popAll("discord");
      if (notifications.length === 0) return;

      const prefs = loadNotifyPrefs(NOTIFY_PREFS_PATH);
      const optedIn = Object.entries(prefs)
        .filter(([, enabled]) => enabled)
        .map(([uid]) => uid);

      for (const note of notifications) {
        const recipientId = note.user_id;
        const message = note.message;
        if (!message) continue;

        // Determine recipients: specific user or all opted-in (broadcast)
        let recipients: string[];
        if (recipientId != null) {
          recipients = prefs[recipientId] ? [recipientId] : [];
        } else {
          recipients = optedIn;
        }

        for (const recipient of recipients) {
          try {
            const user = await client.users.fetch(recipient);
            if (user) {
              await user.send(`**Notification:**\n${message}`);
              console.log(`[discord] Sent notification to user ${recipient}`);
            }
          } catch (exc) {
            console.error(`[discord] Failed to deliver notification to ${recipient}: ${exc}`);
          }
        }
      }
    } catch (exc) {
      console.error(`[discord] Notification poller error: ${exc}`);
    }
  }, NOTIFICATION_POLL_INTERVAL);
}

// ---------------------------------------------------------------------------
// Interaction handler (slash commands)
// ---------------------------------------------------------------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  const userTag = interaction.user.tag;

  // Authorization check
  if (!isAllowed(userId, userTag)) {
    await interaction.reply({ content: "You are not authorized to use this bot.", ephemeral: true });
    return;
  }

  const { commandName } = interaction;

  if (commandName === "ask") {
    const prompt = interaction.options.getString("prompt", true);
    await interaction.reply(`**Prompt:** ${prompt}`);
    await askClaude(prompt, interaction);
  } else if (commandName === "reset") {
    if (!livingMode) {
      await interaction.reply({
        content: "Sessions are not available (running in stateless mode).",
        ephemeral: true,
      });
      return;
    }
    (bridge as LivingBridge).sessions.clear("discord", userId);
    await interaction.reply({
      content: "Session cleared. Your next message starts a fresh conversation.",
      ephemeral: true,
    });
  } else if (commandName === "brain") {
    if (!livingMode) {
      await interaction.reply({
        content: "Brain is not available (running in stateless mode).",
        ephemeral: true,
      });
      return;
    }
    let brainContent = (bridge as LivingBridge).brain.getContext();
    // Truncate if too long for Discord
    // Wrapper: "```markdown\n" (12) + "\n```" (4) = 16 chars
    const wrapperOverhead = "```markdown\n".length + "\n```".length;
    const truncationSuffix = "\n\n*[truncated]*";
    const maxContent = DISCORD_MAX_LEN - wrapperOverhead;
    if (brainContent.length > maxContent) {
      brainContent = brainContent.slice(0, maxContent - truncationSuffix.length) + truncationSuffix;
    }
    await interaction.reply(`\`\`\`markdown\n${brainContent}\n\`\`\``);
  } else if (commandName === "notify") {
    if (!notificationQueue) {
      await interaction.reply({ content: "Notifications are not available.", ephemeral: true });
      return;
    }
    const prefs = loadNotifyPrefs(NOTIFY_PREFS_PATH);
    const newState = !prefs[userId];
    prefs[userId] = newState;
    saveNotifyPrefs(NOTIFY_PREFS_PATH, prefs);

    if (newState) {
      await interaction.reply({
        content:
          "Proactive notifications **enabled**. The agent will DM you when it has updates. Use `/notify` again to disable.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "Proactive notifications **disabled**. Use `/notify` again to re-enable.",
        ephemeral: true,
      });
    }
  } else if (commandName === "project") {
    const rawPath = interaction.options.getString("path");
    if (rawPath) {
      let validated: string | null;
      try {
        validated = validateProjectPath(rawPath);
      } catch {
        validated = null;
      }
      if (validated == null) {
        await interaction.reply({
          content: `Path rejected: must be inside \`${ALLOWED_PROJECT_BASE}\``,
          ephemeral: true,
        });
        return;
      }
      if (!fs.existsSync(validated) || !fs.statSync(validated).isDirectory()) {
        await interaction.reply({
          content: `Directory not found: \`${validated}\``,
          ephemeral: true,
        });
        return;
      }
      const existing = userSettings.get(userId) ?? {};
      existing.projectDir = validated;
      userSettings.set(userId, existing);
      await interaction.reply(`Project directory set to: \`${validated}\``);
    } else {
      const userBridge = getUserBridge(userId);
      await interaction.reply(`Current project directory: \`${userBridge.projectDir}\``);
    }
  } else if (commandName === "model") {
    const name = interaction.options.getString("name");
    if (name) {
      const existing = userSettings.get(userId) ?? {};
      existing.model = name;
      userSettings.set(userId, existing);
      await interaction.reply(`Model set to: \`${name}\``);
    } else {
      const userBridge = getUserBridge(userId);
      const current = userBridge.model ?? "(default)";
      await interaction.reply(`Current model: \`${current}\``);
    }
  } else if (commandName === "respond") {
    const mode = interaction.options.getString("mode", true);
    const prefs = loadRespondPrefs();
    prefs[userId] = mode;
    saveRespondPrefs(prefs);
    if (mode === "all") {
      await interaction.reply({ content: "I'll now respond to **all** your messages in channels I can see. Use `/respond mentions` to switch back.", ephemeral: true });
    } else {
      await interaction.reply({ content: "I'll only respond when you **@mention** me. Use `/respond all` to change.", ephemeral: true });
    }
  } else if (commandName === "costs") {
    const period = (interaction.options.getString("period") ?? "all") as "today" | "week" | "month" | "all";
    const entries = getCosts(period);
    const total = getTotalCost(period);
    const avgDuration = entries.length > 0
      ? Math.round(entries.reduce((s, e) => s + e.durationMs, 0) / entries.length)
      : 0;

    const periodLabel = period === "all" ? "all time" : period;
    let text = `**Cost Summary (${periodLabel})**\n\n`;
    text += `Requests: ${entries.length}\n`;
    text += `Total cost: $${total.toFixed(4)}\n`;
    text += `Avg response time: ${(avgDuration / 1000).toFixed(1)}s\n`;

    if (entries.length > 0) {
      text += `\n**Recent requests:**\n`;
      const recent = entries.slice(-5).reverse();
      for (const e of recent) {
        const date = new Date(e.timestamp).toLocaleString();
        text += `- ${date}: $${e.costUsd.toFixed(4)} — ${e.promptPreview.slice(0, 50)}${e.promptPreview.length > 50 ? "..." : ""}\n`;
      }
    }

    await interaction.reply({ content: text, ephemeral: true });
  } else if (commandName === "help") {
    const modeLabel = livingMode ? "living agent" : "stateless";
    let helpText =
      `**Claude Code Discord Bot** (mode: ${modeLabel})\n\n` +
      "**Commands:**\n" +
      "`/ask <prompt>` — Ask Claude Code a question or give it an instruction\n" +
      "`/reset` — Clear your session and start a fresh conversation\n" +
      "`/brain` — Show the agent's current brain/memory summary\n" +
      "`/notify` — Toggle proactive notifications on/off\n" +
      "`/project [path]` — View or change the active project directory\n" +
      "`/model [name]` — View or change the Claude model\n" +
      "`/costs [period]` — Show usage costs (today/week/month/all)\n" +
      "`/respond <mode>` — Set response mode: `all` (respond to all messages) or `mentions` (only when @mentioned)\n" +
      "`/help` — Show this help message\n\n" +
      "**Notes:**\n" +
      "- Each `/ask` creates a new thread for the conversation.\n" +
      "- Long responses are automatically split across multiple messages.\n" +
      "- The bot shows a typing indicator while Claude is processing.\n";
    if (livingMode) {
      helpText +=
        "- Sessions persist across messages — Claude remembers context.\n" +
        "- Use `/reset` to start a fresh conversation.\n";
    }
    await interaction.reply(helpText);
  }
});

// ---------------------------------------------------------------------------
// Message handler — respond to regular chat messages
// ---------------------------------------------------------------------------

client.on("messageCreate", async (message) => {
  // Ignore own messages
  if (message.author.bot) return;

  // Determine if we should respond:
  // 1. DMs — always respond
  // 2. Mentions — when the bot is @mentioned
  // 3. Thread replies — when replying in a thread the bot created
  const isDM = message.channel.type === ChannelType.DM;
  const isMentioned = message.mentions.has(client.user!);
  const isInBotThread =
    message.channel.isThread() &&
    message.channel.ownerId === client.user?.id;

  const respondPrefs = loadRespondPrefs();
  const userRespondMode = respondPrefs[message.author.id] ?? "mentions";
  const shouldRespond = isDM || isInBotThread || isMentioned || userRespondMode === "all";
  if (!shouldRespond) return;

  // Authorization check
  const userId = message.author.id;
  const userTag = message.author.tag;
  if (!isAllowed(userId, userTag)) {
    await message.reply("You are not authorized to use this bot.");
    return;
  }

  // Strip the bot mention from the message text
  let prompt = message.content;
  if (client.user) {
    prompt = prompt.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  }

  // Handle file attachments
  const tmpFiles: string[] = [];
  if (message.attachments.size > 0) {
    for (const attachment of message.attachments.values()) {
      const ext = path.extname(attachment.name ?? "").toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        await message.reply(
          `Unsupported file type: ${ext}\nSupported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
        );
        continue;
      }

      const tmpPath = path.join(os.tmpdir(), `dc-att-${Date.now()}-${attachment.name ?? "file"}`);
      try {
        await downloadFile(attachment.url, tmpPath);
        tmpFiles.push(tmpPath);

        const textExts = new Set([".txt", ".md", ".ts", ".js", ".py"]);
        if (textExts.has(ext)) {
          const content = fs.readFileSync(tmpPath, "utf-8");
          prompt = `[Attached file: ${attachment.name}]\n\`\`\`\n${content}\n\`\`\`\n\n${prompt}`;
        } else {
          prompt = `[Attached file: ${attachment.name}]\nFile saved at: ${tmpPath}\n\n${prompt}`;
        }
      } catch (err) {
        console.error(`[discord] Failed to download attachment ${attachment.name}:`, err);
        await message.reply(`Failed to download attachment: ${attachment.name}`);
      }
    }
  }

  if (!prompt) {
    await message.reply("Send me a message and I'll ask Claude for you.");
    return;
  }

  if (isProcessing) {
    await message.reply("Ik ben nog bezig met je vorige vraag, even geduld...");
    return;
  }
  isProcessing = true;

  try {
    // Show typing indicator (repeating every 8s since Discord typing expires after ~10s)
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8_000);

    const userBridge = getUserBridge(userId);
    let response;
    try {
      if (livingMode && userBridge instanceof LivingBridge) {
        response = await userBridge.askAs("discord", userId, prompt);
      } else {
        response = await userBridge.askAsync(prompt);
      }
    } catch (err) {
      clearInterval(typingInterval);
      console.error(`[discord] Error processing message from ${userId}:`, err);
      await message.reply("Sorry, something went wrong while contacting Claude. Please try again later.");
      return;
    }

    clearInterval(typingInterval);

    if (response.isError) {
      await message.reply(`**Error:** ${response.text}`);
      return;
    }

    // Send the response, splitting if necessary
    const chunks = splitMessage(response.text, DISCORD_MAX_LEN);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }

    // Footer with cost info
    if (response.costUsd > 0) {
      await message.channel.send(`-# Cost: $${response.costUsd.toFixed(4)} | Turns: ${response.numTurns}`);
    }

    // Log cost
    logCost(response.costUsd, response.numTurns, response.durationMs, prompt);
  } finally {
    isProcessing = false;
    // Cleanup temp files from attachments
    for (const tmp of tmpFiles) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
});

// ---------------------------------------------------------------------------
// Ready event
// ---------------------------------------------------------------------------

client.once("ready", async () => {
  const modeLabel = livingMode ? "LIVING" : "STATELESS";
  console.log(`[discord] Logged in as ${client.user?.tag} (ID: ${client.user?.id}) [${modeLabel} mode]`);
  console.log(`[discord] Project dir: ${bridge.projectDir}`);
  console.log(`[discord] Model: ${bridge.model ?? "(default)"}`);
  if (DISCORD_ALLOWED_USERS.size > 0) {
    console.log(`[discord] Allowed users: ${[...DISCORD_ALLOWED_USERS].join(", ")}`);
  } else {
    console.log("[discord] No user allowlist — all users permitted.");
  }
  if (notificationQueue) {
    console.log(`[discord] Notifications: enabled (polling every ${NOTIFICATION_POLL_INTERVAL / 1000}s)`);
  } else {
    console.log("[discord] Notifications: disabled");
  }

  // Register slash commands
  if (client.user) {
    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
    try {
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log("[discord] Slash commands registered.");
    } catch (err) {
      console.error("[discord] Failed to register slash commands:", err);
    }
  }

  // Start notification poller
  const notifInterval = startNotificationPoller();
  if (notificationQueue) {
    console.log(`[discord] Notification poller started (every ${NOTIFICATION_POLL_INTERVAL / 1000}s).`);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("[discord] Shutting down...");
    if (notifInterval) clearInterval(notifInterval);
    client.destroy();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main(): void {
  if (!DISCORD_BOT_TOKEN) {
    console.error("Error: DISCORD_BOT_TOKEN is not set.");
    console.error("Set it in your .env file or environment variables.");
    process.exit(1);
  }
  client.login(DISCORD_BOT_TOKEN);
}

main();
