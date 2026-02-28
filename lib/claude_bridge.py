"""
claude_bridge.py — Shared wrapper around `claude -p` for all integrations.

Usage:
    from lib.claude_bridge import ClaudeBridge

    bridge = ClaudeBridge(project_dir="/home/user/my-project")
    response = bridge.ask("Fix the bug in auth.py")
    print(response.text)
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

    def __init__(
        self,
        project_dir: str | None = None,
        model: str | None = None,
        allowed_tools: list[str] | None = None,
        max_budget_usd: float | None = None,
        timeout_seconds: int = 300,
    ):
        self.project_dir = project_dir or os.getcwd()
        self.model = model or os.getenv("CLAUDE_MODEL")
        self.allowed_tools = allowed_tools or os.getenv(
            "CLAUDE_ALLOWED_TOOLS", ""
        ).split(",")
        self.allowed_tools = [t.strip() for t in self.allowed_tools if t.strip()]
        self.max_budget_usd = max_budget_usd
        self.timeout_seconds = timeout_seconds

    def _build_command(self, prompt: str) -> list[str]:
        """Build the claude CLI command."""
        cmd = ["claude", "-p", prompt, "--output-format", "json"]

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

    def ask(self, prompt: str) -> ClaudeResponse:
        """Send a prompt to Claude Code and return the response (blocking)."""
        cmd = self._build_command(prompt)
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

    async def ask_async(self, prompt: str) -> ClaudeResponse:
        """Async version of ask() for use in bot event loops."""
        cmd = self._build_command(prompt)
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
