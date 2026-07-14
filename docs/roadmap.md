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
| H — Drift verification | `spec verify` (single/`--changed`/`--all`; diff/working-tree/staged), deterministic rule engine SBV001–SBV025, spec policies, affected-spec resolution, evidence freshness, normalized task-plan approval hash, terminal/JSON/Markdown/HTML reports, quality-gate exit codes, `spec affected`, `spec policy init/show/validate`, `verify rules/explain` | ✅ v0.4 (`spec sync` still deferred) |
| I — GitHub Action | node20 bundled action: event diff resolution, validated inputs, ten outputs, bounded rule-ID annotations, Step Summary, report artifacts; no model, no pnpm required | ✅ v0.4 |
| J — Claude Code skill | thin CLI-wrapper skill (superseded for plugin users by the v0.5 plugin skills; kept for CLI-first setups) | ✅ v0.3, plugin in v0.5 |
| K — MCP server | local stdio server over the same core packages: 21 typed tools, 7 resources, 4 prompts, SBMCP error model, bounded outputs, per-project write mutex, `mcp serve/doctor/manifest/tools` | ✅ v0.5 (stdio only; SDK 1.29.0 pinned; protocol baseline 2025-11-25) |
| L — Interactive execution | `task_begin`/`task_complete`/`task_abort`: the current host session implements tasks with v0.3 snapshots/verification/evidence and verified-only checkbox completion; repository lock + `run recover-lock` | ✅ v0.5 |
| M — Claude Code plugin | self-contained plugin (bundled CLI + MCP server, 8 namespaced skills, human-only approve skill, local marketplace, ZIP artifact, isolated-copy verification) | ✅ v0.5 |
| N — Capability-driven runner platform | versioned capability/operation/event/result/error contracts (frozen for v0.6.1 with snapshot tests), runner profiles, config schema v2 + explicit migration (`config doctor/migrate`), deterministic selection, explicit bounded authoring fallback, append-only attempt records, reusable conformance framework, `runner matrix/show/test/conformance/models` | ✅ v0.6.0 |
| O — Production multi-runner | Codex CLI agent runner (read-only authoring sandbox, workspace-write execution, explicit-session resume, no unrestricted modes) and Ollama authoring runner (loopback-default model API, schema-validated structured output, bounded correction retry, authoring-only by capability); Claude Code runner migrated onto the shared contract unchanged | ✅ v0.6.0 |

## Command availability

| Command | Status |
| --- | --- |
| `doctor`, `steering list/show`, `spec list/show/context`, `compat check` | ✅ v0.1 |
| `spec new`, `spec analyze`, `spec approve`, `spec status` | ✅ v0.2 — fully offline |
| `runner list/doctor/show`, `spec generate/refine`, `spec run`, `spec accept-task`, `run list/show/resume` | ✅ v0.3 — mock runner offline; Claude Code via your local installation |
| `spec verify`, `spec affected`, `spec policy init/show/validate`, `verify rules/explain` | ✅ v0.4 — deterministic, offline, read-only |
| `mcp serve/doctor/manifest/tools`, `run recover-lock` | ✅ v0.5 |
| `/specbridge:doctor·status·new·author·approve·implement·continue·verify` (plugin) | ✅ v0.5 |
| `runner list/matrix/show/doctor/test/conformance/models`, `config doctor/migrate`, `spec generate/refine/run --runner <profile>`, `--show-runner-plan` | ✅ v0.6.0 — codex/ollama via your local installation; fake providers in CI |
| `spec sync/export` | ❌ registered as "(planned)", exit 2 with an honest message |

## v0.6.1 (planned — not implemented)

New adapters against the FROZEN v0.6.0 contract (no core changes expected):

- Gemini CLI runner.
- OpenAI-compatible API authoring runner.
- Antigravity CLI capability adapter.
- MCP runner diagnostic tools.
- Claude Code `/specbridge:runners` Skill.

## v0.7 (planned — not implemented)

- Spec templates and a template registry.
- A plugin SDK and runner extension SDK distribution.
- Analyzer and verifier SDKs.
- An extension registry and community ecosystem documentation and
  contribution paths.

## Explicitly not planned for now

- Remote MCP transports (HTTP/SSE/WebSocket), MCP OAuth, or a cloud-hosted
  SpecBridge service.
- Automatic Git commits, pushes, pull requests, or rollback.
- Parallel task execution / agent teams — not before the sequential
  evidence model has real-world mileage.
- SARIF output and PR-comment publishing from the GitHub Action (still
  candidates, still deferred).

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
- Claude Code plugin-scoped MCP tool names are documented and referenced by
  short name; an end-to-end assertion of the host-generated prefixes needs
  a Claude Code installation and is exercised manually, not in CI.
- SIGINT/SIGTERM shutdown is asserted process-level on POSIX; on Windows,
  Node cannot deliver these signals to a child, so clean shutdown is
  covered by the transport-close path there.
