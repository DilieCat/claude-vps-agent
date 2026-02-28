"""
notifier.py — Notification queue for the living agent.

Stores pending notifications per platform so bots (Telegram, Discord, etc.)
can poll and deliver them to users asynchronously.

Backed by a JSON file at data/notifications.json.

Usage:
    from lib.notifier import NotificationQueue

    q = NotificationQueue()
    q.push("telegram", "123456", "Your nightly tests passed!")
    q.push_broadcast("discord", "Weekly dependency report ready.")
    msgs = q.pop_all("telegram")   # returns and removes all telegram messages
"""

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from lib.filelock import FileLock, atomic_write

logger = logging.getLogger(__name__)

DEFAULT_QUEUE_PATH = Path(__file__).resolve().parent.parent / "data" / "notifications.json"


@dataclass
class Notification:
    """A single queued notification."""

    platform: str
    user_id: str | None  # None = broadcast to all users on that platform
    message: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    source: str = ""  # e.g. "scheduler:daily-code-review"


class NotificationQueue:
    """Process-safe notification queue backed by a JSON file."""

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path else DEFAULT_QUEUE_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self) -> list[dict]:
        """Load the queue from disk (caller must hold the file lock)."""
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text())
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            logger.warning("Corrupted notification queue, resetting")
            return []

    def _save(self, entries: list[dict]) -> None:
        """Persist the queue to disk atomically (caller must hold the file lock)."""
        atomic_write(self.path, json.dumps(entries, indent=2))

    def push(self, platform: str, user_id: str, message: str, source: str = "") -> None:
        """Queue a notification for a specific user on a platform."""
        notif = Notification(
            platform=platform,
            user_id=user_id,
            message=message,
            source=source,
        )
        with FileLock(self.path):
            entries = self._load()
            entries.append(asdict(notif))
            self._save(entries)
        logger.debug("Queued notification for %s:%s", platform, user_id)

    def push_broadcast(self, platform: str, message: str, source: str = "") -> None:
        """Queue a broadcast notification for all users on a platform."""
        notif = Notification(
            platform=platform,
            user_id=None,
            message=message,
            source=source,
        )
        with FileLock(self.path):
            entries = self._load()
            entries.append(asdict(notif))
            self._save(entries)
        logger.debug("Queued broadcast for %s", platform)

    def pop_all(self, platform: str) -> list[dict]:
        """Return and remove all queued notifications for a platform."""
        with FileLock(self.path):
            entries = self._load()
            matched = [e for e in entries if e.get("platform") == platform]
            remaining = [e for e in entries if e.get("platform") != platform]
            self._save(remaining)
        logger.debug("Popped %d notifications for %s", len(matched), platform)
        return matched
