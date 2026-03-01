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
├── setup.ts                    # Interactive setup wizard (@clack/prompts)
├── infra/                      # Server provisioning, systemd, deploy scripts
├── config/                     # MCP server configs
├── data/brain.md               # Persistent brain memory (runtime state, gitignored)
├── data/brain.template.md      # Brain template for new setups ({AGENT_NAME} placeholder)
├── data/workspace-claude.template.md  # Agent CLAUDE.md template ({AGENT_NAME} placeholder)
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

## Git Workflow

- **Never push directly to main.** All changes go through pull requests.
- For each feature or bugfix:
  1. Create a branch from main: `git checkout -b fix/issue-description`
  2. Make changes, commit with descriptive message
  3. Push branch and create a PR via `gh pr create`
  4. PR must be reviewed before merging
  5. Merge via GitHub (squash or merge commit)
- GitHub Issues track all bugs, features, and tasks
- Reference issues in PR descriptions: `Fixes #123`
- Labels: `critical`, `bug`, `enhancement`, `documentation`, `security`

## Agent Personality & Workspace Isolation

The agent runs in an isolated workspace to prevent loading developer instructions:

- **Workspace directory**: `~/.claude-agent/workspace/` (configurable via `CLAUDE_WORKSPACE_DIR`)
- **`workspace/CLAUDE.md`** — agent personality and behavior rules, loaded natively by Claude Code
- **`data/workspace-claude.template.md`** — template with `{AGENT_NAME}` placeholder, used by setup wizard
- **Setup wizard** creates the workspace and generates CLAUDE.md from template
- **Why isolation?** Claude Code walks up directories to load CLAUDE.md. Without workspace isolation, the agent loads the developer CLAUDE.md (with git/PR instructions) and behaves as a developer tool instead of a chat assistant.
- **File access**: The agent uses absolute paths to access user files when asked — workspace isolation does not restrict file access.

## claudebridge CLI — Command Registry

The CLI (`src/cli.ts`) uses a command registry pattern instead of a switch statement. This makes it easy to add new commands without touching the dispatch logic.

### Core interfaces and functions

```typescript
interface Command {
  name: string;          // primary command name (lowercase)
  description: string;   // shown in help output
  aliases?: string[];    // optional alternate names (e.g. ["--help", "-h"])
  usage?: string;        // argument hint appended to name in help output
  run(args: string[]): void | Promise<void>;
}

registerCommand(cmd: Command): void   // add a command to the registry
findCommand(name: string): Command    // look up by name or alias (case-insensitive)
```

### Adding a new command

1. Implement the service logic as a standalone function.
2. Call `registerCommand({...})` after the existing registrations (before `main`).
3. The command appears automatically in `claudebridge help` output — no edits needed elsewhere.

```typescript
registerCommand({
  name: "mycommand",
  description: "Does something useful",
  usage: " [optional-arg]",
  async run(args) {
    // implementation
  },
});
```

### Built-in commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `start` | — | Start services (default: all) |
| `stop` | — | Stop services (default: all) |
| `restart` | — | Restart services |
| `status` | `ps` | Show running services |
| `logs` | — | Tail log files |
| `setup` | — | Run setup wizard |
| `help` | `--help`, `-h` | Show help message |

## Important

- NEVER hardcode API keys or tokens
- NEVER use OAuth token spoofing or unofficial auth methods
- This project uses the OFFICIAL Claude Code CLI only
- All integrations go through `claude -p` (headless mode)
