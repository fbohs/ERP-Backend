#!/usr/bin/env bash
# Block PrismaClient imports outside src/shared/db/.
# Claude Code passes a JSON payload on stdin describing the tool call.
# We parse it with jq, inspect the target file and the proposed content,
# and exit 2 to block the call when a violation is detected.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

# Allow edits inside src/shared/db/
case "$FILE_PATH" in
  *src/shared/db/*) exit 0 ;;
esac

# Detect PrismaClient / @prisma/client imports
if echo "$NEW_CONTENT" | grep -qE "from ['\"]@prisma/client['\"]|from ['\"]prisma['\"]|new PrismaClient"; then
  echo "BLOCKED: PrismaClient is only allowed inside src/shared/db/. Use Kysely for runtime queries." >&2
  exit 2
fi

exit 0
