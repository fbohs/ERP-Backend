#!/usr/bin/env bash
# Block console.* calls outside test files. Use Pino (log.*) instead.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

# Allow in test files and non-source files (docs, config, scripts)
case "$FILE_PATH" in
  *.test.ts|*.spec.ts|*__tests__*) exit 0 ;;
  *.md|*.json|*.yaml|*.yml|*.sh) exit 0 ;;
esac

if echo "$NEW_CONTENT" | grep -qE "console\.(log|info|warn|error|debug)\("; then
  echo "BLOCKED: console.* is forbidden in production code. Use Pino: log.info / log.warn / log.error." >&2
  exit 2
fi

exit 0
