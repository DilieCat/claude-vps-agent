# claude-agent

Run Claude Code as a persistent agent on any machine -- VPS, homelab, laptop, or server. Includes Telegram/Discord bot integrations, task scheduling, and MCP server support. 100% official, no ban risk.

## Why?

You want the functionality of remote AI agents (messaging integration, autonomous tasks, browser automation) but without violating Anthropic's Terms of Service. This project uses **only the official Claude Code CLI** -- specifically `claude -p` (headless mode), which is explicitly designed for scripting and automation.

**What's legal:**
- Running Claude Code on any server or machine via `claude -p`
- Building bot wrappers and automations around the CLI
- Using MCP servers for extended capabilities

**What's NOT legal:**
- Stealing OAuth tokens
- Spoofing Claude Code client headers
- Using unofficial third-party tools that bypass auth

## Features

| Module | Description |
|--------|-------------|
| **Telegram Bot** | Message Claude from Telegram. Supports allowed users, typing indicators, long message splitting. |
| **Discord Bot** | Slash commands (`/ask`, `/project`, `/model`). Thread-per-conversation. |
| **Scheduler** | YAML-based cron tasks. Daily code reviews, dependency checks, custom prompts. |
| **Living Agent** | Persistent memory (brain system), session continuity, proactive notifications. |
| **Infra** | Optional server provisioning script. SSH hardening, firewall, Fail2Ban, systemd services. |
| **MCP Configs** | Pre-configured MCP servers for GitHub, filesystem, search, memory. |

## Quick Start

```bash
git clone https://github.com/yourusername/claude-agent.git
cd claude-agent
npm install
npx tsx setup.ts
```

The setup wizard walks you through module selection, token configuration, dependency installation, and verification -- all in one step.

That's it. Once setup is done, start your services:

```bash
make telegram         # Run Telegram bot
make discord          # Run Discord bot
make scheduler        # Run scheduler
make start            # Start all enabled services
```

## Tech Stack

- **TypeScript** -- all source code in `src/`
- **telegraf** -- Telegram bot framework
- **discord.js** -- Discord bot framework
- **croner** -- cron scheduling
- **dotenv** -- environment variable loading
- **tsx** -- TypeScript execution without a compile step

## Architecture

```
                       +----------------+     +-------------------+
  Telegram Bot ------->|                |---->|                   |
                <------|  Claude Bridge |<----|  Claude Code CLI  |
  Discord Bot -------->|                |---->|  (claude -p)      |
                <------|  (src/lib/     |<----|                   |
  Scheduler ---------->|   claude-      |---->|  Your project     |
                <------|   bridge.ts)   |<----|  files             |
                       +----------------+     +-------------------+
```

All integrations go through `src/lib/claude-bridge.ts`, which wraps `claude -p` with:
- JSON output parsing
- Timeout handling
- Error recovery
- Async support for bot event loops

## Configuration

All config is via environment variables. Run `npx tsx setup.ts` or see [`.env.example`](.env.example) for all options.

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | For Telegram | Get from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USERS` | For Telegram | Comma-separated Telegram user IDs |
| `DISCORD_BOT_TOKEN` | For Discord | Get from [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_ALLOWED_USERS` | For Discord | Comma-separated Discord user IDs |
| `CLAUDE_PROJECT_DIR` | Yes | Directory Claude works in |
| `CLAUDE_MODEL` | No | Model to use (default: system default) |
| `CLAUDE_ALLOWED_TOOLS` | No | Comma-separated tool whitelist |
| `CLAUDE_MAX_BUDGET_USD` | No | Max spend per request |

## Service Management

The Makefile auto-detects whether systemd is available and adapts accordingly:

```bash
make start            # Start all enabled services
make stop             # Stop all services
make restart          # Restart all services
make status           # Show service status
make logs             # Tail service logs (systemd only)
```

On a systemd-based server, these use `systemctl`. On a laptop or non-systemd machine, they manage background processes directly.

## Living Agent

Living agent mode activates automatically when the brain system is available. This mode adds persistent memory, session continuity, and proactive notifications.

**Brain system** -- Claude maintains a persistent markdown memory in `data/brain.md`, loaded before every interaction. This lets it remember context, preferences, and ongoing work across conversations.

**Session continuity** -- Per-user session tracking stores each user's Claude session ID. Conversations resume automatically via `claude --resume`, so context is preserved between messages.

**LivingBridge** -- An enhanced `ClaudeBridge` that combines brain loading, session management, and event logging into a single interface. Each user gets their own bridge instance with independent `/project` and `/model` settings.

**Notification queue** -- The scheduler can push proactive messages to bot users (e.g. task results, reminders). Users opt in/out with `/notify`.

**Bot commands:**

| Command | Description |
|---------|-------------|
| `/reset` | Clear your session and start fresh |
| `/brain` | View the current brain state |
| `/notify` | Toggle proactive notifications on/off |

**Security:**
- `ALLOWED_PROJECT_BASE` restricts which directories `/project` can switch to
- File locking (`src/lib/filelock.ts`) ensures multi-process safety for shared state files (brain, sessions)

## Remote Deployment (Advanced)

If you want to run this on a remote server managed from your laptop:

```bash
# 1. Provision the server (installs deps, hardens SSH, sets up firewall)
make provision-remote

# 2. Authenticate Claude Code on the server via SSH tunnel
make auth-remote

# 3. Deploy and start services
make deploy-remote

# 4. Check status
make status
```

The provisioning script (`infra/setup-vps.sh`) handles: system updates, dedicated user creation, SSH hardening, UFW firewall, Fail2Ban, Node.js and Claude Code CLI installation, and tmux for persistent sessions.

Recommended for remote hosting: **Hetzner CX22** (~4 EUR/month, 2 vCPU, 4GB RAM).

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

## Security

- Bot access restricted to allowed user IDs
- No OAuth tokens or credentials are shared with third parties
- Uses only the official Claude Code CLI
- Optional: SSH key-only auth, firewall, Fail2Ban (via provisioning script)
- Optional: Tailscale for zero-trust VPN

## License

MIT
