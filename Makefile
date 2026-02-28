.PHONY: help setup install setup-vps deploy telegram discord scheduler stop-all status

SHELL := /bin/bash
ENV_FILE := .env
VPS_HOST ?= $(shell grep VPS_HOST $(ENV_FILE) 2>/dev/null | cut -d= -f2)
VPS_USER ?= $(shell grep VPS_USER $(ENV_FILE) 2>/dev/null | cut -d= -f2)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: ## Run interactive setup wizard
	python3 setup.py

install: ## Install all Python dependencies locally
	python3 -m venv .venv
	.venv/bin/pip install --upgrade pip
	.venv/bin/pip install -r bots/telegram/requirements.txt
	.venv/bin/pip install -r bots/discord/requirements.txt
	.venv/bin/pip install -r scheduler/requirements.txt
	@echo "\n✓ All dependencies installed. Activate with: source .venv/bin/activate"

setup-vps: ## Run VPS setup script (requires SSH access)
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	@test -n "$(VPS_USER)" || (echo "Error: VPS_USER not set. Check .env" && exit 1)
	scp infra/setup-vps.sh $(VPS_USER)@$(VPS_HOST):/tmp/setup-vps.sh
	ssh $(VPS_USER)@$(VPS_HOST) 'sudo bash /tmp/setup-vps.sh'

deploy: ## Deploy project to VPS
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	bash scripts/deploy.sh

auth: ## Authenticate Claude Code on VPS via SSH tunnel
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	bash scripts/auth-helper.sh $(VPS_USER)@$(VPS_HOST)

telegram: ## Run Telegram bot locally
	.venv/bin/python bots/telegram/bot.py

discord: ## Run Discord bot locally
	.venv/bin/python bots/discord/bot.py

scheduler: ## Run scheduler locally
	.venv/bin/python scheduler/scheduler.py

scheduler-once: ## Run scheduler one-shot (check and run due tasks)
	.venv/bin/python scheduler/scheduler.py --once

status: ## Check status of services on VPS
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	ssh $(VPS_USER)@$(VPS_HOST) 'systemctl status telegram-bot discord-bot scheduler --no-pager' || true

stop-all: ## Stop all services on VPS
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	ssh $(VPS_USER)@$(VPS_HOST) 'sudo systemctl stop telegram-bot discord-bot scheduler'

logs: ## Tail logs from VPS services
	@test -n "$(VPS_HOST)" || (echo "Error: VPS_HOST not set. Check .env" && exit 1)
	ssh $(VPS_USER)@$(VPS_HOST) 'sudo journalctl -u telegram-bot -u discord-bot -u scheduler -f --no-pager'

lint: ## Run linting on Python code
	.venv/bin/python -m py_compile lib/claude_bridge.py
	.venv/bin/python -m py_compile bots/telegram/bot.py
	.venv/bin/python -m py_compile bots/discord/bot.py
	.venv/bin/python -m py_compile scheduler/scheduler.py
	@echo "✓ All files compile successfully"
