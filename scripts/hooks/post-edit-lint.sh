#!/usr/bin/env bash
#
# Hook: PostToolUse (Edit|Write) — Quick lint after file modifications.
#
# Checks if the modified file is a Python file and runs py_compile on it.
# Non-blocking (exit 0 always) — just provides feedback.
#
set -uo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.output.filePath // .input.file_path // ""')

# Only check Python files
if [[ "$FILE_PATH" == *.py ]]; then
  if ! python3 -m py_compile "$FILE_PATH" 2>&1; then
    echo '{"systemMessage": "Warning: Python syntax error in '"$FILE_PATH"'. Please fix it."}'
  fi
fi

exit 0
