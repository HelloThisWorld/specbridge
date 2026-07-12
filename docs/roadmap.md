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
| E — Spec workflow | `spec new` (offline templates), `spec analyze` (deterministic), `spec approve` (hash-based sidecar approvals, stale detection, revocation), `spec status` | ✅ v0.2 |
| F — Runner adapters | generic runner contract, registry, deterministic mock scenarios, Claude Code detection/capabilities/invocation, `runner list/doctor/show`, model-assisted `spec generate`/`spec refine` | ✅ v0.3 (Claude Code only; codex/ollama/openai-compatible stay honest stubs) |
| G — Task execution | `spec run` (one task per run, `--all` sequential), git before/after snapshots, trusted verification commands, append-only evidence, verified-only checkbox completion, `spec accept-task`, `run list/show/resume` | ✅ v0.3 |
| H — Sync & drift verification | `spec sync`, `spec verify` CLI over the existing `@specbridge/drift` primitives, terminal/JSON/HTML reports, quality-gate exit codes | 🚧 planned — v0.4 candidate (library primitives ✅ since v0.1) |
| I — GitHub Action | drift gates on PRs, Markdown summaries, report artifacts (read-only preview action ships since v0.1) | 🚧 planned |
| J — Claude Code skill | keep the shipped skill aligned with new commands | ✅ updated for v0.3 (thin CLI wrapper, no duplicated logic) |
| K — MCP server | same core packages exposed as MCP tools; not before CLI + drift are stable | 🚧 planned, documented in `integrations/mcp-server/` |

## Command availability

| Command | Status |
| --- | --- |
| `doctor`, `steering list/show`, `spec list/show/context`, `compat check` | ✅ v0.1 |
| `spec new`, `spec analyze`, `spec approve`, `spec status` | ✅ v0.2 — fully offline |
| `runner list/doctor/show`, `spec generate/refine`, `spec run`, `spec accept-task`, `run list/show/resume` | ✅ v0.3 — mock runner offline; Claude Code via your local installation |
| `spec sync/verify/export` | ❌ registered as "(planned)", exit 2 with an honest message |

## v0.4 candidates

- `spec verify` CLI + CI quality gates over the drift primitives (Phase H).
- GitHub Action drift gates (Phase I).
- Additional production runners (codex first) behind the same contract.
- Full spec-to-code drift analysis and cross-spec impact analysis.
- Optional MCP server (Phase K).
- Parallel task execution and worktree orchestration are explicitly **not**
  planned until the sequential evidence model has real-world mileage.

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
- The Claude Code capability probe is validated against a fake CLI and one
  real-world version; broaden the matrix as new CLI versions appear.
