#!/usr/bin/env node
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

// ── Paths ────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIDS_DIR = path.join(ROOT, ".pids");
const LOGS_DIR = path.join(ROOT, "logs");

// ── ANSI helpers (no deps) ───────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

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
      `${c.red}Unknown service: ${arg}${c.reset}\nAvailable: ${SERVICE_KEYS.join(", ")}`,
    );
    process.exit(1);
  }
  return [key];
}

// ── Commands ─────────────────────────────────────────────────────────

async function startService(service: ServiceKey): Promise<void> {
  const def = SERVICES[service];
  const scriptPath = path.join(ROOT, def.script);

  if (!fs.existsSync(scriptPath)) {
    console.log(
      `  ${c.yellow}${def.name}${c.reset}: script not found (${def.script}), skipping`,
    );
    return;
  }

  // If already running, skip
  const existingPgid = readPgid(service);
  if (existingPgid !== null && isAlive(existingPgid)) {
    console.log(
      `  ${c.cyan}${def.name}${c.reset}: already running (PGID ${existingPgid})`,
    );
    return;
  }

  ensureDir(PIDS_DIR);
  ensureDir(LOGS_DIR);

  const logPath = path.join(LOGS_DIR, `${service}.log`);
  const logFd = fs.openSync(logPath, "a");

  const child = spawn("npx", ["tsx", scriptPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: ROOT,
    env: { ...process.env },
  });

  // child.pid is the PID of the new process-group leader (because detached)
  const pgid = child.pid!;
  fs.writeFileSync(pidFile(service), String(pgid));
  child.unref();
  fs.closeSync(logFd);

  console.log(
    `  ${c.green}${def.name}${c.reset}: started (PGID ${pgid})  -> logs/${service}.log`,
  );
}

async function stopService(service: ServiceKey): Promise<void> {
  const def = SERVICES[service];
  const pgid = readPgid(service);

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

  console.log(`  ${c.red}${def.name}${c.reset}: stopped`);
}

function statusAll(): void {
  const header = `${c.bold}${c.white}  Service            Status       PGID      Uptime${c.reset}`;
  const separator = `  ${"─".repeat(52)}`;

  console.log();
  console.log(header);
  console.log(separator);

  for (const service of SERVICE_KEYS) {
    const def = SERVICES[service];
    const pgid = readPgid(service);
    const alive = pgid !== null && isAlive(pgid);

    const nameCol = def.name.padEnd(18);
    const statusCol = alive
      ? `${c.green}running${c.reset}     `
      : `${c.dim}stopped${c.reset}     `;
    const pgidCol = alive ? String(pgid).padEnd(9) : `${c.dim}-${c.reset}`.padEnd(9 + c.dim.length + c.reset.length);

    let uptimeCol = `${c.dim}-${c.reset}`;
    if (alive) {
      const pidFilePath = pidFile(service);
      try {
        const stat = fs.statSync(pidFilePath);
        const secs = Math.floor((Date.now() - stat.mtimeMs) / 1000);
        uptimeCol = formatUptime(secs);
      } catch {
        uptimeCol = `${c.dim}?${c.reset}`;
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
      console.log(`${c.dim}No log file for ${SERVICES[svc].name}${c.reset}`);
      continue;
    }
    console.log(
      `\n${c.bold}${c.cyan}── ${SERVICES[svc].name} ──${c.reset}\n`,
    );
    try {
      const output = execSync(`tail -n 40 '${logPath}'`, {
        encoding: "utf-8",
      });
      console.log(output);
    } catch {
      console.log(`${c.dim}(empty)${c.reset}`);
    }
  }
}

async function runSetup(): Promise<void> {
  const setupPath = path.join(ROOT, "setup.ts");
  if (!fs.existsSync(setupPath)) {
    console.error(`${c.red}setup.ts not found${c.reset}`);
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
  console.log(`
${c.bold}${c.cyan}claudebridge${c.reset} — process manager for Claude Code services

${c.bold}Usage:${c.reset}
  claudebridge ${c.green}<command>${c.reset} [service]

${c.bold}Commands:${c.reset}
  ${c.green}start${c.reset}   [telegram|discord|scheduler|all]  Start services (default: all)
  ${c.green}stop${c.reset}    [telegram|discord|scheduler|all]  Stop services (default: all)
  ${c.green}restart${c.reset} [telegram|discord|scheduler|all]  Restart services
  ${c.green}status${c.reset}                                    Show running services
  ${c.green}logs${c.reset}    [service]                          Tail log files
  ${c.green}setup${c.reset}                                     Run setup wizard

${c.bold}Examples:${c.reset}
  claudebridge start              # start all services
  claudebridge stop telegram      # stop only telegram bot
  claudebridge restart scheduler  # restart scheduler
  claudebridge status             # show status table
`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command, target] = process.argv.slice(2);

  switch (command) {
    case "start": {
      const services = resolveServices(target);
      console.log(`\n${c.bold}Starting services...${c.reset}`);
      for (const svc of services) await startService(svc);
      console.log();
      break;
    }
    case "stop": {
      const services = resolveServices(target);
      console.log(`\n${c.bold}Stopping services...${c.reset}`);
      for (const svc of services) await stopService(svc);
      console.log();
      break;
    }
    case "restart": {
      const services = resolveServices(target);
      console.log(`\n${c.bold}Restarting services...${c.reset}`);
      for (const svc of services) await stopService(svc);
      for (const svc of services) await startService(svc);
      console.log();
      break;
    }
    case "status":
      statusAll();
      break;
    case "logs":
      showLogs(target);
      break;
    case "setup":
      await runSetup();
      break;
    default:
      printUsage();
      break;
  }
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
