#!/usr/bin/env bash
# Reject git commits that include AI / assistant attribution.
# Wired as a PreToolUse hook on Bash; see .claude/settings.json.
#
# Detects the obvious patterns: Co-Authored-By: <anything Claude/anthropic>,
# "Generated with [Claude Code]" footers, and the noreply@anthropic.com email.
# Inspects -m / --message inline, and reads -F / --file targets so a
# multi-line message stored in a file is scanned too.
#
# Deliberately does NOT use `set -e` — several internal greps may legitimately
# return non-zero (no match), which is not an error condition for us.

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)

[ "$tool" = "Bash" ] || exit 0
printf '%s' "$command" | grep -qE '(^|[[:space:];&|`(])git[[:space:]]+commit' || exit 0

# If the commit reads its message from a file, fold the file content into
# the haystack so we scan it too.
file_arg=$(printf '%s' "$command" \
  | grep -oE '(--file=[^[:space:]]+|--file[[:space:]]+[^[:space:]]+|-F[=[:space:]]?[^[:space:]]+)' 2>/dev/null \
  | head -1 \
  | sed -E 's/^(--file=|--file[[:space:]]+|-F[=[:space:]]?)//')

haystack="$command"
if [ -n "${file_arg:-}" ] && [ -f "$file_arg" ]; then
  haystack="$command
$(cat "$file_arg")"
fi

# Patterns. Case-insensitive grep; extended regex.
patterns=(
  'co-authored-by:[^[:cntrl:]]*claude'
  'co-authored-by:[^[:cntrl:]]*anthropic'
  'co-authored-by:[^[:cntrl:]]*noreply@anthropic\.com'
  '🤖[[:space:]]*generated'
  'generated[[:space:]]+with[[:space:]]+\[?claude[[:space:]]*code'
  'noreply@anthropic\.com'
)

for p in "${patterns[@]}"; do
  if printf '%s' "$haystack" | grep -qiE "$p"; then
    cat >&2 <<EOF
Blocked: commit message contains AI / assistant attribution.

Project policy (CLAUDE.md): commits must not contain Co-Authored-By
trailers, "Generated with Claude Code" footers, or any mention of an AI
assistant.

Matched pattern: $p

Rewrite the commit message as a plain engineering summary and try again.
EOF
    exit 2
  fi
done

exit 0
