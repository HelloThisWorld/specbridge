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
| P — Adapter expansion | Gemini CLI runner (plan-mode/allowlist authoring, capability-gated bounded-edit task execution, explicit-UUID resume, never YOLO), OpenAI-compatible authoring runner (chat-completions + responses, explicit structured-output modes, env-var-name credentials, safe redirects), experimental Antigravity capability adapter (detection only, no PTY/TUI automation), read-only MCP runner diagnostics (`runner_list/show/doctor/matrix`), `/specbridge:runners` plugin skill | ✅ v0.6.1 |
| Q — Templates | versioned template manifest (schema 1.0.0), restricted one-pass renderer, 10 built-in templates (embedded at build time), project-local packs, deterministic search, `template list/search/show/validate/preview/apply/install/uninstall/scaffold`, `spec new --template`, append-only template records, MCP `template_list/search/show/preview/apply` (hash-bound apply), `/specbridge:templates` skill, generated gallery with CI drift checks | ✅ v0.7.0 (local-only; no remote registry) |
| R — Extension ecosystem | extension SDK, versioned manifest + out-of-process protocol (1.0.0), permission model with hash-bound grants, five extension kinds, offline extension registry + cache, reference extensions, conformance framework, `extension`/`registry` commands, MCP extension/registry tools, `/specbridge:extensions` skill | ✅ v0.7.1 (process isolation is not an OS sandbox) |
| T — Governed agent orchestration | `@specbridge/orchestration`: 12-phase fail-closed state machine with a phase/action gate, intent assessment (READY/NEEDS_CLARIFICATION/REJECTED/BLOCKED) with structural provenance instead of confidence scores, bounded clarification with durable decisions, execution plans bound to task/approval/Git/policy with staleness detection and a review gate, material-change replanning, an 18-category failure taxonomy driving a deterministic retry/repair/replan engine, deterministic no-progress fingerprinting, explicit budgets, versioned orchestration sidecar state, honest resume + compact checkpoints, `specbridge orchestrate status/show/explain/policy/events/phases`, 10 MCP `orchestration_*` tools, `/specbridge:develop`, and the StepRelay readiness scenarios | ✅ v1.1.0 |
| U — Long-running local-first orchestrator | Persistent jobs (`.specbridge/jobs/`, 13-status fail-closed machine, append-only graph/plan/event history, compact checkpoints, honest resume with repository reconciliation), runtime execution graphs independent of `tasks.md` (per-node plan revisions, node supersession with lineage, deterministic intent-impact screen), a pure deterministic scheduler (sequential source mutation), six agent roles across LOCAL_SMALL/LARGE_AGENT tiers with local-first evidence-based sticky escalation, deterministic complexity assessment, structured local-agent contracts (schema-constrained, complete-response validation, bounded correction), LocalModelManager (managed loopback-only llama.cpp lifecycle, bounded lazy restarts, idle shutdown), the `orchestrate run` foreground persistent driver + `jobs/job/node-plan/review-plan/answer/cancel-job`, `local-model doctor/status`, MCP `job_list/job_read/job_cancel`, `/specbridge:orchestrate`, and driver-level StepRelay readiness scenarios (local plan→executor, HIGH escalation + human gate, verify-fail→diagnose→repair, interruption→resume, local-model crash isolation, manual escalation, budget stops) | ✅ v1.2.0 (unreleased; no daemon — the foreground persistent process is the honest v1 shape) |
| S — Stabilization & release | public contract inventory + machine-readable snapshots (`check:public-contracts`), versioning/deprecation policy, unified migration framework (`migrate`), state validation and hash-bound recovery (`state validate/recover`, `doctor --repair-plan`), `setup`, consolidated threat model + security scan, large-repository performance suite, cross-platform packaging, tag-driven release workflow, documentation hub | ✅ v1.0.0 |
| V — Mission-driven development | `@specbridge/mission` (fail-closed discovery lifecycle, verbatim conversation provenance with structural decision-provenance rules, deterministic 24-topic coverage + irreversibility/materiality screen, Architecture Constitution with machine-checkable guard patterns, immutable ADRs with derived supersession, versioned product Contract Registry, human-only contract change requests, deterministic mission→Kiro synthesis producing objective-oriented `tasks.md`), the objective runtime in `@specbridge/orchestration` (DECOMPOSER-proposed deterministically-validated dynamic work graphs with single-unit fallback, immutable hashed context projections with structural staleness, AgentSupervisor identity + fail-closed result acceptance, isolated per-attempt git worktrees, durable candidate artifacts, deterministic-first evaluation with contract-guard conflict detection, structural + bounded semantic aggregation, single-writer integration inside the unchanged evidence pipeline, conservative opt-in parallelism), five additive agent roles, `specbridge mission …` + `orchestrate objective/workunit`, 14 MCP tools (64 total), `/specbridge:discover`, and offline StepRelay mission E2E scenarios (conflict, CCR + stale-projection replan, investigation aggregation, interruption resume, parallel builders) | ✅ v1.3.0 (unreleased) |
| W — Overnight autonomous product runtime | `@specbridge/autonomy`: immutable MissionSeal (deterministic compilation from mission truth, pinned contract revisions, policy fingerprint, drift refused in both directions), the authority firewall (eleven hard surfaces with no configuration representation, twenty-six delegated engineering surfaces, `NON_AUTHORITY_SIGNALS` proven unable to gate), the lease-based supervisor (progress-based restart accounting, sleep-vs-recheck, no preemption, no force flag), the overnight preflight (twenty-four probes with `SATISFIABLE_AUTONOMOUSLY` and a fail-closed `INDETERMINATE`), the Toolsmith capability broker (fixed argv shapes, no machine-global scope, `WOULD_CREATE_AUTHORITY`), first-class environment lifecycle (readiness dependency graph, real protocol probes, `applicationLevelReady` vs `livenessOnlyReady`, diagnostics retained on failure), browser evidence (closed step vocabulary, isolated contexts, Playwright by dynamic import, `SKIPPED_NO_RUNTIME`), the UX critic with negative authority only, the Contract Closure Oracle and automatic gap-closure lifecycle, system-scenario and reproducibility qualification, governed control-plane self-repair behind an invariant screen, honest autonomy telemetry, the sixteen-fault zero-touch certification, and `autonomy setup/policy/seal/status/report` + `overnight preflight/run` | ✅ v1.10.0 (unreleased; certification CERTIFIED with `humanInterventionsAfterSeal = 0`; real multi-surface dogfood reported honestly with its external limits) |

## Command availability

| Command | Status |
| --- | --- |
| `doctor`, `steering list/show`, `spec list/show/context`, `compat check` | ✅ v0.1 |
| `spec new`, `spec analyze`, `spec approve`, `spec status` | ✅ v0.2 — fully offline |
| `runner list/doctor/show`, `spec generate/refine`, `spec run`, `spec accept-task`, `run list/show/resume` | ✅ v0.3 — mock runner offline; Claude Code via your local installation |
| `spec verify`, `spec affected`, `spec policy init/show/validate`, `verify rules/explain` | ✅ v0.4 — deterministic, offline, read-only |
| `mcp serve/doctor/manifest/tools`, `run recover-lock` | ✅ v0.5 |
| `/specbridge:doctor·status·new·author·approve·implement·continue·verify` (plugin) | ✅ v0.5 |
| `orchestrate status/show/explain/policy show·validate/events/phases`, `/specbridge:develop` | ✅ v1.1.0 — deterministic and read-only; runs are driven from an agent host |
| `autonomy setup/policy/seal/seals/revoke/status/report/toolsmith/supervision/repairs/certification`, `overnight preflight/run` | ✅ v1.10.0 — the four-command unattended surface; every inspection command is read-only |
| `runner list/matrix/show/doctor/test/conformance/models`, `config doctor/migrate`, `spec generate/refine/run --runner <profile>`, `--show-runner-plan` | ✅ v0.6.0 — codex/ollama via your local installation; fake providers in CI |
| `--runner gemini-default / openai-compatible-local`, `runner doctor antigravity`, MCP `runner_list/show/doctor/matrix`, `/specbridge:runners` | ✅ v0.6.1 — gemini/API endpoints via your own installation and accounts; fake providers in CI |
| `template list/search/show/validate/preview/apply/install/uninstall/scaffold`, `spec new --template`, MCP `template_list/search/show/preview/apply`, `/specbridge:templates` | ✅ v0.7.0 — fully offline and deterministic; local sources only |
| `mission begin/status/show/events/coverage/answer/contract-ready/synthesize/contracts/adr/ccr/decisions/reopen/abandon`, `orchestrate objective/workunit`, MCP `mission_*`/`contract_*`/`objective_read`/`workunit_read`/`evaluation_read`, `/specbridge:discover` | ✅ v1.3.0 (unreleased) — discovery over MCP; execution via the standalone orchestrator; approvals and CCR decisions human-only |
| `spec sync/export` | ❌ registered as "(planned)", exit 2 with an honest message |

## v0.6.1 (✅ implemented)

Adapter expansion against the FROZEN v0.6.0 contract (additive-only
contract changes: optional `declaredSupportLevel`, new `AgentRunnerKind`
values — every v0.6.0 snapshot test passes unchanged):

- Gemini CLI runner: safe read-only authoring (plan mode / tool
  allowlist), capability-gated task execution (bounded edit policy, no
  arbitrary shell, never YOLO), explicit-UUID resume.
- OpenAI-compatible API authoring runner: chat-completions and responses
  styles, explicit structured-output modes, environment-variable-name
  credentials, bounded redirects with cross-origin authorization
  stripping. Authoring only — no task execution through generic APIs.
- Antigravity CLI capability adapter: EXPERIMENTAL detection and
  diagnostics only; no TUI/PTY automation exists.
- Read-only MCP runner diagnostic tools: `runner_list`, `runner_show`,
  `runner_doctor`, `runner_matrix` over the shared runner services.
- Claude Code `/specbridge:runners` Skill (MCP-diagnostics-driven,
  read-only).

## v0.7.0 (✅ implemented)

Templates and template scaffolding — secure, deterministic, offline-first:

- Versioned template manifest (`specbridge-template.json`, schema 1.0.0)
  and a restricted one-pass `{{variable}}` renderer: no executable code,
  no expressions, no environment access, no network, no recursion.
- Ten built-in templates (rest-api, cli-tool, database-migration,
  authentication, background-job, event-driven-service, bugfix-regression,
  performance-optimization, security-hardening, refactoring), embedded at
  build time and validated end to end in CI.
- Project-local packs under `.specbridge/templates/` with validated,
  atomic, script-free local installation — no remote registry, no URL or
  npm installation.
- `template list/search/show/validate/preview/apply/install/uninstall/
  scaffold`, `spec new --template`, append-only template records, MCP
  template tools with candidate-hash-bound apply, the
  `/specbridge:templates` plugin skill, and a generated gallery
  (`docs/templates.md`) with CI drift checks.

## v0.7.1 (✅ implemented)

- Extension SDK distribution (analyzer, verifier, exporter, runner, and
  template-provider kinds).
- Out-of-process extension protocol with a permission model and hash-bound
  grants.
- An offline extension registry, reference extensions, and community
  contribution paths.

## v1.0.0 (✅ implemented)

The stabilization and public-release phase — no new product categories.

- Public contract inventory and machine-readable snapshots enforced in CI
  (`pnpm check:public-contracts`), plus a semantic-versioning and deprecation
  policy.
- Unified state-migration framework (`specbridge migrate status/plan/apply/
  verify`) with hash-bound plans, dry-run, backups, and rollback.
- Read-only `specbridge state validate` and hash-bound recovery
  (`specbridge state recover --plan/--apply`, `doctor --repair-plan`); corrupt
  state is always preserved.
- `specbridge setup`, consolidated threat model, a deterministic security
  scan, and a large-repository performance suite with documented budgets.
- Cross-platform packaging (npm `specbridge-cli`, portable Node, standalone
  archives, plugin ZIP) with stable manifests and checksums, and a
  tag-driven, draft-first release workflow.

## Post-1.0 outlook

No new features are promised. The focus after 1.0.0 is maintenance:
compatibility within v1.x under the versioning policy, security fixes, and
documentation. Anything below remains explicitly out of scope.

## Explicitly not planned for now

- Remote MCP transports (HTTP/SSE/WebSocket), MCP OAuth, or a cloud-hosted
  SpecBridge service.
- Automatic Git commits, pushes, pull requests, or rollback.
- SARIF output and PR-comment publishing from the GitHub Action (still
  candidates, still deferred).

(Parallel execution shipped in a deliberately narrow form with v1.3:
opt-in, builder-dispatch-only, isolated worktrees, deterministic
independence proof, single-writer integration. Parallel **objectives** —
`maxConcurrentTasks > 1` — remain not planned until the sequential evidence
model has real-world mileage.)

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
