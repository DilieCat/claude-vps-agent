#!/usr/bin/env npx tsx
/**
 * claude-code all-in-one setup wizard.
 *
 * Run with:  npx tsx setup.ts
 *
 * Uses @clack/prompts for a polished interactive CLI experience.
 */

import * as p from "@clack/prompts";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = nodePath.dirname(new URL(import.meta.url).pathname);
const ENV_FILE = nodePath.join(PROJECT_ROOT, ".env");

const MODULES: Array<{ value: string; label: string }> = [
  { value: "telegram", label: "Telegram Bot" },
  { value: "discord", label: "Discord Bot" },
  { value: "scheduler", label: "Task Scheduler" },
];

const SYSTEMD_SERVICE_MAP: Record<string, [string, string]> = {
  telegram: [
    nodePath.join(PROJECT_ROOT, "infra", "systemd", "telegram-bot.service"),
    "telegram-bot",
  ],
  discord: [
    nodePath.join(PROJECT_ROOT, "infra", "systemd", "discord-bot.service"),
    "discord-bot",
  ],
  scheduler: [
    nodePath.join(PROJECT_ROOT, "infra", "systemd", "scheduler.service"),
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
// Cancel handler
// ---------------------------------------------------------------------------

function cancelGuard<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(1);
  }
  return value;
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
  console.log(BANNER);
  p.intro("All-in-One Setup Wizard");

  if (fs.existsSync(ENV_FILE)) {
    p.log.warn("An existing .env file was detected.");

    const update = cancelGuard(await p.confirm({
      message: "Update existing configuration?",
      initialValue: true,
    }));

    if (!update) {
      p.outro("No changes made. Re-run the wizard when you are ready.");
      process.exit(0);
    }

    p.log.info("Existing values will be shown as defaults. Press Enter to keep them.");
  }
}

// ---------------------------------------------------------------------------
// Step 2 - Prerequisites
// ---------------------------------------------------------------------------

async function stepPrerequisites(): Promise<boolean> {
  p.log.step("Step 1: Checking Prerequisites");
  let allOk = true;

  const s = p.spinner();

  // -- Node.js version --
  s.start("Checking Node.js...");
  const nodeVer = getVersion("node");
  if (nodeVer) {
    const parsed = parseVersionTuple(nodeVer);
    if (parsed && parsed[0] >= 18) {
      s.stop(`Node.js ${nodeVer}`);
    } else {
      s.stop(`Node.js ${nodeVer} -- version 18 or higher is required`);
      p.log.error("Download from: https://nodejs.org/");
      allOk = false;
    }
  } else {
    s.stop("Node.js not found -- version 18 or higher is required");
    p.log.error("Download from: https://nodejs.org/");
    allOk = false;
  }

  // -- npm --
  s.start("Checking npm...");
  const npmVer = getVersion("npm");
  if (npmVer) {
    s.stop(`npm ${npmVer}`);
  } else {
    s.stop("npm not found (usually installed with Node.js)");
    allOk = false;
  }

  // -- Claude CLI --
  s.start("Checking Claude CLI...");
  const claudeVer = getVersion("claude");
  if (claudeVer) {
    s.stop(`Claude CLI (${claudeVer})`);
  } else {
    s.stop("Claude CLI not found");

    if (cmdExists("npm")) {
      const installCli = cancelGuard(await p.confirm({
        message: "Install Claude CLI now? (npm install -g @anthropic-ai/claude-code)",
        initialValue: true,
      }));

      if (installCli) {
        s.start("Installing Claude CLI...");
        const result = runCmd(
          ["npm", "install", "-g", "@anthropic-ai/claude-code"],
          120000,
        );
        if (result.code === 0) {
          s.stop("Claude CLI installed successfully");
        } else {
          s.stop("Claude CLI installation failed");
          if (result.stderr) {
            p.log.error(result.stderr.slice(0, 200));
          }
          p.log.info("Try installing manually: npm install -g @anthropic-ai/claude-code");
          allOk = false;
        }
      } else {
        p.log.warn("Claude CLI is required. Install later with:");
        p.log.info("  npm install -g @anthropic-ai/claude-code");
        allOk = false;
      }
    } else {
      p.log.info("Install Node.js first, then run: npm install -g @anthropic-ai/claude-code");
      allOk = false;
    }
  }

  if (!allOk) {
    p.log.warn("Some prerequisites are missing.");
    const cont = cancelGuard(await p.confirm({
      message: "Continue anyway?",
      initialValue: true,
    }));
    if (!cont) {
      p.cancel("Setup cancelled due to missing prerequisites.");
      process.exit(1);
    }
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// Step 3 - Claude authentication
// ---------------------------------------------------------------------------

async function stepClaudeAuth(): Promise<void> {
  p.log.step("Step 2: Claude Authentication");

  if (!cmdExists("claude")) {
    p.log.warn("Claude CLI not found -- skipping authentication check.");
    p.log.info("Install it later and run: claude login");
    return;
  }

  const s = p.spinner();
  s.start("Checking if Claude CLI is authenticated...");
  const result = runCmd(
    ["claude", "-p", "say ok", "--output-format", "json"],
    30000,
  );

  if (result.code === 0) {
    s.stop("Claude CLI is authenticated and working");
    return;
  }

  s.stop("Claude CLI is not authenticated");

  if (isHeadless()) {
    p.note(
      [
        "This appears to be a headless server (no display detected).",
        "",
        "To authenticate, set up SSH port forwarding from your local machine:",
        "  ssh -L 9315:localhost:9315 user@this-server",
        "",
        "Then, in another terminal on this server, run:",
        "  claude login",
        "",
        "The OAuth URL will open in your local browser via the SSH tunnel.",
      ].join("\n"),
      "Headless Authentication",
    );

    const done = cancelGuard(await p.confirm({
      message: "Have you completed authentication in another terminal?",
      initialValue: false,
    }));

    if (done) {
      s.start("Verifying authentication...");
      const verify = runCmd(
        ["claude", "-p", "say ok", "--output-format", "json"],
        30000,
      );
      if (verify.code === 0) {
        s.stop("Claude CLI authentication verified");
      } else {
        s.stop("Authentication could not be verified. You can try again later.");
      }
    } else {
      p.log.info("You can authenticate later. The setup will continue.");
    }
  } else {
    p.log.info("Running 'claude login' to authenticate...");
    try {
      const loginResult = spawnSync("claude", ["login"], {
        stdio: "inherit",
        timeout: 120000,
      });
      if (loginResult.error) {
        p.log.warn(`Login failed: ${loginResult.error.message}`);
        p.log.info("You can run 'claude login' manually later.");
        return;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      p.log.warn(`Login failed: ${msg}`);
      p.log.info("You can run 'claude login' manually later.");
      return;
    }

    s.start("Verifying authentication...");
    const verify = runCmd(
      ["claude", "-p", "say ok", "--output-format", "json"],
      30000,
    );
    if (verify.code === 0) {
      s.stop("Claude CLI authentication verified");
    } else {
      s.stop("Authentication could not be verified. You can run 'claude login' later.");
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4 - Module selection
// ---------------------------------------------------------------------------

async function stepModules(): Promise<string[]> {
  p.log.step("Step 3: Module Selection");

  const selected = cancelGuard(await p.multiselect({
    message: "Choose which modules to enable:",
    options: MODULES.map((m) => ({
      value: m.value,
      label: m.label,
    })),
    initialValues: MODULES.map((m) => m.value),
    required: true,
  }));

  for (const key of selected) {
    const mod = MODULES.find((m) => m.value === key);
    if (mod) p.log.success(`${mod.label} enabled`);
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
    p.log.step("Step 4a: Telegram Bot Configuration");
    p.log.info("You need a bot token from @BotFather on Telegram.");
    p.log.info("  https://t.me/BotFather");

    const token = cancelGuard(await p.text({
      message: "Bot token:",
      placeholder: "123456:ABC-DEF...",
      initialValue: existingEnv.TELEGRAM_BOT_TOKEN,
      validate: (v) => {
        if (!v || v.trim().length === 0) return "A bot token is required.";
      },
    }));

    const users = cancelGuard(await p.text({
      message: "Allowed Telegram user IDs (comma-separated):",
      placeholder: existingEnv.TELEGRAM_ALLOWED_USERS || "123456789,987654321",
      initialValue: existingEnv.TELEGRAM_ALLOWED_USERS,
    }));

    envVars.TELEGRAM_BOT_TOKEN = token;
    const usersClean = users
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .join(",");
    if (usersClean) envVars.TELEGRAM_ALLOWED_USERS = usersClean;
  }

  if (selected.includes("discord")) {
    p.log.step("Step 4b: Discord Bot Configuration");
    p.log.info("You need a bot token from the Discord Developer Portal.");
    p.log.info("  https://discord.com/developers/applications");

    const token = cancelGuard(await p.text({
      message: "Bot token:",
      placeholder: "MTIzNDU2Nzg5...",
      initialValue: existingEnv.DISCORD_BOT_TOKEN,
      validate: (v) => {
        if (!v || v.trim().length === 0) return "A bot token is required.";
      },
    }));

    const users = cancelGuard(await p.text({
      message: "Allowed Discord user IDs (comma-separated):",
      placeholder:
        existingEnv.DISCORD_ALLOWED_USERS ||
        "123456789012345678,987654321098765432",
      initialValue: existingEnv.DISCORD_ALLOWED_USERS,
    }));

    envVars.DISCORD_BOT_TOKEN = token;
    const usersClean = users
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .join(",");
    if (usersClean) envVars.DISCORD_ALLOWED_USERS = usersClean;
  }

  if (selected.includes("scheduler")) {
    p.log.step("Step 4c: Task Scheduler Configuration");
    p.log.info("The scheduler uses scheduler/tasks.yaml for task definitions.");
    p.log.success("Default tasks.yaml will be used. You can customize it later.");
  }

  return envVars;
}

// ---------------------------------------------------------------------------
// Step 5 - Agent Identity
// ---------------------------------------------------------------------------

async function stepAgentIdentity(): Promise<void> {
  p.log.step("Step 5: Agent Identity");
  p.log.info("Choose a name for your agent. This is how the agent will introduce itself in chat.");

  const agentName = cancelGuard(await p.text({
    message: "Agent name:",
    placeholder: "Atlas",
    defaultValue: "Atlas",
  }));

  // Generate ~/.claude-agent/workspace/CLAUDE.md from template
  const templatePath = nodePath.join(PROJECT_ROOT, "data", "workspace-claude.template.md");
  const workspaceDir = nodePath.join(os.homedir(), ".claude-agent", "workspace");
  const outPath = nodePath.join(workspaceDir, "CLAUDE.md");

  if (fs.existsSync(templatePath)) {
    let shouldWrite = true;
    if (fs.existsSync(outPath)) {
      p.log.warn("Existing workspace CLAUDE.md detected.");
      shouldWrite = cancelGuard(await p.confirm({
        message: "Overwrite with new agent name?",
        initialValue: false,
      }));
    }
    if (shouldWrite) {
      const s = p.spinner();
      s.start("Writing workspace CLAUDE.md...");
      fs.mkdirSync(workspaceDir, { recursive: true });
      const template = fs.readFileSync(templatePath, "utf-8");
      const content = template.replace(/\{AGENT_NAME\}/g, agentName);
      fs.writeFileSync(outPath, content, "utf-8");
      s.stop(`Workspace CLAUDE.md written with agent name: ${agentName}`);
    } else {
      p.log.info("Keeping existing workspace CLAUDE.md.");
    }
  } else {
    p.log.warn("Template data/workspace-claude.template.md not found -- skipping.");
  }

  // Update data/brain.md from template with agent name
  const brainTemplatePath = nodePath.join(PROJECT_ROOT, "data", "brain.template.md");
  const brainPath = nodePath.join(PROJECT_ROOT, "data", "brain.md");
  if (fs.existsSync(brainTemplatePath) && !fs.existsSync(brainPath)) {
    const brainTemplate = fs.readFileSync(brainTemplatePath, "utf-8");
    const brainContent = brainTemplate.replace(/\{AGENT_NAME\}/g, agentName);
    fs.writeFileSync(brainPath, brainContent, "utf-8");
    p.log.success(`Brain initialized for ${agentName}`);
  } else if (fs.existsSync(brainPath)) {
    p.log.info("Existing brain.md found -- not overwriting.");
  }
}

// ---------------------------------------------------------------------------
// Step 6 - Claude permissions & settings
// ---------------------------------------------------------------------------

async function stepClaudeSettings(
  existingEnv: Record<string, string>,
): Promise<Record<string, string>> {
  p.log.step("Step 6: Claude Permissions");
  p.log.info(
    "Claude Code needs permission to use tools (read files, edit code, run commands, etc).",
  );

  const PRESETS: Record<string, string> = {
    readonly: "Read,Glob,Grep",
    readwrite: "Read,Write,Edit,Bash,Glob,Grep",
    full: "Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch",
    custom: "",
  };

  const existingTools = existingEnv.CLAUDE_ALLOWED_TOOLS;
  let initialValue: string = "readwrite";
  if (existingTools) {
    const match = Object.entries(PRESETS).find(([, v]) => v === existingTools);
    initialValue = match ? match[0] : "custom";
  }

  const choice = cancelGuard(await p.select({
    message: "Permission level:",
    options: [
      {
        value: "readonly",
        label: "Read-only",
        hint: "Read, Glob, Grep",
      },
      {
        value: "readwrite",
        label: "Read + Write (recommended)",
        hint: "Read, Write, Edit, Bash, Glob, Grep",
      },
      {
        value: "full",
        label: "Full access",
        hint: "All tools including WebFetch, WebSearch",
      },
      {
        value: "custom",
        label: "Custom",
        hint: "Specify tools manually",
      },
    ],
    initialValue,
  }));

  const envVars: Record<string, string> = {};

  if (choice === "custom") {
    p.log.info("Available tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch");
    const custom = cancelGuard(await p.text({
      message: "Tools (comma-separated):",
      placeholder: "Read,Write,Edit,Bash,Glob,Grep",
      initialValue: existingTools ?? "Read,Write,Edit,Bash,Glob,Grep",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "At least one tool is required.";
      },
    }));
    envVars.CLAUDE_ALLOWED_TOOLS = custom;
  } else {
    envVars.CLAUDE_ALLOWED_TOOLS = PRESETS[choice];
  }

  p.log.success(`Tools: ${envVars.CLAUDE_ALLOWED_TOOLS}`);

  // Optional: model override
  const model = cancelGuard(await p.text({
    message: "Claude model (leave empty for default):",
    placeholder: "e.g. claude-sonnet-4-6",
    initialValue: existingEnv.CLAUDE_MODEL ?? "",
  }));
  if (model.trim()) envVars.CLAUDE_MODEL = model.trim();

  // Optional: project directory
  const projectDir = cancelGuard(await p.text({
    message: "Default project directory (leave empty for current dir):",
    placeholder: "/path/to/your/project",
    initialValue: existingEnv.CLAUDE_PROJECT_DIR ?? "",
  }));
  if (projectDir.trim()) envVars.CLAUDE_PROJECT_DIR = projectDir.trim();

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
  p.log.step("Step 7: Generate .env");

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

  // Preview -- mask sensitive values
  const previewLines: string[] = [];
  for (const line of content.trim().split("\n")) {
    if (line.includes("TOKEN") || line.includes("KEY")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        const keyPart = line.slice(0, eqIdx);
        const valPart = line.slice(eqIdx + 1);
        if (valPart.length > 10) {
          const masked = valPart.slice(0, 5) + "..." + valPart.slice(-3);
          previewLines.push(`${keyPart}=${masked}`);
        } else {
          previewLines.push(line);
        }
      } else {
        previewLines.push(line);
      }
    } else {
      previewLines.push(line);
    }
  }

  p.note(previewLines.join("\n"), ".env preview");

  const write = cancelGuard(await p.confirm({
    message: "Write this .env file?",
    initialValue: true,
  }));

  if (!write) {
    p.log.warn("Skipped writing .env file.");
    return;
  }

  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 });

  p.log.success(`.env written to ${ENV_FILE}`);
  p.log.info("File permissions set to 0600 (owner read/write only)");
}

// ---------------------------------------------------------------------------
// Step 8 - Install dependencies (npm install)
// ---------------------------------------------------------------------------

async function stepInstallDeps(): Promise<void> {
  p.log.step("Step 8: Install Dependencies");

  const install = cancelGuard(await p.confirm({
    message: "Run npm install now?",
    initialValue: true,
  }));

  if (!install) {
    p.log.warn("Skipping dependency installation.");
    p.log.info("Run this command later: npm install");
    return;
  }

  const s = p.spinner();
  s.start("Installing dependencies...");
  const result = runCmd(["npm", "install"], 120000);
  if (result.code === 0) {
    s.stop("All dependencies installed");

    // Register claudebridge command globally
    s.start("Registering claudebridge command...");
    const linkResult = runCmd(["npm", "link"], 30000);
    if (linkResult.code === 0) {
      s.stop("'claudebridge' command registered (available system-wide)");
    } else {
      s.stop("Could not register 'claudebridge' globally -- use 'npx claudebridge' instead");
    }
  } else {
    s.stop("Dependency installation failed");
    if (result.stderr) {
      for (const line of result.stderr.split("\n").slice(0, 3)) {
        p.log.error(line);
      }
    }
    p.log.info("Run 'npm install' manually to retry.");
  }
}

// ---------------------------------------------------------------------------
// Step 9 - Optionally install systemd services (Linux only)
// ---------------------------------------------------------------------------

async function stepSystemdServices(selected: string[]): Promise<void> {
  if (!hasSystemctl()) return;

  p.log.step("Step 9: Systemd Services (optional)");
  p.log.info("This server has systemd. You can install services so your bots start automatically and restart on failure.");

  const installServices = cancelGuard(await p.confirm({
    message: "Install systemd services for selected modules?",
    initialValue: false,
  }));

  if (!installServices) {
    p.log.info("Skipping systemd service installation.");
    return;
  }

  const s = p.spinner();
  const installedServices: string[] = [];
  for (const mod of selected) {
    if (!(mod in SYSTEMD_SERVICE_MAP)) continue;
    const [srcPath, serviceName] = SYSTEMD_SERVICE_MAP[mod];
    if (!fs.existsSync(srcPath)) {
      p.log.warn(`Service file not found: ${srcPath}`);
      continue;
    }

    const dest = `/etc/systemd/system/${serviceName}.service`;
    s.start(`Installing ${serviceName}.service...`);

    const cpResult = runCmd(["sudo", "cp", srcPath, dest], 10000);
    if (cpResult.code !== 0) {
      s.stop(`Failed to copy ${serviceName}.service: ${cpResult.stderr}`);
      continue;
    }

    runCmd(["sudo", "systemctl", "daemon-reload"], 10000);
    const enableResult = runCmd(
      ["sudo", "systemctl", "enable", serviceName],
      10000,
    );
    if (enableResult.code === 0) {
      s.stop(`${serviceName} enabled`);
      installedServices.push(serviceName);
    } else {
      s.stop(`Failed to enable ${serviceName}: ${enableResult.stderr}`);
    }
  }

  if (installedServices.length > 0) {
    const start = cancelGuard(await p.confirm({
      message: "Start the services now?",
      initialValue: true,
    }));

    if (start) {
      for (const svc of installedServices) {
        s.start(`Starting ${svc}...`);
        const startResult = runCmd(
          ["sudo", "systemctl", "start", svc],
          15000,
        );
        if (startResult.code === 0) {
          s.stop(`${svc} started`);
        } else {
          s.stop(`Failed to start ${svc}: ${startResult.stderr}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 10 - Summary
// ---------------------------------------------------------------------------

function stepSummary(selected: string[]): void {
  const moduleLabels = selected.map((key) => {
    const mod = MODULES.find((m) => m.value === key);
    return mod ? mod.label : key;
  });

  const summaryLines = ["What was set up:"];
  for (const label of moduleLabels) {
    summaryLines.push(`  + ${label}`);
  }
  if (fs.existsSync(ENV_FILE)) {
    summaryLines.push("  + .env file configured");
  }
  if (fs.existsSync(nodePath.join(PROJECT_ROOT, "node_modules"))) {
    summaryLines.push("  + Node modules installed");
  }

  p.note(summaryLines.join("\n"), "Setup Complete");

  const quickStart = [
    "Quick start:",
    "",
    "  claudebridge start             # Start all services",
    "  claudebridge stop              # Stop all services",
    "  claudebridge status            # Show running services",
    "  claudebridge logs              # View service logs",
    "",
    "Start individual services:",
  ];

  if (selected.includes("telegram")) {
    quickStart.push("  claudebridge start telegram    # Start only Telegram bot");
  }
  if (selected.includes("discord")) {
    quickStart.push("  claudebridge start discord     # Start only Discord bot");
  }
  if (selected.includes("scheduler")) {
    quickStart.push("  claudebridge start scheduler   # Start only scheduler");
  }
  quickStart.push("");
  quickStart.push("Re-run this wizard:  claudebridge setup");

  p.note(quickStart.join("\n"), "Next Steps");

  p.outro("Happy coding!");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
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
}

main().catch((err) => {
  p.cancel("An unexpected error occurred.");
  console.error(err);
  process.exit(1);
});
