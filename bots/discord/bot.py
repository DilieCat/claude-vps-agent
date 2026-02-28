"""
Discord bot for Claude Code — relay messages to Claude via LivingBridge (or ClaudeBridge fallback).

Supports persistent sessions, brain memory, proactive notifications, and slash commands.

Usage:
    python bot.py          # reads config from .env / environment
"""

import asyncio
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
NOTIFICATION_POLL_INTERVAL = 60  # seconds between notification checks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("discord_bot")

# ---------------------------------------------------------------------------
# Bridge instance — try LivingBridge, fall back to ClaudeBridge
# ---------------------------------------------------------------------------
allowed_tools = [t.strip() for t in CLAUDE_ALLOWED_TOOLS.split(",") if t.strip()] or None
living_mode = False

try:
    from lib.claude_bridge import LivingBridge  # noqa: E402
    bridge = LivingBridge(
        project_dir=CLAUDE_PROJECT_DIR,
        model=CLAUDE_MODEL,
        allowed_tools=allowed_tools,
    )
    living_mode = True
    logger.info("LivingBridge initialized — living agent mode active.")
except Exception as exc:
    logger.warning("LivingBridge init failed (%s), falling back to ClaudeBridge.", exc)
    bridge = ClaudeBridge(
        project_dir=CLAUDE_PROJECT_DIR,
        model=CLAUDE_MODEL,
        allowed_tools=allowed_tools,
    )

# ---------------------------------------------------------------------------
# Notification queue (optional — only in living mode)
# ---------------------------------------------------------------------------
notification_queue = None
if living_mode:
    try:
        from lib.notifier import NotificationQueue  # noqa: E402
        notification_queue = NotificationQueue()
        logger.info("NotificationQueue loaded.")
    except Exception as exc:
        logger.warning("NotificationQueue init failed (%s), notifications disabled.", exc)

# Per-user notification toggle: set of user IDs that have opted in
notify_opted_in: set[str] = set()

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

        # Start notification polling background task
        if notification_queue is not None:
            self.loop.create_task(_notification_poller())
            logger.info("Notification poller started (every %ds).", NOTIFICATION_POLL_INTERVAL)


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
    """Split a long message into chunks that fit within Discord's limit."""
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
    user_id = str(interaction.user.id)

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
        if living_mode:
            response = await bridge.ask_as("discord", user_id, prompt)
        else:
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
# Notification poller background task
# ---------------------------------------------------------------------------

async def _notification_poller() -> None:
    """Poll NotificationQueue every NOTIFICATION_POLL_INTERVAL seconds and deliver."""
    await bot.wait_until_ready()
    logger.info("Notification poller ready.")

    while not bot.is_closed():
        try:
            notifications = notification_queue.pop_all("discord")
            for note in notifications:
                recipient_id = note.get("user_id")
                message = note.get("message", "")

                if recipient_id is None:
                    # Broadcast — skip if no opted-in users
                    logger.info("Broadcast notification (no specific user), skipping for now.")
                    continue

                # Only deliver if user has opted in
                if recipient_id not in notify_opted_in:
                    logger.debug(
                        "Skipping notification for %s (not opted in).", recipient_id
                    )
                    continue

                try:
                    user = await bot.fetch_user(int(recipient_id))
                    if user:
                        await user.send(f"**Notification:**\n{message}")
                except Exception as exc:
                    logger.error("Failed to deliver notification to %s: %s", recipient_id, exc)
        except Exception as exc:
            logger.error("Notification poller error: %s", exc)

        await asyncio.sleep(NOTIFICATION_POLL_INTERVAL)


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


@bot.tree.command(name="reset", description="Clear your conversation session (start fresh)")
async def cmd_reset(interaction: discord.Interaction) -> None:
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "You are not authorized to use this bot.", ephemeral=True
        )
        return

    if not living_mode:
        await interaction.response.send_message(
            "Sessions are not available (running in stateless mode).", ephemeral=True
        )
        return

    user_id = str(interaction.user.id)
    bridge.sessions.clear("discord", user_id)
    await interaction.response.send_message("Session cleared. Your next message starts a fresh conversation.", ephemeral=True)


@bot.tree.command(name="brain", description="Show the agent's current brain/memory summary")
async def cmd_brain(interaction: discord.Interaction) -> None:
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "You are not authorized to use this bot.", ephemeral=True
        )
        return

    if not living_mode:
        await interaction.response.send_message(
            "Brain is not available (running in stateless mode).", ephemeral=True
        )
        return

    brain_content = bridge.brain.get_context()
    # Truncate if too long for Discord
    if len(brain_content) > DISCORD_MAX_LEN - 20:
        brain_content = brain_content[: DISCORD_MAX_LEN - 20] + "\n\n*[truncated]*"
    await interaction.response.send_message(f"```markdown\n{brain_content}\n```")


@bot.tree.command(name="notify", description="Toggle proactive notifications on/off")
async def cmd_notify(interaction: discord.Interaction) -> None:
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "You are not authorized to use this bot.", ephemeral=True
        )
        return

    if notification_queue is None:
        await interaction.response.send_message(
            "Notifications are not available.", ephemeral=True
        )
        return

    user_id = str(interaction.user.id)
    if user_id in notify_opted_in:
        notify_opted_in.discard(user_id)
        await interaction.response.send_message(
            "Proactive notifications **disabled**. Use `/notify` again to re-enable.", ephemeral=True
        )
    else:
        notify_opted_in.add(user_id)
        await interaction.response.send_message(
            "Proactive notifications **enabled**. The agent will DM you when it has updates. "
            "Use `/notify` again to disable.", ephemeral=True
        )


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
    mode_label = "living agent" if living_mode else "stateless"
    help_text = (
        f"**Claude Code Discord Bot** (mode: {mode_label})\n\n"
        "**Commands:**\n"
        "`/ask <prompt>` — Ask Claude Code a question or give it an instruction\n"
        "`/reset` — Clear your session and start a fresh conversation\n"
        "`/brain` — Show the agent's current brain/memory summary\n"
        "`/notify` — Toggle proactive notifications on/off\n"
        "`/project [path]` — View or change the active project directory\n"
        "`/model [name]` — View or change the Claude model\n"
        "`/help` — Show this help message\n\n"
        "**Notes:**\n"
        "- Each `/ask` creates a new thread for the conversation.\n"
        "- Long responses are automatically split across multiple messages.\n"
        "- The bot shows a typing indicator while Claude is processing.\n"
    )
    if living_mode:
        help_text += (
            "- Sessions persist across messages — Claude remembers context.\n"
            "- Use `/reset` to start a fresh conversation.\n"
        )
    await interaction.response.send_message(help_text)


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@bot.event
async def on_ready() -> None:
    mode_label = "LIVING" if living_mode else "STATELESS"
    logger.info("Logged in as %s (ID: %s) [%s mode]", bot.user, bot.user.id, mode_label)
    logger.info("Project dir: %s", bridge.project_dir)
    logger.info("Model: %s", bridge.model or "(default)")
    if DISCORD_ALLOWED_USERS:
        logger.info("Allowed users: %s", DISCORD_ALLOWED_USERS)
    else:
        logger.info("No user allowlist — all users permitted.")
    if notification_queue is not None:
        logger.info("Notifications: enabled (polling every %ds)", NOTIFICATION_POLL_INTERVAL)
    else:
        logger.info("Notifications: disabled")


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
