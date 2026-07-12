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
| H — Drift verification | `spec verify` (single/`--changed`/`--all`; diff/working-tree/staged), deterministic rule engine SBV001–SBV025, spec policies, affected-spec resolution, evidence freshness, normalized task-plan approval hash, terminal/JSON/Markdown/HTML reports, quality-gate exit codes, `spec affected`, `spec policy init/show/validate`, `verify rules/explain` | ✅ v0.4 (`spec sync` moved to v0.5) |
| I — GitHub Action | node20 bundled action: event diff resolution, validated inputs, ten outputs, bounded rule-ID annotations, Step Summary, report artifacts; no model, no pnpm required | ✅ v0.4 |
| J — Claude Code skill | keep the shipped skill aligned with new commands | ✅ updated for v0.3 (thin CLI wrapper, no duplicated logic) |
| K — MCP server | same core packages exposed as MCP tools; not before CLI + drift are stable | 🚧 planned, documented in `integrations/mcp-server/` |

## Command availability

| Command | Status |
| --- | --- |
| `doctor`, `steering list/show`, `spec list/show/context`, `compat check` | ✅ v0.1 |
| `spec new`, `spec analyze`, `spec approve`, `spec status` | ✅ v0.2 — fully offline |
| `runner list/doctor/show`, `spec generate/refine`, `spec run`, `spec accept-task`, `run list/show/resume` | ✅ v0.3 — mock runner offline; Claude Code via your local installation |
| `spec verify`, `spec affected`, `spec policy init/show/validate`, `verify rules/explain` | ✅ v0.4 — deterministic, offline, read-only |
| `spec sync/export` | ❌ registered as "(planned)", exit 2 with an honest message |

## v0.5 candidates

- MCP server (Phase K) exposing the read-only inspection and verification
  APIs as tools.
- Additional production runners (codex first) behind the existing contract.
- `spec sync` (evidence-aware checkbox reconciliation) and `spec export`.
- SARIF report output for code-scanning integrations (deliberately deferred
  from v0.4).
- Optional PR-comment publishing from the GitHub Action (today: Step
  Summary + artifacts only; the action never posts by itself).
- Cross-spec impact analysis heuristics — clearly labelled as heuristics.
- Parallel task execution and worktree orchestration remain explicitly
  **not** planned until the sequential evidence model has real-world
  mileage.

## Sequencing rule

Compatibility and round-trip safety stay ahead of everything else. No
generation or model integration ships in a phase whose compatibility
groundwork is not fully tested — an incorrect edit to someone's `.kiro`
files is the one unrecoverable failure mode this project cannot have.

## Testing debt tracked openly

- The GitHub Action is exercised process-level against fixture event
  payloads in CI; an end-to-end `uses:` workflow test still needs a
  published tag — revisit at first release.
- Setext headings: preserved byte-for-byte but not recognized as section
  boundaries; add to the tolerant reader if real-world specs use them.
- The Claude Code capability probe is validated against a fake CLI and one
  real-world version; broaden the matrix as new CLI versions appear.
- Commit-lineage checks (`merge-base --is-ancestor`) treat unresolvable
  SHAs as `unknown` rather than stale; shallow local clones therefore skip
  that one freshness signal (content hashes still apply).
