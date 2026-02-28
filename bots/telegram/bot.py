"""
Telegram bot for Claude Code.

Forwards messages to the Claude CLI via ClaudeBridge and returns responses.
Configure via environment variables (see README.md).
"""

import logging
import os
import sys

from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ChatAction, ParseMode
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ---------------------------------------------------------------------------
# Import ClaudeBridge from the shared library
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib.claude_bridge import ClaudeBridge  # noqa: E402

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

# ---------------------------------------------------------------------------
# Bridge instance (mutable at runtime via /project and /model)
# ---------------------------------------------------------------------------
bridge = ClaudeBridge(
    project_dir=os.getenv("CLAUDE_PROJECT_DIR"),
    model=os.getenv("CLAUDE_MODEL"),
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _is_allowed(user_id: int) -> bool:
    """Return True if the user is allowed (or if no allowlist is set)."""
    if not ALLOWED_USERS:
        return True
    return user_id in ALLOWED_USERS


def _split_message(text: str, limit: int = TELEGRAM_MAX_LEN) -> list[str]:
    """Split *text* into chunks that fit within Telegram's message limit.

    Tries to split on newlines first, then falls back to hard-cutting.
    """
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break

        # Try to find a newline to split on
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
    await update.message.reply_text(
        "Hello! I'm a Claude Code bot.\n\n"
        "Send me a message or use /ask <prompt> to interact with Claude.\n"
        "Type /help to see all commands."
    )


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user.id):
        return
    await update.message.reply_text(
        "Available commands:\n\n"
        "/start  - Welcome message\n"
        "/ask <prompt>  - Ask Claude a question\n"
        "/project <path>  - Switch Claude's working directory\n"
        "/model <model>  - Switch Claude model\n"
        "/help  - Show this help message\n\n"
        "You can also send a plain text message and it will be forwarded "
        "to Claude as a prompt."
    )


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
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    if not BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN is not set. Exiting.")
        sys.exit(1)

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("ask", cmd_ask))
    app.add_handler(CommandHandler("project", cmd_project))
    app.add_handler(CommandHandler("model", cmd_model))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Telegram bot starting (allowed users: %s)", ALLOWED_USERS or "ALL")
    app.run_polling()


if __name__ == "__main__":
    main()
