"""
session_store.py — Track Claude Code session IDs per user for conversation continuity.

Each user (identified by platform + user_id) gets a persistent session.
When they send a message, we resume their session instead of starting fresh.

Usage:
    from lib.session_store import SessionStore

    store = SessionStore()
    session_id = store.get("telegram", "123456789")
    # Use session_id with claude -p --resume
    store.set("telegram", "123456789", new_session_id)
"""

import json
import time
from pathlib import Path

from lib.filelock import FileLock, atomic_write

DEFAULT_STORE_PATH = Path(__file__).resolve().parent.parent / "data" / "sessions.json"

# Sessions older than this are expired (7 days)
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60


class SessionStore:
    """Process-safe file-backed session ID store keyed by (platform, user_id)."""

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path else DEFAULT_STORE_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self) -> dict:
        """Load sessions from disk (caller must hold the file lock)."""
        if self.path.exists():
            try:
                return json.loads(self.path.read_text())
            except (json.JSONDecodeError, OSError):
                return {}
        return {}

    def _save(self, data: dict) -> None:
        """Persist sessions to disk atomically (caller must hold the file lock)."""
        atomic_write(self.path, json.dumps(data, indent=2))

    def _key(self, platform: str, user_id: str) -> str:
        return f"{platform}:{user_id}"

    def get(self, platform: str, user_id: str) -> str | None:
        """Get the session ID for a user, or None if no active session."""
        key = self._key(platform, user_id)
        with FileLock(self.path):
            data = self._load()
            entry = data.get(key)
            if entry is None:
                return None

            # Check TTL — if expired, delete under the same lock
            if time.time() - entry.get("updated_at", 0) > SESSION_TTL_SECONDS:
                del data[key]
                self._save(data)
                return None

            return entry.get("session_id")

    def set(self, platform: str, user_id: str, session_id: str) -> None:
        """Store or update a session ID for a user."""
        key = self._key(platform, user_id)
        with FileLock(self.path):
            data = self._load()
            data[key] = {
                "session_id": session_id,
                "platform": platform,
                "user_id": user_id,
                "updated_at": time.time(),
            }
            self._save(data)

    def clear(self, platform: str, user_id: str) -> None:
        """Remove a user's session (start fresh next time)."""
        key = self._key(platform, user_id)
        with FileLock(self.path):
            data = self._load()
            data.pop(key, None)
            self._save(data)

    def clear_all(self) -> None:
        """Remove all sessions."""
        with FileLock(self.path):
            self._save({})

    def cleanup_expired(self) -> int:
        """Remove all expired sessions. Returns number removed."""
        now = time.time()
        with FileLock(self.path):
            data = self._load()
            expired = [
                k for k, v in data.items()
                if now - v.get("updated_at", 0) > SESSION_TTL_SECONDS
            ]
            for k in expired:
                del data[k]
            if expired:
                self._save(data)
        return len(expired)
