# claude-vps-agent

Run Claude Code on your own VPS with Telegram/Discord bot integrations, task scheduling, and MCP server support. 100% legal, no ban risk.

## Why?

You want the functionality of remote AI agents (messaging integration, autonomous tasks, browser automation) but without violating Anthropic's Terms of Service. This project uses **only the official Claude Code CLI** — specifically `claude -p` (headless mode), which is explicitly designed for scripting and automation.

**What's legal:**
- Running Claude Code on a VPS via SSH ✅
- Using `claude -p` for automation ✅
- Building bot wrappers around `claude -p` ✅
- Using MCP servers ✅

**What's NOT legal:**
- Stealing OAuth tokens ❌
- Spoofing Claude Code client headers ❌
- Using unofficial third-party tools that bypass auth ❌

## Features

| Module | Description |
|--------|-------------|
| **Telegram Bot** | Message Claude from Telegram. Supports allowed users, typing indicators, long message splitting. |
| **Discord Bot** | Slash commands (`/ask`, `/project`, `/model`). Thread-per-conversation. |
| **Scheduler** | YAML-based cron tasks. Daily code reviews, dependency checks, custom prompts. |
| **Infra** | One-command VPS setup. SSH hardening, firewall, Fail2Ban, systemd services. |
| **MCP Configs** | Pre-configured MCP servers for GitHub, filesystem, search, memory. |

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/yourusername/claude-vps-agent.git
cd claude-vps-agent

# Option A: Interactive setup wizard (recommended)
make setup            # or: python3 setup.py

# Option B: Manual configuration
cp .env.example .env
# Edit .env with your tokens and VPS details
```

The setup wizard walks you through module selection, token configuration, dependency installation, and verification -- all in one step.

### 2. Local development

```bash
make install          # Create venv and install all deps
make telegram         # Run Telegram bot locally
make discord          # Run Discord bot locally
make scheduler        # Run scheduler locally
```

### 3. Deploy to VPS

```bash
# First time: provision the VPS
make setup-vps

# Authenticate Claude Code on VPS
make auth

# Deploy and start services
make deploy

# Check status
make status
```

### 4. Docker (alternative)

```bash
docker compose --profile telegram up -d    # Start Telegram bot
docker compose --profile discord up -d     # Start Discord bot
docker compose --profile scheduler up -d   # Start scheduler
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Telegram    │────▶│              │────▶│                 │
│  Bot         │◀────│  Claude      │◀────│  Claude Code    │
└─────────────┘     │  Bridge      │     │  CLI (claude -p) │
┌─────────────┐     │              │     │                 │
│  Discord     │────▶│  (lib/       │────▶│  Your project   │
│  Bot         │◀────│   claude_    │◀────│  files on VPS   │
└─────────────┘     │   bridge.py) │     │                 │
┌─────────────┐     │              │     │                 │
│  Scheduler   │────▶│              │────▶│                 │
│  (cron)      │◀────│              │◀────│                 │
└─────────────┘     └──────────────┘     └─────────────────┘
```

All integrations go through `lib/claude_bridge.py`, which wraps `claude -p` with:
- JSON output parsing
- Timeout handling
- Error recovery
- Async support for bot event loops

## Configuration

All config is via environment variables. See [`.env.example`](.env.example) for all options.

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | For Telegram | Get from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USERS` | For Telegram | Comma-separated Telegram user IDs |
| `DISCORD_BOT_TOKEN` | For Discord | Get from [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_ALLOWED_USERS` | For Discord | Comma-separated Discord user IDs |
| `CLAUDE_PROJECT_DIR` | Yes | Directory Claude works in on VPS |
| `CLAUDE_MODEL` | No | Model to use (default: system default) |
| `CLAUDE_ALLOWED_TOOLS` | No | Comma-separated tool whitelist |
| `CLAUDE_MAX_BUDGET_USD` | No | Max spend per request |

## VPS Setup

Recommended: **Hetzner CX22** (~€4/month, 2 vCPU, 4GB RAM)

The setup script (`infra/setup-vps.sh`) handles:
- System updates and essential packages
- Dedicated `claude` user with SSH keys
- SSH hardening (no root login, no password auth)
- UFW firewall (ports 22 + 443 only)
- Fail2Ban for brute-force protection
- Node.js and Claude Code CLI installation
- tmux for persistent sessions

**Mobile access:**
- Android: Termux → SSH → tmux attach
- iPhone: Termius → SSH → tmux attach

## MCP Servers

Pre-configured MCP server templates in `config/mcp-servers.json`:

| Server | Purpose |
|--------|---------|
| Filesystem | File access for Claude |
| GitHub | Issues, PRs, repos |
| Brave Search | Web search |
| SQLite | Database access |
| Memory | Persistent knowledge graph |

Copy to your Claude Code config:
```bash
cp config/mcp-servers.json ~/.claude/mcp-servers.json
```

## Costs

| Component | Monthly cost |
|-----------|-------------|
| Claude Max subscription | $100 |
| Hetzner VPS (CX22) | ~€4 |
| Tailscale | Free (personal) |
| Telegram Bot API | Free |
| Discord Bot | Free |
| **Total** | **~$105/mo** |

## Security

- All auth via SSH keys (no passwords)
- Firewall allows only ports 22 and 443
- Fail2Ban blocks brute-force attempts
- Bot access restricted to allowed user IDs
- Optional: Tailscale for zero-trust VPN
- No OAuth tokens or credentials are shared with third parties

## License

MIT
