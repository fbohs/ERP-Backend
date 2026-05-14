# `.claude/` and `CLAUDE.md` Layout — Why It's Split This Way

This project's Claude Code configuration is deliberately bifurcated. The goal is to give Claude *exactly* the right context for the task at hand — no more, no less — so context windows aren't burned on rules that don't apply to the current edit.

## What Loads When

| File | When loaded |
| ---- | ----------- |
| `CLAUDE.md` (root) | Every session, every turn. Keep it under ~200 lines. |
| `src/modules/CLAUDE.md` | When Claude touches anything under `src/modules/`. |
| `src/shared/db/CLAUDE.md` | When Claude touches the DB layer. |
| `.claude/skills/<name>/SKILL.md` | On demand. Claude reads the skill when its description matches the task. |
| `.claude/commands/<name>.md` | When the user types `/<name>`. Not auto-loaded. |
| `.claude/settings.json` | Always active. Hooks run on every relevant tool call. |
| `docs/engineering-charter.md` | Only when Claude (or a human) reads it. Not in any context by default. |

## The Mental Model

- **CLAUDE.md** = the constitution. Hard rules. Reject-on-sight items. Map of the codebase.
- **Nested CLAUDE.md** = laws for a specific territory. Loaded when you're in that territory.
- **Skills** = playbooks. "When the task is X, here is the workflow."
- **Commands** = user-invoked rituals. PR checklists, ADR scaffolding.
- **Hooks** = the enforcement layer. Things prose can't reliably catch — blocked at edit time.
- **Charter** = the explanation. Rationale, depth, history. Read when needed, not preloaded.

## Why Not One Big File?

A single `CLAUDE.md` of 600+ lines:
- Burns tokens on every turn, even when working on a one-line fix.
- Dilutes attention — the important rules drown in the unimportant.
- Becomes a dumping ground; nothing gets removed because everything "might apply."
- Can't be selectively updated without re-reading the whole thing.

Splitting by **scope** (root / module / db) and by **modality** (always-on / on-demand / user-invoked / enforcement) keeps each surface small, owned, and reviewable.

## Adding More

- **New always-on rule?** Goes in root `CLAUDE.md`. Be ruthless — does it really apply *every turn*?
- **New module-specific rule?** Goes in `src/modules/CLAUDE.md` or a deeper nested file.
- **New repeatable workflow?** New skill in `.claude/skills/<name>/SKILL.md`. The description determines when Claude loads it — make it specific.
- **New user-invoked workflow?** New command in `.claude/commands/<name>.md`.
- **New deterministic check?** Hook in `.claude/settings.json`. Hooks block tool calls — keep them fast and high-signal.
- **New depth / explanation?** `docs/engineering-charter.md`.

## Skills vs Commands vs Hooks — How to Choose

- **Skill** if Claude should follow a workflow when the task matches. Description-triggered, automatic.
- **Command** if the user should be able to invoke it explicitly. Slash-triggered.
- **Hook** if the check is deterministic and should fire regardless of intent. No LLM in the loop.

Use all three together. Example for migrations:
- The **skill** (`add-migration`) walks Claude through the workflow when it detects a schema change.
- A **command** (`/migration-review`) could let the user demand a focused review of a pending migration.
- A **hook** reminds Claude to regenerate Kysely types after `prisma/schema.prisma` is edited.
