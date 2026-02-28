# claude-vps-agent

A modular, self-hostable toolkit for running Claude Code on a VPS with messaging bot integrations, scheduling, and MCP server support.

## Project Structure

```
claude-vps-agent/
├── lib/claude_bridge.py        # Shared wrapper around `claude -p`
├── lib/brain.py                # Persistent markdown memory (brain system)
├── lib/session_store.py        # Per-user session tracking
├── lib/notifier.py             # Notification queue for proactive messages
├── lib/filelock.py             # Cross-process file locking
├── bots/telegram/              # Telegram bot module
├── bots/discord/               # Discord bot module
├── scheduler/                  # YAML-based task scheduler
├── infra/                      # VPS setup, systemd, deploy scripts
├── config/                     # MCP server configs
├── data/brain.md               # Persistent brain memory (runtime state)
├── data/brain.template.md      # Brain template for new setups
├── .env.example                # Environment variable template
├── Makefile                    # Build/install targets
├── docker-compose.yml          # Optional Docker setup
└── README.md                   # User-facing documentation
```

## Conventions

- Python 3.10+ with type hints
- All bots import from `lib.claude_bridge` — never call `claude -p` directly
- Config via environment variables (python-dotenv), never hardcoded
- Each module has its own `requirements.txt`
- Systemd service files in `infra/systemd/`
- All code must be generic — no hardcoded usernames, paths, or tokens
- Error handling: log errors, don't crash. Bots should auto-recover.
- Use `asyncio` for bot event loops
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
