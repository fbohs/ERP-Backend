---
name: git
description: Use when performing any git operation — staging, committing, writing commit messages, splitting changes across multiple commits, amending, rebasing, force-push, pushing, opening pull requests, or recovering from mistakes (broken stash, accidental commits, lost work). Triggered by phrases like "commit this", "push to X", "amend", "rebase", "fix the commit message", "split this into commits", "propose a commit plan", "open a PR", "I lost my changes", "git reset", or any other phrasing about manipulating git state.
---

# Git — Working With Repository State

> Use for every git action. Read the unconditional rules in CLAUDE.md first; they always apply. This file is the *how*.

## First principles

- **Correctness over convenience.** A wrong commit lives in history forever; an extra five minutes of care is cheap.
- **Never commit or push on your own initiative.** Only when the user explicitly asks. "It seems like a good place to commit" is not permission.
- **Branch first if on the project's default branch.** Read CLAUDE.md to learn the default-branch name. If on it, propose a feature branch and confirm before any work that mutates state.
- **One concern per commit.** A reviewer should be able to describe what changed in one sentence with no "and also".

## Commit messages

Format: Conventional Commits-ish prefix (`feat`, `fix`, `chore`, `docs`, `refactor`, `build`, `test`, `perf`), optional scope, imperative present tense, lowercase first word after the prefix.

```
<type>(<scope>): <imperative summary, ≤ ~72 chars>

<wrapped body explaining *why* — not *what* the diff already shows.
Mention trade-offs, alternatives rejected, and links to issues/ADRs.>
```

What the body should answer (when non-trivial):

- *Why* this change, not what — the diff shows what.
- What was the alternative and why it was rejected.
- Any consequence the next reader needs to know (migration order, follow-up branch, deferred concern).
- Links: ADR number, issue, learnings doc.

**Never put in a commit message:**

- `Co-Authored-By:` trailers naming an AI assistant or any model.
- `Generated with [tool]` footers.
- Any mention of Claude, an AI, or an assistant. A hook enforces this; the hook will reject the commit.
- Comments explaining what the code does — that belongs in code (rename, refactor), not in a commit.
- "WIP", "fix typo", "address PR comments" as standalone commits on a shared branch — rebase or squash them into the work they belong to.

**Good — examples:**

```
feat(audit): add audit_log table and write rows for state-changing endpoints

Hard rule #7: state-changing endpoints must write an audit row in the same
transaction. Adds the audit_log table per charter §8, plus a shared
AuditRepository composed inside each service transaction via withTx.

The decision to keep audit in Postgres rather than push to an OLAP store
is recorded in learnings/technical/audit-logging.md.
```

```
chore(deps): pin @types/node to 24.12.4 and drop unused @hono override

Types should track the runtime (Node 24.15.0), not the TypeScript dist-tag
which points at 25.x and would expose APIs absent in the runtime.

The @hono override forced a transitive dep with no recorded reason and
no CVE; removing it leaves prisma/build/lint/test all green.
```

## Granularity — one commit or many?

One commit per **logical concern**, where a "logical concern" is the smallest unit a reviewer could accept or reject independently. Examples:

- Bumping a dependency → one commit.
- Adding a database table → one commit (schema + migration + types + the minimum wiring to use it).
- Adding a feature that touches three modules → still arguably one commit, unless each module's change is independently reviewable.
- A refactor mixed with a behavior change → **two commits**, refactor first. A reviewer can't separate them otherwise.

When in doubt, split. Squashing later is trivial; un-squashing isn't.

## Splitting a dirty working tree into multiple commits

The hard case: the working tree contains many logical changes already made, and one or more files contain edits belonging to multiple planned commits ("multi-touch files"). `git add -p` solves this interactively for humans; agents driving the shell have no TTY, so this playbook replaces it.

### Workflow

1. **Plan, then confirm with the user.** Map every modified/new/deleted path to a numbered commit. Surface the plan and get explicit approval before any `git commit`.

2. **Classify every file:**
   - **Single-touch** — changes belong to exactly one commit. Easy: `git add <path>` at commit time.
   - **Multi-touch** — changes belong to two or more commits. The complexity below is for these.
   - **New files / deletions** — treat as single-touch.

3. **Back up multi-touch files before mutating.** Copy them to a known location:
   ```bash
   mkdir -p /tmp/<session>-final
   cp <each multi-touch path> /tmp/<session>-final/
   ```
   This is your verification target later. Don't skip it.

4. **Commit forward, in planned order.** For each commit:
   - Edit each multi-touch file to the state it should have *at this commit* — i.e. all earlier commits applied, none of the later ones yet. Use `Edit` for small deltas, `Write` for big intermediate states, `sed`/`awk`/`python` for bulk line removals.
   - Stage **only the paths that belong to this commit, by explicit name**. Never `git add .` or `git add -A` in this flow.
   - Commit with a plain engineering message (see above).

5. **Verify HEAD matches the backup:**
   ```bash
   for f in /tmp/<session>-final/*; do
     diff -q "<corresponding path>" "$f"
   done
   ```
   Silence = success. Any output = a reconstruction was wrong; investigate before pushing.

6. **Verify HEAD is green:** run `build`, `lint`, the test suite. The diff can be clean and the code still broken if a hunk was misplaced.

7. **Clean up `/tmp/<session>-final/`** once verified.

### Honest disclosure

Splitting one file's edits across multiple commits means **intermediate commits between two touches of the same file are not guaranteed to compile in isolation**. The full sequence compiles, HEAD compiles, but `git checkout <middle-commit>` of that file mid-journey can show a type signature out of sync with its callers in a later commit. Surface this when reporting. Offer to squash the affected range into one commit if the user needs every individual commit to be independently green (e.g. strict `git bisect`).

## Amending, rebasing, force-push

- **`git commit --amend` is safe only on commits that have not been pushed** — or have been pushed only to a personal branch the user is the sole user of. Confirm before amending anything.
- **Interactive rebase (`rebase -i`) is not supported in this environment.** Use scripted rebases (`git rebase --onto`, `git cherry-pick`) or ask the user to drive `rebase -i` themselves.
- **Never force-push to a shared branch** (default branch, any branch with other contributors, any branch backing an open PR with reviewers). Force-pushing to one's own feature branch before PR-open is acceptable if the user explicitly asks.
- **`--force-with-lease`** beats `--force`. Always.
- When rewriting history that has been pushed, **say so explicitly to the user** and confirm before pushing. "I rebased onto main and force-pushed" is the kind of sentence that needs prior consent.

## Pushing

- Only on explicit user request.
- Confirm the target: `git push <remote> <branch>` — name them. Don't rely on `git push` with no args.
- Before pushing, run `build` + `lint` + the project's test command. If any fail, report and stop; don't push broken state because the user said "push".
- If the branch tracks a remote, mention any divergence (`git status -sb`) before pushing.

## Pull requests

- Use `gh pr create` for GitHub. Don't construct PRs through the web UI flow.
- PR title: same conventions as commit messages.
- PR body sections (typical):
  - **What changed** — one paragraph, the same depth as a good commit body.
  - **Why** — the problem, the reasoning, the alternatives considered.
  - **Risk / migration** — anything reviewers must do or watch for (migrations, env vars, follow-ups).
  - **How tested** — what runs proved this works.
  - **Links** — issues, ADRs, learnings docs.
- Do **not** put AI/Claude attribution in PR bodies either. The hook only inspects commits; PR bodies are on you.
- Draft PRs are appropriate for work-in-progress; mark them as such (`gh pr create --draft`).

## Recovery from mistakes

| Situation | Move |
|---|---|
| Accidentally committed to the wrong branch | `git reset --soft HEAD~N` on the wrong branch, then `git checkout <right-branch>`, then commit there. Confirm `reflog` still shows the work first. |
| Accidentally `git reset --hard` and lost work | `git reflog` — every commit Claude or the user made is there for ~90 days. Find the SHA, `git checkout <sha>` or `git reset --hard <sha>`. |
| `git stash pop` produced conflicts and a mess | `git stash list` — the original stash is still there until explicitly dropped. `git checkout -- <files>` to wipe the bad state, then `git stash apply --3way` or stash-then-restore selectively. |
| Pushed a bad commit to a shared branch | Don't force-push. Write a new commit that reverts (`git revert <sha>`) and push that. |
| Committed a secret / file that shouldn't have landed | Stop immediately. If unpushed: `git reset HEAD~1` + remove the file + recommit. If pushed: tell the user — secret rotation is needed regardless of git surgery, and rewriting shared history needs their call. |
| The working tree is in a state I don't recognise after many edits | `git status` first, then `git diff` per file. Don't `git reset` or `git checkout --` until you've understood what's there — those discard work. |

## Hard Rules

- **Plan before committing.** No commits without an explicit plan that the user has seen, especially when splitting.
- **Stage by explicit path.** No `git add .` / `-A` in any split workflow.
- **Back up multi-touch files before mutating** for any split.
- **Verify HEAD == backup** at the end of any split, with `diff -q`.
- **Verify the branch is green at HEAD** before declaring done.
- **No AI/Claude attribution** in commits, PR bodies, or anywhere else. The hook enforces commits; you enforce the rest.
- **Never push, force-push, or rewrite shared history without explicit user permission**, scoped to the exact branch and remote.

## Anti-patterns

- ❌ Squashing everything into one mega-commit because splitting is hard. The pattern above exists for that.
- ❌ `git add .` during a split — stages files at whatever intermediate state they're in.
- ❌ `git stash` mid-split to "park" state — pop conflicts will eat the day. Use file backups instead.
- ❌ `--force` (vs `--force-with-lease`).
- ❌ Amending a pushed commit on a shared branch.
- ❌ "I'll just commit and amend if it's wrong" — amend after push is the second mistake.
- ❌ Trusting that the diff being clean means the commit is correct — also build, lint, and run the tests.
