# Quickstart

Thirty seconds inside any project that already contains a `.kiro`
directory. Every command below is read-only — nothing is converted,
copied, or modified.

```bash
cd your-kiro-project

specbridge doctor              # workspace health — read-only
specbridge spec list           # every spec, with type, progress, approvals
specbridge spec status <name>  # one spec: stages, approvals, stale detection
specbridge spec verify --changed   # deterministic drift check vs your working tree
```

What you just saw:

- `doctor` proves the workspace is compatible and that SpecBridge added no
  metadata to your files.
- `spec list` and `spec status` read your existing specs directly —
  existing Kiro specs show up as `unmanaged` until you record an approval,
  and they stay fully usable either way.
- `spec verify --changed` runs the deterministic rule engine
  (SBV001–SBV026) against the specs your current changes touch: no model,
  no API key, no network.

## Where to go next

- [Using an existing Kiro project](existing-kiro-project.md) — what
  SpecBridge reads, what it never touches, and the optional sidecar state.
- [Claude Code plugin](claude-code-plugin.md) — the same workflow as
  slash commands inside Claude Code.
- [Approval workflow](../approval-workflow.md) — recording stage approvals
  with byte-exact hashes.
- [Spec drift verification](../spec-drift-verification.md) — the full
  verification story, including CI via the
  [GitHub Action](../github-action.md).
- [Documentation hub](../README.md) — everything else.
