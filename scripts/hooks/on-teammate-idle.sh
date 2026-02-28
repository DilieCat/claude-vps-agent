#!/usr/bin/env bash
#
# Hook: TeammateIdle — Checks if a teammate has uncommitted work before going idle.
#
# If the teammate has unstaged changes and no open PR, it's probably not done yet.
# Exit 2 forces the teammate to keep working (commit + create PR).
#
set -euo pipefail

INPUT=$(cat)
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$PROJECT_DIR"

# Skip if not in a git repo
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

# Check for uncommitted changes
DIRTY=$(git status --porcelain 2>/dev/null | head -5)
if [ -n "$DIRTY" ]; then
  echo "You have uncommitted changes. Please commit your work and create a PR before stopping." >&2
  exit 2
fi

exit 0
