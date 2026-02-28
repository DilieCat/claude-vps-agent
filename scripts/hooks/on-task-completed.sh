#!/usr/bin/env bash
#
# Hook: TaskCompleted — Validates that completed tasks meet quality standards.
#
# Runs syntax checks on all Python and shell files. If any fail,
# blocks the task completion (exit 2) so the agent has to fix them first.
#
set -euo pipefail

INPUT=$(cat)
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // "unknown"')
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // "."')

cd "$PROJECT_DIR"

ERRORS=""

# Check all Python files compile
while IFS= read -r f; do
  if ! python3 -m py_compile "$f" 2>/dev/null; then
    ERRORS="${ERRORS}Python syntax error: ${f}\n"
  fi
done < <(find . -name "*.py" -not -path "./.venv/*" -not -path "./.git/*" 2>/dev/null)

# Check all shell scripts parse
while IFS= read -r f; do
  if ! bash -n "$f" 2>/dev/null; then
    ERRORS="${ERRORS}Shell syntax error: ${f}\n"
  fi
done < <(find . -name "*.sh" -not -path "./.venv/*" -not -path "./.git/*" 2>/dev/null)

if [ -n "$ERRORS" ]; then
  echo "Task '${TASK_SUBJECT}' has syntax errors. Fix before completing:" >&2
  echo -e "$ERRORS" >&2
  exit 2
fi

exit 0
