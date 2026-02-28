#!/usr/bin/env python3
"""
claude-vps-agent interactive setup wizard.

Run with: python3 setup.py
Automatically installs the 'rich' library if not present.
"""

import importlib
import os
import shutil
import subprocess
import sys
import textwrap

# ---------------------------------------------------------------------------
# Bootstrap: ensure 'rich' is available
# ---------------------------------------------------------------------------

def _ensure_rich():
    """Install rich into the running interpreter if it is missing."""
    try:
        importlib.import_module("rich")
    except ImportError:
        print("Installing 'rich' library ...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", "rich>=13.0"],
        )

_ensure_rich()

# ---------------------------------------------------------------------------
# Imports that require rich
# ---------------------------------------------------------------------------

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, IntPrompt, Prompt
from rich.table import Table
from rich.text import Text
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich import box

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(PROJECT_ROOT, ".env")
ENV_EXAMPLE = os.path.join(PROJECT_ROOT, ".env.example")

BANNER = r"""
      _                 _
  ___| | __ _ _   _  __| | ___  __   ___ __  ___
 / __| |/ _` | | | |/ _` |/ _ \ \ \ / / '_ \/ __|
| (__| | (_| | |_| | (_| |  __/  \ V /| |_) \__ \
 \___|_|\__,_|\__,_|\__,_|\___|   \_/ | .__/|___/
                                      |_|         agent
"""

console = Console()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def heading(title: str) -> None:
    console.print()
    console.rule(f"[bold cyan]{title}[/bold cyan]")
    console.print()


def success(msg: str) -> None:
    console.print(f"  [green]:heavy_check_mark:[/green] {msg}")


def warn(msg: str) -> None:
    console.print(f"  [yellow]![/yellow] {msg}")


def fail(msg: str) -> None:
    console.print(f"  [red]x[/red] {msg}")


def check_command(name: str, test_args: list[str] | None = None) -> bool:
    """Return True if *name* is on PATH and responds to *test_args*."""
    path = shutil.which(name)
    if path is None:
        return False
    if test_args is None:
        test_args = ["--version"]
    try:
        subprocess.run(
            [path, *test_args],
            capture_output=True,
            timeout=15,
        )
        return True
    except Exception:
        return False


def comma_list(prompt_text: str, example: str) -> str:
    """Prompt for a comma-separated list; return cleaned string."""
    raw = Prompt.ask(f"  {prompt_text} [dim](e.g. {example})[/dim]")
    return ",".join(s.strip() for s in raw.split(",") if s.strip())


# ---------------------------------------------------------------------------
# Step 1 - Welcome
# ---------------------------------------------------------------------------

def step_welcome() -> None:
    console.print(
        Panel(
            Text(BANNER, style="bold bright_cyan", justify="center"),
            subtitle="[dim]Interactive Setup Wizard[/dim]",
            box=box.DOUBLE_EDGE,
            border_style="bright_cyan",
            padding=(0, 2),
        )
    )
    console.print(
        "  This wizard will walk you through configuring [bold]claude-vps-agent[/bold].\n"
        "  It creates a [cyan].env[/cyan] file, installs dependencies, and verifies\n"
        "  that everything is ready to go.\n"
    )
    if os.path.exists(ENV_FILE):
        warn("An existing [cyan].env[/cyan] file was detected.")
        if not Confirm.ask("  Overwrite it with a fresh configuration?", default=False):
            console.print("\n  Re-run the wizard when you are ready. Bye!")
            raise SystemExit(0)


# ---------------------------------------------------------------------------
# Step 2 - Prerequisites
# ---------------------------------------------------------------------------

PREREQUISITES = [
    ("python3", None, "https://www.python.org/downloads/"),
    ("node", None, "https://nodejs.org/"),
    ("npm", None, "https://nodejs.org/"),
    ("claude", None, "npm install -g @anthropic-ai/claude-code"),
]


def step_prerequisites() -> bool:
    heading("Prerequisites")
    all_ok = True
    for name, args, hint in PREREQUISITES:
        if check_command(name, args):
            success(f"[bold]{name}[/bold] found")
        else:
            fail(f"[bold]{name}[/bold] not found  ->  {hint}")
            all_ok = False

    if not all_ok:
        warn("Some prerequisites are missing. The wizard can continue,")
        warn("but you will need to install them before running the project.")
        if not Confirm.ask("  Continue anyway?", default=True):
            raise SystemExit(1)
    return all_ok


# ---------------------------------------------------------------------------
# Step 3 - Module selection
# ---------------------------------------------------------------------------

MODULES = [
    ("telegram", "Telegram Bot"),
    ("discord", "Discord Bot"),
    ("scheduler", "Task Scheduler"),
]


def step_modules() -> list[str]:
    heading("Module Selection")
    console.print("  Choose which modules to enable:\n")

    selected: list[str] = []
    for key, label in MODULES:
        if Confirm.ask(f"  Enable [bold]{label}[/bold]?", default=True):
            selected.append(key)

    if not selected:
        warn("You must enable at least one module.")
        return step_modules()

    console.print()
    for key in selected:
        label = dict(MODULES)[key]
        success(f"{label} enabled")
    return selected


# ---------------------------------------------------------------------------
# Step 4 - Per-module config
# ---------------------------------------------------------------------------

def config_telegram() -> dict[str, str]:
    heading("Telegram Bot Configuration")
    console.print(
        "  You need a bot token from [link=https://t.me/BotFather]@BotFather[/link] on Telegram.\n"
    )
    token = Prompt.ask("  Bot token")
    users = comma_list("Allowed Telegram user IDs", "123456789,987654321")
    return {
        "TELEGRAM_BOT_TOKEN": token,
        "TELEGRAM_ALLOWED_USERS": users,
    }


def config_discord() -> dict[str, str]:
    heading("Discord Bot Configuration")
    console.print(
        "  You need a bot token from the "
        "[link=https://discord.com/developers/applications]Discord Developer Portal[/link].\n"
    )
    token = Prompt.ask("  Bot token")
    users = comma_list("Allowed Discord user IDs", "123456789012345678,987654321098765432")
    return {
        "DISCORD_BOT_TOKEN": token,
        "DISCORD_ALLOWED_USERS": users,
    }


def config_scheduler() -> dict[str, str]:
    heading("Task Scheduler Configuration")
    console.print(
        "  The scheduler uses [cyan]scheduler/tasks.yaml[/cyan] for its task definitions.\n"
        "  You can customise it later.\n"
    )
    success("Default tasks.yaml will be used.")
    return {}


MODULE_CONFIGURATORS = {
    "telegram": config_telegram,
    "discord": config_discord,
    "scheduler": config_scheduler,
}


def step_module_config(selected: list[str]) -> dict[str, str]:
    env_vars: dict[str, str] = {}
    for mod in selected:
        env_vars.update(MODULE_CONFIGURATORS[mod]())
    return env_vars


# ---------------------------------------------------------------------------
# Step 5 - Claude Code settings
# ---------------------------------------------------------------------------

def step_claude_settings() -> dict[str, str]:
    heading("Claude Code Settings")
    env: dict[str, str] = {}

    env["CLAUDE_PROJECT_DIR"] = Prompt.ask(
        "  Project directory",
        default="~/projects",
    )
    env["CLAUDE_MODEL"] = Prompt.ask(
        "  Model preference",
        default="claude-opus-4-6",
    )
    env["CLAUDE_ALLOWED_TOOLS"] = Prompt.ask(
        "  Allowed tools (comma-separated)",
        default="Read,Write,Edit,Bash,Glob,Grep",
    )

    if Confirm.ask("  Set a per-request budget limit?", default=False):
        budget = Prompt.ask("  Max USD per request", default="0.50")
        env["CLAUDE_MAX_BUDGET_USD"] = budget

    timeout = Prompt.ask(
        "  Timeout in seconds per request",
        default="300",
    )
    env["CLAUDE_TIMEOUT_SECONDS"] = timeout

    return env


# ---------------------------------------------------------------------------
# Step 6 - VPS settings
# ---------------------------------------------------------------------------

def step_vps_settings() -> dict[str, str]:
    heading("VPS Deployment (optional)")
    if not Confirm.ask("  Are you deploying to a VPS?", default=False):
        return {}

    env: dict[str, str] = {}
    env["VPS_HOST"] = Prompt.ask("  VPS hostname or IP")
    env["VPS_USER"] = Prompt.ask("  SSH user", default="claude")
    env["VPS_PORT"] = Prompt.ask("  SSH port", default="22")

    console.print()
    if Confirm.ask("  Configure Tailscale auth key?", default=False):
        env["TAILSCALE_AUTH_KEY"] = Prompt.ask("  Tailscale auth key")

    return env


# ---------------------------------------------------------------------------
# Step 6b - Optional MCP tokens
# ---------------------------------------------------------------------------

def step_optional_tokens() -> dict[str, str]:
    heading("Optional Integrations")
    env: dict[str, str] = {}

    if Confirm.ask("  Configure a GitHub token for MCP?", default=False):
        env["GITHUB_TOKEN"] = Prompt.ask("  GitHub personal access token")

    if Confirm.ask("  Configure a Brave Search API key?", default=False):
        env["BRAVE_API_KEY"] = Prompt.ask("  Brave API key")

    return env


# ---------------------------------------------------------------------------
# Step 7 - Generate .env
# ---------------------------------------------------------------------------

ENV_SECTION_ORDER = [
    ("VPS Connection", ["VPS_HOST", "VPS_USER", "VPS_PORT"]),
    ("Telegram Bot", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]),
    ("Discord Bot", ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USERS"]),
    ("Claude Code settings", [
        "CLAUDE_PROJECT_DIR",
        "CLAUDE_ALLOWED_TOOLS",
        "CLAUDE_MODEL",
    ]),
    ("Claude budget / timeout", [
        "CLAUDE_MAX_BUDGET_USD",
        "CLAUDE_TIMEOUT_SECONDS",
    ]),
    ("Tailscale (optional)", ["TAILSCALE_AUTH_KEY"]),
    ("MCP Servers (optional)", ["GITHUB_TOKEN", "BRAVE_API_KEY"]),
]


def step_generate_env(env_vars: dict[str, str]) -> None:
    heading("Generate .env")

    lines: list[str] = []
    for section_name, keys in ENV_SECTION_ORDER:
        section_lines: list[str] = []
        for k in keys:
            if k in env_vars:
                section_lines.append(f'{k}="{env_vars[k]}"')
        if section_lines:
            lines.append(f"# {section_name}")
            lines.extend(section_lines)
            lines.append("")

    content = "\n".join(lines) + "\n"

    # Preview
    console.print(Panel(content.strip(), title=".env", border_style="green", box=box.ROUNDED))

    with open(ENV_FILE, "w") as f:
        f.write(content)
    os.chmod(ENV_FILE, 0o600)

    success(f".env written to [cyan]{ENV_FILE}[/cyan]")


# ---------------------------------------------------------------------------
# Step 8 - Install dependencies
# ---------------------------------------------------------------------------

REQUIREMENTS_MAP = {
    "telegram": os.path.join(PROJECT_ROOT, "bots", "telegram", "requirements.txt"),
    "discord": os.path.join(PROJECT_ROOT, "bots", "discord", "requirements.txt"),
    "scheduler": os.path.join(PROJECT_ROOT, "scheduler", "requirements.txt"),
}


def step_install_deps(selected: list[str]) -> None:
    heading("Install Dependencies")

    if not Confirm.ask("  Create a virtualenv and install dependencies now?", default=True):
        warn("Skipping dependency installation. Run [bold]make install[/bold] later.")
        return

    venv_dir = os.path.join(PROJECT_ROOT, ".venv")
    pip = os.path.join(venv_dir, "bin", "pip")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        # Create venv
        task = progress.add_task("Creating virtual environment ...", total=None)
        subprocess.run(
            [sys.executable, "-m", "venv", venv_dir],
            capture_output=True,
        )
        progress.update(task, description="Upgrading pip ...")
        subprocess.run(
            [pip, "install", "--upgrade", "--quiet", "pip"],
            capture_output=True,
        )

        for mod in selected:
            req_file = REQUIREMENTS_MAP.get(mod)
            if req_file and os.path.exists(req_file):
                label = dict(MODULES)[mod]
                progress.update(task, description=f"Installing {label} deps ...")
                subprocess.run(
                    [pip, "install", "--quiet", "-r", req_file],
                    capture_output=True,
                )

        progress.update(task, description="Done")

    success("Virtual environment created at [cyan].venv/[/cyan]")
    success("Dependencies installed for selected modules")


# ---------------------------------------------------------------------------
# Step 9 - Verify installation
# ---------------------------------------------------------------------------

def step_verify(selected: list[str]) -> None:
    heading("Verify Installation")

    venv_python = os.path.join(PROJECT_ROOT, ".venv", "bin", "python")
    use_venv = os.path.exists(venv_python)
    python_bin = venv_python if use_venv else sys.executable

    checks: list[tuple[str, str]] = [
        ("python-dotenv", "dotenv"),
    ]
    if "telegram" in selected:
        checks.append(("python-telegram-bot", "telegram"))
    if "discord" in selected:
        checks.append(("discord.py", "discord"))
    if "scheduler" in selected:
        checks.append(("croniter", "croniter"))
        checks.append(("PyYAML", "yaml"))

    for label, module in checks:
        try:
            result = subprocess.run(
                [python_bin, "-c", f"import {module}"],
                capture_output=True,
                timeout=10,
            )
            if result.returncode == 0:
                success(f"{label} importable")
            else:
                fail(f"{label} import failed")
        except Exception:
            fail(f"{label} check error")

    # claude CLI
    if check_command("claude"):
        try:
            result = subprocess.run(
                ["claude", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            version = result.stdout.strip() or result.stderr.strip()
            success(f"Claude CLI: {version}")
        except Exception:
            warn("Claude CLI found but could not get version")
    else:
        warn("Claude CLI not found -- install with: npm install -g @anthropic-ai/claude-code")


# ---------------------------------------------------------------------------
# Step 10 - Next steps
# ---------------------------------------------------------------------------

def step_next(selected: list[str]) -> None:
    heading("Setup Complete")

    rows: list[str] = []

    rows.append("[bold]Activate the virtual environment:[/bold]")
    rows.append("  source .venv/bin/activate\n")

    if "telegram" in selected:
        rows.append("[bold]Start the Telegram bot:[/bold]")
        rows.append("  make telegram\n")

    if "discord" in selected:
        rows.append("[bold]Start the Discord bot:[/bold]")
        rows.append("  make discord\n")

    if "scheduler" in selected:
        rows.append("[bold]Start the scheduler:[/bold]")
        rows.append("  make scheduler\n")

    rows.append("[bold]Deploy to VPS:[/bold]")
    rows.append("  make setup-vps   # provision the server")
    rows.append("  make auth        # authenticate Claude Code")
    rows.append("  make deploy      # deploy and start services\n")

    rows.append("[dim]Re-run this wizard at any time with:[/dim]  python3 setup.py")

    console.print(
        Panel(
            "\n".join(rows),
            title="[bold green]Next Steps[/bold green]",
            border_style="green",
            box=box.ROUNDED,
            padding=(1, 2),
        )
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    try:
        # 1. Welcome
        step_welcome()

        # 2. Prerequisites
        step_prerequisites()

        # 3. Module selection
        selected = step_modules()

        # 4. Per-module config
        env_vars: dict[str, str] = {}
        env_vars.update(step_module_config(selected))

        # 5. Claude Code settings
        env_vars.update(step_claude_settings())

        # 6. VPS settings
        env_vars.update(step_vps_settings())

        # 6b. Optional tokens
        env_vars.update(step_optional_tokens())

        # 7. Generate .env
        step_generate_env(env_vars)

        # 8. Install deps
        step_install_deps(selected)

        # 9. Verify
        step_verify(selected)

        # 10. Next steps
        step_next(selected)

    except KeyboardInterrupt:
        console.print("\n\n  [dim]Setup cancelled.[/dim]")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
