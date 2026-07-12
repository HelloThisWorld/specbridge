# Claude Code integration

SpecBridge is CLI-first; the Claude Code integration is a thin wrapper that
teaches Claude Code to drive the CLI. The CLI remains the product core, so
everything here also works with any other agent that can run shell commands.

Two directions exist, and they compose:

1. **SpecBridge invokes Claude Code** — the v0.3
   [Claude Code runner](claude-code-runner.md): `spec generate`,
   `spec refine`, and `spec run` spawn your locally installed `claude` CLI
   with restricted tools, capture evidence, and gate checkbox completion.
2. **Claude Code drives SpecBridge** — the skill below, for interactive
   sessions where Claude Code is your terminal.

## Prerequisites

- Install and authenticate Claude Code yourself; SpecBridge never handles
  credentials (see [security](security.md)).
- Verify readiness any time with `specbridge runner doctor claude-code`
  (read-only).

## The skill

A Claude Code skill lives at
`integrations/claude-code/skills/specbridge/SKILL.md` with reference
workflows for requirements, design, task execution, and verification.
Install it by copying the `specbridge` skill directory into your project's
`.claude/skills/` directory:

```sh
cp -r integrations/claude-code/skills/specbridge .claude/skills/specbridge
```

The skill is a thin orchestration layer over the CLI. It duplicates no core
logic — no workflow validation, no approval checks, no evidence evaluation,
no checkbox editing, no runner invocation. It instructs Claude Code to:

1. Detect and inspect specs with `doctor`, `spec list`, `spec status`.
2. Author stages through `spec generate` / `spec refine`, then hand approval
   to the user via `spec analyze` + `spec approve` — never approving
   anything itself.
3. Execute tasks through `spec run` (one at a time), read the evidence
   result, and inspect failures with `run show` before continuing.
4. Resume interrupted runs with `run resume`, following refusals instead of
   forcing them.
5. Use `spec accept-task --reason` when the user explicitly accepts
   manually verified work.
6. Never bypass approval gates, never mark checkboxes directly, never edit
   `.specbridge/` state, never use permission bypasses, and run
   `compat check` after any manual `.kiro` edit.

Suggested user-facing workflows: `/specbridge status <spec>`,
`/specbridge generate <spec> <stage>`, `/specbridge implement <spec> <task>`,
`/specbridge continue <run-id>`.

Commands that are still planned (`spec sync`, `spec verify`, `spec export`)
are marked as such in the skill; it never instructs the agent to pretend
they exist.

## Configuration safety

SpecBridge never modifies `.claude/settings.json`, user-level or managed
Claude configuration, authentication, MCP, or permission settings, and it
installs no command hooks. If you tune Claude settings for SpecBridge
workflows, do it yourself and understand the consequences — and never enable
`bypassPermissions`; SpecBridge refuses to work with it anyway.

## Planned (later phases)

- `specbridge integration install claude-code --project` — an installer that
  writes only the skill directory (with `--dry-run`, no overwrites without
  confirmation).
- `specbridge spec verify` in the loop — Phase H: the agent repairs drift or
  explains why the spec should change.
