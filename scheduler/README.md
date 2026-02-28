# Scheduler

YAML-based task scheduler for Claude Code. Define tasks with cron schedules, and the scheduler dispatches prompts to Claude via `ClaudeBridge`.

## Setup

```bash
pip install -r scheduler/requirements.txt
```

Ensure `.env` is configured at the project root with `CLAUDE_PROJECT_DIR`, `CLAUDE_MODEL`, and `CLAUDE_ALLOWED_TOOLS`.

## Usage

```bash
# One-shot: run all due tasks, then exit
python scheduler/scheduler.py --once

# Daemon mode: check every 60 seconds
python scheduler/scheduler.py

# Custom interval (120 seconds)
python scheduler/scheduler.py --interval 120

# List tasks and next run times
python scheduler/scheduler.py --list

# Custom tasks file
python scheduler/scheduler.py --tasks /path/to/tasks.yaml
```

## Task Definition

Edit `tasks.yaml` to define scheduled tasks:

```yaml
tasks:
  - name: daily-code-review
    schedule: "0 9 * * 1-5"       # cron expression
    prompt: "Review recent commits..."
    project_dir: /home/user/project  # optional, defaults to CLAUDE_PROJECT_DIR
    allowed_tools: "Read,Bash,Glob"  # optional, defaults to CLAUDE_ALLOWED_TOOLS
    model: claude-sonnet-4-6          # optional, defaults to CLAUDE_MODEL
    max_budget_usd: 0.50             # optional
    timeout_seconds: 600             # optional, default 300
    enabled: true                    # optional, default true
```

## Logs

All task results are written to `scheduler/logs/`:
- `scheduler.log` — main scheduler log
- `<task_name>_<timestamp>.log` — per-execution output

## Running as a Service

Use the systemd unit in `infra/systemd/` or run directly:

```bash
nohup python scheduler/scheduler.py &
```
