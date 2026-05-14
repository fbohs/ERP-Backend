#!/usr/bin/env bash
# Block process.env reads outside src/shared/config/. The typed config object
# is the only sanctioned way to read environment variables.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

# Allow inside src/shared/config/
case "$FILE_PATH" in
  *src/shared/config/*) exit 0 ;;
esac

if echo "$NEW_CONTENT" | grep -qE "process\.env\."; then
  echo "BLOCKED: process.env reads belong in src/shared/config/. Import the typed config object." >&2
  exit 2
fi

exit 0
