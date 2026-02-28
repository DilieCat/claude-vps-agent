#!/usr/bin/env python3
"""
scheduler.py — YAML-based task scheduler for Claude Code.

Reads task definitions from tasks.yaml, checks cron schedules,
and dispatches prompts to Claude via LivingBridge (brain-aware,
session-persistent) with fallback to ClaudeBridge. Pushes results
to the notification queue for delivery by platform bots.

Usage:
    # One-shot: check and run all due tasks, then exit
    python scheduler.py --once

    # Daemon mode: run continuously, checking every 60s
    python scheduler.py

    # Custom check interval (seconds)
    python scheduler.py --interval 120

    # Custom tasks file
    python scheduler.py --tasks /path/to/tasks.yaml
"""

import argparse
import datetime
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path

import yaml
from croniter import croniter
from dotenv import load_dotenv

# Import bridge and support modules from project lib
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.claude_bridge import ClaudeBridge, LivingBridge
from lib.notifier import NotificationQueue

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCHEDULER_DIR = Path(__file__).resolve().parent
DEFAULT_TASKS_FILE = SCHEDULER_DIR / "tasks.yaml"
LOGS_DIR = SCHEDULER_DIR / "logs"
STATE_FILE = SCHEDULER_DIR / "logs" / ".last_run.json"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOGS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOGS_DIR / "scheduler.log"),
    ],
)
logger = logging.getLogger("scheduler")

# ---------------------------------------------------------------------------
# Load environment
# ---------------------------------------------------------------------------
# Walk up to find .env (project root)
_env_path = SCHEDULER_DIR.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)


# ---------------------------------------------------------------------------
# State management — track last run times per task
# ---------------------------------------------------------------------------

def load_state() -> dict:
    """Load last-run timestamps from disk."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(state: dict) -> None:
    """Persist last-run timestamps to disk."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Task loading & validation
# ---------------------------------------------------------------------------

def load_tasks(tasks_file: Path) -> list[dict]:
    """Load and validate task definitions from a YAML file."""
    if not tasks_file.exists():
        logger.error("Tasks file not found: %s", tasks_file)
        sys.exit(1)

    with open(tasks_file) as f:
        data = yaml.safe_load(f)

    if not data or "tasks" not in data:
        logger.error("Invalid tasks file: must contain a top-level 'tasks' key")
        sys.exit(1)

    tasks = []
    for i, task in enumerate(data["tasks"]):
        name = task.get("name", f"task_{i}")

        if "prompt" not in task:
            logger.warning("Task '%s' has no prompt — skipping", name)
            continue
        if "schedule" not in task:
            logger.warning("Task '%s' has no schedule — skipping", name)
            continue

        # Validate cron expression
        try:
            croniter(task["schedule"])
        except (ValueError, KeyError) as exc:
            logger.warning("Task '%s' has invalid cron '%s': %s — skipping",
                           name, task.get("schedule"), exc)
            continue

        tasks.append({
            "name": name,
            "schedule": task["schedule"],
            "prompt": task["prompt"],
            "project_dir": task.get("project_dir", os.getenv("CLAUDE_PROJECT_DIR", os.getcwd())),
            "allowed_tools": task.get("allowed_tools"),
            "model": task.get("model"),
            "max_budget_usd": task.get("max_budget_usd"),
            "timeout_seconds": task.get("timeout_seconds", 300),
            "enabled": task.get("enabled", True),
            "notify": task.get("notify", True),
            "notify_platforms": task.get("notify_platforms", ["telegram", "discord"]),
        })

    logger.info("Loaded %d valid task(s) from %s", len(tasks), tasks_file)
    return tasks


# ---------------------------------------------------------------------------
# Task execution
# ---------------------------------------------------------------------------

def is_due(task: dict, state: dict, now: datetime.datetime) -> bool:
    """Check if a task is due to run based on its cron schedule."""
    if not task["enabled"]:
        return False

    last_run_str = state.get(task["name"])
    if last_run_str is None:
        # Never run before — check if the current minute matches the cron
        cron = croniter(task["schedule"], now - datetime.timedelta(minutes=1))
        next_time = cron.get_next(datetime.datetime)
        return next_time <= now

    last_run = datetime.datetime.fromisoformat(last_run_str)
    cron = croniter(task["schedule"], last_run)
    next_time = cron.get_next(datetime.datetime)
    return next_time <= now


def _make_bridge(task: dict) -> ClaudeBridge | LivingBridge:
    """Create a LivingBridge for the task, falling back to ClaudeBridge."""
    allowed_tools = task.get("allowed_tools")
    if isinstance(allowed_tools, str):
        allowed_tools = [t.strip() for t in allowed_tools.split(",") if t.strip()]

    kwargs = dict(
        project_dir=task["project_dir"],
        model=task.get("model"),
        allowed_tools=allowed_tools,
        max_budget_usd=task.get("max_budget_usd"),
        timeout_seconds=task.get("timeout_seconds", 300),
    )

    try:
        bridge = LivingBridge(**kwargs)
        logger.debug("Using LivingBridge for task '%s'", task["name"])
        return bridge
    except Exception as exc:
        logger.warning("LivingBridge unavailable (%s), falling back to ClaudeBridge", exc)
        return ClaudeBridge(**kwargs)


# Shared instances — initialised lazily in run_task
_notifier: NotificationQueue | None = None
_brain = None  # lib.brain.Brain


def _get_notifier() -> NotificationQueue:
    global _notifier
    if _notifier is None:
        _notifier = NotificationQueue()
    return _notifier


def _get_brain():
    global _brain
    if _brain is None:
        from lib.brain import Brain
        _brain = Brain()
    return _brain


def run_task(task: dict) -> None:
    """Execute a single scheduled task via LivingBridge and log the result.

    After execution:
    - Logs a brain event via brain.add_event()
    - Pushes the result to the notification queue (if task.notify is True)
    """
    logger.info(">>> Running task: %s", task["name"])

    bridge = _make_bridge(task)

    # Use the sync brain-aware path when available
    if isinstance(bridge, LivingBridge):
        response = bridge.ask_as_sync("scheduler", task["name"], task["prompt"])
    else:
        response = bridge.ask(task["prompt"])

    # Write result to a per-task log file
    safe_name = task["name"].replace(" ", "_").replace("/", "_")
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = LOGS_DIR / f"{safe_name}_{timestamp}.log"

    log_content = (
        f"Task: {task['name']}\n"
        f"Time: {timestamp}\n"
        f"Schedule: {task['schedule']}\n"
        f"Project: {task['project_dir']}\n"
        f"Exit code: {response.exit_code}\n"
        f"Cost: ${response.cost_usd:.4f}\n"
        f"Duration: {response.duration_ms}ms\n"
        f"Error: {response.is_error}\n"
        f"{'=' * 60}\n"
        f"{response.text}\n"
    )
    log_file.write_text(log_content)

    # --- Log to brain ---
    brain = _get_brain()
    if response.is_error:
        logger.error("Task '%s' failed (exit %d): %s",
                      task["name"], response.exit_code,
                      response.text[:200])
        brain.add_event(
            f"[scheduler] Task '{task['name']}' FAILED "
            f"(exit {response.exit_code}): {response.text[:120]}"
        )
    else:
        logger.info("Task '%s' completed — cost=$%.4f, %d chars",
                     task["name"], response.cost_usd, len(response.text))
        brain.add_event(
            f"[scheduler] Task '{task['name']}' completed "
            f"(cost=${response.cost_usd:.4f}, {len(response.text)} chars)"
        )

    # --- Push to notification queue ---
    if task.get("notify", True):
        notifier = _get_notifier()
        source = f"scheduler:{task['name']}"

        # Build a concise notification message
        if response.is_error:
            summary = response.text[:300]
            notif_msg = f"[Scheduled Task Failed] {task['name']}\n\n{summary}"
        else:
            # Truncate long results for notification readability
            summary = response.text[:500]
            if len(response.text) > 500:
                summary += "\n\n(truncated — full output in scheduler logs)"
            notif_msg = f"[Scheduled Task] {task['name']}\n\n{summary}"

        for platform in task.get("notify_platforms", ["telegram", "discord"]):
            notifier.push_broadcast(platform, notif_msg, source=source)


def check_and_run(tasks: list[dict], state: dict) -> dict:
    """Check all tasks and run any that are due. Returns updated state."""
    now = datetime.datetime.now()

    for task in tasks:
        if is_due(task, state, now):
            run_task(task)
            state[task["name"]] = now.isoformat()
            save_state(state)

    return state


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Claude Code task scheduler",
    )
    parser.add_argument(
        "--tasks", "-t",
        type=Path,
        default=DEFAULT_TASKS_FILE,
        help="Path to tasks YAML file (default: tasks.yaml in scheduler dir)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run due tasks once, then exit (one-shot mode)",
    )
    parser.add_argument(
        "--interval", "-i",
        type=int,
        default=60,
        help="Check interval in seconds for daemon mode (default: 60)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all tasks and their next run times, then exit",
    )
    args = parser.parse_args()

    tasks = load_tasks(args.tasks)
    state = load_state()

    # --list: display tasks and exit
    if args.list:
        now = datetime.datetime.now()
        print(f"{'Name':<30} {'Enabled':<9} {'Schedule':<20} {'Next Run'}")
        print("-" * 90)
        for task in tasks:
            last_run_str = state.get(task["name"])
            base = (datetime.datetime.fromisoformat(last_run_str)
                    if last_run_str else now - datetime.timedelta(minutes=1))
            cron = croniter(task["schedule"], base)
            next_run = cron.get_next(datetime.datetime)
            print(f"{task['name']:<30} {str(task['enabled']):<9} "
                  f"{task['schedule']:<20} {next_run.strftime('%Y-%m-%d %H:%M')}")
        return

    # --once: one-shot mode
    if args.once:
        logger.info("One-shot mode: checking for due tasks")
        check_and_run(tasks, state)
        logger.info("One-shot complete")
        return

    # Daemon mode
    logger.info("Daemon mode: checking every %ds (Ctrl+C to stop)", args.interval)
    running = True

    def handle_signal(signum, frame):
        nonlocal running
        logger.info("Received signal %d, shutting down...", signum)
        running = False

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    while running:
        try:
            state = check_and_run(tasks, state)
        except Exception:
            logger.exception("Error during check cycle")
        time.sleep(args.interval)

    logger.info("Scheduler stopped")


if __name__ == "__main__":
    main()
