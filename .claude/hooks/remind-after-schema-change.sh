#!/usr/bin/env bash
# After a Prisma schema edit, remind to run the migration + kysely-codegen workflow.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')

case "$FILE_PATH" in
  *prisma/schema.prisma)
    echo "REMINDER: prisma/schema.prisma changed. Workflow: 1) npx prisma migrate dev --name <desc>  2) review generated SQL  3) npx kysely-codegen --out-file src/shared/db/generated-types.ts  4) commit both together. See .claude/skills/add-migration/SKILL.md."
    ;;
esac

exit 0
