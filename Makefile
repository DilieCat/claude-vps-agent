.PHONY: help setup install telegram discord scheduler scheduler-once start stop restart status logs lint provision-remote deploy-remote auth-remote

SHELL := /bin/bash
ENV_FILE := .env

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
	npx tsx setup.ts

install: ## Install all Node.js dependencies
	npm install

# ---------------------------------------------------------------------------
# Run services locally
# ---------------------------------------------------------------------------

telegram: ## Run Telegram bot
	npx tsx src/bots/telegram.ts

discord: ## Run Discord bot
	npx tsx src/bots/discord.ts

scheduler: ## Run scheduler
	npx tsx src/scheduler.ts

scheduler-once: ## Run scheduler one-shot (check and run due tasks)
	npx tsx src/scheduler.ts --once

# ---------------------------------------------------------------------------
# Service management (works with systemd or local processes)
# ---------------------------------------------------------------------------

start: ## Start all enabled services (stops existing ones first)
	@$(MAKE) stop --no-print-directory 2>/dev/null || true
	@mkdir -p .pids
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
		if [ -f src/bots/telegram.ts ]; then \
			npx tsx src/bots/telegram.ts & echo $$! > .pids/telegram-bot.pid; echo "  telegram-bot: started (PID $$!)"; \
		fi; \
		if [ -f src/bots/discord.ts ]; then \
			npx tsx src/bots/discord.ts & echo $$! > .pids/discord-bot.pid; echo "  discord-bot: started (PID $$!)"; \
		fi; \
		if [ -f src/scheduler.ts ]; then \
			npx tsx src/scheduler.ts & echo $$! > .pids/scheduler.pid; echo "  scheduler: started (PID $$!)"; \
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
		pkill -f 'src/bots/telegram.ts' 2>/dev/null && echo "  telegram-bot: stopped" || echo "  telegram-bot: not running"; \
		pkill -f 'src/bots/discord.ts' 2>/dev/null && echo "  discord-bot: stopped" || echo "  discord-bot: not running"; \
		pkill -f 'src/scheduler.ts' 2>/dev/null && echo "  scheduler: stopped" || echo "  scheduler: not running"; \
		rm -f .pids/*.pid 2>/dev/null; \
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
		pgrep -fa 'src/bots/telegram.ts' >/dev/null 2>&1 && echo "  telegram-bot: running" || echo "  telegram-bot: not running"; \
		pgrep -fa 'src/bots/discord.ts' >/dev/null 2>&1 && echo "  discord-bot: running" || echo "  discord-bot: not running"; \
		pgrep -fa 'src/scheduler.ts' >/dev/null 2>&1 && echo "  scheduler: running" || echo "  scheduler: not running"; \
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

lint: ## Run TypeScript type checking
	npx tsc --noEmit

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
