# Runner adapter contract (v0.6 — FROZEN; implemented by the v0.6.1 adapters)

This document defines the public adapter contract the v0.6.1 providers
(Gemini CLI, OpenAI-compatible, Antigravity) implement. The exported
names below are stable; changing their shapes, discriminator values, or
required methods is a breaking change and is guarded by the contract
snapshot tests in `tests/runners/contracts.test.ts`.

v0.6.1 made exactly two ADDITIVE, backward-compatible extensions (no
existing field, value, meaning, or error code changed; every v0.6.0
snapshot test passes unchanged):

- `AgentRunner.declaredSupportLevel?` (optional) — the support level the
  adapter itself declares. Absent means `production` (the v0.6.0
  behavior). Preview/experimental adapters are never selected
  automatically and can never be confirmed production by conformance.
- New `AgentRunnerKind` values in `@specbridge/core`: `gemini-cli`,
  `openai-compatible`, `antigravity-cli` (value additions to an existing
  union; stored data referencing older kinds stays readable).

Internal implementation details (adapter file layout, private helpers,
prompt assembly internals) are NOT frozen.

## Frozen exports (`@specbridge/runners` unless noted)

| Concept | Export |
| --- | --- |
| Adapter interface | `AgentRunner` |
| Categories | `RunnerCategory`, `RUNNER_CATEGORIES` |
| Support levels | `RunnerSupportLevel`, `RUNNER_SUPPORT_LEVELS`, `effectiveSupportLevel` |
| Capabilities | `RunnerCapabilities`, `RunnerCapabilitySet`, `RUNNER_CAPABILITY_KEYS`, `runnerCapabilitiesSchema` |
| Operations | `RunnerOperation`, `RUNNER_OPERATIONS`, `RunnerOperationRequirements`, `RUNNER_OPERATION_REQUIREMENTS`, `checkOperationSupport` |
| Detection | `RunnerDetectionContext`, `RunnerDetectionResult` |
| Execution I/O | `RunnerExecutionOptions`, `StageGenerationInput`/`StageGenerationResult` (generation AND refinement — refinement passes `intent: 'refine'`), `TaskExecutionInput`/`TaskExecutionResult`, `TaskResumeInput` |
| Events | `NormalizedRunnerEvent`, `NORMALIZED_RUNNER_EVENT_TYPES`, `normalizedRunnerEventSchema` |
| Results | `NormalizedExecutionResult`, `NORMALIZED_EXECUTION_OUTCOMES`, `normalizedExecutionResultSchema`, `composeNormalizedResult` |
| Errors | `NormalizedRunnerError`, `RUNNER_ERROR_CODES`, `runnerError` |
| Usage/cost | `RunnerUsage`, `RunnerCost`, `runnerUsageSchema`, `runnerCostSchema` |
| Profiles | `RunnerProfileConfig` and per-runner profile schemas (`@specbridge/core`) |
| Registry | `RunnerRegistry`, `RegisteredRunnerProfile`, `createDefaultRunnerRegistry` |
| Selection | `RunnerSelectionRequest`, `RunnerSelectionResult`, `RunnerSelectionPlan`, `selectRunner` |
| Conformance | `RunnerConformanceContext` (suite context), `RunnerConformanceResult`, `runRunnerConformance`, `ConformanceGroupRunner` |

## Adapter lifecycle

1. **Construction** — the adapter is instantiated once per registered
   profile with that profile's validated configuration. Construction must be
   side-effect free (no processes, no network).
2. **Detection** — `detect()` probes the provider read-only. It may run
   version/help commands or loopback reachability checks; it must NEVER send
   a model request, read credential files, or modify provider configuration.
3. **Execution** — `generateStage`, `executeTask`, `resumeTask` perform one
   provider invocation each and return a structured result. They never throw
   for provider-level failures — failures come back as classified results.
4. **Disposal** — adapters hold no persistent resources; every invocation
   cleans up its own temporary files and child processes.

## Detection semantics

`detect()` returns a `RunnerDetectionResult` with:

- `status` — `available`, `unavailable`, `unauthenticated`, `incompatible`,
  `misconfigured`, or `error`. Only `available` permits execution.
- `capabilitySet` — the DETECTED capability set: the declared set downgraded
  by what the installed provider actually supports (never upgraded).
- `supportLevel` — the declared level downgraded by detection:
  missing executable/endpoint → `unavailable`; missing required
  capabilities → `incompatible`.
- `networkBacked` — true when SpecBridge itself would talk to a non-loopback
  endpoint. Agent CLIs are `false` (the provider handles its own
  connectivity); loopback model APIs are `false`; remote model APIs `true`.
- `diagnostics` — a non-`available` status must explain itself with at least
  one error diagnostic. Diagnostics never echo credentials.

Use capability probes (help-text tokens, endpoint responses), never one
exact help layout.

## Capability declaration

`declaredCapabilities` is the static capability set when the provider is
fully available. Rules:

- Declare a capability only when the adapter implements it AND the
  applicable conformance group passes.
- `structuredFinalOutput` means the adapter returns a schema-validated
  structured result — via provider JSON Schema constraining
  (`supportsJsonSchema`) or a validated fallback that passed
  structured-output conformance. Truncated output is never valid.
- Never declare a single `supported` boolean; the seventeen keys in
  `RUNNER_CAPABILITY_KEYS` are the vocabulary.

## Support-level assignment

- `production` — implementation complete; all applicable conformance groups
  pass with provider integration tests (fake providers in CI); security
  boundaries documented.
- `preview` — explicitly selectable only; documented limitations remain.
- `experimental` — detection or partial integration; never selected
  automatically.
- `unavailable` / `incompatible` — detection-time downgrades.

## Operation requirements

`RUNNER_OPERATION_REQUIREMENTS` (frozen values):

| Operation | Required capabilities | Boundary (any of) |
| --- | --- | --- |
| `stage-generation` | stageGeneration, structuredFinalOutput, supportsCancellation | — |
| `stage-refinement` | stageRefinement, structuredFinalOutput, supportsCancellation | — |
| `task-execution` | taskExecution, repositoryRead, repositoryWrite, structuredFinalOutput, supportsCancellation | sandbox OR toolRestriction |
| `task-resume` | taskResume, taskExecution, structuredFinalOutput, supportsCancellation | sandbox OR toolRestriction |
| `model-list` | provider-supported enumeration (`listModels` method) | — |
| `runner-test` | structuredFinalOutput, supportsCancellation (`selfTest` method) | — |

`toolRestriction` is the documented, conformance-approved adapter-specific
boundary equivalent (used by Claude Code: restricted tool set + permission
modes, no bypass flags).

## Structured-output contract

- Authoring returns a stage report: `schemaVersion`, `stage`, `markdown`,
  `summary`, `assumptions[]`, `openQuestions[]`, `referencedFiles[]`.
- Task execution returns a task report: `schemaVersion`, `outcome`
  (`completed | blocked | failed | no-change`), `summary`, plus claim arrays.
- Reports are validated with Zod; malformed output is `malformed-output`
  with `error.code = structured_output_invalid` and the raw candidate
  retained in `invalidStructuredOutput` (bounded, never applied).
- Extra prose around the JSON document is rejected. Markdown code fences are
  not parsed as structured output for model-API adapters.
- Every report field is a CLAIM. Completion authority stays with Git
  snapshots, trusted verification, SpecBridge evidence, and explicit manual
  acceptance.

## Event normalization

Adapters that consume provider event streams translate them into
`NormalizedRunnerEvent` values (types frozen in
`NORMALIZED_RUNNER_EVENT_TYPES`). Rules:

- payloads are flat (string/number/boolean/null) and size-limited
  (`MAX_EVENT_PAYLOAD_BYTES`);
- hidden chain-of-thought / reasoning content is NEVER normalized as content
  — retain only safe status metadata (redaction flag, length, token counts);
- raw provider events may be retained in append-only attempt artifacts when
  they contain no secrets, under the process output limits.

## Error normalization

Provider failures are classified into `RUNNER_ERROR_CODES` (frozen). Each
error carries a safe message, remediation steps, a `retryable` flag, an
optional short provider code, and optional flat redacted details. Stack
traces and raw credential-bearing provider errors are never exposed.

## Timeout and cancellation

Every operation accepts `RunnerExecutionOptions.timeoutMs` and an optional
`AbortSignal`. CLI adapters must terminate the child process (graceful, then
forced); API adapters must abort the HTTP request. Output limits
(stdout/stderr byte caps, HTTP response caps) terminate the invocation, and
truncated output is never parsed. Temporary prompt/schema files are cleaned
up on every outcome.

## Credentials and redaction

- SpecBridge never stores, reads, proxies, logs, or prints credentials.
- Authentication state comes only from official safe provider commands;
  otherwise it is `unknown`.
- Configuration rejects credential-looking keys; argv audit records redact
  configured sensitive values; detection diagnostics summarize, never echo.

## Repository-write boundaries

- Authoring operations are read-only for every adapter: candidates are
  returned to SpecBridge, which validates and writes atomically.
- Task execution uses the safest provider write boundary (Codex
  `workspace-write` sandbox; Claude tool restriction + permission modes).
  Unrestricted modes are rejected at the configuration schema, argv
  assembly, and pre-spawn assertion layers.
- Model-API adapters (category `model-api`) never receive repository access
  and never modify files; their `executeTask` refuses without any request.

## Conformance requirements

A production adapter passes every applicable group of the conformance
framework (`runRunnerConformance` + the execution-layer groups):
detection, structured-output, process-control, stage-generation,
stage-refinement, and — for agent CLIs — task-execution and resume.
Applicability derives from declared capabilities. CI runs the full suite
against fake providers (real child processes / real loopback HTTP);
`specbridge runner conformance <profile> --network` runs it against the
real provider.

## Versioning and backward compatibility

- Contract schemas are versioned (`schemaVersion` fields, currently 1.0.0).
- Within v0.6.x: discriminator values may be EXTENDED (append-only); values
  are never renamed or removed; required adapter members are never added
  without defaults. The snapshot tests enforce exact current values — a
  deliberate extension updates the snapshot test in the same change.
- Stored artifacts (attempt records, normalized results) parse tolerantly:
  unknown fields survive round trips; consumers must ignore fields they do
  not know.
