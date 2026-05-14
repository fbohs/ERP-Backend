#!/usr/bin/env bash
# Lint changed TS files after an edit. Non-blocking — surfaces issues to Claude
# in stdout so it can react in the next turn. Stays fast: only lints the one file.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')

case "$FILE_PATH" in
  *.ts|*.tsx)
    if [ -f "$FILE_PATH" ]; then
      npx eslint --max-warnings 0 "$FILE_PATH" 2>&1 || true
    fi
    ;;
esac

exit 0
