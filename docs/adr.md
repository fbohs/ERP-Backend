# /adr

Create a new Architecture Decision Record.

## What to do

1. Ask the user for a short title in kebab-case (e.g. `use-keyset-pagination-on-invoices`) if not provided as an argument.
2. List existing ADRs in `docs/adr/` to determine the next sequence number (4-digit, zero-padded).
3. Create `docs/adr/NNNN-<title>.md` using the template below.
4. Open the file for the user to fill in. Do not invent the content — ADRs reflect the user's reasoning, not yours.

## When an ADR is Required

Per root `CLAUDE.md`:
- Adding a runtime dependency.
- Changing a public API contract.
- Introducing a new module.
- Cross-module coupling beyond events.
- Changing transaction or caching strategy.
- Adopting a new major version of any stack component.

If the user is about to make one of these changes without an ADR, prompt them to use `/adr` first.

## Template

```markdown
# NNNN — <Title>

**Status:** Proposed | Accepted | Superseded by NNNN | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** <names>

## Context

What is the situation? What constraints are in play? Link to issues, performance data, or prior discussion.

## Decision

What did we decide? Be specific. State the rule, not the rationale (rationale comes next).

## Consequences

What becomes easier? What becomes harder? What new constraints does this introduce on future work?

## Alternatives Considered

What else was on the table? Why were they not chosen? Be honest about the trade-offs — future readers need to know what was rejected and why, especially if they're considering re-opening the decision.

## References

- Related ADRs: NNNN, NNNN
- Issues/PRs: #...
- External: <links>
```

## Rules for ADRs

- ADRs are **immutable** once Accepted. Mistakes are fixed by writing a new ADR that supersedes the old one. Old ADRs link to their replacement.
- Status starts at **Proposed** during PR review and moves to **Accepted** when merged.
- No vague language. "We will consider X" is not a decision. "X is required for new modules; existing modules grandfathered until NNNN" is a decision.
