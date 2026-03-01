#!/usr/bin/env -S npx tsx
/**
 * claudebridge CLI — process manager for Claude Code bot services.
 *
 * Spawns each service in its own process group (detached) and stores
 * the negative PID (PGID) so that `stop` can kill the entire tree
 * reliably, solving the npx→tsx→node zombie-process problem.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { createSpinner } from "nanospinner";
import figlet from "figlet";
import gradient from "gradient-string";
import boxen from "boxen";

// ── Paths ────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIDS_DIR = path.join(ROOT, ".pids");
const LOGS_DIR = path.join(ROOT, "logs");

// ── Service definitions ──────────────────────────────────────────────
interface ServiceDef {
  script: string;
  name: string;
}

const SERVICES: Record<string, ServiceDef> = {
  telegram: { script: "src/bots/telegram.ts", name: "Telegram Bot" },
  discord: { script: "src/bots/discord.ts", name: "Discord Bot" },
  scheduler: { script: "src/scheduler.ts", name: "Scheduler" },
};

type ServiceKey = keyof typeof SERVICES;
const SERVICE_KEYS = Object.keys(SERVICES) as ServiceKey[];

// ── Helpers ──────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pidFile(service: string): string {
  return path.join(PIDS_DIR, `${service}.pid`);
}

function readPgid(service: string): number | null {
  const file = pidFile(service);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8").trim();
  const num = parseInt(raw, 10);
  return Number.isNaN(num) ? null : num;
}

/** Check if a process (group) is alive. */
function isAlive(pgid: number): boolean {
  try {
    // signal 0 = existence check
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format seconds into human-friendly uptime. */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Resolve list of services from user argument. */
function resolveServices(arg?: string): ServiceKey[] {
  if (!arg || arg === "all") return [...SERVICE_KEYS];
  const key = arg.toLowerCase();
  if (!(key in SERVICES)) {
    console.error(
      pc.red(`Unknown service: ${arg}`) + `\nAvailable: ${SERVICE_KEYS.join(", ")}`,
    );
    process.exit(1);
  }
  return [key];
}

// ── Banner ────────────────────────────────────────────────────────────

function printBanner(): void {
  const ascii = figlet.textSync("claudebridge", { font: "Small" });
  console.log(gradient.atlas(ascii));
  console.log(pc.dim("  process manager for Claude Code services\n"));
}

// ── Command Registry ─────────────────────────────────────────────────

interface Command {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
  run(args: string[]): void | Promise<void>;
}

const commands: Command[] = [];

function registerCommand(cmd: Command): void {
  commands.push(cmd);
}

function findCommand(name: string): Command | undefined {
  const lower = name.toLowerCase();
  return commands.find(
    (cmd) =>
      cmd.name === lower || (cmd.aliases && cmd.aliases.includes(lower)),
  );
}

// ── Service operations ───────────────────────────────────────────────

async function startService(service: ServiceKey): Promise<void> {
  const def = SERVICES[service];
  const scriptPath = path.join(ROOT, def.script);

  if (!fs.existsSync(scriptPath)) {
    console.log(
      `  ${pc.yellow(def.name)}: script not found (${def.script}), skipping`,
    );
    return;
  }

  // If already running, skip
  const existingPgid = readPgid(service);
  if (existingPgid !== null && isAlive(existingPgid)) {
    console.log(
      `  ${pc.cyan(def.name)}: already running ${pc.dim(`(PGID ${existingPgid})`)}`,
    );
    return;
  }

  const spinner = createSpinner(`Starting ${pc.bold(def.name)}...`).start();

  ensureDir(PIDS_DIR);
  ensureDir(LOGS_DIR);

  const logPath = path.join(LOGS_DIR, `${service}.log`);
  const logFd = fs.openSync(logPath, "a");

  let child;
  try {
    child = spawn("npx", ["tsx", scriptPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: ROOT,
      env: { ...process.env },
    });
  } catch (err) {
    fs.closeSync(logFd);
    spinner.error({ text: `${pc.bold(def.name)}: failed to spawn — ${err}` });
    return;
  }

  if (!child.pid) {
    fs.closeSync(logFd);
    spinner.error({ text: `${pc.bold(def.name)}: failed to start (no PID)` });
    return;
  }

  // child.pid is the PID of the new process-group leader (because detached)
  const pgid = child.pid;
  fs.writeFileSync(pidFile(service), String(pgid));
  child.unref();
  fs.closeSync(logFd);

  spinner.success({
    text: `${pc.bold(def.name)}: ${pc.green("started")} ${pc.dim(`(PGID ${pgid})`)}  → ${pc.dim(`logs/${service}.log`)}`,
  });
}

async function stopService(service: ServiceKey): Promise<void> {
  const def = SERVICES[service];
  const pgid = readPgid(service);

  const spinner = createSpinner(`Stopping ${pc.bold(def.name)}...`).start();

  let killed = false;

  // 1) Try SIGTERM on the whole process group
  if (pgid !== null && isAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGTERM");
      killed = true;
    } catch {
      // already gone
    }
  }

  if (killed) {
    // Wait up to 3s for graceful shutdown
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      if (!isAlive(pgid!)) break;
    }

    // 2) SIGKILL stragglers
    if (isAlive(pgid!)) {
      try {
        process.kill(-pgid!, "SIGKILL");
      } catch {
        // already gone
      }
      await sleep(500);
    }
  }

  // 3) pkill fallback to catch any escaped processes
  const pattern = SERVICES[service].script;
  try {
    execSync(`pkill -9 -f '${pattern}' 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // pkill returns non-zero if no processes matched — that's fine
  }

  // Clean up pid file
  const file = pidFile(service);
  if (fs.existsSync(file)) fs.unlinkSync(file);

  spinner.success({ text: `${pc.bold(def.name)}: ${pc.red("stopped")}` });
}

function statusAll(): void {
  console.log();

  const header =
    pc.bold("  Service            Status       PGID      Uptime");
  const separator = `  ${"─".repeat(52)}`;

  console.log(header);
  console.log(pc.dim(separator));

  for (const service of SERVICE_KEYS) {
    const def = SERVICES[service];
    const pgid = readPgid(service);
    const alive = pgid !== null && isAlive(pgid);

    const nameCol = def.name.padEnd(18);
    const statusCol = alive
      ? pc.green("running") + "     "
      : pc.dim("stopped") + "     ";
    const pgidCol = alive ? String(pgid).padEnd(9) : pc.dim("-").padEnd(9);

    let uptimeCol = pc.dim("-");
    if (alive) {
      const pidFilePath = pidFile(service);
      try {
        const stat = fs.statSync(pidFilePath);
        const secs = Math.floor((Date.now() - stat.mtimeMs) / 1000);
        uptimeCol = pc.cyan(formatUptime(secs));
      } catch {
        uptimeCol = pc.dim("?");
      }
    }

    console.log(`  ${nameCol} ${statusCol} ${pgidCol} ${uptimeCol}`);
  }
  console.log();
}

function showLogs(service?: string): void {
  const services = service ? resolveServices(service) : SERVICE_KEYS;

  for (const svc of services) {
    const logPath = path.join(LOGS_DIR, `${svc}.log`);
    if (!fs.existsSync(logPath)) {
      console.log(pc.dim(`No log file for ${SERVICES[svc].name}`));
      continue;
    }
    console.log(
      `\n${pc.bold(pc.cyan(`── ${SERVICES[svc].name} ──`))}\n`,
    );
    try {
      const output = execSync(`tail -n 40 '${logPath}'`, {
        encoding: "utf-8",
      });
      console.log(output);
    } catch {
      console.log(pc.dim("(empty)"));
    }
  }
}

async function runSetup(): Promise<void> {
  const setupPath = path.join(ROOT, "setup.ts");
  if (!fs.existsSync(setupPath)) {
    console.error(pc.red("setup.ts not found"));
    process.exit(1);
  }
  const child = spawn("npx", ["tsx", setupPath], {
    stdio: "inherit",
    cwd: ROOT,
  });
  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Setup exited with code ${code}`));
    });
  });
}

function printUsage(): void {
  const cmdLines = commands
    .filter((cmd) => cmd.name !== "help")
    .map((cmd) => {
      const nameStr = pc.green(cmd.name);
      const usageStr = cmd.usage ?? "";
      return `  ${nameStr}${usageStr.padEnd(40 - cmd.name.length)}  ${pc.dim(cmd.description)}`;
    })
    .join("\n");

  const examples = [
    ["claudebridge start", "start all services"],
    ["claudebridge stop telegram", "stop only telegram bot"],
    ["claudebridge restart scheduler", "restart scheduler"],
    ["claudebridge status", "show status table"],
  ];

  const exampleLines = examples
    .map(([cmd, desc]) => `  ${pc.cyan(cmd!.padEnd(34))} ${pc.dim("# " + desc)}`)
    .join("\n");

  const content =
    `${pc.bold("Usage:")} claudebridge ${pc.green("<command>")} [service]\n\n` +
    `${pc.bold("Commands:")}\n${cmdLines}\n\n` +
    `${pc.bold("Examples:")}\n${exampleLines}`;

  console.log(
    boxen(content, {
      padding: 1,
      margin: { top: 0, right: 0, bottom: 1, left: 0 },
      borderStyle: "round",
      borderColor: "cyan",
    }),
  );
}

// ── Register commands ────────────────────────────────────────────────

registerCommand({
  name: "start",
  description: "Start services (default: all)",
  usage: "  [telegram|discord|scheduler|all]",
  async run(args) {
    const services = resolveServices(args[0]);
    printBanner();
    console.log(pc.bold("Starting services...\n"));
    for (const svc of services) await startService(svc);
    console.log();
  },
});

registerCommand({
  name: "stop",
  description: "Stop services (default: all)",
  usage: "   [telegram|discord|scheduler|all]",
  async run(args) {
    const services = resolveServices(args[0]);
    printBanner();
    console.log(pc.bold("Stopping services...\n"));
    for (const svc of services) await stopService(svc);
    console.log();
  },
});

registerCommand({
  name: "restart",
  description: "Restart services",
  usage: " [telegram|discord|scheduler|all]",
  async run(args) {
    const services = resolveServices(args[0]);
    printBanner();
    console.log(pc.bold("Restarting services...\n"));
    for (const svc of services) await stopService(svc);
    for (const svc of services) await startService(svc);
    console.log();
  },
});

registerCommand({
  name: "status",
  description: "Show running services",
  aliases: ["ps"],
  run() {
    printBanner();
    statusAll();
  },
});

registerCommand({
  name: "logs",
  description: "Tail log files",
  usage: "   [service]                     ",
  run(args) {
    showLogs(args[0]);
  },
});

registerCommand({
  name: "setup",
  description: "Run setup wizard",
  async run() {
    await runSetup();
  },
});

registerCommand({
  name: "health",
  description: "Check system health",
  run() {
    printBanner();
    console.log(pc.bold("Health checks:\n"));

    // 1. claude --version
    let claudeOk = false;
    try {
      const ver = execSync("claude --version 2>&1", { encoding: "utf-8" }).trim();
      console.log(`  ${pc.green("✓")} Claude CLI: ${pc.dim(ver)}`);
      claudeOk = true;
    } catch {
      console.log(`  ${pc.red("✗")} Claude CLI: not found or not working`);
    }

    // 2. brain.md readable
    const brainPath = path.join(ROOT, "data", "brain.md");
    if (fs.existsSync(brainPath)) {
      try {
        fs.accessSync(brainPath, fs.constants.R_OK);
        const stat = fs.statSync(brainPath);
        console.log(`  ${pc.green("✓")} Brain: ${pc.dim(`${stat.size} bytes`)}`);
      } catch {
        console.log(`  ${pc.red("✗")} Brain: exists but not readable`);
      }
    } else {
      console.log(`  ${pc.yellow("○")} Brain: not found (will be created on first use)`);
    }

    // 3. data/ directory
    const dataDir = path.join(ROOT, "data");
    if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) {
      console.log(`  ${pc.green("✓")} Data directory: ${pc.dim(dataDir)}`);
    } else {
      console.log(`  ${pc.red("✗")} Data directory: missing`);
    }

    // 4. Disk space
    try {
      const dfOutput = execSync(`df -h "${ROOT}" | tail -1`, { encoding: "utf-8" }).trim();
      const parts = dfOutput.split(/\s+/);
      const available = parts[3];
      const usePct = parts[4];
      console.log(`  ${pc.green("✓")} Disk: ${pc.dim(`${available} available (${usePct} used)`)}`);
    } catch {
      console.log(`  ${pc.yellow("○")} Disk: unable to check`);
    }

    console.log();
    if (claudeOk) {
      console.log(pc.green("  All critical checks passed."));
    } else {
      console.log(pc.red("  Some checks failed — see above."));
    }
    console.log();
  },
});

registerCommand({
  name: "stats",
  description: "Show usage statistics and costs",
  run() {
    // Dynamic import to avoid circular dependency at module level
    const costsPath = path.join(ROOT, "data", "costs.json");
    if (!fs.existsSync(costsPath)) {
      printBanner();
      console.log(pc.dim("  No usage data yet.\n"));
      return;
    }

    let entries: Array<{ timestamp: string; costUsd: number; numTurns: number; durationMs: number; promptPreview: string }>;
    try {
      entries = JSON.parse(fs.readFileSync(costsPath, "utf-8"));
    } catch {
      console.log(pc.red("  Failed to read costs data.\n"));
      return;
    }

    printBanner();
    console.log(pc.bold("  Usage Statistics\n"));

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now);
    monthStart.setDate(monthStart.getDate() - 30);
    monthStart.setHours(0, 0, 0, 0);

    const periods: Array<{ label: string; start: Date }> = [
      { label: "Today", start: todayStart },
      { label: "Last 7 days", start: weekStart },
      { label: "Last 30 days", start: monthStart },
      { label: "All time", start: new Date(0) },
    ];

    const header = `  ${"Period".padEnd(16)} ${"Requests".padEnd(10)} ${"Cost".padEnd(12)} ${"Avg Time"}`;
    console.log(pc.bold(header));
    console.log(pc.dim(`  ${"─".repeat(52)}`));

    for (const p of periods) {
      const filtered = entries.filter((e) => new Date(e.timestamp) >= p.start);
      const totalCost = filtered.reduce((s, e) => s + e.costUsd, 0);
      const avgDuration = filtered.length > 0
        ? Math.round(filtered.reduce((s, e) => s + e.durationMs, 0) / filtered.length)
        : 0;
      const avgSec = (avgDuration / 1000).toFixed(1);

      console.log(
        `  ${p.label.padEnd(16)} ${String(filtered.length).padEnd(10)} ${pc.green(`$${totalCost.toFixed(4)}`.padEnd(12))} ${pc.dim(`${avgSec}s`)}`,
      );
    }

    console.log();
  },
});

registerCommand({
  name: "help",
  description: "Show this help message",
  aliases: ["--help", "-h"],
  run() {
    printBanner();
    printUsage();
  },
});

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [commandName, ...rest] = process.argv.slice(2);

  const cmd = commandName ? findCommand(commandName) : undefined;

  if (cmd) {
    await cmd.run(rest);
  } else {
    printBanner();
    printUsage();
  }
}

main().catch((err) => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});
