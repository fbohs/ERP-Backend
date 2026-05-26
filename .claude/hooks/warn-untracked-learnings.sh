#!/usr/bin/env bash
# Warn when a git commit is attempted while learnings/ has untracked files.
# Wired as a PreToolUse hook on Bash; see .claude/settings.json.
# Non-blocking — emits a note so the learnings file can be staged first.

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)

[ "$tool" = "Bash" ] || exit 0
printf '%s' "$command" | grep -qE '(^|[[:space:];&|`(])git[[:space:]]+commit' || exit 0

# Find the repo root from the script's location (.claude/hooks/ → repo root)
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

untracked=$(git -C "$repo_root" ls-files --others --exclude-standard learnings/ 2>/dev/null)

if [ -n "$untracked" ]; then
  echo "NOTE: The following learnings/ files are untracked and will NOT be included in this commit:"
  printf '%s\n' "$untracked" | sed 's/^/  /'
  echo "Stage them with: git add $repo_root/learnings/ (or specific files) before committing."
fi

exit 0
