# claude-agent

A modular, self-hostable toolkit for running Claude Code as a persistent agent with messaging bot integrations, scheduling, and MCP server support. Runs on any machine (VPS, homelab, laptop, server).

## Project Structure

```
claude-agent/
├── src/lib/claude-bridge.ts    # Shared wrapper around `claude -p`
├── src/lib/brain.ts            # Persistent markdown memory (brain system)
├── src/lib/session-store.ts    # Per-user session tracking
├── src/lib/notifier.ts         # Notification queue for proactive messages
├── src/lib/filelock.ts         # Cross-process file locking
├── src/lib/index.ts            # Re-exports for all lib modules
├── src/bots/telegram.ts        # Telegram bot module
├── src/bots/discord.ts         # Discord bot module
├── src/scheduler.ts            # YAML-based task scheduler
├── setup.ts                    # Interactive setup wizard (zero-dependency)
├── infra/                      # Server provisioning, systemd, deploy scripts
├── config/                     # MCP server configs
├── data/brain.md               # Persistent brain memory (runtime state)
├── data/brain.template.md      # Brain template for new setups
├── .env.example                # Environment variable template
├── Makefile                    # Local-first build/run targets + remote deployment
├── package.json                # Node.js dependencies and scripts
├── tsconfig.json               # TypeScript configuration
└── README.md                   # User-facing documentation
```

## Conventions

- TypeScript with strict mode enabled
- All bots import from `src/lib` -- never call `claude -p` directly
- Config via environment variables (dotenv), never hardcoded
- All dependencies managed through package.json
- Systemd service files in `infra/systemd/`
- All code must be generic -- no hardcoded usernames, paths, or tokens
- Error handling: log errors, don't crash. Bots should auto-recover.
- Use `async/await` for bot event loops
- README in English (project is international)

## claude -p Interface

The headless mode `claude -p` is the core integration point:

```bash
# Basic usage
claude -p "your prompt here"

# JSON output (recommended for programmatic use)
claude -p "your prompt" --output-format json

# Restrict tools
claude -p "your prompt" --allowedTools "Read,Bash,Edit"

# With model selection
claude -p "your prompt" --model claude-sonnet-4-6

# With max budget
claude -p "your prompt" --max-budget-usd 0.50
```

JSON output format returns: `{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":1234,"duration_api_ms":1100,"is_error":false,"num_turns":1,"result":"response text","session_id":"..."}`

## Important

- NEVER hardcode API keys or tokens
- NEVER use OAuth token spoofing or unofficial auth methods
- This project uses the OFFICIAL Claude Code CLI only
- All integrations go through `claude -p` (headless mode)
