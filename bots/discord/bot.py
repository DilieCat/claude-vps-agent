"""
Discord bot for Claude Code — relay messages to `claude -p` via ClaudeBridge.

Usage:
    python bot.py          # reads config from .env / environment
"""

import logging
import os
import sys

import discord
from discord import app_commands
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Path setup so we can import the shared bridge from lib/
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib.claude_bridge import ClaudeBridge  # noqa: E402

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
DISCORD_ALLOWED_USERS = {
    u.strip()
    for u in os.getenv("DISCORD_ALLOWED_USERS", "").split(",")
    if u.strip()
}
CLAUDE_PROJECT_DIR = os.getenv("CLAUDE_PROJECT_DIR", os.getcwd())
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL")
CLAUDE_ALLOWED_TOOLS = os.getenv("CLAUDE_ALLOWED_TOOLS", "")

DISCORD_MAX_LEN = 2000  # Discord message character limit

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("discord_bot")

# ---------------------------------------------------------------------------
# Bridge instance
# ---------------------------------------------------------------------------
allowed_tools = [t.strip() for t in CLAUDE_ALLOWED_TOOLS.split(",") if t.strip()] or None
bridge = ClaudeBridge(
    project_dir=CLAUDE_PROJECT_DIR,
    model=CLAUDE_MODEL,
    allowed_tools=allowed_tools,
)

# ---------------------------------------------------------------------------
# Bot setup
# ---------------------------------------------------------------------------
intents = discord.Intents.default()
intents.message_content = True


class ClaudeBot(discord.Client):
    def __init__(self) -> None:
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self) -> None:
        await self.tree.sync()
        logger.info("Slash commands synced.")


bot = ClaudeBot()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_allowed(user: discord.User | discord.Member) -> bool:
    """Return True if the user is permitted to use the bot."""
    if not DISCORD_ALLOWED_USERS:
        return True  # no allowlist configured => everyone allowed
    return str(user.id) in DISCORD_ALLOWED_USERS or str(user) in DISCORD_ALLOWED_USERS


def split_message(text: str, limit: int = DISCORD_MAX_LEN) -> list[str]:
    """Split a long message into chunks that fit within Discord's limit.

    Tries to split on newlines first, then on spaces, and finally hard-cuts.
    """
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break

        # Try to find a good split point
        split_at = text.rfind("\n", 0, limit)
        if split_at == -1 or split_at < limit // 2:
            split_at = text.rfind(" ", 0, limit)
        if split_at == -1 or split_at < limit // 2:
            split_at = limit

        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")

    return chunks


async def ask_claude(prompt: str, interaction: discord.Interaction) -> None:
    """Send a prompt to Claude and reply in the interaction's channel/thread."""
    # Create a thread for the conversation if we're not already in one
    channel = interaction.channel
    if isinstance(channel, (discord.TextChannel, discord.ForumChannel)):
        thread_name = prompt[:100] if len(prompt) <= 100 else prompt[:97] + "..."
        thread = await channel.create_thread(
            name=thread_name,
            type=discord.ChannelType.public_thread,
        )
    else:
        # Already in a thread or DM — reply in place
        thread = channel

    # Send initial acknowledgement in the thread
    thinking_msg = await thread.send("Thinking...")

    # Typing indicator while Claude works
    async with thread.typing():
        response = await bridge.ask_async(prompt)

    # Delete the "Thinking..." placeholder
    await thinking_msg.delete()

    if response.is_error:
        await thread.send(f"**Error:** {response.text}")
        return

    # Send the response, splitting if necessary
    chunks = split_message(response.text)
    for chunk in chunks:
        await thread.send(chunk)

    # Footer with cost info
    if response.cost_usd > 0:
        footer = f"-# Cost: ${response.cost_usd:.4f} | Turns: {response.num_turns}"
        await thread.send(footer)


# ---------------------------------------------------------------------------
# Slash commands
# ---------------------------------------------------------------------------

@bot.tree.command(name="ask", description="Ask Claude Code a question")
@app_commands.describe(prompt="Your question or instruction for Claude")
async def cmd_ask(interaction: discord.Interaction, prompt: str) -> None:
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "You are not authorized to use this bot.", ephemeral=True
        )
        return

    await interaction.response.send_message(f"**Prompt:** {prompt}")
    await ask_claude(prompt, interaction)


@bot.tree.command(name="project", description="View or change the active project directory")
@app_commands.describe(path="New project directory path (leave empty to view current)")
async def cmd_project(interaction: discord.Interaction, path: str | None = None) -> None:
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "You are not authorized to use this bot.", ephemeral=True
        )
        return

    if path:
        if not os.path.isdir(path):
            await interaction.response.send_message(
                f"Directory not found: `{path}`", ephemeral=True
            )
            return
        bridge.project_dir = path
        await interaction.response.send_message(f"Project directory set to: `{path}`")
    else:
        await interaction.response.send_message(
            f"Current project directory: `{bridge.project_dir}`"
        )


@bot.tree.command(name="model", description="View or change the Claude model")
@app_commands.describe(name="Model name (leave empty to view current)")
async def cmd_model(interaction: discord.Interaction, name: str | None = None) -> None:
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "You are not authorized to use this bot.", ephemeral=True
        )
        return

    if name:
        bridge.model = name
        await interaction.response.send_message(f"Model set to: `{name}`")
    else:
        current = bridge.model or "(default)"
        await interaction.response.send_message(f"Current model: `{current}`")


@bot.tree.command(name="help", description="Show help for the Claude Discord bot")
async def cmd_help(interaction: discord.Interaction) -> None:
    help_text = (
        "**Claude Code Discord Bot**\n\n"
        "**Commands:**\n"
        "`/ask <prompt>` — Ask Claude Code a question or give it an instruction\n"
        "`/project [path]` — View or change the active project directory\n"
        "`/model [name]` — View or change the Claude model\n"
        "`/help` — Show this help message\n\n"
        "**Notes:**\n"
        "- Each `/ask` creates a new thread for the conversation.\n"
        "- Long responses are automatically split across multiple messages.\n"
        "- The bot shows a typing indicator while Claude is processing.\n"
    )
    await interaction.response.send_message(help_text)


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@bot.event
async def on_ready() -> None:
    logger.info("Logged in as %s (ID: %s)", bot.user, bot.user.id)
    logger.info("Project dir: %s", bridge.project_dir)
    logger.info("Model: %s", bridge.model or "(default)")
    if DISCORD_ALLOWED_USERS:
        logger.info("Allowed users: %s", DISCORD_ALLOWED_USERS)
    else:
        logger.info("No user allowlist — all users permitted.")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    if not DISCORD_BOT_TOKEN:
        print("Error: DISCORD_BOT_TOKEN is not set.")
        print("Set it in your .env file or environment variables.")
        sys.exit(1)

    bot.run(DISCORD_BOT_TOKEN, log_handler=None)


if __name__ == "__main__":
    main()
