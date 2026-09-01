# Migrating from SpecBridge 1.x

SpecBridge 2.0 is a clean break, not an in-place runtime upgrade.

## Breaking product change

- SpecBridge 1.x execution runtime is discontinued.
- Existing execution Jobs cannot be resumed in 2.0.
- Existing repository and specification artifacts may be imported where useful.
- Implementation execution now belongs to external coding agents.

There are no compatibility shims for Missions, Jobs, WorkUnits, Attempts, candidates, builders, schedulers, supervisors, drivers, worker sessions, worktrees, execution ledgers, cooldown continuations, or implementation handoffs. Their packages, CLI commands, MCP tools, persisted schemas, documentation, and tests have been removed from the active product.

## New workflow

```text
1.x: spec → SpecBridge-managed execution runtime → implementation
2.0: idea → repository-grounded design → approved Spec Pack
                                                ↓
                         independent external implementation
```

Start a new `DesignSession` for each active design. Bootstrap the repository to create a `CurrentSystemSnapshot`, complete the staged design, resolve material product questions and required research, run evaluation, and approve in natural language. The resulting `.specbridge/specs/<slug>/` directory is the portable deliverable.

## Existing data

Do not copy old runtime state into `.specbridge/design-sessions/`. Old Jobs and execution records have different semantics and are intentionally unreadable by 2.0.

Useful human-authored requirements, research citations, architecture notes, and acceptance criteria can be brought into a new design as evidence. Review their freshness and attribution; do not treat old generated output as sealed product truth.

## Integrations and automation

Replace old job/build/runner MCP calls with the compact design surface documented in the README. Replace manual CLI approval gates with explicit natural-language human approval through the frontend or `specbridge design approve` for automation.

Any automation that depended on SpecBridge launching or supervising coding agents must move that responsibility to the chosen coding harness. SpecBridge ends after compiling the approved Spec Pack.
