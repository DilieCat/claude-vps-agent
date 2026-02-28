# Claude Code Discord Bot

A Discord bot that forwards slash commands to Claude Code via the shared `ClaudeBridge`.

## Setup

1. **Create a Discord application** at https://discord.com/developers/applications and add a bot.
2. **Invite the bot** to your server with the `applications.commands` and `bot` scopes (permissions: Send Messages, Create Public Threads, Manage Messages, Read Message History).
3. **Install dependencies:**

```bash
pip install -r requirements.txt
```

4. **Configure environment** — create a `.env` file in this directory (or export the vars):

```
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_ALLOWED_USERS=username#1234,123456789012345678  # optional allowlist (usernames or IDs)
CLAUDE_PROJECT_DIR=/path/to/your/project
CLAUDE_MODEL=claude-sonnet-4-6                          # optional
CLAUDE_ALLOWED_TOOLS=Read,Grep,Glob                     # optional
```

5. **Run:**

```bash
python bot.py
```

## Commands

| Command | Description |
|---------|-------------|
| `/ask <prompt>` | Ask Claude Code a question |
| `/project [path]` | View or change the project directory |
| `/model [name]` | View or change the Claude model |
| `/help` | Show help |

## Notes

- Each `/ask` creates a thread so conversations stay organized.
- Long responses are automatically split to stay within Discord's 2000-character limit.
- If `DISCORD_ALLOWED_USERS` is empty, all server members can use the bot.
