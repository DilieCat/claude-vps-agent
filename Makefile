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

install: ## Install dependencies and register claudebridge command
	npm install
	npm link 2>/dev/null || true
	@echo ""
	@echo "  ✓ Dependencies installed"
	@command -v claudebridge &>/dev/null && echo "  ✓ 'claudebridge' command registered" || echo "  ⚠ 'claudebridge' not linked (use 'npx claudebridge' instead)"

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

start: ## Start all enabled services
	npx tsx src/cli.ts start

stop: ## Stop all services
	npx tsx src/cli.ts stop

restart: ## Restart all services
	npx tsx src/cli.ts restart

status: ## Show service status
	npx tsx src/cli.ts status

logs: ## Tail service logs
	npx tsx src/cli.ts logs

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
