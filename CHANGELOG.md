# Changelog

## 0.4.0

Added:

- Deterministic spec drift rule engine (`@specbridge/drift`) with 25 stable,
  documented rule IDs (`SBV001`–`SBV025`) across workspace, approval,
  requirements, design, tasks, evidence, impact-area, verification-command,
  protected-path, mapping, and git categories. Every diagnostic carries a
  versioned schema, severity, category, message, remediation, source
  location, structured evidence, and a deterministic/heuristic confidence
  label. Heuristic rules never default to error severity.
- `specbridge spec verify [name] | --changed | --all` — read-only
  verification against a git comparison: `--diff base...head`,
  `--base/--head`, `--working-tree` (default), or `--staged`, with
  `--fail-on error|warning|never`, `--strict`, `--policy`, `--json`,
  `--format terminal|json|markdown|html`, and `--output`. Exit codes:
  0 passed, 1 threshold reached, 2 invalid input/policy/state, 3 comparison
  unavailable, 4 command failed to start, 5 command timeout.
- Requirement-to-task traceability extraction: requirement and acceptance
  criterion IDs (`R1`, `R1.1`, `REQ-001`, `Requirement 1`, `AC-1`, `AC1.2`),
  task references (`_Requirements: 1.1_`, `Requirements: R1`, `[R1]`,
  keyword phrases as heuristics), explicit design path references, source
  lines, and extraction-method provenance.
- Task evidence freshness validation: recorded approved-content hashes,
  checkbox-invariant task fingerprints, commit lineage, repository-path
  safety, and timestamp fallbacks for v0.3 records. New evidence records a
  `specContext` (approved hashes + task fingerprint) for exact drift checks.
- Spec-specific verification policies under `.specbridge/policies/<spec>.json`
  (versioned Zod schema; validated globs; advisory/strict modes; per-rule
  severity overrides) with `spec policy init|show|validate`. `.git/**`
  protection can never be configured away.
- Affected-spec resolution (`spec affected`, `spec verify --changed`): spec
  files, sidecar state, policy files, impact areas, accepted task evidence,
  and explicit design references; unmapped files (SBV014) and ambiguous
  mappings (SBV022) are reported, never silently ignored.
- Trusted verification command orchestration for CI: policy-required
  commands run by default, `--run-verification` runs everything configured,
  `--no-run-verification` reuses passing results only from valid, fresh
  evidence recorded at the exact current HEAD.
- Verification reports: terminal, versioned JSON (`schemaVersion 1.0.0`,
  validated before writing), GitHub-flavored Markdown (Step Summary ready),
  and a self-contained HTML report (no scripts, no external requests,
  CSS-only severity/spec filters).
- Production GitHub Action (`integrations/github-action`, node20, bundled,
  no pnpm or model required): pull_request/push/workflow_dispatch diff
  resolution, validated inputs, ten documented outputs, bounded file/line
  annotations with rule IDs, and a Step Summary. The committed bundle is
  rebuilt and diffed in CI.
- `specbridge verify rules` and `specbridge verify explain <rule-id>` —
  deterministic, read-only rule inspection.

Changed:

- Task-plan approval hashing distinguishes checkbox progress from plan
  changes (hash semantics v2): approving `tasks.md` now records an
  `approvedPlanHash` (checkbox state normalized) beside the exact
  `approvedHash`. `[ ]` → `[x]` progress keeps the approval effective; task
  text, ID, hierarchy, or reference changes still invalidate it.
  Requirements and design approvals remain exact-byte. Pre-v0.4 sidecar
  state keeps validating with exact-byte semantics until the next sanctioned
  write migrates it.
- Verification reports use versioned schemas; reports are validated with Zod
  before they are written.

Security:

- Verification needs no model, no API key, and no network access.
- Verification commands come only from `.specbridge/config.json` — never
  from spec text or model output; argv arrays only, no shell interpolation.
- Git refs are validated (no option injection); git runs argv-only with
  timeouts and output limits; SpecBridge never fetches, commits, or pushes.
- Verification never writes to `.kiro`, approval state, task checkboxes, or
  evidence; report artifacts are its only writes.
- Policy globs reject absolute paths, traversal, null bytes, and malformed
  patterns; evidence paths escaping the repository are flagged (SBV024);
  symlinks escaping the repository are detected.
- HTML reports escape all dynamic content and load nothing external.

Deferred (documented on the roadmap, not claimed):

- MCP server, Claude Code plugin bundle, additional production runners
  (codex/gemini/ollama), extension SDK, template registry, SARIF output.

## 0.3.0

Added:

- Generic agent runner contract (`detect` / `generateStage` / `executeTask`
  / `resumeTask`) with a runner registry, discriminated statuses
  (available/unavailable/unauthenticated/incompatible/misconfigured/error),
  and structured execution outcomes.
- Claude Code local CLI runner: executable/authentication detection,
  help-based capability probing with graceful degradation, non-interactive
  JSON invocation built as an argv array with prompts over stdin, session
  ids, timeouts, cancellation, and stdout/stderr size limits.
- Runner diagnostics: `runner list`, `runner doctor [name]`,
  `runner show <name>` — read-only, `--json`, never echo credentials.
- Model-assisted spec authoring: `spec generate <name> --stage <stage>` and
  `spec refine <name> --stage <stage> --instruction …` with versioned prompt
  contracts, workflow-mode prerequisites, read-only generation tools,
  deterministic candidate validation (invalid candidates are retained under
  the run directory and never applied), unified diffs, atomic writes, and
  dependent-approval invalidation. Nothing is ever auto-approved.
- Approved task execution: `spec run <name>` (`--task`, `--next`, `--all`,
  `--dry-run`, `--allow-dirty`, `--no-verify`) — one task per run, twenty
  pre-run checks, bounded task context, sequential `--all` that stops on the
  first unverified task.
- Git before/after snapshots with hash-exact changed-file attribution,
  protected-path hashing (`.kiro/**`, sidecar config/state), patch capture
  with size limits, and a clean-working-tree policy with a precise
  `--allow-dirty` baseline.
- Trusted verification commands from `.specbridge/config.json` (argv arrays,
  per-command timeouts, required/optional), never derived from spec content
  or model output.
- Append-only task evidence under `.specbridge/evidence/<spec>/<task>/`,
  deterministic evidence evaluation, and verified-only surgical checkbox
  completion (one character on one line; the tasks approval hash is
  re-recorded for SpecBridge's own sanctioned edit).
- Manual task acceptance: `spec accept-task --task … --reason …`, recorded
  as `manually-accepted` (actor `local-user`), always distinct from
  automated verification.
- Run records under `.specbridge/runs/<run-id>/` (prompt, raw output,
  snapshots, verification, evidence, report) plus `run list`, `run show`,
  and resumable Claude Code sessions via `run resume <run-id>` with
  divergence detection and `parentRunId` lineage.
- Versioned runner configuration schema (v0.2 config files upgrade with safe
  defaults), a deterministic mock runner with failure/rogue scenarios, and a
  fake Claude CLI process fixture — CI needs no Claude installation and no
  network.
- Documented exit codes 3–6 (runner unavailable / runner failure /
  timeout–cancel / safety) extending the unchanged 0/1/2 contract.

Security:

- No embedded authentication: the local user installs and authenticates
  Claude Code independently; SpecBridge never stores or prints credentials.
- No dangerous permission bypass: `bypassPermissions` and
  `dangerously-skip-permissions` are rejected at the config schema, argv
  assembly, and pre-spawn layers.
- No model-controlled verification: commands come only from trusted project
  configuration; spec files and model output are treated as data.
- No automatic git commit, push, reset, stash, or rollback.
- Protected-path modifications (`.kiro`, sidecar state, moved HEAD,
  configured paths) prevent verification and are reported, with evidence
  preserved.

Deferred (see docs/roadmap.md):

- full spec-to-code drift verification CLI, GitHub Action gates, MCP server,
  additional production runners (codex/ollama/openai-compatible remain
  honest stubs), parallel task execution.

## 0.2.0

- Offline Kiro-compatible spec creation: `spec new` renders plain-Markdown
  templates for feature and bugfix specs — no model, no API key, no network.
- Requirements-first, design-first, quick, and bugfix workflows with an
  explicit state machine and per-stage approval gates.
- Deterministic spec analysis: `spec analyze` reports structural and
  consistency problems (placeholders, missing criteria, malformed EARS,
  vague wording, task-plan gaps) with error/warning/info levels and
  `--strict` mode. Same bytes, same findings, every time.
- Approval state and document hashing: `spec approve` records the SHA-256 of
  the exact approved file bytes in versioned sidecar state
  (`.specbridge/state/specs/<name>.json`, schema 1.0.0). Approved Markdown
  files are never rewritten.
- Stale approval detection: `spec status`, `spec list`, and `doctor` report
  approved files that changed after approval and invalidate dependent
  approvals in memory; re-approving repairs the hash and cascades honestly.
- Approval revocation: `spec approve --revoke` clears a stage and every
  approval that depended on it, keeping all files.
- Existing Kiro workspace support: specs without SpecBridge state stay fully
  usable (reported as `unmanaged`); the first successful approval initializes
  sidecar state with `origin: existing-kiro-workspace`.
- `spec status` (new), plus extended `spec list` (mode/status/approval
  health), `spec show` (`--state`, `--analysis`, `--status`), and `doctor`
  (sidecar validation, orphan and stale state detection).
- No model or API key required for any v0.2 command; `.kiro` files carry no
  SpecBridge metadata and the byte-identical no-op round trip is unchanged.

## 0.1.0

- Read-only Kiro compatibility: workspace detection, steering discovery,
  spec discovery and classification, tolerant Markdown parsers.
- `doctor`, `steering list/show`, `spec list/show/context`, `compat check`.
- Line-preserving document model with a byte-identical no-op round-trip
  guarantee and a surgical checkbox patcher.
- Deterministic drift-check library primitives, runner interfaces with an
  offline mock runner, terminal/JSON/HTML report helpers.
