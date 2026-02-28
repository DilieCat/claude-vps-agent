"""
Telegram bot for Claude Code — Living Agent mode.

Forwards messages to Claude via LivingBridge (brain-aware, session-persistent).
Falls back to stateless ClaudeBridge if LivingBridge fails to initialise.
Configure via environment variables (see README.md).
"""

import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ---------------------------------------------------------------------------
# Import bridge — prefer LivingBridge, fall back to ClaudeBridge
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from lib.claude_bridge import ClaudeBridge  # noqa: E402

_living_mode = False
try:
    from lib.claude_bridge import LivingBridge  # noqa: E402
    from lib.notifier import NotificationQueue  # noqa: E402

    _living_mode = True
except Exception:
    LivingBridge = None  # type: ignore[assignment,misc]
    NotificationQueue = None  # type: ignore[assignment,misc]

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
load_dotenv()

BOT_TOKEN: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
ALLOWED_USERS: set[int] = set()
_raw = os.getenv("TELEGRAM_ALLOWED_USERS", "")
if _raw.strip():
    for uid in _raw.split(","):
        uid = uid.strip()
        if uid.isdigit():
            ALLOWED_USERS.add(int(uid))

TELEGRAM_MAX_LEN = 4096
NOTIFY_PREFS_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "notify_prefs.json"
NOTIFICATION_CHECK_INTERVAL = 60  # seconds

# ---------------------------------------------------------------------------
# Bridge instance — try LivingBridge first, fall back to ClaudeBridge
# ---------------------------------------------------------------------------
bridge: ClaudeBridge  # type hint covers both subclass and base

if _living_mode:
    try:
        bridge = LivingBridge(
            project_dir=os.getenv("CLAUDE_PROJECT_DIR"),
            model=os.getenv("CLAUDE_MODEL"),
        )
        logger.info("LivingBridge initialised — brain + sessions active")
    except Exception:
        logger.warning("LivingBridge init failed, falling back to ClaudeBridge")
        bridge = ClaudeBridge(
            project_dir=os.getenv("CLAUDE_PROJECT_DIR"),
            model=os.getenv("CLAUDE_MODEL"),
        )
        _living_mode = False
else:
    bridge = ClaudeBridge(
        project_dir=os.getenv("CLAUDE_PROJECT_DIR"),
        model=os.getenv("CLAUDE_MODEL"),
    )
    logger.info("Running in stateless mode (LivingBridge not available)")

# Notification queue (only in living mode)
notification_queue: "NotificationQueue | None" = None
if _living_mode and NotificationQueue is not None:
    try:
        notification_queue = NotificationQueue()
    except Exception:
        logger.warning("NotificationQueue init failed, notifications disabled")


# ---------------------------------------------------------------------------
# Notification preferences helpers
# ---------------------------------------------------------------------------
def _load_notify_prefs() -> dict:
    NOTIFY_PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if NOTIFY_PREFS_PATH.exists():
        try:
            return json.loads(NOTIFY_PREFS_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_notify_prefs(prefs: dict) -> None:
    NOTIFY_PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    NOTIFY_PREFS_PATH.write_text(json.dumps(prefs, indent=2))


def _is_notify_enabled(user_id: int) -> bool:
    prefs = _load_notify_prefs()
    return prefs.get(str(user_id), False)


def _toggle_notify(user_id: int) -> bool:
    """Toggle notification preference. Returns new state."""
    prefs = _load_notify_prefs()
    key = str(user_id)
    new_state = not prefs.get(key, False)
    prefs[key] = new_state
    _save_notify_prefs(prefs)
    return new_state


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _is_allowed(user_id: int) -> bool:
    """Return True if the user is allowed (or if no allowlist is set)."""
    if not ALLOWED_USERS:
        return True
    return user_id in ALLOWED_USERS


def _split_message(text: str, limit: int = TELEGRAM_MAX_LEN) -> list[str]:
    """Split *text* into chunks that fit within Telegram's message limit."""
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break

        split_at = text.rfind("\n", 0, limit)
        if split_at == -1 or split_at == 0:
            split_at = limit

        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")

    return chunks


async def _send_long(update: Update, text: str) -> None:
    """Send a potentially long response, splitting into multiple messages."""
    for chunk in _split_message(text):
        await update.message.reply_text(chunk)


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        return
    mode = "living agent" if _living_mode else "stateless"
    await update.message.reply_text(
        f"Hello! I'm a Claude Code bot ({mode} mode).\n\n"
        "Send me a message or use /ask <prompt> to interact with Claude.\n"
        "Type /help to see all commands."
    )


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        return

    lines = [
        "Available commands:\n",
        "/start  - Welcome message",
        "/ask <prompt>  - Ask Claude a question",
        "/project <path>  - Switch Claude's working directory",
        "/model <model>  - Switch Claude model",
    ]
    if _living_mode:
        lines.extend([
            "/reset  - Clear your session (start fresh)",
            "/brain  - Show current brain summary",
            "/notify  - Toggle proactive notifications",
        ])
    lines.extend([
        "/help  - Show this help message",
        "",
        "You can also send a plain text message and it will be forwarded "
        "to Claude as a prompt.",
    ])
    await update.message.reply_text("\n".join(lines))


async def cmd_ask(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        return

    prompt = " ".join(ctx.args) if ctx.args else ""
    if not prompt:
        await update.message.reply_text("Usage: /ask <your prompt>")
        return

    await _handle_prompt(update, prompt)


async def cmd_project(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        return

    path = " ".join(ctx.args) if ctx.args else ""
    if not path:
        await update.message.reply_text(
            f"Current project directory: {bridge.project_dir}\n\n"
            "Usage: /project <path>"
        )
        return

    path = os.path.expanduser(path)
    if not os.path.isdir(path):
        await update.message.reply_text(f"Directory not found: {path}")
        return

    bridge.project_dir = path
    await update.message.reply_text(f"Project directory set to: {path}")


async def cmd_model(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        return

    model = " ".join(ctx.args) if ctx.args else ""
    if not model:
        current = bridge.model or "(default)"
        await update.message.reply_text(
            f"Current model: {current}\n\nUsage: /model <model-name>"
        )
        return

    bridge.model = model
    await update.message.reply_text(f"Model set to: {model}")


async def cmd_reset(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Clear the user's session so the next message starts fresh."""
    if not _is_allowed(update.effective_user.id):
        return

    if not _living_mode or not isinstance(bridge, LivingBridge):
        await update.message.reply_text("Reset is only available in living agent mode.")
        return

    bridge.sessions.clear("telegram", str(update.effective_user.id))
    await update.message.reply_text("Session cleared. Your next message will start a fresh conversation.")


async def cmd_brain(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Show the current brain summary."""
    if not _is_allowed(update.effective_user.id):
        return

    if not _living_mode or not isinstance(bridge, LivingBridge):
        await update.message.reply_text("Brain is only available in living agent mode.")
        return

    brain_content = bridge.brain.get_context()
    if not brain_content.strip():
        await update.message.reply_text("Brain is empty.")
        return

    await _send_long(update, brain_content)


async def cmd_notify(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Toggle proactive notifications for this user."""
    if not _is_allowed(update.effective_user.id):
        return

    if not _living_mode:
        await update.message.reply_text("Notifications are only available in living agent mode.")
        return

    new_state = _toggle_notify(update.effective_user.id)
    if new_state:
        await update.message.reply_text("Proactive notifications enabled. I'll message you when I have updates.")
    else:
        await update.message.reply_text("Proactive notifications disabled.")


# ---------------------------------------------------------------------------
# Plain-text message handler
# ---------------------------------------------------------------------------
async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        return

    prompt = update.message.text
    if not prompt:
        return

    await _handle_prompt(update, prompt)


# ---------------------------------------------------------------------------
# Core prompt handling
# ---------------------------------------------------------------------------
async def _handle_prompt(update: Update, prompt: str) -> None:
    """Send *prompt* to Claude via the bridge and reply with the result."""
    await update.message.chat.send_action(ChatAction.TYPING)

    try:
        if _living_mode and isinstance(bridge, LivingBridge):
            response = await bridge.ask_as(
                "telegram", str(update.effective_user.id), prompt
            )
        else:
            response = await bridge.ask_async(prompt)
    except Exception:
        logger.exception("Bridge call failed")
        await update.message.reply_text(
            "Sorry, something went wrong while contacting Claude. "
            "Please try again later."
        )
        return

    if response.is_error:
        await update.message.reply_text(f"Error: {response.text}")
        return

    text = response.text or "(empty response)"
    footer = f"\n\n[cost=${response.cost_usd:.4f} | turns={response.num_turns}]"

    await _send_long(update, text + footer)


# ---------------------------------------------------------------------------
# Periodic notification check
# ---------------------------------------------------------------------------
async def _check_notifications(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Pop pending notifications and send them to opted-in users."""
    if notification_queue is None:
        return

    pending = notification_queue.pop_all("telegram")
    if not pending:
        return

    prefs = _load_notify_prefs()

    # Collect opted-in user IDs for broadcasts
    opted_in = [uid for uid, enabled in prefs.items() if enabled]

    for note in pending:
        user_id = note.get("user_id")
        message = note.get("message", "")
        if not message:
            continue

        # Determine recipients: specific user or all opted-in (broadcast)
        if user_id is not None:
            recipients = [str(user_id)] if prefs.get(str(user_id), False) else []
        else:
            recipients = opted_in

        for recipient in recipients:
            try:
                await ctx.bot.send_message(
                    chat_id=int(recipient),
                    text=f"[Notification]\n{message}",
                )
                logger.info("Sent notification to user %s", recipient)
            except Exception:
                logger.exception("Failed to send notification to user %s", recipient)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    if not BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN is not set. Exiting.")
        sys.exit(1)

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    # Commands
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("ask", cmd_ask))
    app.add_handler(CommandHandler("project", cmd_project))
    app.add_handler(CommandHandler("model", cmd_model))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("brain", cmd_brain))
    app.add_handler(CommandHandler("notify", cmd_notify))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Periodic notification check (every 60 seconds)
    if _living_mode and notification_queue is not None:
        app.job_queue.run_repeating(
            _check_notifications,
            interval=NOTIFICATION_CHECK_INTERVAL,
            first=10,  # start 10s after boot
        )
        logger.info("Notification check scheduled every %ds", NOTIFICATION_CHECK_INTERVAL)

    logger.info(
        "Telegram bot starting (%s mode, allowed users: %s)",
        "living" if _living_mode else "stateless",
        ALLOWED_USERS or "ALL",
    )
    app.run_polling()


if __name__ == "__main__":
    main()
