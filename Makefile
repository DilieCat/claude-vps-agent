.PHONY: help setup install telegram discord scheduler scheduler-once start stop restart status logs lint provision-remote deploy-remote auth-remote

SHELL := /bin/bash
ENV_FILE := .env
VENV := .venv/bin

# Remote deployment settings (only needed for remote-* targets)
VPS_HOST ?= $(shell grep '^VPS_HOST=' $(ENV_FILE) 2>/dev/null | cut -d= -f2 | tr -d '"')
VPS_USER ?= $(shell grep '^VPS_USER=' $(ENV_FILE) 2>/dev/null | cut -d= -f2 | tr -d '"')

# Service names matching infra/systemd/*.service
SERVICES := telegram-bot discord-bot scheduler

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Local setup
# ---------------------------------------------------------------------------

setup: ## Run interactive setup wizard
	python3 setup.py

install: ## Create venv and install all Python dependencies
	python3 -m venv .venv
	$(VENV)/pip install --upgrade pip
	$(VENV)/pip install -r bots/telegram/requirements.txt
	$(VENV)/pip install -r bots/discord/requirements.txt
	$(VENV)/pip install -r scheduler/requirements.txt
	@echo "\nAll dependencies installed. Activate with: source .venv/bin/activate"

# ---------------------------------------------------------------------------
# Run services locally
# ---------------------------------------------------------------------------

telegram: ## Run Telegram bot
	$(VENV)/python bots/telegram/bot.py

discord: ## Run Discord bot
	$(VENV)/python bots/discord/bot.py

scheduler: ## Run scheduler
	$(VENV)/python scheduler/scheduler.py

scheduler-once: ## Run scheduler one-shot (check and run due tasks)
	$(VENV)/python scheduler/scheduler.py --once

# ---------------------------------------------------------------------------
# Service management (works with systemd or local processes)
# ---------------------------------------------------------------------------

start: ## Start all enabled services
	@if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then \
		echo "Starting services via systemd..."; \
		for svc in $(SERVICES); do \
			if systemctl is-enabled $$svc.service &>/dev/null; then \
				sudo systemctl start $$svc.service && echo "  $$svc: started" || echo "  $$svc: failed"; \
			else \
				echo "  $$svc: not enabled (skip)"; \
			fi; \
		done; \
	else \
		echo "Starting services as background processes..."; \
		echo "(Use 'make stop' to stop them later)"; \
		if [ -f bots/telegram/bot.py ]; then \
			$(VENV)/python bots/telegram/bot.py & echo "  telegram-bot: started (PID $$!)"; \
		fi; \
		if [ -f bots/discord/bot.py ]; then \
			$(VENV)/python bots/discord/bot.py & echo "  discord-bot: started (PID $$!)"; \
		fi; \
		if [ -f scheduler/scheduler.py ]; then \
			$(VENV)/python scheduler/scheduler.py & echo "  scheduler: started (PID $$!)"; \
		fi; \
	fi

stop: ## Stop all services
	@if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then \
		echo "Stopping services via systemd..."; \
		for svc in $(SERVICES); do \
			sudo systemctl stop $$svc.service 2>/dev/null && echo "  $$svc: stopped" || echo "  $$svc: not running"; \
		done; \
	else \
		echo "Stopping background processes..."; \
		pkill -f 'bots/telegram/bot.py' 2>/dev/null && echo "  telegram-bot: stopped" || echo "  telegram-bot: not running"; \
		pkill -f 'bots/discord/bot.py' 2>/dev/null && echo "  discord-bot: stopped" || echo "  discord-bot: not running"; \
		pkill -f 'scheduler/scheduler.py' 2>/dev/null && echo "  scheduler: stopped" || echo "  scheduler: not running"; \
	fi

restart: ## Restart all services
	@$(MAKE) stop
	@$(MAKE) start

status: ## Show status of services
	@if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then \
		for svc in $(SERVICES); do \
			if systemctl is-enabled $$svc.service &>/dev/null; then \
				status=$$(systemctl is-active $$svc.service 2>/dev/null || true); \
				echo "  $$svc: $$status"; \
			else \
				echo "  $$svc: not installed"; \
			fi; \
		done; \
	else \
		echo "Checking local processes..."; \
		pgrep -fa 'bots/telegram/bot.py' >/dev/null 2>&1 && echo "  telegram-bot: running" || echo "  telegram-bot: not running"; \
		pgrep -fa 'bots/discord/bot.py' >/dev/null 2>&1 && echo "  discord-bot: running" || echo "  discord-bot: not running"; \
		pgrep -fa 'scheduler/scheduler.py' >/dev/null 2>&1 && echo "  scheduler: running" || echo "  scheduler: not running"; \
	fi

logs: ## Tail service logs
	@if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then \
		sudo journalctl -u telegram-bot -u discord-bot -u scheduler -f --no-pager; \
	else \
		echo "No systemd detected. Check process output directly or use 'make telegram' etc. in separate terminals."; \
	fi

# ---------------------------------------------------------------------------
# Code quality
# ---------------------------------------------------------------------------

lint: ## Run linting on Python code
	$(VENV)/python -m py_compile lib/claude_bridge.py
	$(VENV)/python -m py_compile lib/brain.py
	$(VENV)/python -m py_compile lib/session_store.py
	$(VENV)/python -m py_compile lib/notifier.py
	$(VENV)/python -m py_compile lib/filelock.py
	$(VENV)/python -m py_compile bots/telegram/bot.py
	$(VENV)/python -m py_compile bots/discord/bot.py
	$(VENV)/python -m py_compile scheduler/scheduler.py
	@echo "All files compile successfully"

# ---------------------------------------------------------------------------
# Remote deployment (for managing a remote server from your laptop)
# ---------------------------------------------------------------------------

provision-remote: ## Provision a remote server (requires VPS_HOST in .env)
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	@test -n "$(VPS_USER)" || (echo "Error: VPS_USER not set. Check .env" && exit 1)
	scp infra/setup-vps.sh $(VPS_USER)@$(VPS_HOST):/tmp/setup-vps.sh
	ssh $(VPS_USER)@$(VPS_HOST) 'sudo bash /tmp/setup-vps.sh'

deploy-remote: ## Deploy project to remote server (requires VPS_HOST in .env)
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	bash scripts/deploy.sh

auth-remote: ## Authenticate Claude Code on remote server via SSH tunnel
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	bash scripts/auth-helper.sh $(VPS_USER)@$(VPS_HOST)
