#!/usr/bin/env npx tsx
/**
 * claude-code all-in-one setup wizard.
 *
 * Run with:  npx tsx setup.ts
 *
 * This is the ONLY command you need after cloning the repository.
 * Zero external dependencies -- uses only Node.js built-in modules.
 */

import * as readline from "readline";
import { execSync, execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.dirname(new URL(import.meta.url).pathname);
const ENV_FILE = path.join(PROJECT_ROOT, ".env");

const MODULES: Array<[string, string]> = [
  ["telegram", "Telegram Bot"],
  ["discord", "Discord Bot"],
  ["scheduler", "Task Scheduler"],
];

const SYSTEMD_SERVICE_MAP: Record<string, [string, string]> = {
  telegram: [
    path.join(PROJECT_ROOT, "infra", "systemd", "telegram-bot.service"),
    "telegram-bot",
  ],
  discord: [
    path.join(PROJECT_ROOT, "infra", "systemd", "discord-bot.service"),
    "discord-bot",
  ],
  scheduler: [
    path.join(PROJECT_ROOT, "infra", "systemd", "scheduler.service"),
    "scheduler",
  ],
};

const BANNER = `
      _                 _
  ___| | __ _ _   _  __| | ___        ___ ___   __| | ___
 / __| |/ _\` | | | |/ _\` |/ _ \\___  / __/ _ \\ / _\` |/ _ \\
| (__| | (_| | |_| | (_| |  __/___| | (_| (_) | (_| |  __/
 \\___|_|\\__,_|\\__,_|\\__,_|\\___|      \\___\\___/ \\__,_|\\___|
`;

// ---------------------------------------------------------------------------
// Plain-text UI helpers (no dependencies)
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

function printBanner(): void {
  console.log(BANNER);
  console.log("  All-in-One Setup Wizard");
  console.log("  " + "=".repeat(40));
  console.log();
}

function heading(title: string): void {
  const width = 60;
  console.log();
  console.log("-".repeat(width));
  console.log(`  ${title}`);
  console.log("-".repeat(width));
  console.log();
}

function ok(msg: string): void {
  console.log(`  [ok] ${msg}`);
}

function warn(msg: string): void {
  console.log(`  [!!] ${msg}`);
}

function fail(msg: string): void {
  console.log(`  [FAIL] ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${msg}`);
}

async function askYesNo(prompt: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  while (true) {
    const answer = (await question(prompt + suffix)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("  Please answer y or n.");
  }
}

async function askInput(
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  if (defaultValue) {
    const raw = (await question(`  ${prompt} [${defaultValue}]: `)).trim();
    return raw || defaultValue;
  }
  while (true) {
    const raw = (await question(`  ${prompt}: `)).trim();
    if (raw) return raw;
    console.log("  A value is required.");
  }
}

async function askCommaList(prompt: string, example: string): Promise<string> {
  const raw = (await question(`  ${prompt} (e.g. ${example}): `)).trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
}

// ---------------------------------------------------------------------------
// System helpers
// ---------------------------------------------------------------------------

function runCmd(
  args: string[],
  timeoutMs = 30000,
): { code: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync(args[0], args.slice(1), {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      code: result.status ?? 1,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  } catch {
    return { code: 1, stdout: "", stderr: `Command failed: ${args[0]}` };
  }
}

function cmdExists(name: string): boolean {
  try {
    const cmd = os.platform() === "win32" ? "where" : "which";
    execSync(`${cmd} ${name}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getVersion(name: string, args: string[] = ["--version"]): string | null {
  if (!cmdExists(name)) return null;
  const result = runCmd([name, ...args], 15000);
  if (result.code === 0) return result.stdout || result.stderr;
  return null;
}

function parseVersionTuple(
  versionStr: string,
): [number, number] | null {
  const match = versionStr.match(/(\d+)\.(\d+)/);
  if (match) return [parseInt(match[1], 10), parseInt(match[2], 10)];
  return null;
}

function isHeadless(): boolean {
  if (os.platform() === "darwin") return false;
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

function isLinux(): boolean {
  return os.platform() === "linux";
}

function hasSystemctl(): boolean {
  return isLinux() && cmdExists("systemctl");
}

function loadExistingEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  const content = fs.readFileSync(ENV_FILE, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Step 1 - Welcome
// ---------------------------------------------------------------------------

async function stepWelcome(): Promise<void> {
  clearScreen();
  printBanner();
  info("This wizard sets up everything you need to run claude-code.");
  info("It checks prerequisites, collects configuration, installs");
  info("dependencies, and gets you ready to go.");
  console.log();

  if (fs.existsSync(ENV_FILE)) {
    warn("An existing .env file was detected.");
    console.log();
    const choice = await askYesNo("  Update existing configuration?", true);
    if (!choice) {
      console.log();
      info("No changes made. Re-run the wizard when you are ready.");
      process.exit(0);
    }
    console.log();
    info(
      "Existing values will be shown as defaults. Press Enter to keep them.",
    );
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Step 2 - Prerequisites
// ---------------------------------------------------------------------------

async function stepPrerequisites(): Promise<boolean> {
  heading("Step 1: Checking Prerequisites");
  let allOk = true;

  // -- Node.js version --
  const nodeVer = getVersion("node");
  if (nodeVer) {
    const parsed = parseVersionTuple(nodeVer);
    if (parsed && parsed[0] >= 18) {
      ok(`Node.js ${nodeVer}`);
    } else {
      fail(`Node.js ${nodeVer} -- version 18 or higher is required`);
      info("Download from: https://nodejs.org/");
      allOk = false;
    }
  } else {
    fail("Node.js not found -- version 18 or higher is required");
    info("Download from: https://nodejs.org/");
    allOk = false;
  }

  // -- npm --
  const npmVer = getVersion("npm");
  if (npmVer) {
    ok(`npm ${npmVer}`);
  } else {
    fail("npm not found (usually installed with Node.js)");
    allOk = false;
  }

  // -- Claude CLI --
  const claudeVer = getVersion("claude");
  if (claudeVer) {
    ok(`Claude CLI (${claudeVer})`);
  } else {
    warn("Claude CLI not found");
    console.log();
    if (cmdExists("npm")) {
      if (
        await askYesNo(
          "  Install Claude CLI now? (npm install -g @anthropic-ai/claude-code)",
        )
      ) {
        info("Installing Claude CLI...");
        const result = runCmd(
          ["npm", "install", "-g", "@anthropic-ai/claude-code"],
          120000,
        );
        if (result.code === 0) {
          ok("Claude CLI installed successfully");
        } else {
          fail("Claude CLI installation failed");
          if (result.stderr) {
            info(`Error: ${result.stderr.slice(0, 200)}`);
          }
          info(
            "Try installing manually: npm install -g @anthropic-ai/claude-code",
          );
          allOk = false;
        }
      } else {
        warn("Claude CLI is required. Install later with:");
        info("  npm install -g @anthropic-ai/claude-code");
        allOk = false;
      }
    } else {
      info(
        "Install Node.js first, then run: npm install -g @anthropic-ai/claude-code",
      );
      allOk = false;
    }
  }

  if (!allOk) {
    console.log();
    warn("Some prerequisites are missing.");
    if (!(await askYesNo("  Continue anyway?", true))) {
      process.exit(1);
    }
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// Step 3 - Claude authentication
// ---------------------------------------------------------------------------

async function stepClaudeAuth(): Promise<void> {
  heading("Step 2: Claude Authentication");

  if (!cmdExists("claude")) {
    warn("Claude CLI not found -- skipping authentication check.");
    info("Install it later and run: claude login");
    return;
  }

  // Quick check: try running a simple prompt
  info("Checking if Claude CLI is authenticated...");
  const result = runCmd(
    ["claude", "-p", "say ok", "--output-format", "json"],
    30000,
  );

  if (result.code === 0) {
    ok("Claude CLI is authenticated and working");
    return;
  }

  // Not authenticated
  warn("Claude CLI is not authenticated.");
  console.log();

  if (isHeadless()) {
    info("This appears to be a headless server (no display detected).");
    console.log();
    info("To authenticate, you need to set up SSH port forwarding from");
    info("your local machine so the OAuth flow can complete in your browser.");
    console.log();
    info("From your local machine, run:");
    info("  ssh -L 9315:localhost:9315 user@this-server");
    console.log();
    info("Then, in another terminal on this server, run:");
    info("  claude login");
    console.log();
    info(
      "The OAuth URL will open in your local browser via the SSH tunnel.",
    );
    console.log();
    if (
      await askYesNo(
        "  Have you completed authentication in another terminal?",
        false,
      )
    ) {
      // Verify
      const verify = runCmd(
        ["claude", "-p", "say ok", "--output-format", "json"],
        30000,
      );
      if (verify.code === 0) {
        ok("Claude CLI authentication verified");
      } else {
        warn(
          "Authentication could not be verified. You can try again later.",
        );
      }
    } else {
      info("You can authenticate later. The setup will continue.");
    }
  } else {
    info("Running 'claude login' to authenticate...");
    console.log();
    try {
      const loginResult = spawnSync("claude", ["login"], {
        stdio: "inherit",
        timeout: 120000,
      });
      if (loginResult.error) {
        warn(`Login failed: ${loginResult.error.message}`);
        info("You can run 'claude login' manually later.");
        return;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`Login failed: ${msg}`);
      info("You can run 'claude login' manually later.");
      return;
    }

    // Verify
    const verify = runCmd(
      ["claude", "-p", "say ok", "--output-format", "json"],
      30000,
    );
    if (verify.code === 0) {
      ok("Claude CLI authentication verified");
    } else {
      warn(
        "Authentication could not be verified. You can run 'claude login' later.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4 - Module selection
// ---------------------------------------------------------------------------

async function stepModules(): Promise<string[]> {
  heading("Step 3: Module Selection");
  info("Choose which modules to enable:");
  console.log();

  const selected: string[] = [];
  for (const [key, label] of MODULES) {
    if (await askYesNo(`  Enable ${label}?`, true)) {
      selected.push(key);
    }
  }

  if (selected.length === 0) {
    console.log();
    warn("You must enable at least one module.");
    return stepModules();
  }

  console.log();
  const moduleMap = new Map(MODULES);
  for (const key of selected) {
    ok(`${moduleMap.get(key)} enabled`);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Step 5 - Per-module config
// ---------------------------------------------------------------------------

async function stepModuleConfig(
  selected: string[],
  existingEnv: Record<string, string>,
): Promise<Record<string, string>> {
  const envVars: Record<string, string> = {};

  if (selected.includes("telegram")) {
    heading("Step 4a: Telegram Bot Configuration");
    info("You need a bot token from @BotFather on Telegram.");
    info("  https://t.me/BotFather");
    console.log();
    const token = await askInput(
      "Bot token",
      existingEnv.TELEGRAM_BOT_TOKEN,
    );
    const users = await askCommaList(
      "Allowed Telegram user IDs",
      existingEnv.TELEGRAM_ALLOWED_USERS || "123456789,987654321",
    );
    envVars.TELEGRAM_BOT_TOKEN = token;
    if (users) envVars.TELEGRAM_ALLOWED_USERS = users;
  }

  if (selected.includes("discord")) {
    heading("Step 4b: Discord Bot Configuration");
    info("You need a bot token from the Discord Developer Portal.");
    info("  https://discord.com/developers/applications");
    console.log();
    const token = await askInput(
      "Bot token",
      existingEnv.DISCORD_BOT_TOKEN,
    );
    const users = await askCommaList(
      "Allowed Discord user IDs",
      existingEnv.DISCORD_ALLOWED_USERS ||
        "123456789012345678,987654321098765432",
    );
    envVars.DISCORD_BOT_TOKEN = token;
    if (users) envVars.DISCORD_ALLOWED_USERS = users;
  }

  if (selected.includes("scheduler")) {
    heading("Step 4c: Task Scheduler Configuration");
    info("The scheduler uses scheduler/tasks.yaml for task definitions.");
    info("You can customize it later.");
    console.log();
    ok("Default tasks.yaml will be used.");
  }

  return envVars;
}

// ---------------------------------------------------------------------------
// Step 5 - Agent Identity
// ---------------------------------------------------------------------------

async function stepAgentIdentity(): Promise<void> {
  heading("Step 5: Agent Identity");
  info("Choose a name for your agent.");
  info("This is how the agent will introduce itself in chat.");
  console.log();

  const agentName = await askInput("Agent name", "Atlas");

  // Generate data/system-prompt.md from template
  const templatePath = path.join(PROJECT_ROOT, "data", "system-prompt.template.md");
  const outPath = path.join(PROJECT_ROOT, "data", "system-prompt.md");
  if (fs.existsSync(templatePath)) {
    let shouldWrite = true;
    if (fs.existsSync(outPath)) {
      console.log();
      warn("Existing system-prompt.md detected.");
      shouldWrite = await askYesNo("  Overwrite with new agent name?", false);
    }
    if (shouldWrite) {
      const template = fs.readFileSync(templatePath, "utf-8");
      const content = template.replace(/\{AGENT_NAME\}/g, agentName);
      fs.writeFileSync(outPath, content, "utf-8");
      ok(`System prompt written with agent name: ${agentName}`);
    } else {
      info("Keeping existing system-prompt.md.");
    }
  } else {
    warn("Template data/system-prompt.template.md not found — skipping.");
  }

  // Update data/brain.md from template with agent name
  const brainTemplatePath = path.join(PROJECT_ROOT, "data", "brain.template.md");
  const brainPath = path.join(PROJECT_ROOT, "data", "brain.md");
  if (fs.existsSync(brainTemplatePath) && !fs.existsSync(brainPath)) {
    const brainTemplate = fs.readFileSync(brainTemplatePath, "utf-8");
    const brainContent = brainTemplate.replace(/\{AGENT_NAME\}/g, agentName);
    fs.writeFileSync(brainPath, brainContent, "utf-8");
    ok(`Brain initialized for ${agentName}`);
  } else if (fs.existsSync(brainPath)) {
    info("Existing brain.md found — not overwriting.");
  }
}

// ---------------------------------------------------------------------------
// Step 6 - Claude permissions & settings
// ---------------------------------------------------------------------------

async function stepClaudeSettings(
  existingEnv: Record<string, string>,
): Promise<Record<string, string>> {
  heading("Step 6: Claude Permissions");
  info("Claude Code needs permission to use tools (read files, edit code, run");
  info("commands, etc). Without this, the bot can only answer questions but");
  info("cannot actually work on your code.");
  console.log();
  info("Choose a permission level:");
  console.log();
  info("  1) Read-only        — Can read files and search code");
  info("                        Tools: Read, Glob, Grep");
  console.log();
  info("  2) Read + Write     — Can read, edit files, and run commands (recommended)");
  info("                        Tools: Read, Write, Edit, Bash, Glob, Grep");
  console.log();
  info("  3) Full access      — All tools including web search and fetch");
  info("                        Tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch");
  console.log();
  info("  4) Custom           — Specify tools manually");
  console.log();

  const PRESETS: Record<string, string> = {
    "1": "Read,Glob,Grep",
    "2": "Read,Write,Edit,Bash,Glob,Grep",
    "3": "Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch",
  };

  const existingTools = existingEnv.CLAUDE_ALLOWED_TOOLS;
  let defaultChoice = "2";
  if (existingTools) {
    // Detect which preset matches
    const match = Object.entries(PRESETS).find(([, v]) => v === existingTools);
    defaultChoice = match ? match[0] : "4";
  }

  const choice = await askInput(
    `Permission level [1-4]`,
    defaultChoice,
  );

  const envVars: Record<string, string> = {};

  if (choice === "4") {
    info("Available tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch");
    const custom = await askInput(
      "Tools (comma-separated)",
      existingTools ?? "Read,Write,Edit,Bash,Glob,Grep",
    );
    envVars.CLAUDE_ALLOWED_TOOLS = custom;
  } else {
    const tools = PRESETS[choice] ?? PRESETS["2"];
    envVars.CLAUDE_ALLOWED_TOOLS = tools;
  }

  ok(`Tools: ${envVars.CLAUDE_ALLOWED_TOOLS}`);
  console.log();

  // Optional: model override
  const model = await askInput(
    "Claude model (leave empty for default)",
    existingEnv.CLAUDE_MODEL ?? "",
  );
  if (model) envVars.CLAUDE_MODEL = model;

  // Optional: project directory
  const projectDir = await askInput(
    "Default project directory (leave empty for current dir)",
    existingEnv.CLAUDE_PROJECT_DIR ?? "",
  );
  if (projectDir) envVars.CLAUDE_PROJECT_DIR = projectDir;

  return envVars;
}

// ---------------------------------------------------------------------------
// Step 7 - Generate .env
// ---------------------------------------------------------------------------

const ENV_SECTION_ORDER: Array<[string, string[]]> = [
  ["Claude Settings", ["CLAUDE_ALLOWED_TOOLS", "CLAUDE_MODEL", "CLAUDE_PROJECT_DIR"]],
  ["Telegram Bot", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]],
  ["Discord Bot", ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USERS"]],
];

async function stepGenerateEnv(
  envVars: Record<string, string>,
): Promise<void> {
  heading("Step 7: Generate .env");

  const lines: string[] = [];
  for (const [sectionName, keys] of ENV_SECTION_ORDER) {
    const sectionLines: string[] = [];
    for (const k of keys) {
      if (k in envVars) {
        sectionLines.push(`${k}="${envVars[k]}"`);
      }
    }
    if (sectionLines.length > 0) {
      lines.push(`# ${sectionName}`);
      lines.push(...sectionLines);
      lines.push("");
    }
  }

  // Add any remaining keys not in the section order
  const orderedKeys = new Set<string>();
  for (const [, keys] of ENV_SECTION_ORDER) {
    for (const k of keys) orderedKeys.add(k);
  }
  const extra = Object.entries(envVars).filter(
    ([k]) => !orderedKeys.has(k),
  );
  if (extra.length > 0) {
    lines.push("# Additional settings");
    for (const [k, v] of extra) {
      lines.push(`${k}="${v}"`);
    }
    lines.push("");
  }

  const content = lines.join("\n") + "\n";

  // Preview
  console.log("  --- .env preview ---");
  for (const line of content.trim().split("\n")) {
    if (line.includes("TOKEN") || line.includes("KEY")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        const keyPart = line.slice(0, eqIdx);
        const valPart = line.slice(eqIdx + 1);
        if (valPart.length > 10) {
          const masked = valPart.slice(0, 5) + "..." + valPart.slice(-3);
          console.log(`  ${keyPart}=${masked}`);
        } else {
          console.log(`  ${line}`);
        }
      } else {
        console.log(`  ${line}`);
      }
    } else {
      console.log(`  ${line}`);
    }
  }
  console.log("  --- end preview ---");
  console.log();

  if (!(await askYesNo("  Write this .env file?", true))) {
    warn("Skipped writing .env file.");
    return;
  }

  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 });

  ok(`.env written to ${ENV_FILE}`);
  ok("File permissions set to 0600 (owner read/write only)");
}

// ---------------------------------------------------------------------------
// Step 8 - Install dependencies (npm install)
// ---------------------------------------------------------------------------

async function stepInstallDeps(): Promise<void> {
  heading("Step 8: Install Dependencies");

  if (!(await askYesNo("  Run npm install now?", true))) {
    warn("Skipping dependency installation.");
    info("Run this command later:");
    info("  npm install");
    return;
  }

  info("Installing dependencies...");
  const result = runCmd(["npm", "install"], 120000);
  if (result.code === 0) {
    ok("All dependencies installed");

    // Register claudebridge command globally
    info("Registering claudebridge command...");
    const linkResult = runCmd(["npm", "link"], 30000);
    if (linkResult.code === 0) {
      ok("'claudebridge' command registered (available system-wide)");
    } else {
      warn("Could not register 'claudebridge' globally — use 'npx claudebridge' instead");
    }
  } else {
    fail("Dependency installation failed");
    if (result.stderr) {
      for (const line of result.stderr.split("\n").slice(0, 3)) {
        info(`  ${line}`);
      }
    }
    info("Run 'npm install' manually to retry.");
  }
}

// ---------------------------------------------------------------------------
// Step 9 - Optionally install systemd services (Linux only)
// ---------------------------------------------------------------------------

async function stepSystemdServices(selected: string[]): Promise<void> {
  if (!hasSystemctl()) return;

  heading("Step 9: Systemd Services (optional)");
  info("This server has systemd. You can install services so your");
  info("bots start automatically and restart on failure.");
  console.log();

  if (
    !(await askYesNo(
      "  Install systemd services for selected modules?",
      false,
    ))
  ) {
    info("Skipping systemd service installation.");
    return;
  }

  const installedServices: string[] = [];
  for (const mod of selected) {
    if (!(mod in SYSTEMD_SERVICE_MAP)) continue;
    const [srcPath, serviceName] = SYSTEMD_SERVICE_MAP[mod];
    if (!fs.existsSync(srcPath)) {
      warn(`Service file not found: ${srcPath}`);
      continue;
    }

    const dest = `/etc/systemd/system/${serviceName}.service`;
    info(`Installing ${serviceName}.service...`);

    const cpResult = runCmd(["sudo", "cp", srcPath, dest], 10000);
    if (cpResult.code !== 0) {
      fail(`Failed to copy ${serviceName}.service: ${cpResult.stderr}`);
      continue;
    }

    runCmd(["sudo", "systemctl", "daemon-reload"], 10000);
    const enableResult = runCmd(
      ["sudo", "systemctl", "enable", serviceName],
      10000,
    );
    if (enableResult.code === 0) {
      ok(`${serviceName} enabled`);
      installedServices.push(serviceName);
    } else {
      fail(`Failed to enable ${serviceName}: ${enableResult.stderr}`);
    }
  }

  if (installedServices.length > 0) {
    console.log();
    if (await askYesNo("  Start the services now?", true)) {
      for (const svc of installedServices) {
        const startResult = runCmd(
          ["sudo", "systemctl", "start", svc],
          15000,
        );
        if (startResult.code === 0) {
          ok(`${svc} started`);
        } else {
          fail(`Failed to start ${svc}: ${startResult.stderr}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 10 - Summary
// ---------------------------------------------------------------------------

function stepSummary(selected: string[]): void {
  heading("Setup Complete");

  const moduleMap = new Map(MODULES);

  info("What was set up:");
  for (const key of selected) {
    ok(moduleMap.get(key)!);
  }
  if (fs.existsSync(ENV_FILE)) {
    ok(".env file configured");
  }
  if (fs.existsSync(path.join(PROJECT_ROOT, "node_modules"))) {
    ok("Node modules installed");
  }
  console.log();

  info("Quick start:");
  console.log();
  info("  claudebridge start             # Start all services");
  info("  claudebridge stop              # Stop all services");
  info("  claudebridge status            # Show running services");
  info("  claudebridge logs              # View service logs");
  console.log();
  info("Start individual services:");
  console.log();
  if (selected.includes("telegram")) {
    info("  claudebridge start telegram    # Start only Telegram bot");
  }
  if (selected.includes("discord")) {
    info("  claudebridge start discord     # Start only Discord bot");
  }
  if (selected.includes("scheduler")) {
    info("  claudebridge start scheduler   # Start only scheduler");
  }
  console.log();
  info("Re-run this wizard:  claudebridge setup");
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    // Load existing config for defaults
    const existingEnv = loadExistingEnv();

    // 1. Welcome
    await stepWelcome();

    // 2. Prerequisites (node 18+, npm, claude CLI)
    await stepPrerequisites();

    // 3. Claude authentication
    await stepClaudeAuth();

    // 4. Module selection
    const selected = await stepModules();

    // 5. Per-module config
    const envVars = await stepModuleConfig(selected, existingEnv);

    // 6. Agent identity (name + system prompt)
    await stepAgentIdentity();

    // 7. Claude permissions & settings
    const claudeVars = await stepClaudeSettings(existingEnv);
    Object.assign(envVars, claudeVars);

    // 8. Generate .env
    await stepGenerateEnv(envVars);

    // 9. Install dependencies (npm install)
    await stepInstallDeps();

    // 10. Optionally install systemd services (Linux only)
    await stepSystemdServices(selected);

    // 11. Summary
    stepSummary(selected);
  } catch (e) {
    if (e instanceof Error && e.message.includes("readline was closed")) {
      console.log("\n\n  Setup cancelled.");
      process.exit(1);
    }
    throw e;
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
