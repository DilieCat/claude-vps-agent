/**
 * scheduler.ts — YAML-based task scheduler for Claude Code.
 *
 * Reads task definitions from tasks.yaml, checks cron schedules,
 * and dispatches prompts to Claude via LivingBridge (brain-aware,
 * session-persistent) with fallback to ClaudeBridge. Pushes results
 * to the notification queue for delivery by platform bots.
 *
 * Usage:
 *    # One-shot: check and run all due tasks, then exit
 *    npx tsx src/scheduler.ts --once
 *
 *    # Daemon mode: run continuously with cron jobs active
 *    npx tsx src/scheduler.ts
 *
 *    # Custom check interval (seconds, for --once polling)
 *    npx tsx src/scheduler.ts --interval 120
 *
 *    # Custom tasks file
 *    npx tsx src/scheduler.ts --tasks /path/to/tasks.yaml
 *
 *    # List tasks and next run times
 *    npx tsx src/scheduler.ts --list
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import yaml from "js-yaml";
import { Cron } from "croner";
import dotenv from "dotenv";
import {
  ClaudeBridge,
  LivingBridge,
  NotificationQueue,
  Brain,
} from "./lib/index.js";
import type { ClaudeResponse } from "./lib/index.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCHEDULER_DIR = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "..",
  "scheduler",
);
const PROJECT_ROOT = path.resolve(SCHEDULER_DIR, "..");
const DEFAULT_TASKS_FILE = path.join(SCHEDULER_DIR, "tasks.yaml");
const LOGS_DIR = path.join(SCHEDULER_DIR, "logs");
const STATE_FILE = path.join(LOGS_DIR, ".last_run.json");
const LOG_FILE = path.join(LOGS_DIR, "scheduler.log");

// ---------------------------------------------------------------------------
// Ensure directories
// ---------------------------------------------------------------------------
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Ignore file-write errors for logging
  }
}

const logger = {
  info: (msg: string) => log("INFO", msg),
  warn: (msg: string) => log("WARN", msg),
  error: (msg: string) => log("ERROR", msg),
  debug: (msg: string) => log("DEBUG", msg),
};

// ---------------------------------------------------------------------------
// Load environment
// ---------------------------------------------------------------------------
const envPath = path.join(PROJECT_ROOT, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// ---------------------------------------------------------------------------
// Task interface
// ---------------------------------------------------------------------------
interface ScheduledTask {
  name: string;
  schedule: string;
  prompt: string;
  projectDir: string;
  allowedTools: string[] | undefined;
  model: string | undefined;
  maxBudgetUsd: number | undefined;
  timeoutSeconds: number;
  enabled: boolean;
  notify: boolean;
  notifyPlatforms: string[];
}

// ---------------------------------------------------------------------------
// State management — track last run times per task
// ---------------------------------------------------------------------------
function loadState(): Record<string, string> {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(state: Record<string, string>): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Task loading & validation
// ---------------------------------------------------------------------------
interface TasksYaml {
  tasks: Array<Record<string, unknown>>;
}

function loadTasks(tasksFile: string): ScheduledTask[] {
  if (!fs.existsSync(tasksFile)) {
    logger.error(`Tasks file not found: ${tasksFile}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(tasksFile, "utf-8");
  const data = yaml.load(raw) as TasksYaml | null;

  if (!data || !data.tasks) {
    logger.error("Invalid tasks file: must contain a top-level 'tasks' key");
    process.exit(1);
  }

  const tasks: ScheduledTask[] = [];

  for (let i = 0; i < data.tasks.length; i++) {
    const task = data.tasks[i];
    const name = (task["name"] as string) ?? `task_${i}`;

    if (!task["prompt"]) {
      logger.warn(`Task '${name}' has no prompt -- skipping`);
      continue;
    }
    if (!task["schedule"]) {
      logger.warn(`Task '${name}' has no schedule -- skipping`);
      continue;
    }

    // Validate cron expression
    const schedule = task["schedule"] as string;
    try {
      // Croner validates on construction; we create a throwaway instance
      new Cron(schedule);
    } catch (exc) {
      logger.warn(`Task '${name}' has invalid cron '${schedule}': ${exc} -- skipping`);
      continue;
    }

    // Parse allowed_tools: can be string (comma-separated) or array
    let allowedTools: string[] | undefined;
    if (typeof task["allowed_tools"] === "string") {
      allowedTools = task["allowed_tools"]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (Array.isArray(task["allowed_tools"])) {
      allowedTools = task["allowed_tools"] as string[];
    }

    tasks.push({
      name,
      schedule,
      prompt: task["prompt"] as string,
      projectDir:
        (task["project_dir"] as string) ??
        process.env["CLAUDE_PROJECT_DIR"] ??
        process.cwd(),
      allowedTools,
      model: task["model"] as string | undefined,
      maxBudgetUsd: task["max_budget_usd"] as number | undefined,
      timeoutSeconds: (task["timeout_seconds"] as number) ?? 300,
      enabled: (task["enabled"] as boolean) ?? true,
      notify: (task["notify"] as boolean) ?? true,
      notifyPlatforms:
        (task["notify_platforms"] as string[]) ?? ["telegram", "discord"],
    });
  }

  logger.info(`Loaded ${tasks.length} valid task(s) from ${tasksFile}`);
  return tasks;
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------
function isDue(task: ScheduledTask, state: Record<string, string>, now: Date): boolean {
  if (!task.enabled) return false;

  const lastRunStr = state[task.name];
  const baseTime = lastRunStr ? new Date(lastRunStr) : new Date(now.getTime() - 60_000);

  // Use croner to get the next scheduled time after baseTime
  const cron = new Cron(task.schedule);
  const nextTime = cron.nextRun(baseTime);
  if (!nextTime) return false;

  return nextTime <= now;
}

function makeBridge(task: ScheduledTask): ClaudeBridge | LivingBridge {
  const opts = {
    projectDir: task.projectDir,
    model: task.model,
    allowedTools: task.allowedTools,
    maxBudgetUsd: task.maxBudgetUsd,
    timeoutSeconds: task.timeoutSeconds,
  };

  try {
    const bridge = new LivingBridge(opts);
    logger.debug(`Using LivingBridge for task '${task.name}'`);
    return bridge;
  } catch (exc) {
    logger.warn(`LivingBridge unavailable (${exc}), falling back to ClaudeBridge`);
    return new ClaudeBridge(opts);
  }
}

let notifier: NotificationQueue | null = null;

function getNotifier(): NotificationQueue {
  if (!notifier) {
    notifier = new NotificationQueue();
  }
  return notifier;
}

function runTask(task: ScheduledTask): void {
  logger.info(`>>> Running task: ${task.name}`);

  const bridge = makeBridge(task);

  // Use the sync brain-aware path when available
  let response: ClaudeResponse;
  if (bridge instanceof LivingBridge) {
    response = bridge.askAsSync("scheduler", task.name, task.prompt);
  } else {
    response = bridge.ask(task.prompt);
  }

  // Write result to a per-task log file
  const safeName = task.name.replace(/ /g, "_").replace(/\//g, "_");
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const logFile = path.join(LOGS_DIR, `${safeName}_${timestamp}.log`);

  const logContent = [
    `Task: ${task.name}`,
    `Time: ${timestamp}`,
    `Schedule: ${task.schedule}`,
    `Project: ${task.projectDir}`,
    `Exit code: ${response.exitCode}`,
    `Cost: $${response.costUsd.toFixed(4)}`,
    `Duration: ${response.durationMs}ms`,
    `Error: ${response.isError}`,
    "=".repeat(60),
    response.text,
    "",
  ].join("\n");
  fs.writeFileSync(logFile, logContent);

  // --- Log to brain ---
  let brain: Brain;
  if (bridge instanceof LivingBridge) {
    brain = bridge.brain;
  } else {
    brain = new Brain();
  }

  if (response.isError) {
    logger.error(
      `Task '${task.name}' failed (exit ${response.exitCode}): ${response.text.slice(0, 200)}`,
    );
    brain.addEvent(
      `[scheduler] Task '${task.name}' FAILED (exit ${response.exitCode}): ${response.text.slice(0, 120)}`,
    );
  } else {
    logger.info(
      `Task '${task.name}' completed -- cost=$${response.costUsd.toFixed(4)}, ${response.text.length} chars`,
    );
    brain.addEvent(
      `[scheduler] Task '${task.name}' completed (cost=$${response.costUsd.toFixed(4)}, ${response.text.length} chars)`,
    );
  }

  // --- Push to notification queue ---
  if (task.notify) {
    const nq = getNotifier();
    const source = `scheduler:${task.name}`;

    let notifMsg: string;
    if (response.isError) {
      const summary = response.text.slice(0, 300);
      notifMsg = `[Scheduled Task Failed] ${task.name}\n\n${summary}`;
    } else {
      let summary = response.text.slice(0, 500);
      if (response.text.length > 500) {
        summary += "\n\n(truncated -- full output in scheduler logs)";
      }
      notifMsg = `[Scheduled Task] ${task.name}\n\n${summary}`;
    }

    for (const platform of task.notifyPlatforms) {
      nq.pushBroadcast(platform, notifMsg, source);
    }
  }
}

function checkAndRun(
  tasks: ScheduledTask[],
  state: Record<string, string>,
): Record<string, string> {
  const now = new Date();

  for (const task of tasks) {
    if (isDue(task, state, now)) {
      runTask(task);
      state[task.name] = now.toISOString();
      saveState(state);
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const { values: args } = parseArgs({
    options: {
      tasks: { type: "string", short: "t", default: DEFAULT_TASKS_FILE },
      once: { type: "boolean", default: false },
      interval: { type: "string", short: "i", default: "60" },
      list: { type: "boolean", default: false },
    },
    strict: true,
  });

  const tasksFile = args.tasks!;
  const interval = parseInt(args.interval!, 10);

  const tasks = loadTasks(tasksFile);
  const state = loadState();

  // --list: display tasks and exit
  if (args.list) {
    const now = new Date();
    const header = `${"Name".padEnd(30)} ${"Enabled".padEnd(9)} ${"Schedule".padEnd(20)} Next Run`;
    console.log(header);
    console.log("-".repeat(90));

    for (const task of tasks) {
      const lastRunStr = state[task.name];
      const baseTime = lastRunStr
        ? new Date(lastRunStr)
        : new Date(now.getTime() - 60_000);
      const cron = new Cron(task.schedule);
      const nextRun = cron.nextRun(baseTime);
      const nextRunStr = nextRun
        ? `${nextRun.getFullYear()}-${String(nextRun.getMonth() + 1).padStart(2, "0")}-${String(nextRun.getDate()).padStart(2, "0")} ${String(nextRun.getHours()).padStart(2, "0")}:${String(nextRun.getMinutes()).padStart(2, "0")}`
        : "N/A";

      console.log(
        `${task.name.padEnd(30)} ${String(task.enabled).padEnd(9)} ${task.schedule.padEnd(20)} ${nextRunStr}`,
      );
    }
    return;
  }

  // --once: one-shot mode
  if (args.once) {
    logger.info("One-shot mode: checking for due tasks");
    checkAndRun(tasks, state);
    logger.info("One-shot complete");
    return;
  }

  // Daemon mode: use croner to schedule jobs
  logger.info(`Daemon mode: scheduling ${tasks.length} task(s) via cron (Ctrl+C to stop)`);

  const jobs: Cron[] = [];

  for (const task of tasks) {
    if (!task.enabled) {
      logger.info(`Skipping disabled task '${task.name}'`);
      continue;
    }

    const job = new Cron(task.schedule, () => {
      try {
        runTask(task);
        const s = loadState();
        s[task.name] = new Date().toISOString();
        saveState(s);
      } catch (err) {
        logger.error(`Error running task '${task.name}': ${err}`);
      }
    });

    jobs.push(job);
    const nextRun = job.nextRun();
    logger.info(
      `Scheduled '${task.name}' (${task.schedule}) -- next: ${nextRun?.toISOString() ?? "N/A"}`,
    );
  }

  // Handle shutdown signals
  let running = true;
  const shutdown = (signal: string) => {
    if (!running) return;
    running = false;
    logger.info(`Received ${signal}, shutting down...`);
    for (const job of jobs) {
      job.stop();
    }
    logger.info("Scheduler stopped");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Also support a fallback polling loop for any edge cases
  // (croner handles scheduling, but we keep the process alive)
  if (jobs.length === 0) {
    logger.info("No enabled tasks -- exiting");
    return;
  }

  // Keep the process alive by setting a periodic heartbeat
  const heartbeat = setInterval(() => {
    if (!running) {
      clearInterval(heartbeat);
    }
  }, interval * 1000);

  // Ensure the heartbeat timer doesn't prevent natural exit
  heartbeat.unref();
}

main();
