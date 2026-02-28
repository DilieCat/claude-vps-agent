#!/usr/bin/env python3
"""
claude-code all-in-one setup wizard.

Run with:  python3 setup.py

This is the ONLY command you need after cloning the repository.
No external dependencies required -- works with the Python 3.10+ standard library.
"""

import os
import platform
import re
import shutil
import subprocess
import sys

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(PROJECT_ROOT, ".env")
ENV_EXAMPLE = os.path.join(PROJECT_ROOT, ".env.example")

MODULES = [
    ("telegram", "Telegram Bot"),
    ("discord", "Discord Bot"),
    ("scheduler", "Task Scheduler"),
]

REQUIREMENTS_MAP = {
    "telegram": os.path.join(PROJECT_ROOT, "bots", "telegram", "requirements.txt"),
    "discord": os.path.join(PROJECT_ROOT, "bots", "discord", "requirements.txt"),
    "scheduler": os.path.join(PROJECT_ROOT, "scheduler", "requirements.txt"),
}

SYSTEMD_SERVICE_MAP = {
    "telegram": (
        os.path.join(PROJECT_ROOT, "infra", "systemd", "telegram-bot.service"),
        "telegram-bot",
    ),
    "discord": (
        os.path.join(PROJECT_ROOT, "infra", "systemd", "discord-bot.service"),
        "discord-bot",
    ),
    "scheduler": (
        os.path.join(PROJECT_ROOT, "infra", "systemd", "scheduler.service"),
        "scheduler",
    ),
}

BANNER = r"""
      _                 _
  ___| | __ _ _   _  __| | ___        ___ ___   __| | ___
 / __| |/ _` | | | |/ _` |/ _ \___  / __/ _ \ / _` |/ _ \
| (__| | (_| | |_| | (_| |  __/___| | (_| (_) | (_| |  __/
 \___|_|\__,_|\__,_|\__,_|\___|      \___\___/ \__,_|\___|
"""

# ---------------------------------------------------------------------------
# Plain-text UI helpers (no dependencies)
# ---------------------------------------------------------------------------

def clear_screen():
    """Clear the terminal screen."""
    if sys.stdout.isatty():
        os.system("cls" if os.name == "nt" else "clear")


def print_banner():
    print(BANNER)
    print("  All-in-One Setup Wizard")
    print("  " + "=" * 40)
    print()


def heading(title):
    width = 60
    print()
    print("-" * width)
    print(f"  {title}")
    print("-" * width)
    print()


def ok(msg):
    print(f"  [ok] {msg}")


def warn(msg):
    print(f"  [!!] {msg}")


def fail(msg):
    print(f"  [FAIL] {msg}")


def info(msg):
    print(f"  {msg}")


def ask_yes_no(prompt, default=True):
    """Ask a yes/no question. Returns True for yes, False for no."""
    suffix = " [Y/n] " if default else " [y/N] "
    while True:
        answer = input(prompt + suffix).strip().lower()
        if answer == "":
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("  Please answer y or n.")


def ask_input(prompt, default=None):
    """Ask for text input with an optional default."""
    if default:
        raw = input(f"  {prompt} [{default}]: ").strip()
        return raw if raw else default
    while True:
        raw = input(f"  {prompt}: ").strip()
        if raw:
            return raw
        print("  A value is required.")


def ask_input_optional(prompt, default=""):
    """Ask for text input where empty is acceptable."""
    raw = input(f"  {prompt} [{default}]: ").strip()
    return raw if raw else default


def ask_comma_list(prompt, example):
    """Ask for a comma-separated list. Returns cleaned string."""
    raw = input(f"  {prompt} (e.g. {example}): ").strip()
    return ",".join(s.strip() for s in raw.split(",") if s.strip())


# ---------------------------------------------------------------------------
# System helpers
# ---------------------------------------------------------------------------

def run_cmd(args, timeout=30, capture=True):
    """Run a command, return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(
            args,
            capture_output=capture,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"Command not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return 1, "", "Command timed out"
    except Exception as e:
        return 1, "", str(e)


def cmd_exists(name):
    """Check if a command is on PATH."""
    return shutil.which(name) is not None


def get_version(name, args=None):
    """Get the version string from a command, or None."""
    if args is None:
        args = ["--version"]
    path = shutil.which(name)
    if not path:
        return None
    rc, stdout, stderr = run_cmd([path] + args, timeout=15)
    if rc == 0:
        return stdout or stderr
    return None


def parse_version_tuple(version_str):
    """Extract major.minor version numbers from a version string."""
    match = re.search(r"(\d+)\.(\d+)", version_str)
    if match:
        return int(match.group(1)), int(match.group(2))
    return None


def is_headless():
    """Detect if we are running without a display (headless server)."""
    if platform.system() == "Darwin":
        return False
    return not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY")


def is_linux():
    return platform.system() == "Linux"


def has_systemctl():
    return is_linux() and cmd_exists("systemctl")


def load_existing_env():
    """Load existing .env file into a dict, if it exists."""
    env = {}
    if not os.path.exists(ENV_FILE):
        return env
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                env[key] = value
    return env


# ---------------------------------------------------------------------------
# Step 1 - Welcome
# ---------------------------------------------------------------------------

def step_welcome():
    clear_screen()
    print_banner()
    info("This wizard sets up everything you need to run claude-code.")
    info("It checks prerequisites, collects configuration, installs")
    info("dependencies, and gets you ready to go.")
    print()

    if os.path.exists(ENV_FILE):
        warn("An existing .env file was detected.")
        print()
        choice = ask_yes_no("  Update existing configuration?", default=True)
        if not choice:
            print()
            info("No changes made. Re-run the wizard when you are ready.")
            raise SystemExit(0)
        print()
        info("Existing values will be shown as defaults. Press Enter to keep them.")
        print()


# ---------------------------------------------------------------------------
# Step 2 - Prerequisites
# ---------------------------------------------------------------------------

def step_prerequisites():
    heading("Step 1: Checking Prerequisites")
    all_ok = True

    # -- Python version --
    py_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if sys.version_info >= (3, 10):
        ok(f"Python {py_version}")
    else:
        fail(f"Python {py_version} -- version 3.10 or higher is required")
        info("Download from: https://www.python.org/downloads/")
        all_ok = False

    # -- Node.js --
    node_ver = get_version("node")
    if node_ver:
        parsed = parse_version_tuple(node_ver)
        if parsed and parsed[0] >= 18:
            ok(f"Node.js {node_ver}")
        else:
            fail(f"Node.js {node_ver} -- version 18 or higher is required")
            info("Download from: https://nodejs.org/")
            all_ok = False
    else:
        fail("Node.js not found -- version 18 or higher is required")
        info("Download from: https://nodejs.org/")
        all_ok = False

    # -- npm --
    npm_ver = get_version("npm")
    if npm_ver:
        ok(f"npm {npm_ver}")
    else:
        fail("npm not found (usually installed with Node.js)")
        all_ok = False

    # -- Claude CLI --
    claude_ver = get_version("claude")
    if claude_ver:
        ok(f"Claude CLI ({claude_ver})")
    else:
        warn("Claude CLI not found")
        print()
        if cmd_exists("npm"):
            if ask_yes_no("  Install Claude CLI now? (npm install -g @anthropic-ai/claude-code)"):
                info("Installing Claude CLI...")
                rc, stdout, stderr = run_cmd(
                    ["npm", "install", "-g", "@anthropic-ai/claude-code"],
                    timeout=120,
                    capture=True,
                )
                if rc == 0:
                    ok("Claude CLI installed successfully")
                else:
                    fail("Claude CLI installation failed")
                    if stderr:
                        info(f"Error: {stderr[:200]}")
                    info("Try installing manually: npm install -g @anthropic-ai/claude-code")
                    all_ok = False
            else:
                warn("Claude CLI is required. Install later with:")
                info("  npm install -g @anthropic-ai/claude-code")
                all_ok = False
        else:
            info("Install Node.js first, then run: npm install -g @anthropic-ai/claude-code")
            all_ok = False

    if not all_ok:
        print()
        warn("Some prerequisites are missing.")
        if not ask_yes_no("  Continue anyway?", default=True):
            raise SystemExit(1)

    return all_ok


# ---------------------------------------------------------------------------
# Step 3 - Claude authentication
# ---------------------------------------------------------------------------

def step_claude_auth():
    heading("Step 2: Claude Authentication")

    if not cmd_exists("claude"):
        warn("Claude CLI not found -- skipping authentication check.")
        info("Install it later and run: claude login")
        return

    # Quick check: try running a simple prompt
    info("Checking if Claude CLI is authenticated...")
    rc, stdout, stderr = run_cmd(
        ["claude", "-p", "say ok", "--output-format", "json"],
        timeout=30,
    )

    if rc == 0:
        ok("Claude CLI is authenticated and working")
        return

    # Not authenticated
    warn("Claude CLI is not authenticated.")
    print()

    if is_headless():
        info("This appears to be a headless server (no display detected).")
        print()
        info("To authenticate, you need to set up SSH port forwarding from")
        info("your local machine so the OAuth flow can complete in your browser.")
        print()
        info("From your local machine, run:")
        info("  ssh -L 9315:localhost:9315 user@this-server")
        print()
        info("Then, in another terminal on this server, run:")
        info("  claude login")
        print()
        info("The OAuth URL will open in your local browser via the SSH tunnel.")
        print()
        if ask_yes_no("  Have you completed authentication in another terminal?", default=False):
            # Verify
            rc, stdout, stderr = run_cmd(
                ["claude", "-p", "say ok", "--output-format", "json"],
                timeout=30,
            )
            if rc == 0:
                ok("Claude CLI authentication verified")
            else:
                warn("Authentication could not be verified. You can try again later.")
        else:
            info("You can authenticate later. The setup will continue.")
    else:
        info("Running 'claude login' to authenticate...")
        print()
        try:
            subprocess.run(["claude", "login"], timeout=120)
        except subprocess.TimeoutExpired:
            warn("Login timed out. You can run 'claude login' manually later.")
            return
        except Exception as e:
            warn(f"Login failed: {e}")
            info("You can run 'claude login' manually later.")
            return

        # Verify
        rc, stdout, stderr = run_cmd(
            ["claude", "-p", "say ok", "--output-format", "json"],
            timeout=30,
        )
        if rc == 0:
            ok("Claude CLI authentication verified")
        else:
            warn("Authentication could not be verified. You can run 'claude login' later.")


# ---------------------------------------------------------------------------
# Step 4 - Module selection
# ---------------------------------------------------------------------------

def step_modules():
    heading("Step 3: Module Selection")
    info("Choose which modules to enable:")
    print()

    selected = []
    for key, label in MODULES:
        if ask_yes_no(f"  Enable {label}?", default=True):
            selected.append(key)

    if not selected:
        print()
        warn("You must enable at least one module.")
        return step_modules()

    print()
    for key in selected:
        label = dict(MODULES)[key]
        ok(f"{label} enabled")

    return selected


# ---------------------------------------------------------------------------
# Step 5 - Per-module config
# ---------------------------------------------------------------------------

def step_module_config(selected, existing_env):
    env_vars = {}

    if "telegram" in selected:
        heading("Step 4a: Telegram Bot Configuration")
        info("You need a bot token from @BotFather on Telegram.")
        info("  https://t.me/BotFather")
        print()
        token = ask_input(
            "Bot token",
            default=existing_env.get("TELEGRAM_BOT_TOKEN"),
        )
        users = ask_comma_list(
            "Allowed Telegram user IDs",
            existing_env.get("TELEGRAM_ALLOWED_USERS", "123456789,987654321"),
        )
        env_vars["TELEGRAM_BOT_TOKEN"] = token
        if users:
            env_vars["TELEGRAM_ALLOWED_USERS"] = users

    if "discord" in selected:
        heading("Step 4b: Discord Bot Configuration")
        info("You need a bot token from the Discord Developer Portal.")
        info("  https://discord.com/developers/applications")
        print()
        token = ask_input(
            "Bot token",
            default=existing_env.get("DISCORD_BOT_TOKEN"),
        )
        users = ask_comma_list(
            "Allowed Discord user IDs",
            existing_env.get("DISCORD_ALLOWED_USERS", "123456789012345678,987654321098765432"),
        )
        env_vars["DISCORD_BOT_TOKEN"] = token
        if users:
            env_vars["DISCORD_ALLOWED_USERS"] = users

    if "scheduler" in selected:
        heading("Step 4c: Task Scheduler Configuration")
        info("The scheduler uses scheduler/tasks.yaml for task definitions.")
        info("You can customize it later.")
        print()
        ok("Default tasks.yaml will be used.")

    return env_vars


# ---------------------------------------------------------------------------
# Step 6 - Generate .env
# ---------------------------------------------------------------------------

ENV_SECTION_ORDER = [
    ("Telegram Bot", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]),
    ("Discord Bot", ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USERS"]),
]


def step_generate_env(env_vars):
    heading("Step 5: Generate .env")

    lines = []
    for section_name, keys in ENV_SECTION_ORDER:
        section_lines = []
        for k in keys:
            if k in env_vars:
                section_lines.append(f'{k}="{env_vars[k]}"')
        if section_lines:
            lines.append(f"# {section_name}")
            lines.extend(section_lines)
            lines.append("")

    # Add any remaining keys not in the section order
    ordered_keys = set()
    for _, keys in ENV_SECTION_ORDER:
        ordered_keys.update(keys)
    extra = {k: v for k, v in env_vars.items() if k not in ordered_keys}
    if extra:
        lines.append("# Additional settings")
        for k, v in extra.items():
            lines.append(f'{k}="{v}"')
        lines.append("")

    content = "\n".join(lines) + "\n"

    # Preview
    print("  --- .env preview ---")
    for line in content.strip().split("\n"):
        # Mask tokens in preview
        if "TOKEN" in line or "KEY" in line:
            key_part, _, val_part = line.partition("=")
            if val_part and len(val_part) > 10:
                masked = val_part[:5] + "..." + val_part[-3:]
                print(f"  {key_part}={masked}")
            else:
                print(f"  {line}")
        else:
            print(f"  {line}")
    print("  --- end preview ---")
    print()

    if not ask_yes_no("  Write this .env file?", default=True):
        warn("Skipped writing .env file.")
        return

    with open(ENV_FILE, "w") as f:
        f.write(content)
    os.chmod(ENV_FILE, 0o600)

    ok(f".env written to {ENV_FILE}")
    ok("File permissions set to 0600 (owner read/write only)")


# ---------------------------------------------------------------------------
# Step 7 - Create venv and install dependencies
# ---------------------------------------------------------------------------

def step_install_deps(selected):
    heading("Step 6: Install Dependencies")

    venv_dir = os.path.join(PROJECT_ROOT, ".venv")
    pip = os.path.join(venv_dir, "bin", "pip")

    if not ask_yes_no("  Create a virtualenv and install dependencies now?", default=True):
        warn("Skipping dependency installation.")
        info("Run these commands later:")
        info(f"  python3 -m venv {venv_dir}")
        info(f"  {pip} install --upgrade pip")
        for mod in selected:
            req_file = REQUIREMENTS_MAP.get(mod)
            if req_file and os.path.exists(req_file):
                info(f"  {pip} install -r {req_file}")
        return

    # Create venv
    info("Creating virtual environment...")
    rc, stdout, stderr = run_cmd(
        [sys.executable, "-m", "venv", venv_dir],
        timeout=60,
    )
    if rc != 0:
        fail(f"Failed to create virtual environment: {stderr}")
        return
    ok("Virtual environment created at .venv/")

    # Upgrade pip
    info("Upgrading pip...")
    run_cmd([pip, "install", "--upgrade", "--quiet", "pip"], timeout=60)

    # Install per-module deps
    for mod in selected:
        req_file = REQUIREMENTS_MAP.get(mod)
        if req_file and os.path.exists(req_file):
            label = dict(MODULES)[mod]
            info(f"Installing {label} dependencies...")
            rc, stdout, stderr = run_cmd(
                [pip, "install", "--quiet", "-r", req_file],
                timeout=120,
            )
            if rc == 0:
                ok(f"{label} dependencies installed")
            else:
                fail(f"{label} dependency installation failed")
                if stderr:
                    for line in stderr.split("\n")[:3]:
                        info(f"  {line}")

    ok("All dependencies installed")


# ---------------------------------------------------------------------------
# Step 8 - Optionally install systemd services (Linux only)
# ---------------------------------------------------------------------------

def step_systemd_services(selected):
    if not has_systemctl():
        return

    heading("Step 7: Systemd Services (optional)")
    info("This server has systemd. You can install services so your")
    info("bots start automatically and restart on failure.")
    print()

    if not ask_yes_no("  Install systemd services for selected modules?", default=False):
        info("Skipping systemd service installation.")
        return

    installed_services = []
    for mod in selected:
        if mod not in SYSTEMD_SERVICE_MAP:
            continue
        src_path, service_name = SYSTEMD_SERVICE_MAP[mod]
        if not os.path.exists(src_path):
            warn(f"Service file not found: {src_path}")
            continue

        dest = f"/etc/systemd/system/{service_name}.service"
        info(f"Installing {service_name}.service...")

        rc, _, stderr = run_cmd(
            ["sudo", "cp", src_path, dest],
            timeout=10,
        )
        if rc != 0:
            fail(f"Failed to copy {service_name}.service: {stderr}")
            continue

        rc, _, _ = run_cmd(["sudo", "systemctl", "daemon-reload"], timeout=10)
        rc, _, stderr = run_cmd(
            ["sudo", "systemctl", "enable", service_name],
            timeout=10,
        )
        if rc == 0:
            ok(f"{service_name} enabled")
            installed_services.append(service_name)
        else:
            fail(f"Failed to enable {service_name}: {stderr}")

    if installed_services:
        print()
        if ask_yes_no("  Start the services now?", default=True):
            for svc in installed_services:
                rc, _, stderr = run_cmd(
                    ["sudo", "systemctl", "start", svc],
                    timeout=15,
                )
                if rc == 0:
                    ok(f"{svc} started")
                else:
                    fail(f"Failed to start {svc}: {stderr}")


# ---------------------------------------------------------------------------
# Step 9 - Summary
# ---------------------------------------------------------------------------

def step_summary(selected):
    heading("Setup Complete")

    info("What was set up:")
    for key in selected:
        label = dict(MODULES)[key]
        ok(label)
    if os.path.exists(ENV_FILE):
        ok(".env file configured")
    venv_dir = os.path.join(PROJECT_ROOT, ".venv")
    if os.path.exists(venv_dir):
        ok("Virtual environment at .venv/")
    print()

    info("To start services manually:")
    print()
    info("  source .venv/bin/activate")
    print()
    if "telegram" in selected:
        info("  make telegram      # Start the Telegram bot")
    if "discord" in selected:
        info("  make discord       # Start the Discord bot")
    if "scheduler" in selected:
        info("  make scheduler     # Start the task scheduler")
    print()
    info("Re-run this wizard any time with:  python3 setup.py")
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    try:
        # Load existing config for defaults
        existing_env = load_existing_env()

        # 1. Welcome
        step_welcome()

        # 2. Prerequisites (python 3.10+, node 18+, claude CLI)
        step_prerequisites()

        # 3. Claude authentication
        step_claude_auth()

        # 4. Module selection
        selected = step_modules()

        # 5. Per-module config
        env_vars = {}
        env_vars.update(step_module_config(selected, existing_env))

        # 6. Generate .env
        step_generate_env(env_vars)

        # 7. Create venv + install deps
        step_install_deps(selected)

        # 8. Optionally install systemd services (Linux only)
        step_systemd_services(selected)

        # 9. Summary
        step_summary(selected)

    except KeyboardInterrupt:
        print("\n\n  Setup cancelled.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
