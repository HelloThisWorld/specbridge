# Execution telemetry and token-conservation reports

Phase 9 turns durable Job, WorkUnit, routing, research, cooldown,
verification, closure, and autonomy records into one versioned operational
report. The report is observational: it cannot approve work, change routing,
grant authority, or make a Job complete.

## Read a report

```bash
specbridge report job <jobId>
specbridge report job <jobId> --verbose
specbridge report job <jobId> --json
```

The human view is concise by default. `--verbose` adds bounded WorkUnit
accounting and the cooldown timeline. The JSON view carries
`schemaVersion: "1.1.0"` and, unless `--no-persist` is used, is saved at
`.specbridge/reports/job-<jobId>-telemetry.json`.

MCP clients can call the read-only `job_report` tool. It derives the same
report without persisting a file.

## Formal metric definitions

A ratio is represented as `{ numerator, denominator, value }`. `value` is
`null` when the denominator is zero or the underlying durable facts do not
exist. Unknown measurements are never reported as zero.

| Metric | Numerator | Denominator | Exclusions and unknown semantics |
| --- | --- | --- | --- |
| `StrongBuilderAvoidanceRatio` | Eligible, completed implementation WorkUnits with no `STRONG` or `STRONG_FALLBACK` builder attempt | Eligible, completed implementation WorkUnits | Excludes `STRONG_REQUIRED`, cancelled, authority-pending, research-pending, context-pending, and incomplete work. A Strong evaluator is not a Strong Builder. `null` when no eligible implementation WorkUnit completed. |
| `SecondaryInitialSuccessRate` | WorkUnits whose initial `SECONDARY` attempt passed without repair | WorkUnits with an initial `SECONDARY` attempt | `null` when Secondary was never initially attempted. Replayed attempt IDs are counted once. |
| `SecondaryRepairRecoveryRate` | WorkUnits whose `SECONDARY_REPAIR` path passed | WorkUnits that received a `SECONDARY_REPAIR` attempt | `null` when repair was never attempted. |
| `SecondaryToStrongFallbackRate` | Secondary-attempted WorkUnits that later used `STRONG_FALLBACK` | WorkUnits with any Secondary implementation attempt | `null` when Secondary was never attempted. |
| `ResearchAvoidanceRatio` | Research-gate considerations resolved without a new QUICK or DEEP provider call | Research-gate considerations | `null` where gate aggregates are unavailable. The report labels existing aggregate gate telemetry as `WORKSPACE`; it does not pretend it is Job-scoped. Job-scoped provider records remain Job-scoped. |
| `ResearchReuseRate` | Reused prior research reports | Reused reports plus new provider calls | `null` when neither reuse nor a new call occurred. |
| `UsefulWorkDuringSubscriptionCooldown` | Distinct WorkUnits durably recorded as completed during a Strong subscription cooldown | Not a ratio | Includes productive Secondary and research progress while Strong-required work waits. Duplicate WorkUnit IDs within the same objective are counted once. |
| `ZeroTouchAfterSeal` | `true` only when `humanInterventionsAfterSeal` is zero | Not a ratio | Correct authority escalation is reported separately. A missing seal boundary is diagnosed by the underlying autonomy telemetry; it is never inferred from a successful outcome. |
| `CompletedWorkRedoCount` | Implementation attempts that began after the same WorkUnit had already been durably integrated | Not a ratio | Resource waits and replayed copies of the same durable attempt ID are excluded. Candidate reuse and restart recovery are reported separately. |
| `lostCandidates` | Candidates rebuilt after restart because the prior candidate could not be reused | Not a ratio | Must be zero for production qualification. |
| `duplicateDispatches` | Distinct attempt IDs with the same Objective, WorkUnit attempt, and builder kind | Not a ratio | Replayed copies of one durable attempt ID are deduplicated and do not count as execution. |
| `runtimeMutation` | `0` when candidate-bound runtime start/end digests match; `1` otherwise | Not a ratio | `null` outside a candidate-bound qualification because absence is not proof of stability. |

## Work accounting

Every current WorkUnit belongs to exactly one reporting category:
`completed`, `failed`, `cancelled`, `waiting`, `not-ready`,
`human-authority-pending`, `research-pending`, or `context-pending`. This is
reporting classification only and does not alter the WorkUnit state machine.

The same accounting is rolled up per Objective and for the whole Job;
`missionId` links the Job report to its sealed Mission when that durable
binding exists. Secondary eligibility reports both the eligible total and an
explicit ineligible total, with Strong-required, research, authority,
context, and not-ready reasons kept separate.

Implementation builder calls and evaluator calls are separate populations.
`STRONG` and `STRONG_FALLBACK` count as Strong Builder calls;
non-local `EVALUATOR` ledger entries count only as Strong evaluator calls.

## Token and research coverage

Provider-reported input and output tokens are summed only when present.
`knownTokens` is the sum of observed components; `completeTokens` is `null`
unless every attempt reported both components. Coverage states how many
attempts reported any, input, and output usage. Research cost and duration
follow the same rule: absence is `null`, not free or instantaneous.

Research reports expose `JOB`, `WORKSPACE`, or `NONE` scope. Lifecycle
breakdowns cover conversation, spec draft, intake decision, and runtime
investigation. Workspace-scoped legacy aggregates are explicitly labeled so
cross-Job evidence cannot be mistaken for a Job-only total.

## Provenance, safety, and compatibility

The report records Job and objective graph revisions, event and execution
ledger watermarks, seal references, the current non-secret strategy summary,
whether the current runtime policy differs from the sealed binding, and—when
Phase 10 supplies a candidate-bound observation—the runtime start and end
digests. A Mission seal binding can persist the qualified version, commit,
digest, and qualification run ID without granting any additional authority.
Diagnostic text is bounded and redacted. Prompts, transcripts, raw provider
payloads, environment secrets, and credentials are never report fields.

Older Jobs remain reportable. Missing Phase 7/8, research, seal, or closure
records produce empty or `null` sections plus diagnostics rather than
invented facts. Inputs and output arrays are bounded, and duplicate durable
attempt IDs are deterministically deduplicated.

## Comparing routing strategies

Efficiency claims require comparable verification and closure outcomes.
The JSON report can carry an explicitly identified observed or qualification
baseline; it reports whether outcomes match before presenting Strong Builder
call reduction. `correctnessEqual` remains false when trusted verification or
closure evidence is unavailable, even when both missing values match. This is
evidence for qualification and operations, not a learned-routing or
production-readiness claim.
