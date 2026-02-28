# Telegram Bot for Claude Code

A Telegram bot that forwards messages to the Claude CLI via `ClaudeBridge`.

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and copy the token.

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Create a `.env` file (or export the variables):

   ```env
   TELEGRAM_BOT_TOKEN=your-bot-token
   TELEGRAM_ALLOWED_USERS=123456789,987654321   # comma-separated Telegram user IDs (empty = allow all)
   CLAUDE_PROJECT_DIR=/path/to/your/project      # optional, defaults to cwd
   CLAUDE_MODEL=                                  # optional, e.g. claude-opus-4-6
   CLAUDE_ALLOWED_TOOLS=                          # optional, comma-separated tool names
   ```

4. Run the bot:

   ```bash
   python bot.py
   ```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/ask <prompt>` | Ask Claude a question |
| `/project <path>` | Switch Claude's working directory |
| `/model <name>` | Switch Claude model |
| `/help` | Show available commands |

Plain text messages are also forwarded to Claude as prompts.
