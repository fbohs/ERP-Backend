#!/usr/bin/env bash
# Soft warning when a user prompt asks to skip tests or disable type/lint checks.
# Non-blocking — emits a note that gets injected into Claude's context so it
# can push back rather than complying silently.

set -euo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // .user_prompt // empty')

if echo "$PROMPT" | grep -qiE "skip.{0,15}tests?|disable.{0,15}(strict|type[- ]?check|lint|eslint|tsc)|just push|no tests?|ignore.{0,15}(eslint|tsc|warnings)"; then
  echo "NOTE: This prompt may be asking to skip tests or disable checks. CLAUDE.md requires failing-test-first and zero lint warnings. Push back unless the user has stated an explicit, scoped reason."
fi

exit 0
