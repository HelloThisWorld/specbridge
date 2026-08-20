# SpecBridge documentation

The map of everything under `docs/`. Start with
[Getting started](#getting-started) if you are new; everything else is
reference, grouped by area.

## Getting started

- [Installation](getting-started/installation.md) — npm, standalone
  archives, the Claude Code plugin, from source.
- [Quickstart](getting-started/quickstart.md) — 30 read-only seconds in an
  existing Kiro project.
- [Using an existing Kiro project](getting-started/existing-kiro-project.md)
  — the zero-migration story and `specbridge setup`.
- [Claude Code plugin](getting-started/claude-code-plugin.md) — install
  pointer and the twelve skills.

## Specs & approvals

- [Kiro compatibility](kiro-compatibility.md) — the file contract and the
  byte-identical round-trip guarantee.
- [Spec authoring](spec-authoring.md) — `spec new` and the offline
  workflows (requirements-first, design-first, quick, bugfix).
- [Spec analysis](spec-analysis.md) — deterministic structural and
  consistency checks.
- [Approval workflow](approval-workflow.md) — hash-based stage approvals,
  stale detection, revocation.
- [Sidecar state](sidecar-state.md) — everything SpecBridge writes, and
  where.
- [Migration from Kiro](migration-from-kiro.md) — there is none.

## Execution & evidence

- [Task execution](task-execution.md) — `spec run`: one approved task per
  run, snapshots, safety checks.
- [Execution evidence](execution-evidence.md) — append-only Git-backed
  evidence records.
- [Task verification](task-verification.md) — trusted commands decide
  completion, never model claims.
- [Interactive task execution](interactive-task-execution.md) —
  `task_begin`/`task_complete` from a live agent session.
- [Session resume](session-resume.md) — resuming interrupted runs.

## Governed agent orchestration (v1.1)

- [Agent orchestration](orchestration/agent-orchestration.md) — the
  lifecycle, the state machine, and the SpecBridge/agent/evidence split.
- [Intent and clarification](orchestration/intent-clarification.md) —
  READY / NEEDS_CLARIFICATION / REJECTED / BLOCKED, and provenance instead
  of confidence scores.
- [Execution planning](orchestration/execution-planning.md) — plans bound to
  task, approvals, and Git baseline; the review gate; materiality.
- [Retry and repair](orchestration/retry-and-repair.md) — the failure
  taxonomy, the decision order, and every budget.
- [ReAct/TAO execution discipline](orchestration/react-tao-execution.md) —
  the bounded loop, and why no chain-of-thought is stored.
- [Orchestration recovery](orchestration/orchestration-recovery.md) —
  resuming honestly, checkpoints, stale plans.
- [Enforcement boundaries](orchestration/enforcement-boundaries.md) — what is
  hard-enforced, contract-enforced, and merely skill-guided.
- [Long-running jobs (v1.2)](orchestration/long-running-jobs.md) — the
  persistent local-first orchestrator: scheduler, workers, budgets, resume.
- [Survival runtime (vNext.1)](orchestration/survival-runtime.md) — durable
  attempts, structured checkpoints, and the provider-neutral context
  lifecycle.
- [Quota-aware scheduling (vNext.2)](orchestration/quota-scheduling.md) —
  the free-local + prepaid-Max optimizer: lanes, quota windows, HARVEST,
  cross-reset admission.
- [Orchestration configuration](orchestration/configuration.md) — every
  policy knob, with defaults.

## Mission-driven development

- [Mission Discovery](mission/mission-discovery.md) — the lifecycle from a
  product direction to CONTRACT_READY: coverage, materiality, the human
  gates.
- [Conversation provenance](mission/conversation-provenance.md) — every
  decision traces to a visible exchange; no hidden reasoning is ever
  persisted.
- [Architecture Constitution and ADRs](mission/architecture-constitution.md)
  — durable invariants with machine-checkable guard patterns; immutable
  decision records.
- [Contract Registry and change requests](mission/contract-registry.md) —
  the product's versioned contracts, and the human-only change path.
- [Mission → spec synthesis](mission/spec-synthesis.md) — the deterministic
  compiler that turns contracts into a Kiro spec of Objectives.
- [Objective decomposition](orchestration/objective-decomposition.md) — the
  dynamic work graph between an approved objective and worker dispatches.
- [Context projection](orchestration/context-projection.md) — share truth,
  not context: what each isolated worker sees, hashed and staleness-checked.
- [Sub-agent isolation](orchestration/subagent-isolation.md) — worker
  identity, fail-closed result acceptance, isolated git worktrees.
- [Evaluation and aggregation](orchestration/evaluation-and-aggregation.md)
  — deterministic checks first, semantic judgment where genuine, conflicts
  as first-class records.
- [Integration model and parallelism](orchestration/integration-model.md) —
  the single writer, the unchanged evidence pipeline, opt-in conservative
  parallelism.
- [StepRelay walkthrough](mission/steprelay-walkthrough.md) — the complete
  dogfood flow, failure paths included.

## Verification & CI

- [Spec drift verification](spec-drift-verification.md) — the
  deterministic `spec verify` engine.
- [Verification rules](verification-rules.md) — the stable rule registry
  SBV001–SBV026.
- [Verification policy](verification-policy.md) — per-spec impact areas,
  required commands, rule overrides.
- [Requirement–task traceability](requirement-task-traceability.md) — how
  references are extracted.
- [Evidence freshness](evidence-freshness.md) — hash semantics and
  staleness.
- [Affected-spec detection](affected-spec-detection.md) — mapping a change
  set to specs.
- [CI quality gates](ci-quality-gates.md) — exit codes and gate design.
- [GitHub Action](github-action.md) — the bundled node20 action.

## Runners

- [Runners overview](runners.md) — profiles, the capability model, and
  configuration.
- [Runner capabilities](runner-capabilities.md) ·
  [profiles](runner-profiles.md) · [selection](runner-selection.md) ·
  [fallback](runner-fallback.md) · [conformance](runner-conformance.md).
- [Runner adapter contract](runner-adapter-contract.md) — the frozen
  adapter interface (index of adapter docs:
  [runner adapters](runner-adapters.md), background:
  [agent runners](agent-runners.md)).
- Providers: [Claude Code](claude-code-runner.md) ·
  [Codex CLI](codex-cli-runner.md) · [Gemini CLI](gemini-cli-runner.md) ·
  [Ollama](ollama-runner.md) ·
  [OpenAI-compatible](openai-compatible-runner.md) ·
  [Antigravity (experimental)](antigravity-cli-runner.md).
- [Model-assisted authoring](model-assisted-authoring.md) —
  `spec generate` / `spec refine`.
- [Runner security](runner-security.md) ·
  [network & data boundaries](network-data-boundaries.md) ·
  [troubleshooting](runner-troubleshooting.md).

## Templates

- [Template gallery](templates.md) — every built-in template (generated).
- [Creating templates](creating-templates.md) — authoring a pack.
- [Template manifest](template-manifest.md) ·
  [rendering](template-rendering.md) ·
  [installation](template-installation.md) ·
  [security](template-security.md) ·
  [contribution guide](template-contribution-guide.md).

## Extensions

- [Extension gallery](extensions.md) — maintained reference extensions
  (generated).
- [Extension architecture](extensions/overview.md) — kinds, protocol,
  permissions, lifecycle.
- [Extension manifest reference](extensions/manifest.md) — the
  `specbridge-extension.json` schema.

## MCP & Claude Code plugin

- [MCP server](mcp-server.md) — the local stdio server.
- [MCP tool reference](mcp/tool-reference.md) — all 47 tools (generated).
- [MCP tools](mcp-tools.md) · [resources](mcp-resources.md) ·
  [prompts](mcp-prompts.md) · [CLI/MCP parity](cli-mcp-parity.md).
- [Claude Code integration](claude-code-integration.md) — both directions.
- [Claude Code plugin](claude-code-plugin.md) —
  [installation](plugin-installation.md) ·
  [development](plugin-development.md) ·
  [marketplace](plugin-marketplace.md) · [security](plugin-security.md) ·
  [release](plugin-release.md).
- [Skill verification](skill-verification/README.md) — live-model results
  for the eleven v1.0 plugin skills (the v1.1 `develop` skill is BLOCKED,
  not yet live-verified).

## Migrations & recovery

- [Migrations & recovery hub](migrations/README.md) —
  `migrate status|plan|apply|verify`, `state validate`,
  `state recover`, `doctor --repair-plan`.
- [Configuration migration (v1 → v2)](configuration-migration.md) — the
  config schema rewrite.

## Security

- [Security model](security.md) — the overall guarantees.
- [Threat model](security/threat-model.md) — T01–T32 with mitigations and
  explicit non-claims.
- [Runner security](runner-security.md) ·
  [template security](template-security.md) ·
  [plugin security](plugin-security.md).
- [Reporting a vulnerability](../SECURITY.md).

## Stability

- [Public contracts](stability/public-contracts.md) — the v1.0.0 contract
  inventory: what is stable and what stability means per surface.
- [Versioning policy](stability/versioning-policy.md) — release types,
  schema/protocol versioning, deprecation rules.

## Performance

- [Performance](performance.md) — the large-repository suite, measured
  numbers, and CI budgets.

## Development

- [Architecture](architecture.md) — the package layout and design rules.
- [Dependencies](development/dependencies.md) — every direct dependency,
  its license, and what ships in release assets.
- [Release checklist](development/release-checklist.md) — the v1.x release
  procedure.
- [Roadmap](roadmap.md) — honest status of every capability.
- [Changelog](../CHANGELOG.md) · [Contributing](../CONTRIBUTING.md) ·
  [Support](../SUPPORT.md).
