# Roadmap

Honest status of every planned capability. Nothing below is claimed as
implemented unless marked ✅ and covered by tests.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| A — Foundation | pnpm workspace, strict TS, vitest, packages, fixtures | ✅ v0.1 |
| B — Read-only Kiro compatibility | workspace detection, steering, discovery, classification, tolerant parsers, `doctor`, `steering list/show`, `spec list/show/context` | ✅ v0.1 |
| C — Round-trip safety | line-preserving model, no-op byte identity, surgical checkbox patcher, golden tests | ✅ v0.1 |
| D — Docs & release readiness | README, compatibility docs, CI (3 OS × Node 20/22), examples, smoke tests | ✅ v0.1 |
| E — Spec workflow | `spec new` (offline templates + optional runner mode), `spec analyze`, `spec approve`, sidecar approvals | 🚧 planned |
| F — Runner adapters | real `claude-code` / `codex` generation; config plumbing (interface + mock + detection ship in v0.1) | 🚧 planned |
| G — Task execution | `spec run`, run records under `.specbridge/runs/`, evidence-gated checkbox completion | 🚧 planned |
| H — Sync & drift verification | `spec sync`, `spec verify` CLI over the existing `@specbridge/drift` primitives, terminal/JSON/HTML reports, quality-gate exit codes | 🚧 planned (library primitives ✅ in v0.1) |
| I — GitHub Action | drift gates on PRs, Markdown summaries, report artifacts (read-only preview action ships in v0.1) | 🚧 planned |
| J — Claude Code skill | polish the shipped skill as commands land | 🚧 iterating (v0.1 skill covers read-only workflows) |
| K — MCP server | same core packages exposed as MCP tools; not before CLI + drift are stable | 🚧 planned, documented in `integrations/mcp-server/` |

## Command availability

| Command | v0.1 |
| --- | --- |
| `doctor`, `steering list/show`, `spec list/show/context`, `compat check` | ✅ implemented |
| `spec new/analyze/approve/run/sync/verify/export` | ❌ registered as "(planned)", exit 2 with an honest message |

## Sequencing rule

Compatibility and round-trip safety stay ahead of everything else. No
generation or model integration ships in a phase whose compatibility
groundwork is not fully tested — an incorrect edit to someone's `.kiro`
files is the one unrecoverable failure mode this project cannot have.

## Testing debt tracked openly

- GitHub Action smoke test in CI: not yet practical before the action can
  install a released package; revisit at first npm publish.
- Setext headings: preserved byte-for-byte but not recognized as section
  boundaries; add to the tolerant reader if real-world specs use them.
