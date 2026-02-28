"""
brain.py — Persistent memory for the living agent.

The brain is a Markdown file that the agent reads before every interaction
and updates after. It stores: identity, ongoing tasks, user preferences,
recent conversation summaries, and learned patterns.

Usage:
    from lib.brain import Brain

    brain = Brain()                       # loads data/brain.md
    context = brain.get_context()         # markdown string for claude prompt
    brain.update("user_prefs", "Prefers Dutch in chat")
    brain.add_event("Built WhatsApp bot, merged PR #5")
"""

import os
import re
import datetime
from pathlib import Path

from lib.filelock import FileLock, atomic_write

DEFAULT_BRAIN_PATH = Path(__file__).resolve().parent.parent / "data" / "brain.md"

# Maximum events to keep in recent history
MAX_EVENTS = 50


class Brain:
    """Persistent agent memory backed by a Markdown file."""

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path else DEFAULT_BRAIN_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)

        if not self.path.exists():
            self._init_brain()

        self._content = self.path.read_text()

    def _init_brain(self) -> None:
        """Create the brain file from the template."""
        template = Path(__file__).resolve().parent.parent / "data" / "brain.template.md"
        if template.exists():
            self.path.write_text(template.read_text())
        else:
            self.path.write_text(_DEFAULT_TEMPLATE)

    def reload(self) -> None:
        """Reload brain from disk (in case another process updated it)."""
        self._content = self.path.read_text()

    def save(self) -> None:
        """Write current brain state to disk atomically."""
        atomic_write(self.path, self._content)

    def get_context(self) -> str:
        """Return the full brain content for injection into a claude prompt."""
        self.reload()
        return self._content

    def get_context_prompt(self) -> str:
        """Return a prompt-ready string that instructs Claude to use the brain."""
        brain_content = self.get_context()
        return (
            "You are a persistent AI agent. Below is your brain — your memory "
            "from previous sessions. Use it to maintain continuity. At the end "
            "of this interaction, you will update your brain with anything new "
            "you learned.\n\n"
            "<brain>\n"
            f"{brain_content}\n"
            "</brain>\n\n"
            "Important: Respond naturally as a continuous being. Reference past "
            "interactions when relevant. Remember user preferences."
        )

    def get_section(self, heading: str) -> str:
        """Extract content under a specific ## heading."""
        pattern = rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)"
        match = re.search(pattern, self._content, re.DOTALL | re.MULTILINE)
        return match.group(1).strip() if match else ""

    def update_section(self, heading: str, content: str) -> None:
        """Replace content under a specific ## heading (locked, atomic)."""
        with FileLock(self.path):
            self.reload()
            self._apply_section_update(heading, content)
            self.save()

    def _apply_section_update(self, heading: str, content: str) -> None:
        """Internal: modify self._content for a section (caller must hold lock)."""
        pattern = rf"(^## {re.escape(heading)}\n).*?(?=^## |\Z)"
        new_content = re.sub(
            pattern,
            lambda m: m.group(1) + content + "\n",
            self._content,
            flags=re.DOTALL | re.MULTILINE,
        )
        if new_content == self._content:
            # Section didn't exist — but check if it exists with same content
            if not self.get_section(heading):
                self._content = self._content.rstrip() + f"\n\n## {heading}\n{content}\n"
        else:
            self._content = new_content

    def add_event(self, event: str) -> None:
        """Add a timestamped event to the Recent History section."""
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        entry = f"- [{timestamp}] {event}"

        with FileLock(self.path):
            self.reload()
            history = self.get_section("Recent History")
            lines = [l for l in history.split("\n") if l.strip()]
            lines.insert(0, entry)
            lines = lines[:MAX_EVENTS]
            self._apply_section_update("Recent History", "\n".join(lines))
            self.save()

    def get_user_pref(self, key: str) -> str | None:
        """Get a specific user preference by key."""
        prefs = self.get_section("User Preferences")
        for line in prefs.split("\n"):
            if line.strip().startswith(f"- {key}:"):
                return line.split(":", 1)[1].strip()
        return None

    def set_user_pref(self, key: str, value: str) -> None:
        """Set a user preference (adds or updates)."""
        prefs = self.get_section("User Preferences")
        lines = [l for l in prefs.split("\n") if l.strip()]

        # Update existing or append
        updated = False
        for i, line in enumerate(lines):
            if line.strip().startswith(f"- {key}:"):
                lines[i] = f"- {key}: {value}"
                updated = True
                break
        if not updated:
            lines.append(f"- {key}: {value}")

        self.update_section("User Preferences", "\n".join(lines))


_DEFAULT_TEMPLATE = """# Agent Brain

## Identity
- Name: Atlas
- Role: Personal AI agent
- Platform: claude-vps-agent

## Active Tasks
No active tasks.

## User Preferences
- Language: auto-detect

## Learned Patterns
No patterns learned yet.

## Recent History
No events yet.
"""
