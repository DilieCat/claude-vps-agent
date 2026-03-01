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
| **Telegram Bot** | Message Claude from Telegram. Supports allowed users, typing indicators, long message splitting, and concurrency control. |
| **Discord Bot** | Slash commands (`/ask`, `/project`, `/model`). Thread-per-conversation. Concurrency control prevents overlapping requests. |
| **Scheduler** | YAML-based cron tasks. Daily code reviews, dependency checks, custom prompts. |
| **Living Agent** | Persistent memory (brain system), session continuity, proactive notifications. |
| **Agent Personality** | Give your agent a name and persona. First-interaction onboarding collects user preferences. |
| **Workspace Isolation** | Agent runs from `~/.claude-agent/workspace/` -- keeps your developer CLAUDE.md separate from the agent's identity. |
| **claudebridge CLI** | Process manager: start, stop, restart, status, and logs for all services. |
| **Infra** | Optional server provisioning script. SSH hardening, firewall, Fail2Ban, systemd services. |
| **MCP Configs** | Pre-configured MCP servers for GitHub, filesystem, search, memory. |

## Quick Start

```bash
git clone https://github.com/yourusername/claude-agent.git
cd claude-agent
npm install
npm run setup
```

The setup wizard walks you through:
1. Module selection (Telegram, Discord, Scheduler)
2. Token configuration
3. Claude Code settings
4. Dependency installation and verification
5. **Agent identity** -- choose a name and persona for your agent

Once setup is done, a workspace is created at `~/.claude-agent/workspace/` and you can start your services:

```bash
claudebridge start          # Start all enabled services
claudebridge start telegram # Start only Telegram bot
claudebridge status         # Check service status
```

Or with npm scripts:
```bash
npm start                   # Start all enabled services
npm run telegram            # Run Telegram bot directly
npm run discord             # Run Discord bot directly
npm run scheduler           # Run scheduler directly
```

## Tech Stack

- **TypeScript** -- all source code in `src/`
- **telegraf** -- Telegram bot framework
- **discord.js** -- Discord bot framework
- **croner** -- cron scheduling
- **dotenv** -- environment variable loading
- **tsx** -- TypeScript execution without a compile step
- **@clack/prompts** -- interactive CLI prompts for the setup wizard
- **boxen**, **figlet**, **gradient-string**, **picocolors**, **nanospinner** -- setup wizard UI

## Architecture

```
                       +----------------+     +-------------------+
  Telegram Bot ------->|                |---->|                   |
                <------|  Claude Bridge |     |  Claude Code CLI  |
  Discord Bot -------->|                |     |  (claude -p)      |
                <------|  (src/lib/     |     |                   |
  Scheduler ---------->|   claude-      |     |  Workspace dir    |
                <------|   bridge.ts)   |     |  ~/.claude-agent/ |
                       +----------------+     |   workspace/      |
                              |               +-------------------+
                       +------+-------+
                       |  Brain       |
                       |  (brain.md)  |
                       +--------------+
```

All integrations go through `src/lib/claude-bridge.ts`, which wraps `claude -p` with:
- JSON output parsing
- Timeout handling
- Error recovery
- Async support for bot event loops
- **Workspace isolation** -- `claude -p` runs from the agent workspace, not your project directory, so your developer CLAUDE.md files don't bleed into the agent's persona

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
| `CLAUDE_TIMEOUT_SECONDS` | No | Timeout per request in seconds (default: 300) |
| `CLAUDE_BIN` | No | Full path to claude binary (auto-detected if not set) |
| `CLAUDE_WORKSPACE_DIR` | No | Custom workspace path (default: `~/.claude-agent/workspace`) |

## claudebridge CLI

`claudebridge` is the process manager installed with the package. It manages services as background processes with full process-group tracking, so start/stop work reliably even with nested `npx tsx` launchers.

```bash
claudebridge start   [telegram|discord|scheduler|all]  # Start services (default: all)
claudebridge stop    [telegram|discord|scheduler|all]  # Stop services (default: all)
claudebridge restart [telegram|discord|scheduler|all]  # Restart services
claudebridge status                                    # Show status table with uptime (alias: ps)
claudebridge logs    [telegram|discord|scheduler]      # Tail log files
claudebridge setup                                     # Re-run setup wizard
claudebridge help                                      # Show help (alias: --help, -h)
```

Logs are written to `logs/<service>.log`. PIDs are tracked in `.pids/`.

## Service Management (Makefile / systemd)

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

**Agent personality** -- During setup, you give the agent a name. This name is injected into the workspace CLAUDE.md at `~/.claude-agent/workspace/CLAUDE.md`, which defines the agent's persona and behavior. On first interaction with a new user, the agent introduces itself and asks for their preferences (language, interests, communication style), saving everything to its brain.

**Workspace isolation** -- The agent's CLAUDE.md lives in `~/.claude-agent/workspace/`, separate from any developer CLAUDE.md files in your projects. This prevents project-specific instructions from leaking into the agent's chat persona. The workspace is created automatically by the setup wizard.

**Bot commands:**

| Command | Bots | Description |
|---------|------|-------------|
| `/reset` | Both | Clear your session and start fresh |
| `/brain` | Both | View the current brain state |
| `/notify` | Both | Toggle proactive notifications on/off |
| `/project [path]` | Both | View or change the active project directory |
| `/model [name]` | Both | View or change the Claude model |
| `/ask <prompt>` | Both | Ask Claude a question |
| `/respond <mode>` | Discord | Set response mode: `all` (all messages) or `mentions` (only @mentions) |

**Concurrency control:**
Both bots enforce a single-request-at-a-time policy. If a request is already being processed when a new message arrives, the bot replies with a "still busy" message and discards the new request. This prevents Claude from being called in parallel and keeps costs predictable.

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
