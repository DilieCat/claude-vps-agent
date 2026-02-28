"""
claude_bridge.py — Shared wrapper around `claude -p` for all integrations.

Supports two modes:
  - Stateless: ClaudeBridge (original, one-shot per request)
  - Living:    LivingBridge (brain-aware, session-persistent, proactive)

Usage:
    # Stateless (backwards compatible)
    from lib.claude_bridge import ClaudeBridge
    bridge = ClaudeBridge(project_dir="/home/user/my-project")
    response = bridge.ask("Fix the bug in auth.py")

    # Living agent
    from lib.claude_bridge import LivingBridge
    agent = LivingBridge(project_dir="/home/user/my-project")
    response = await agent.ask_as("telegram", "123456", "Fix the bug in auth.py")
"""

import asyncio
import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ClaudeResponse:
    """Structured response from a claude -p invocation."""

    text: str
    exit_code: int
    cost_usd: float = 0.0
    duration_ms: int = 0
    duration_api_ms: int = 0
    num_turns: int = 0
    session_id: str = ""
    is_error: bool = False
    raw: dict = field(default_factory=dict)


class ClaudeBridge:
    """Wrapper around the `claude -p` CLI for programmatic access."""

    _DEFAULT_TIMEOUT = 300

    def __init__(
        self,
        project_dir: str | None = None,
        model: str | None = None,
        allowed_tools: list[str] | None = None,
        max_budget_usd: float | None = None,
        timeout_seconds: int | None = None,
    ):
        self.project_dir = project_dir or os.getcwd()
        self.model = model or os.getenv("CLAUDE_MODEL")
        self.allowed_tools = allowed_tools or os.getenv(
            "CLAUDE_ALLOWED_TOOLS", ""
        ).split(",")
        self.allowed_tools = [t.strip() for t in self.allowed_tools if t.strip()]
        if max_budget_usd is not None:
            self.max_budget_usd = max_budget_usd
        else:
            env_budget = os.getenv("CLAUDE_MAX_BUDGET_USD")
            self.max_budget_usd = float(env_budget) if env_budget else None
        if timeout_seconds is not None:
            self.timeout_seconds = timeout_seconds
        else:
            env_timeout = os.getenv("CLAUDE_TIMEOUT_SECONDS")
            self.timeout_seconds = int(env_timeout) if env_timeout else self._DEFAULT_TIMEOUT

    def _build_command(self, prompt: str, resume_session: str | None = None) -> list[str]:
        """Build the claude CLI command."""
        cmd = ["claude", "-p", prompt, "--output-format", "json"]

        if resume_session:
            cmd.extend(["--resume", resume_session])

        if self.model:
            cmd.extend(["--model", self.model])

        if self.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.allowed_tools)])

        if self.max_budget_usd is not None:
            cmd.extend(["--max-budget-usd", str(self.max_budget_usd)])

        return cmd

    def _parse_response(self, stdout: str, exit_code: int) -> ClaudeResponse:
        """Parse JSON output from claude -p."""
        try:
            data = json.loads(stdout)
            return ClaudeResponse(
                text=data.get("result", stdout),
                exit_code=exit_code,
                cost_usd=data.get("cost_usd", 0.0),
                duration_ms=data.get("duration_ms", 0),
                duration_api_ms=data.get("duration_api_ms", 0),
                num_turns=data.get("num_turns", 0),
                session_id=data.get("session_id", ""),
                is_error=data.get("is_error", exit_code != 0),
                raw=data,
            )
        except json.JSONDecodeError:
            return ClaudeResponse(
                text=stdout.strip(),
                exit_code=exit_code,
                is_error=exit_code != 0,
            )

    def ask(self, prompt: str, resume_session: str | None = None) -> ClaudeResponse:
        """Send a prompt to Claude Code and return the response (blocking)."""
        cmd = self._build_command(prompt, resume_session)
        logger.info("Running: %s", " ".join(cmd[:4]) + "...")

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                cwd=self.project_dir,
            )
            response = self._parse_response(result.stdout, result.returncode)

            if result.returncode != 0 and not response.text:
                response.text = result.stderr.strip() or "Unknown error"
                response.is_error = True

            logger.info(
                "Response: %d chars, cost=$%.4f, turns=%d",
                len(response.text),
                response.cost_usd,
                response.num_turns,
            )
            return response

        except subprocess.TimeoutExpired:
            logger.error("Claude timed out after %ds", self.timeout_seconds)
            return ClaudeResponse(
                text=f"Timeout after {self.timeout_seconds}s",
                exit_code=-1,
                is_error=True,
            )
        except FileNotFoundError:
            logger.error("claude CLI not found — is Claude Code installed?")
            return ClaudeResponse(
                text="claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
                exit_code=-1,
                is_error=True,
            )

    async def ask_async(self, prompt: str, resume_session: str | None = None) -> ClaudeResponse:
        """Async version of ask() for use in bot event loops."""
        cmd = self._build_command(prompt, resume_session)
        logger.info("Running async: %s", " ".join(cmd[:4]) + "...")

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.project_dir,
            )

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(), timeout=self.timeout_seconds
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                return ClaudeResponse(
                    text=f"Timeout after {self.timeout_seconds}s",
                    exit_code=-1,
                    is_error=True,
                )

            stdout = stdout_bytes.decode()
            response = self._parse_response(stdout, proc.returncode or 0)

            if proc.returncode != 0 and not response.text:
                response.text = stderr_bytes.decode().strip() or "Unknown error"
                response.is_error = True

            return response

        except FileNotFoundError:
            return ClaudeResponse(
                text="claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
                exit_code=-1,
                is_error=True,
            )


class LivingBridge(ClaudeBridge):
    """Brain-aware, session-persistent bridge for the living agent.

    Extends ClaudeBridge with:
    - Persistent memory (brain.md) injected into every prompt
    - Session continuity per user (resume conversations)
    - Automatic brain updates after each interaction
    - Event logging for history
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Lazy imports to avoid circular deps
        from lib.brain import Brain
        from lib.session_store import SessionStore

        self.brain = Brain()
        self.sessions = SessionStore()

    def _build_living_prompt(self, user_message: str) -> str:
        """Wrap user message with brain context."""
        brain_context = self.brain.get_context_prompt()
        return (
            f"{brain_context}\n\n"
            f"---\n\n"
            f"User message:\n{user_message}\n\n"
            f"---\n\n"
            f"Respond to the user's message. If you learn anything new about "
            f"the user's preferences or if there are important events to "
            f"remember, note them — your brain will be updated after this."
        )

    async def ask_as(
        self, platform: str, user_id: str, message: str
    ) -> ClaudeResponse:
        """Send a message as a specific user with brain context and session resume.

        This is the primary method for the living agent. It:
        1. Loads the brain for context
        2. Looks up the user's session for continuity
        3. Sends the prompt with brain + session
        4. Stores the new session ID
        5. Logs the event to brain history
        """
        # Build prompt with brain context
        prompt = self._build_living_prompt(message)

        # Try to resume user's session
        session_id = self.sessions.get(platform, user_id)

        # Send to Claude
        response = await self.ask_async(prompt, resume_session=session_id)

        # Store new session ID for continuity
        if response.session_id:
            self.sessions.set(platform, user_id, response.session_id)

        # Log event to brain
        short_msg = message[:80] + "..." if len(message) > 80 else message
        platform_label = f"{platform}:{user_id}"
        if response.is_error:
            self.brain.add_event(f"[{platform_label}] Error: {response.text[:100]}")
        else:
            self.brain.add_event(
                f"[{platform_label}] Q: {short_msg} "
                f"(cost=${response.cost_usd:.4f}, turns={response.num_turns})"
            )

        return response

    def ask_as_sync(
        self, platform: str, user_id: str, message: str
    ) -> ClaudeResponse:
        """Sync version of ask_as for non-async contexts."""
        prompt = self._build_living_prompt(message)
        session_id = self.sessions.get(platform, user_id)
        response = self.ask(prompt, resume_session=session_id)

        if response.session_id:
            self.sessions.set(platform, user_id, response.session_id)

        short_msg = message[:80] + "..." if len(message) > 80 else message
        platform_label = f"{platform}:{user_id}"
        if response.is_error:
            self.brain.add_event(f"[{platform_label}] Error: {response.text[:100]}")
        else:
            self.brain.add_event(
                f"[{platform_label}] Q: {short_msg} "
                f"(cost=${response.cost_usd:.4f}, turns={response.num_turns})"
            )

        return response
