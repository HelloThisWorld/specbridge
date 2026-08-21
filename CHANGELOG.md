# Changelog

## 1.6.0 (unreleased) — vNext.3 DeepSeek Harness Integration

DeepSeek Harness (DSH) becomes an isolated, replaceable agent-harness
backend behind the existing frozen `AgentRunner` contract: SpecBridge stays
the engineering control plane (Job/Task, contracts, ExecutionAttempts,
Checkpoints, canonical context, quota, scheduling, evidence, completion
authority); DSH owns only attempt-local mechanics (agent loop, tools,
sandbox, agent-local session/context, native compaction). The governing
invariant, proven end to end by the new validation scenario: **DSH state is
disposable working state** — killing the runtime, deleting its sessions, or
replacing its version never destroys a Job, Task, Checkpoint, Decision, or
Evidence.

Integration, not migration: the profile is PREVIEW, disabled by default,
never selected automatically, and changes no scheduler behavior — vNext.2
LOCAL/SUBSCRIPTION routing and the direct LocalExecutor path are
byte-identical with DSH enabled or not. Automatic `LOCAL → HARNESS` routing
is explicitly deferred to vNext.4; API-lane gap routing to vNext.5.

### Added

- **`deepseek-harness` runner** (`packages/runners/src/deepseek-harness/`)
  — task execution and (attested, verified) session resume through the
  official `@deepseek-ai/dsh-sdk-client`, exact-pinned at `0.1.1-rc.1`
  (developer preview) and isolated inside `@specbridge/runners`. One narrow
  `DshSdkAdapter` owns every SDK call — launch, `initialize` handshake
  (wire-stable `deepseek-harness-sdk-runtime` identity verified, runtime
  version recorded), receipt-to-idle run collection, bounded teardown —
  so a breaking SDK change lands in one file and no DSH/Cordis type leaks
  into core domain packages. The runtime runs out-of-process, launched
  from an explicit argv command spec with an allowlist-REPLACED child
  environment (never inherited credentials).
- **Fail-closed safety attestations** — the public DSH SDK exposes no
  sandbox/tool-restriction configuration (the runtime's own `cordis.yml`
  owns its tools), so task execution is unavailable
  (`sandbox_unavailable`, pre-spawn) until the operator attests
  `workspaceBoundary: "runtime-profile"`; authoring is refused outright
  (no enforceable read-only boundary); the adapter is `preview` and can
  never be confirmed production by conformance. SpecBridge protected-path
  checks and evidence evaluation still verify every run independently.
- **Resume with a continuity guard** — `sessionPersistence:
  "runtime-managed"` enables the fast path, and every resume is verified
  by session-log `seq` continuity: a runtime that silently recreated the
  session empty (seq 0) is stopped before any agentic work and normalized
  as `session_unavailable`, falling back to the canonical path (SpecBridge
  Checkpoint + repository state + ContextLifecycle reconstruction → fresh
  session). A lost DSH session never loses a Task.
- **Bounded cancellation/timeout/crash semantics** — the DSH wire has no
  mid-turn cancel, so aborts and deadlines close the runtime through the
  SDK's shutdown → EOF → SIGTERM → SIGKILL ladder (idempotent, no orphan
  processes); crashes classify as worker failures that preserve the
  attempt, checkpoint, and Job.
- **Event normalization + strict reasoning redaction** — safe lifecycle
  notifications map into `NormalizedRunnerEvent` (plus the additive
  `compaction.occurred` type for observed native compaction — working
  memory only, never canonical); reasoning blocks/deltas are never
  persisted anywhere (occurrence metadata only; retained raw notification
  logs are deep-redacted and `request/header` prompts elided). Usage is
  provider-reported per `assistant/message` accounting; cost is never
  computed.
- **Deterministic fake DSH runtime**
  (`tests/fixtures/fake-dsh/fake-dsh.mjs`) — speaks the real stdio
  JSON-RPC protocol to the REAL pinned SDK client in CI: success,
  false-claim, malformed/prose output, reasoning, compaction, subagents,
  RPC errors, hang, crash, EOF-refusing teardown, and cross-process
  session persistence for resume/lost-session scenarios.
- **vNext.3 validation scenario**
  (`tests/orchestration/dsh-validation.test.ts`) — workspace → explicit
  DSH profile → Attempt/Checkpoint/ContextPackage → real subprocess run →
  independent evidence → native compaction with durable context
  byte-identical → mid-attempt crash → restart/reconcile → lost session →
  checkpoint reconstruction → fresh session → verified completion →
  delete ALL DSH state → everything canonical survives → disabled profile
  changes nothing. Plus runner-level (`tests/runners/deepseek-harness.
  test.ts`) and evidence-boundary/conformance suites
  (`tests/execution/deepseek-harness-execution.test.ts`).

### Changed

- **Additive public contracts** (deliberate, snapshot-regenerated): runner
  kind `deepseek-harness`; normalized error code `session_unavailable`
  (non-retryable); normalized event type `compaction.occurred`;
  `deepseekHarnessProfileSchema` in the profile union with a disabled
  built-in profile (existing workspaces load unchanged, no migration).
- **Execution-layer conformance** now selects the profile under test
  explicitly (`runnerName`), so preview adapters — explicit-selection-only
  by design — are exercised exactly like `runner conformance <profile>`;
  production adapters are unaffected.

## 1.5.0 (unreleased) — vNext.2 Free & Prepaid Optimizer

SpecBridge's job runtime becomes an intelligent scheduler over two compute
resources: **local model compute** (zero marginal cost, no subscription
quota) and the **prepaid Claude Max subscription** (the primary
strong-intelligence engine, limited by rolling five-hour and weekly quota
windows whose unused capacity expires at reset). The governing policy: use
local compute for work it can reliably perform, use Max productively while
it is available, harvest capacity that is about to expire, and never let a
subscription cooldown stall local-capable work. The PAYG API lane is
explicitly **not** part of this release — when Max is unavailable and local
execution cannot handle a task, the task stays durably pending with a
recorded scheduling reason.

Additive throughout: the scheduler block is optional and defaulted
(`orchestration.jobs.scheduler.enabled: false` restores vNext.1 scheduling
byte-identically), every vocabulary and event addition is append-only, new
schema families are versioned from day one (`quotaSnapshot`,
`schedulingDecision`), and attempt-metric extensions are nullable
observations — nothing fabricated, no migration required.

### Added

- **Execution lanes** — the scheduler reasons about the economic lane
  (`LOCAL` / `SUBSCRIPTION`) first, then the concrete provider
  (`scheduling/vocabulary.ts`).
- **Local task execution** (`scheduling/local-execution.ts`) — the local
  model becomes a first-class execution provider with SpecBridge driving
  the loop: one bounded structured request returns complete replacement
  file contents (or an explicit escalation), SpecBridge validates and
  applies them, and the EXISTING interactive evidence pipeline verifies
  (lock, Git snapshots, trusted verification, verified-only completion).
  Local attempts are ordinary durable ExecutionAttempts on the `LOCAL`
  lane; the model itself never writes, has no tools, and no shell.
- **Deterministic local suitability** (`scheduling/suitability.ts`) —
  `LOCAL_SAFE` / `LOCAL_TRY` / `STRONG_REQUIRED` from documented keyword
  tables plus the deterministic complexity class. `LOCAL_TRY` requires
  trusted verification commands: verifiability, not perceived difficulty,
  is the criterion.
- **Bounded local retries** — `scheduler.maxLocalAttempts` (default 2)
  local execution attempts per task, then a sticky
  `LOCAL_EXECUTION_ESCALATED` escalation routes the task to the strong
  lane. Failed local attempts stay visible in attempt history and ledger.
- **Subscription quota model** (`quota/`) — independent five-hour and
  weekly window snapshots (never combined into one percentage), a
  `QuotaTelemetryProvider` abstraction (manual file-backed adapter kept
  current via the CLI, deterministic fake for tests, a documented seam for
  future machine-readable adapters — no UI scraping, no invented APIs),
  freshness handling (`FRESH`/`STALE`/`UNKNOWN`), and a pure
  `QuotaForecast` the scheduler consumes as a value.
- **Workload profiler** (`scheduling/profiler.ts`) — wall time, five-hour
  burn, weekly burn, and context growth estimated independently, with
  explicit confidence and basis; heuristic complexity defaults replaced
  conservatively by subscription-lane ledger history (medians, observation
  floor). Burn-over-time is a profile (`linear` today) — the extension
  point for measured curves.
- **Cooldown-aware scheduler** (`scheduling/scheduler.ts`) — modes
  `NORMAL` / `CONSERVE` / `HARVEST` / `EXHAUSTED_5H` / `EXHAUSTED_WEEKLY`
  as explicit domain state; weekly scarcity suppresses five-hour
  harvesting; pure lane decisions (`LOCAL`/`SUBSCRIPTION`/`DEFER`) with a
  closed reason-code vocabulary.
- **Cross-reset admission** (`scheduling/admission.ts`) — admission
  compares expected **burn before the reset** (plus a configurable safety
  multiplier) against remaining capacity minus the dynamic reserve;
  `taskDuration <= timeToReset` is deliberately not a rule anywhere. The
  mandatory scenario (50% remaining, reset in 20 minutes, 50-minute task
  burning 35%) starts immediately and continues across the reset.
- **Dynamic reserve** (`scheduling/reserve.ts`) — interpolates from
  `baseRatio` far from the reset to `minRatio` near it; weekly pressure and
  stale telemetry add reserve.
- **Ready-task selection and cooldown overtake** — the scheduler inspects
  every READY node; runnable work beats deferring work, HARVEST prefers
  admissible strong work, and a LOCAL-lane node whose only unfinished
  predecessors are quota-deferred is promoted (recorded) so local work
  continues through a subscription cooldown. Deferred strong work parks the
  job in `WAITING_RETRY` with `retryAt` at the reset — resumable, never
  blocked.
- **Context-aware admission** — quota capacity and context capacity are
  both required; heavy durable context triggers the vNext.1
  checkpoint → compact → reconstruct path before the dispatch
  (`context_compaction_before_dispatch`).
- **Local preprocessing** (`scheduling/preprocess.ts`) — bulky regenerable
  context items (test logs, tool output) compressed into structured
  summaries via the local lane before strong work sees them; pinned and
  durable layers untouched.
- **SchedulingDecision records** — every routing/admission decision
  persisted (`jobs/<id>/scheduling/decisions.jsonl`, bounded) with the
  forecast, estimate, reserve, context status, and reason code it saw.
- **ExecutionLedger extensions** — optional nullable attempt metrics
  (five-hour/weekly remaining before and after, context usage before and
  after, test loops) plus lane, suitability, category, and decision id;
  `quota/observations.ts` derives burn, burn-per-minute, wall time, and
  success aggregates without fabricating gaps (a reset crossed mid-attempt
  makes burn honestly unknown).
- **Observability** — seventeen additive job events
  (`quota_snapshot_updated`, `scheduler_mode_changed`, `harvest_entered`,
  `cross_reset_admitted`, `task_routed_local`, `task_deferred`,
  `local_escalation_triggered`, …) and three CLI commands:
  `orchestrate quota`, `orchestrate quota-set`, `orchestrate scheduler`.
- **Configuration** — `orchestration.jobs.scheduler` (additive, defaulted,
  documented; outside the job policy fingerprint like the context block).
- **Documentation** — `docs/orchestration/quota-scheduling.md`.

### Explicit non-goals (deferred to vNext.3)

PAYG API gap bridge and automatic API fallback, predictive/ML scheduling,
semantic repository indexing, multi-agent collaboration, distributed
scheduling, billing.

## 1.4.0 (unreleased) — vNext.1 Survival Runtime

The first stage of SpecBridge's evolution into a provider-neutral
long-horizon engineering runtime. A job now survives agent death, session
loss, provider handoff, process restart, and repeated model-context
compaction without losing the durable information required to continue
correctly. Two invariants govern the design: **agents and model sessions
are disposable workers — SpecBridge owns the durable job state**, and
**context windows are disposable working memory — SpecBridge state is
durable memory**.

Additive throughout: no persisted schema version moved, every new schema
family is versioned from day one (`taskAttempt`, `taskCheckpoint`,
`contextPackage`, `runnerContextCapabilities`), existing CLI/MCP/plugin
surfaces are unchanged, and v1.0–v1.3 workspaces load with no migration.

### Added

- **Durable ExecutionAttempts** (`@specbridge/orchestration` `survival/`) —
  Job, Task, and ExecutionAttempt are now three distinct durable concepts. A
  Task (job graph node) is durable intended work; an attempt is ONE
  disposable worker run against it, persisted at `.specbridge/jobs/<jobId>/
  task-attempts/` **when the dispatch starts** (status `RUNNING`), finalized
  when it ends, and reconciled `RUNNING → INTERRUPTED` by `resumeJob` when
  the owning process disappeared. Attempts are append-only history with
  `resumedFromAttemptId` lineage; retrying or switching providers never
  overwrites a previous attempt.
- **Structured task checkpoints** — `taskCheckpointSchema`: objective,
  pinned context (task contract, acceptance criteria, constraints,
  invariants), completed/pending work, important decisions, **failed
  approaches**, changed files, repository state (Git-snapshot grounded, no
  commit required), test results, known failures, unresolved issues,
  next actions, artifact references. Append-only revisions per task;
  decisions and failed approaches carry forward automatically; a completed
  task auto-checkpoints as a milestone. Corrupt newest revisions fall back
  to the newest readable one.
- **`@specbridge/context`** — the provider-neutral context lifecycle as a
  pure, deterministic domain package: six context layers (`PINNED`,
  `DURABLE_TASK_STATE`, `COMPACTED_HISTORY`, `WORKING_SET`, `RECENT_DELTA`,
  `CURRENT_ACTION`; the protected layers can never be compacted away),
  configurable context budgets with reserved output/reasoning/growth
  headroom, a closed health vocabulary (`HEALTHY` → `PREPARE` →
  `PROACTIVE_COMPACT` → `FORCE_COMPACT` → `OVERFLOW` at configurable
  ~55/70/85/90% thresholds), three compaction levels (micro / milestone /
  emergency — emergency is a normal operation that only discards state a
  persisted checkpoint already made durable), a bounded recent-delta log,
  a pluggable summarizer boundary, and a `ContextLifecycleManager`
  composing them. Over-budget assembly with no checkpoint **fails
  explicitly** rather than silently dropping context.
- **Deterministic context reconstruction and resume** —
  `reconstructTaskContext` / `prepareTaskResume`: load Job → Task → latest
  checkpoint → pinned → durable → repository snapshot/working set → delta →
  apply budget → compact if required → `ContextPackage`. A fresh worker (or
  a different provider) starts from SpecBridge durable state plus current
  repository state; the previous agent conversation is structurally
  unreachable. Cumulative task context can exceed one model window by many
  multiples (exercised at >5× in tests).
- **Execution ledger** — every attempt yields a normalized
  `ExecutionLedgerEntry` (`readExecutionLedger`,
  `summarizeExecutionLedger`): provider, model, timings, tokens, tool
  calls, files changed, cost — all null-tolerant. Missing provider metrics
  never block execution and are never fabricated.
- **Provider context capabilities** (`@specbridge/runners`) — additive
  optional `declaredContextCapabilities` on the runner contract (window
  size when known, native-compaction mode `none`/`automatic`/`explicit`,
  session persistence), declared by the Claude Code adapter (automatic
  native compaction, sessions) and the mock adapter (deterministic small
  window, no native compaction). Provider-native compaction integrates
  through the `NativeCompactionAdapter` boundary and remains session
  working memory — it can never become canonical SpecBridge state, and
  cross-provider continuity never depends on it.
- **Context policy** — additive `orchestration.jobs.context` configuration
  block (default window, reservations, compaction thresholds, delta
  bounds). Operational tuning only; nothing here can weaken a safety
  boundary or configure pinned state away.
- **Observability** — additive job events (`attempt_started`,
  `attempt_completed`, `attempt_interrupted`, `task_checkpoint_created`,
  `task_resumed`, `context_threshold_reached`, `context_compacted`) with
  stable ids; new SBO049–SBO051 error codes; new `context-contract.json`
  snapshot and schema-version registrations.
- **Tests** — `tests/context/context-lifecycle.test.ts` (budgets, health,
  compaction levels, >5× repeated-compaction survival, emergency pressure
  as normal operation), `tests/orchestration/survival-runtime.test.ts`
  (attempt lifecycle, checkpoint carry-forward and corruption fallback,
  process restart, provider handoff, canonical-state independence,
  failed-approach preservation, crash recovery, ledger tolerance), and
  `tests/orchestration/survival-validation.test.ts` (the full end-to-end
  survival scenario against a real Git workspace).
- **Documentation** — `docs/orchestration/survival-runtime.md`: runtime
  ownership, Job/Task/Attempt, the context model, the three compaction
  mechanisms and why they are different things, recovery semantics.

### Changed

- `beginExecutorDispatch` also persists the durable attempt (and accepts
  optional `provider`/`model`/`providerSessionId`); `completeExecutorDispatch`
  finalizes it and auto-checkpoints verified completions;`resumeJob`
  additionally reconciles interrupted attempts and reports their ids. All
  signatures remain backward compatible.
- `JobState` gains optional `currentAttemptId` (additive; schema version
  unchanged).

## 1.3.0 (unreleased)

Mission-driven development. v1.2 drives an approved spec as a persistent
job; v1.3 adds everything **around** and **inside** that: how a high-level
product direction becomes an approved spec worth driving (**Mission
Discovery** → contracts → synthesis), and how one approved objective
executes as governed multi-agent work (**dynamic work graphs → isolated
builders → evaluation → aggregation → single-writer integration**) — while
completion authority, human approval, Kiro byte-preservation, and the
evidence pipeline stay exactly where they were.

Two principles run through every addition. *Share truth, not context*:
agents collaborate through approved, versioned artifacts — immutable
context projections — never by sharing conversational context, and no
schema anywhere can carry chain-of-thought. *Model proposes, SpecBridge
governs, evidence decides*: every model output is a schema-validated
proposal that deterministic code accepts, refuses, or routes to a human.

Additive throughout: no persisted schema version moved, no public contract
changed meaning, v1.0/v1.1/v1.2 workspaces load with no migration, and
legacy workflows (`spec run`, `/specbridge:implement`, `/specbridge:develop`,
non-mission orchestration jobs) are byte-identical. Mission-driven
development is an additional mode, never forced.

### Added

- **`@specbridge/mission`** — Mission Discovery as a domain package. A
  fail-closed lifecycle (`IDEA → DISCOVERING ⇄ NEEDS_DECISION →
  CONTRACT_READY → SPEC_SYNTHESIS → SPEC_REVIEW → APPROVED`, plus final
  `ABANDONED`) persisted under `.specbridge/missions/<id>/` — versioned,
  atomic, workspace-confined, append-only where history matters. `.kiro` is
  never touched.
- **Conversation provenance** — every material user-visible discovery
  exchange persists verbatim as a bounded turn; decisions carry structural
  provenance, and a `known-from-user` decision must cite a confirming USER
  turn (an agent turn is refused — the injection boundary is structural).
  Unsafe provenance (`inferred`/`unknown`/`conflicting`) can never back a
  decision. Full lineage: turn → decision → constitution rule → contract →
  requirement → implementation evidence.
- **Deterministic coverage and materiality** — coverage is computed over a
  closed 24-topic taxonomy (never asserted); a deterministic
  irreversibility screen classifies questions touching public API, wire
  protocol, persisted state, configuration language, SDK contract,
  extension SPI, compatibility, security boundaries, delivery semantics, or
  cross-module architecture as **blocking** (it may only RAISE declared
  materiality). Only open blocking questions and unaddressed required
  topics gate `CONTRACT_READY`; implementation detail never stalls
  discovery.
- **Architecture Constitution** — few, strong, durable invariants
  (`CON-###`) with versions, provenance, supersession history kept in-file,
  and optional machine-checkable **guard patterns** the deterministic
  evaluator greps candidate diffs for.
- **ADRs** — immutable `ADR-####` files with context, alternatives,
  rationale, consequences, revisit conditions, and DERIVED supersession
  (old history is never rewritten).
- **Product Contract Registry** — versioned engineering contracts
  (`CTR-###`) with immutable per-revision files, public/internal
  classification, compatibility policies, dependencies, requirements,
  invariants, and provenance. Deliberately separate from the repository's
  own `contracts/` snapshots.
- **Contract change requests** — durable `CCR-###` artifacts
  (`PROPOSED/NEEDS_HUMAN/APPROVED/REJECTED/SUPERSEDED`). Anyone may raise
  one (workers, aggregators, MCP, CLI); **only the human decides one**, and
  the decision path is CLI-only (`specbridge mission ccr … --approve|
  --reject`). Approval writes the next immutable revision, records the
  decision in the provenance chain, and makes every projection built
  against the old revision stale — affected work replans, never continues
  silently.
- **Mission → spec synthesis** — a deterministic compiler (no model) from
  the contract set to Kiro candidates through the existing creation
  machinery, archived with a provenance map before creation. For
  mission-driven projects `tasks.md` contains **Objectives with acceptance
  criteria**, not coding steps. Approval remains the unchanged human
  workflow.
- **The objective runtime** (`@specbridge/orchestration` `objectives/`) —
  between an approved objective and worker dispatches: a **dynamic work
  graph** (append-only revisions, fail-closed unit state machine in which
  `INTEGRATED` is reachable only from `VERIFIED_CANDIDATE`), proposed by a
  new DECOMPOSER role and validated deterministically (bounds, acyclicity,
  depth, terminal integration unit, contract-ownership surfacing) — with a
  deterministic single-unit fallback, so a model outage cannot stall an
  objective. Runtime replanning may split/supersede units within the
  approved objective; it can never silently change approved behavior.
- **Context projections** — immutable, hashed, bounded worker context:
  constitution snapshot + objective + relevant contract revisions + ADRs +
  decisions + spec excerpts + verified dependency evidence. Identity is two
  hashes (content, contract snapshot) stamped into the worker record;
  staleness is structural and fails closed.
- **AgentSupervisor** — durable worker identity per attempt and fail-closed
  result acceptance: wrong identity, duplicate, late/superseded, forged or
  stale hashes are all rejected even when content looks valid; two workers
  can never own one attempt.
- **Isolated builder worktrees** — one detached git worktree per
  (workUnit, attempt) under the sidecar, dependency patches applied on top;
  SpecBridge observes the diff against the recorded baseline (a worker
  committing locally hides nothing), runs trusted verification inside the
  worktree, refuses protected-path changes, never pushes or merges, and
  prunes on resume with interrupted workers superseded.
- **Candidate artifacts** — durable results (observed changed files,
  normalized patch, local verification, bounded claims incl. discovered
  assumptions and contract change requests). No field can encode commands,
  permissions, or authority.
- **Evaluation engine** — deterministic layer always first (identity,
  protected paths, projection freshness, local verification, non-empty
  change, scope, contract guard patterns; a guard hit is a CONFLICT), then
  a semantic EVALUATOR (local-first) only where judgment is genuine, with
  schema-constrained verdicts routed through the existing decision-authority
  table. A worker is never the sole evaluator of its own work.
- **Aggregation engine** — structural aggregation is deterministic (a
  failed required unit prevents integration, no model involved); semantic
  aggregation runs one bounded AGGREGATOR dispatch only over ≥2 verified
  investigation reports, may surface cross-report contract conflicts
  (first-class `CONTRACT_CONFLICT` records — never a silently picked side)
  and recommend contract changes (as CCRs, never approvals).
- **Single-writer integration** — the INTEGRATOR applies verified
  candidates in dependency order inside the existing interactive-run
  bracket (lock, snapshots, protected paths, trusted verification,
  verified-only completion); one bounded reconciliation dispatch may make
  minimal integration edits on a genuine patch conflict. No second
  completion path exists.
- **Conservative opt-in parallelism** — `orchestration.jobs.objectives.
  parallelism` (default disabled). Concurrency only for provably
  independent units (disjoint declared contracts and areas; unresolved
  decisions serialize everything; unprovable independence runs alone), and
  only the isolated builder dispatches run concurrently — graph writes stay
  sequential, and integration remains exactly one run.
- **New agent roles** (additive enum): DECOMPOSER, BUILDER, EVALUATOR,
  AGGREGATOR, INTEGRATOR — with deterministic routing (BUILDER/INTEGRATOR
  structurally require the repository-writing large agent; DECOMPOSER/
  AGGREGATOR default large-agent; EVALUATOR local-first), 18 new semantic
  job event types, and SBO039–SBO048.
- **Configuration** (additive, defaulted): `orchestration.jobs.objectives`
  (bounds, builder attempts/timeout, semantic-evaluation mode, parallelism,
  candidate/projection ceilings) and routing entries for the new reasoning
  roles.
- **CLI**: the `specbridge mission` group (begin, status, show, events,
  coverage, answer, contract-ready, synthesize, contracts, adr, ccr,
  decisions, reopen, abandon) plus `orchestrate objective` and
  `orchestrate workunit` inspection.
- **MCP**: 14 tools (50 → 64) — `mission_begin/status/read/record_turn/
  assess/questions/answer/synthesize`, `contract_list/read/
  change_request`, `objective_read`, `workunit_read`, `evaluation_read`.
  Deliberately absent: stage approval, CCR decisions, filesystem, shell,
  git, or any automatic human-decision API.
- **Plugin**: `/specbridge:discover` (13 → 14 skills) — the discovery
  interlocutor; it records and proposes, approves nothing, and never
  becomes the long-running executor.
- **Contracts**: new `contracts/mission-contract.json` snapshot; schema
  versions snapshotted for all mission and objective families (and the
  v1.2 job families); orchestration snapshot gains the objective vocabulary
  additively.
- **StepRelay dogfood** — offline end-to-end scenarios proving the full
  §Definition-of-Done flow: discovery with blocking-question gating,
  contract synthesis, human approval, dynamic decomposition, isolated
  parallel builders, deterministic `nextState` conflict detection, the
  missing-`nack` CCR loop with stale-projection replanning, investigation
  aggregation with contradiction stops, persistent-failure honesty, and
  mid-objective interruption resumed to completion.

### Fixed

- The shared model-API HTTP client no longer composes its total timeout
  with `AbortSignal.any([AbortSignal.timeout(ms), external])`. On Node 20
  the composite holds only weak references to its sources, so an
  otherwise-unreferenced timeout signal could be garbage collected before
  its timer fired — and a request against an endpoint that never answers
  (Ollama, OpenAI-compatible, the managed local model, registry downloads)
  then hung forever instead of timing out. This was the intermittent
  node-20 CI failure where "a timeout aborts the request deterministically"
  burned the full 30-second test budget. The client now uses one explicit
  `AbortController` with a real timer per request — no GC dependence on any
  Node version — released in a `finally`, which also fixes the 'abort'
  listener `any()` leaked on long-lived external signals per request, and
  makes the timeout genuinely TOTAL across redirect hops and body
  streaming, as the contract always documented.

## 1.2.0 (unreleased)

The persistent, local-first, multi-agent orchestrator. v1.1 governed how a
single interactive session works through one task; v1.2 adds the layer
above it: a **long-running job** that takes an approved spec, plans the
work, schedules bounded agent executions, verifies results, diagnoses
failures, repairs defects, replans invalid assumptions, escalates hard
reasoning to Claude Code, checkpoints continuously, survives process
interruption, and continues until the approved work is verified complete or
honestly blocked. SpecBridge owns state, policy, scheduling, budgets, and
completion; agents are replaceable ephemeral workers.

Additive throughout: no persisted schema version moved, no public contract
changed meaning, and v1.0/v1.1 workspaces load with no migration. New
schema families (job state 1.0.0, job graph 1.0.0, job checkpoint 1.0.0)
and new SBO codes (SBO025–SBO038) are appended, never renumbered.

### Added

- **Persistent jobs** under `.specbridge/jobs/<jobId>/` — versioned,
  atomic, workspace-confined state; append-only graph/plan/agent-result/
  event history; compact checkpoints; a 13-status fail-closed state machine
  in which `RUNNING → REPAIRING` deliberately does not exist (a failure
  must pass through `DIAGNOSING` first).
- **Runtime execution graphs** independent of the approved `tasks.md`: one
  node per open required leaf task, explicit dependencies, per-node plan
  revisions with supersession lineage, and graph-revision node supersession
  that carries attempt history and replan budgets forward. Runtime ids
  never touch `.kiro`, and no replan can change approved intent — the
  replanner must declare impact AND a deterministic keyword screen checks
  the replacement regardless of the declaration.
- **A deterministic scheduler** (`scheduleNext`): one pure function from
  (job, graph, policy, workers, clock) to the single next action —
  reproducible in tests and quoted verbatim in the audit trail. Sequential
  source mutation (`maxConcurrentTasks` fixed at 1) matches the evidence
  model; the field exists so future parallelism is a config change.
- **Agent roles and tiers**: CLASSIFIER / PLANNER / CRITIC / DIAGNOSER /
  REPLANNER (read-only) and EXECUTOR (the only writing role) across
  LOCAL_SMALL and LARGE_AGENT reasoning tiers with LOCAL/PAID cost tiers.
  Routing is **local-first, escalate-on-evidence** with sticky, recorded
  escalation reasons — a paid worker is never selected silently, and
  `escalation: "manual"` stops for the user instead.
- **Deterministic complexity assessment**: documented signal classes
  (public API, architecture, security, distributed semantics, concurrency,
  persistence, new dependencies, failure/replan history) scored into
  LOW/MEDIUM/HIGH routing classes; hard signals force HIGH; a local
  classifier may only RAISE the class.
- **Structured local-agent contracts** for all five reasoning roles:
  versioned zod schemas plus strict JSON Schemas for constrained decoding,
  complete-response validation (no substring extraction, no silent
  repair), one bounded correction round, and conversion into the existing
  v1.1 execution-plan lifecycle. No schema has a field for
  chain-of-thought.
- **LocalModelManager** — a managed llama.cpp server lifecycle: validated
  executable/model paths, loopback-only binding (not configurable;
  reserved flags rejected in `extraArgs`/`executableArgs`), observed
  /health readiness, bounded log capture, idle shutdown, graceful stop,
  and bounded LAZY restarts. One server serves all roles; a local model
  crash is a worker failure, never a task failure.
- **`specbridge orchestrate run <spec>`** — the foreground persistent
  driver (Ctrl+C checkpoints; `--resume` continues the SAME job), plus
  `jobs`, `job`, `node-plan`, `review-plan`, `answer`, `cancel-job`, and
  `--dry-run`/`--json`. Executor dispatches run through the UNCHANGED
  evidence pipeline: git snapshots, trusted verification, verified-only
  checkbox completion — job orchestration adds no second completion path.
- **`specbridge local-model doctor|status`** — read-only diagnostics; no
  spawn, no inference.
- **MCP**: `job_list`, `job_read`, `job_cancel` — thin and deliberately
  narrow; jobs are driven by the standalone process, never from MCP.
- **Plugin**: `/specbridge:orchestrate` — inspect jobs, surface gates,
  relay human decisions; the interactive session never launches the
  orchestrator or nested agents (the standalone orchestrator invoking the
  Claude Code runner is the designed worker path).
- **Configuration** (additive, defaulted): `localInference` block and
  `orchestration.jobs` policy (routing, plan review `high-risk|always|
  auto`, escalation mode, complexity thresholds, budgets incl. optional
  reported-usage cost/token ceilings). Config migration carries both
  blocks; the v1/v2 schema versions are unchanged.

### Fixed

- `TaskRunRequest` gained additive `extraObservations` so a repair dispatch
  can hand the executor the latest diagnosis as bounded, data-only
  repository observations; absent, the prompt is byte-identical.

## 1.1.0

Governed agent orchestration. v1.0 controlled **what** may be executed and
whether a result counts as complete; v1.1 governs **how** an agent gets
there — with a bounded, observable, resumable control loop.

This is an additive minor release. Every v1.0 contract is unchanged, no
persisted schema version moved, and a v1.0 workspace keeps working with no
migration.

### Added

- **`@specbridge/orchestration`** — a reusable domain package holding the
  whole capability: a 12-phase fail-closed state machine with a per-phase
  allowed-action table, intent and clarification contracts, the
  execution-plan lifecycle, an 18-category failure taxonomy, the
  deterministic retry/repair/replan decision engine, budgets, progress
  fingerprinting, and versioned persistence. CLI, MCP, and plugin skills are
  thin adapters over it.
- **Intent assessment** with four strictly distinct outcomes (`READY`,
  `NEEDS_CLARIFICATION`, `REJECTED`, `BLOCKED`). The host agent submits a
  structured assessment; SpecBridge validates it against approvals,
  staleness, task existence, lock ownership, and hard product boundaries,
  and may override it — always towards caution, never towards `READY`.
- **Structural provenance instead of confidence scores.** A `READY` claim
  resting on `inferred`, `unknown`, or `conflicting` facts is downgraded
  automatically. No numeric model-confidence value is used as a safety
  mechanism anywhere.
- **Bounded clarification** with durable structured decisions: required
  justification per question, refused duplicates and re-asks, bounded rounds,
  supersession, and an explicit refusal to resolve an ambiguity by inference.
  A decision never amends an approved `.kiro` document — the tooling routes
  spec-changing answers back to re-authoring and human approval.
- **Execution plans** bound to the task fingerprint, approved stage hashes,
  the Git baseline, and the policy fingerprint, with staleness detection and
  a **plan review gate** (`review` by default, `auto` and `disabled` as
  explicit opt-ins). A review is bound to the exact plan hash.
- **Material-change replanning:** a changed goal, non-goal, constraint,
  subsystem, strategy, or step set re-opens review; a reorder or a wording
  fix does not.
- **Deterministic no-progress detection** from normalized failure
  fingerprints, diff fingerprints, plan revision, and action category —
  never natural-language similarity.
- **Explicit budgets** for iterations, repair cycles, replans, transient
  retries, no-progress cycles, clarification rounds, elapsed time, and event
  history. Each exhaustion names the budget, preserves evidence, and leaves
  the task incomplete.
- **`specbridge orchestrate status | show | explain | policy show |
  policy validate | events | phases`** — deterministic, read-only, JSON-capable
  inspection. No orchestrate command invokes a model or advances a run.
- **Ten MCP tools** (`orchestration_status`, `_begin`, `_assess_intent`,
  `_clarify`, `_resolve_clarification`, `_submit_plan`, `_review_plan`,
  `_record_action`, `_checkpoint`, `_finalize`) with versioned schemas,
  annotations, bounds, and stable `SBMCP021`–`SBMCP030` error mapping over
  the `SBO###` domain registry.
- **`/specbridge:develop`** — the governed Claude Code workflow.
  `/specbridge:implement` keeps its historical direct lifecycle unchanged;
  `/specbridge:continue` is now orchestration-aware.
- **Honest resume and compact checkpoints:** a resumed run keeps its real
  identity, counters, and history; a finalized run reports its outcome and
  refuses to continue; a stale plan is never executed silently.
- **`orchestration` configuration block** (additive; accepted by both the v1
  and v2 config schemas, no migration required), plus
  `contracts/orchestration-contract.json` and three new versioned sidecar
  schemas (`orchestrationState`, `executionPlan`, `orchestrationCheckpoint`).
- **StepRelay readiness fixture and scenarios A–L** covering ambiguity,
  approved-spec conflict, planned implementation, implementation defect,
  transient failure, no-progress, stale plan, repository divergence,
  interruption, auto-approval refusal, prompt injection, and budget
  exhaustion.
- Documentation: [agent orchestration](docs/orchestration/agent-orchestration.md),
  [intent and clarification](docs/orchestration/intent-clarification.md),
  [execution planning](docs/orchestration/execution-planning.md),
  [retry and repair](docs/orchestration/retry-and-repair.md),
  [ReAct/TAO execution discipline](docs/orchestration/react-tao-execution.md),
  [orchestration recovery](docs/orchestration/orchestration-recovery.md),
  [configuration](docs/orchestration/configuration.md), and
  [enforcement boundaries](docs/orchestration/enforcement-boundaries.md).

### Unchanged (and asserted by tests)

- `.kiro` remains the source of truth. No orchestration metadata is written
  into any Kiro document; byte-identical round trips still hold.
- Stage approval remains human-only. There is no agent-accessible approval
  path, and the MCP catalog is tested against a forbidden-name list.
- `task_complete` remains the sole completion authority. Orchestration
  refuses to mark a task complete without a `verified` or
  `manually-accepted` evidence status it actually returned.
- No arbitrary shell, filesystem, or Git tool; no automatic Git mutations; no
  automatic provider fallback during implementation; no nested coding agent
  from the plugin; no hidden network access; no telemetry.
- No private chain-of-thought is persisted. No schema has a field for it —
  see [why](docs/orchestration/react-tao-execution.md#why-no-chain-of-thought-is-stored).

### Notes

- The two rules that are only *skill-guided* rather than enforced — that the
  user was genuinely asked before a plan review is recorded, and that a
  clarification question is genuinely load-bearing — are documented as such
  in [enforcement boundaries](docs/orchestration/enforcement-boundaries.md).
  No Claude Code hooks are used; the rationale is documented there too.

## 1.0.0

The first stable release. The primary promise is unchanged — start in Kiro,
continue anywhere, return whenever you want — and it is now backed by
documented, machine-checked contracts.

### Stable (frozen for v1.x under [the versioning policy](docs/stability/versioning-policy.md))

- CLI command and exit-code contract
- Kiro-compatible filesystem contract (`.kiro/steering`, `.kiro/specs`,
  byte-identical no-op round trips, surgical checkbox updates)
- SpecBridge sidecar schemas (config, spec state, approvals, runs, evidence,
  policies, templates, extensions, registries)
- Verification rule IDs `SBV001`–`SBV026` and the report/diagnostic schemas
- Runner adapter contract (operations, capability keys, support levels,
  normalized events/results/errors)
- Template manifest and extension protocol (`1.0.0`)
- MCP server name, tool names, resource URIs, and prompt names
- Claude Code plugin and marketplace namespace

Every stable contract has a machine-readable snapshot under
[`contracts/`](contracts/), enforced in CI by `pnpm check:public-contracts`.

### Added

- Unified state-migration framework and `specbridge migrate status | plan |
  apply | verify` (hash-bound plans, dry-run, atomic writes, backups,
  rollback, and a migration report under `.specbridge/migrations/<id>/`)
- `specbridge state validate` — read-only diagnosis across every persisted
  state family
- Recovery planning and hash-bound `specbridge state recover --plan` /
  `--apply <id>` (acknowledgement-token gated; corrupted originals are
  preserved in quarantine, never destroyed), plus `specbridge doctor
  --repair-plan`
- `specbridge setup` — preview-first, safe workspace initialization
- Public contract inventory ([docs/stability/public-contracts.md](docs/stability/public-contracts.md))
  and versioning/deprecation policy
- Large-repository performance suite and documented budgets
  ([docs/performance.md](docs/performance.md))
- Consolidated threat model ([docs/security/threat-model.md](docs/security/threat-model.md))
  and a deterministic repository security scan (`pnpm check:security`)
- Cross-platform release packaging and a tag-driven release workflow
- npm package `specbridge-cli` (the command remains `specbridge`)
- Maintained example projects and reproducible offline demo scripts
- Public release documentation, community files, and issue/PR templates

### Changed

- Documentation reorganized around a hub ([docs/README.md](docs/README.md))
  without breaking existing links
- Release assets carry stable manifests and `SHA256SUMS`; the npm package
  uses an explicit `files` allowlist
- `specbridge config migrate` is deprecated in favor of `specbridge migrate`;
  it keeps working and prints a deprecation notice to stderr (removal no
  earlier than v2.0.0)
- GitHub Action metadata aligned to `1.0.0`
- Template and extension compatibility ranges widened to `<2.0.0`

### Security

- Migration and recovery actions are hash-bound and refuse stale plans
- Release assets are checksum-verified
- Archive, symlink, and path-traversal protections are consolidated and
  documented; credentials and provider environments remain isolated
- Extension and MCP protocol limits are enforced

### Limitations

- Extension process isolation is **not** an operating-system sandbox
- Checksums verify integrity, **not** publisher identity
- Released binaries may be unsigned
- Model-assisted authoring and execution remain nondeterministic
- Antigravity integration remains experimental

## 0.7.1

Added:

- Versioned extension manifest (`specbridge-extension.json`, schema 1.0.0)
  covering five stable extension kinds: template-provider, analyzer,
  verifier, exporter, and runner.
- Publishable extension SDK (`@specbridge/extension-sdk`): manifest,
  protocol, permission, and diagnostic schemas; a stdio extension server
  with input/output validation, cancellation, and clean shutdown; typed
  helpers per kind; in-process testing utilities.
- Out-of-process extension protocol (JSON-RPC 2.0 over JSON Lines, protocol
  1.0.0): initialize handshake with identity and capability validation,
  invocation, cancellation, shutdown, structured errors, bounded messages.
- Explicit extension permission model (specRead, repositoryRead,
  repositoryWrite, network, childProcess, explicit environment-variable
  names) with permission-aware input boundaries per kind.
- Permission-hash acceptance: enabling requires
  `--accept-permissions <hash>`, deterministically bound to the extension
  ID, version, manifest hash, and normalized permissions; any manifest
  change invalidates prior grants (SBE018).
- Analyzer extensions (`spec analyze --extension <id>`, repeatable) with
  namespaced rule IDs (`<extension-id>/<RULE>`) that never overwrite
  built-in diagnostics.
- Verifier extensions via explicit per-spec policy (`extensionVerifiers`);
  results land in the verification report and reach the gate only through
  the new built-in rollup rule SBV026 (required failure fails, optional
  warns).
- Exporter extensions (`spec export --extension <id> --output <dir>`):
  candidate files only, previewed by default, written atomically after
  explicit `--yes`, never overwriting, recorded append-only.
- Runner extensions behind an extension-runner proxy implementing the
  frozen v0.6.0 `AgentRunner` contract, wired through a new
  backward-compatible `"runner": "extension"` profile variant (disabled by
  default, preview support level, never auto-selected).
- Template-provider extensions: data-only v0.7.0-format template packs
  contributed to the catalog as `extension:<extension-id>/<template-id>`,
  with ambiguity errors instead of shadowing.
- Local extension installation from directories and archives (atomic,
  versioned side-by-side, disabled after install, zero code execution),
  plus explicit enablement/disablement and recoverable uninstall.
- Extension conformance framework (`extension conformance --yes`) with
  common protocol checks and kind-specific checks, recorded per install.
- Deterministic extension packaging
  (`<id>-<version>.specbridge-extension.zip`, store-method, fixed
  timestamps, sorted entries, regenerated checksums, printed SHA-256).
- Local (built-in + `--file`) and HTTPS registry indexes with a validated
  atomic cache under `.specbridge/registry-cache/` and explicit
  `registry update <name> --network`.
- Extension and registry CLI command groups (`specbridge extension …`,
  `specbridge registry …`) including scaffold for every kind.
- Seven read-only MCP discovery tools: extension_list, extension_search,
  extension_show, extension_doctor, registry_list, registry_search,
  registry_show (37 MCP tools total).
- Claude Code `/specbridge:extensions` Skill (discovery only).
- Generated extension gallery (`docs/extensions.md`) with CI drift check,
  repository registry index (`registry/`), and five maintained reference
  extensions under `examples/extensions/`.
- Stable error code registries: SBE001–SBE030 (extensions) and
  SBR001–SBR015 (registry), every error with remediation.

Security:

- No in-process third-party code execution: no dynamic import of installed
  extensions, no `eval`, no `Function`; the only executable surface is the
  declared entrypoint launched as `node <entrypoint>` (argv array, no
  shell) in a child process.
- No package-manager lifecycle scripts: install/postinstall/prepare
  declarations in a bundled package.json are validation errors and are
  never executed.
- No automatic enablement, no automatic updates, no automatic registry
  network access; remote installs and updates require an explicit
  `--network`.
- Manifest-bound permission grants with stale-grant detection.
- SHA-256 archive and per-file integrity checks; installed files are
  revalidated after extraction.
- Symlink and path-traversal rejection everywhere packages are read,
  extracted, installed, or exported.
- Bounded archive extraction (50 MB archive, 100 MB extracted, 1,000
  files) with CRC verification and declared-size enforcement.
- Protocol stdout isolation: stdout is protocol-only, logs go to stderr,
  corruption terminates the process without crashing SpecBridge.
- Startup (10 s) and operation (default 5 min) timeouts, cooperative
  cancellation, SIGTERM→SIGKILL cleanup, bounded stdout/stderr capture.
- Sanitized child environment with an explicit variable allowlist; granted
  secret values are redacted from retained logs.
- Extensions cannot approve stages, complete tasks, change evidence, or
  disable built-in protected-path rules.

Limitations:

- Process isolation and permission declarations are safety boundaries and
  audit mechanisms, not an OS sandbox; enabled executable extensions run
  as local code with the user's operating-system permissions.
- Checksums prove integrity, not publisher identity.
- Registry listing is not endorsement.
- Registry archive URLs in the repository index use a documented
  placeholder host until a real hosted registry exists.

Deferred to v1.0:

- Stable publishing workflow and release automation.
- Cross-platform installation verification.
- Final security audit and performance hardening.
- Schema migration guarantees and public launch assets.

## 0.7.0

Added:

- Versioned template manifest (`specbridge-template.json`, schema 1.0.0)
  with strict validation: template IDs, semver versions, kinds, workflow
  modes, file sets, typed variables (string/boolean/integer/enum with
  constraints), compatibility ranges, and safe optional metadata.
- Restricted deterministic template renderer: `{{variableName}}`
  substitution only — one pass, no expressions, no conditionals, no
  includes, no environment access, values never re-scanned.
- Built-in template catalog bundled with SpecBridge (immutable at runtime,
  embedded at build time so every bundle ships it).
- Project-local template packs under `.specbridge/templates/<id>/`.
- Deterministic local template search over IDs, display names,
  descriptions, and tags (exact ID > ID prefix > exact tag > display-name
  token > description token; no model, no network).
- `template list | search | show | validate | preview | apply` CLI
  commands; preview and `apply --dry-run` share the exact rendering path
  with apply and write nothing.
- Local template installation and uninstallation
  (`template install <local-path>` / `template uninstall project:<id>`):
  validated, script-free, atomic (temp directory + rename), never
  overwriting; built-in templates cannot be uninstalled.
- `template scaffold` — generates a complete community-ready template pack
  (manifest, README with validation instructions and a contribution
  checklist, plain-Markdown template files); no TypeScript required.
- `spec new --template <reference> [--var key=value]`, delegating to the
  same template application service (existing non-template `spec new`
  behavior unchanged).
- Append-only template operation records in
  `.specbridge/template-records.jsonl` (apply/install/uninstall/scaffold)
  storing variable names and rendered-content hashes, never values.
- MCP template tools: `template_list`, `template_search`, `template_show`,
  `template_preview` (read-only), and `template_apply` (candidate-hash
  bound, acknowledgement-gated). Install/uninstall/scaffold remain
  CLI-only.
- Claude Code `/specbridge:templates` Skill: list/search/show/preview, and
  apply only after explicit confirmation with the previewed candidate
  hash.
- Generated template gallery in `docs/templates.md`
  (`pnpm generate:template-gallery`) with a CI drift check
  (`pnpm check:template-gallery`); built-in packs are likewise embedded via
  `pnpm generate:builtin-templates` with `pnpm check:builtin-templates`.
- Template contribution workflow and documentation
  (`docs/creating-templates.md`, `docs/template-manifest.md`,
  `docs/template-rendering.md`, `docs/template-security.md`,
  `docs/template-installation.md`, `docs/template-contribution-guide.md`).
- Stable template error codes SBT001–SBT025 with remediation in every
  message.

Built-in templates:

- REST API (`rest-api`)
- CLI tool (`cli-tool`)
- Database migration (`database-migration`)
- Authentication (`authentication`)
- Background job (`background-job`)
- Event-driven service (`event-driven-service`)
- Bugfix regression (`bugfix-regression`)
- Performance optimization (`performance-optimization`)
- Security hardening (`security-hardening`)
- Refactoring (`refactoring`)

Security:

- No executable template code, lifecycle scripts, or shell execution.
- No environment interpolation and no network access anywhere in the
  template system (no remote registry, no URL or npm installation).
- Path traversal and symlinks rejected; targets restricted to the exact
  Kiro spec file set; variables never allowed in target paths.
- One-pass rendering: substituted values are never re-rendered.
- Bounded packs and output (20 files, 256 KB manifest, 1 MB per template
  file, 5 MB per pack, 1 MB per rendered document).
- Candidate-hash binding and an explicit acknowledgement for MCP apply.
- Atomic installation and atomic spec creation; existing specs are never
  overwritten; generated stages always start unapproved.

Deferred to v0.7.1:

- Extension/plugin SDK, runner SDK distribution, analyzer/verifier/exporter
  SDKs.
- Remote extension registry and community ecosystem index.

## 0.6.1

Added:

- Gemini CLI adapter (`gemini-cli`, built-in profile `gemini-default`):
  headless invocation through the frozen v0.6.0 runner contract with
  bounded read-only capability detection (`--version`/`--help` token
  probes; never a model request, login, or trusted-folder change).
- Capability-gated Gemini authoring, task execution, and resume: authoring
  through the plan approval mode or a read-only tool allowlist; task
  execution only when the installed CLI proves a bounded edit policy
  (auto_edit plus tool allowlist or sandbox) without arbitrary shell
  access; resume only by explicit session UUID with session-identity
  verification.
- OpenAI-compatible authoring adapter (`openai-compatible`, built-in
  profile `openai-compatible-local`): production stage generation and
  refinement against chat-completions and responses API styles.
- Configurable structured-output modes (`json-schema`, `json-object`,
  `strict-json-prompt`) with complete-response Zod validation in every
  mode and an explicit, warned, opt-in-only downgrade
  (`allowStructuredOutputFallback`).
- Experimental Antigravity CLI capability adapter (`antigravity-cli`,
  built-in profile `antigravity`): executable/version/documented-capability
  detection and transparent diagnostics only — no automation of any kind.
- Read-only MCP runner diagnostic tools: `runner_list` (paginated),
  `runner_show`, `runner_doctor`, `runner_matrix` — thin adapters over the
  same shared runner services the CLI uses.
- Claude Code `/specbridge:runners` Skill: list profiles, explain
  categories and boundaries, diagnose one profile, and recommend
  compatible profiles — driven exclusively by the MCP diagnostic tools.
- Additional provider conformance fixtures: process-level fake Gemini and
  Antigravity executables and a fake OpenAI-compatible loopback server
  covering authentication, quota, rate-limit, timeout, cancellation,
  oversized output, malformed/prose/fenced output, protected-path writes,
  resume identity, and redirect scenarios — CI needs no real provider and
  no network.
- Explicit remote endpoint and redirect protections in the shared HTTP
  client: opt-in bounded redirect following with cross-origin
  authorization stripping, HTTPS-downgrade rejection, scheme validation,
  and recorded safe redirect metadata (default behavior unchanged:
  redirects rejected).

Changed:

- The runner capability matrix (CLI `runner matrix`, MCP `runner_matrix`,
  README, docs) includes Gemini, OpenAI-compatible, and Antigravity and is
  generated from one shared implementation in @specbridge/runners.
- Provider diagnostics are available through both the CLI and MCP.
- The plugin bundle includes the runner inspection workflow (nine skills).
- Network-backed authoring reports exact data boundaries (endpoint, API
  style, model, structured-output mode, documents, input size, whether a
  network request will occur) before execution; dry-run performs no
  request.
- Additive contract extensions (no existing field, value, or code
  changed): optional `AgentRunner.declaredSupportLevel` (absent =
  production, the v0.6.0 behavior) and new `AgentRunnerKind` values
  (`gemini-cli`, `openai-compatible`, `antigravity-cli`). All v0.6.0
  contract snapshot tests pass unchanged.

Security:

- Gemini YOLO mode is forbidden at three layers (config schema enum plus
  config-wide fragment rejection, argv assembly, pre-spawn assertion).
- Gemini task execution requires a bounded safe edit policy; shell tools
  are excluded from every allowlist and the policy is never relaxed.
- Antigravity TUI and PTY automation are forbidden (no PTY library, no
  keystroke injection, no ANSI parsing — enforced by tests).
- API-key values are never stored: profiles hold an environment-variable
  NAME only; the value is read at request time, redacted from every
  retained byte, and never logged or passed to verification commands.
- Authorization is never forwarded across origins on redirects, and
  HTTPS-to-HTTP downgrades are rejected.
- Generic API runners cannot modify source (authoring-only by capability;
  task execution is rejected before any request).
- No new provider is selected implicitly: all new profiles default
  disabled, network profiles require explicit selection, experimental
  profiles require explicit opt-in.
- Provider claims remain non-authoritative: Git evidence and trusted
  verification decide task completion, whatever runner executed.

Deferred to v0.7:

- templates and the template registry
- plugin SDK and runner extension SDK distribution
- analyzer SDK and verifier SDK
- extension registry and community ecosystem

## 0.6.0

Added:

- Capability-driven runner platform: core orchestration selects and gates
  runners by DECLARED CAPABILITIES (17 stable keys), never by provider
  names. Runner categories (`agent-cli`, `model-api`, `mock`,
  `experimental`) and support levels (`production`, `preview`,
  `experimental`, `unavailable`, `incompatible`) are explicit everywhere.
- Versioned, FROZEN runner adapter contract for v0.6.1
  (docs/runner-adapter-contract.md) with snapshot tests guarding categories,
  support levels, operation names, capability keys, normalized outcomes,
  normalized error codes, event types, and required adapter methods — plus a
  minimal-adapter test proving new providers register without core changes.
- Operation-specific capability validation: `stage-generation`,
  `stage-refinement`, `task-execution`, `task-resume`, `model-list`,
  `runner-test`, each with required capabilities and (for execution) a
  required safe boundary (`sandbox` OR the documented `toolRestriction`
  equivalent). Incompatible selections stop BEFORE any process spawn, HTTP
  request, run record, or file change, and list the missing capabilities and
  compatible configured profiles.
- Normalized provider events (17 types, size-limited flat payloads, no
  reasoning content), normalized execution results (13 outcomes), normalized
  runner errors (24 stable codes with safe messages, remediation, and
  retryability), and normalized usage/cost metadata (cost is
  provider-reported, configured-estimate, or unavailable — never computed
  from hardcoded pricing; local Ollama reports `unavailable`, not zero).
- Versioned runner profiles (configuration schema 2.0.0): named
  configurations of implementations (`codex-default`, `codex-fast`,
  `ollama-qwen`, …) with per-profile executable/endpoint, model, timeout,
  sandbox, and output limits; unique names; unknown implementations
  rejected.
- Configuration migration tools: `specbridge config doctor` (read-only) and
  `specbridge config migrate --dry-run|--apply` (atomic write, recoverable
  `config.v1.backup.json`, validated result). The v1 schema remains fully
  readable before explicit migration; migration preserves the Claude Code
  default behavior and trusted verification commands, adds Codex/Ollama
  profiles DISABLED, and creates no credentials.
- Deterministic runner selection with precedence explicit `--runner` →
  operation default → global default, a capability-checked selection plan
  (`--show-runner-plan`, dry-run output), and network-policy enforcement
  (network-backed profiles are never selected implicitly).
- Explicit authoring fallback policy: per-operation chains
  (`fallbacks.stageGeneration/.stageRefinement`), bounded correction and
  transport retries, and hard stop conditions (auth/permission/config
  failures, cancellation, quota, repository modification, real results).
  Disabled by default; never during task execution or resume.
- Generated runner capability matrix: `specbridge runner matrix`
  (`--json`, `--markdown`) from registered runner metadata; plus
  `runner show <profile>`, `runner test <profile> [--network]`,
  `runner conformance <profile> [--network]`, and
  `runner models <profile>`.
- Reusable runner conformance framework (detection, structured-output,
  process-control, stage-generation, stage-refinement, task-execution,
  resume) with capability-derived applicability; a runner is production only
  when every applicable group passes. Conformance uses throwaway fixture
  workspaces, requires `--network` for real-provider invocations, and runs
  fully against fake providers in CI.
- Production Codex CLI runner (`codex-cli`): read-only probes for
  version/help/`exec --help`/`login status` (never a model request, never
  credential files), JSONL event capture and normalization, JSON Schema
  structured output with strict validation, read-only sandbox for authoring,
  workspace-write sandbox for task execution, explicit-session resume
  (`codex exec resume <id>`, never "latest"), and full failure
  classification (auth, permission, sandbox, quota, rate limit, timeout,
  cancellation, output limits).
- Production Ollama authoring runner (`ollama`): loopback-default native
  HTTP API with strict URL safety (no credentials in URLs, no file/ftp
  schemes, HTTPS-by-default for remote endpoints with a labeled insecure
  development override, redirects never followed), model listing without
  inference, schema-validated non-streaming structured output at
  temperature 0, ONE bounded correction retry, input/output size limits,
  thinking-content redaction, and task execution refused by capability
  before any request.
- Append-only per-invocation attempt records under
  `.specbridge/runs/<run-id>/attempts/<attempt-id>/`: capability snapshot,
  operation, local/network boundary, model, normalized events and result,
  process observation, error classification, and fallback lineage. Failed
  attempts (including invalid structured-output candidates) are retained.
- Fake-provider test infrastructure: a process-level fake Codex CLI
  (26 scenarios) and a real loopback fake Ollama HTTP server (20 scenarios);
  CI needs no real providers, no network, no models, no credentials.

Changed:

- The existing Claude Code runner now implements the shared capability
  contract (category `agent-cli`, declared capability set, detection-derived
  support level) with its v0.3–v0.5 behavior, process safety, permission
  modes, resume, structured-output validation, and configuration semantics
  preserved unchanged.
- Runner selection validates operation capabilities before execution; task
  execution is restricted to compatible agent CLI runners and model API
  runners are authoring-only.
- Provider output is normalized (events, results, errors, usage) before it
  enters shared orchestration; run records now reference per-attempt
  capability snapshots and attempt metadata.
- The shared prompt contract (v1.1.0) parameterizes repository access:
  agent CLIs receive read-only repository tools for authoring; model APIs
  receive an explicit no-repository-access variant. The same core safety
  sections appear for every provider (tested for semantic equivalence).
- `runner list`/`doctor`/`show` are profile-based; the v0.3 `unsupported`
  stub registrations (codex/ollama/openai-compatible) were replaced by real
  disabled-by-default profiles, and deferred providers are no longer
  registered at all.

Security:

- No provider credentials stored; credential-looking configuration keys are
  rejected; no credential-file parsing anywhere.
- No automatic paid or network-provider selection; no automatic
  task-execution fallback or provider switching.
- No unrestricted Codex execution mode (`danger-full-access`, bypass flags,
  and repo-check skips rejected at three layers).
- No source editing by Ollama (no repository access by construction).
- No provider claims treated as task evidence; Git snapshots and trusted
  verification remain the only completion authority.
- No shell interpolation for runner commands (argv arrays only, both
  schemas).
- Explicit local and network data boundaries in every plan and attempt
  record; provider reasoning content never exposed; provider event payloads
  size-limited.

Deferred to v0.6.1:

- Gemini CLI runner.
- OpenAI-compatible authoring runner.
- Antigravity capability adapter.
- MCP runner diagnostics.
- Claude Code runner-management Skill (`/specbridge:runners`).

Deferred to v0.7:

- Templates, plugin SDK, runner extension SDK distribution, analyzer and
  verifier SDKs, extension registry, community ecosystem.

## 0.5.0

Added:

- Local stdio MCP server (`specbridge mcp serve`) built on the official
  `@modelcontextprotocol/sdk` 1.29.0 (pinned; stable protocol baseline
  2025-11-25): 21 typed tools with versioned Zod input/output schemas,
  annotations, and the stable SBMCP001–SBMCP020 error envelope; 7 read-only
  resources (`specbridge://…`); 4 workflow prompts for non-Claude clients;
  bounded structured responses (pagination cursors, 1 MB documents, 2 MB
  responses, 500-diagnostic cap); `specbridge mcp doctor|manifest|tools`.
- Direct interactive task execution: `task_begin` → the CURRENT host session
  edits source → `task_complete` (plus `task_abort`), reusing the v0.3 Git
  snapshots, trusted verification commands, evidence evaluation, append-only
  evidence, and the verified-only surgical checkbox update. Model-reported
  fields are recorded as claims, never proof.
- Interactive execution locking (`.specbridge/locks/interactive-task.lock`):
  atomic acquisition, heartbeats, crash-tolerant staleness diagnosis, and
  the explicit `specbridge run recover-lock [--remove] [--json]` recovery
  command. Ambiguous or actively held locks are never removed.
- Candidate stage authoring over MCP: `spec_stage_validate` (deterministic
  analysis + diff + approval effects + candidate hash, read-only) and
  `spec_stage_apply` (atomic, hash-bound to the reviewed bytes, dependent
  approvals invalidated per workflow rules, append-only
  `interactive-authoring` run record, no force option). Preview-first
  `spec_create` (apply: false renders without writing).
- Self-contained Claude Code plugin
  (`integrations/claude-code-plugin/specbridge`): bundled `dist/cli.cjs` and
  `dist/mcp-server.cjs` (no node_modules, no workspace resolution, no
  monorepo paths), POSIX + Windows CLI wrappers, eight namespaced skills
  (`/specbridge:doctor·status·new·author·approve·implement·continue·verify`),
  third-party license report, and a SHA-256 checksum manifest.
- Repository-local plugin marketplace (`.claude-plugin/marketplace.json`,
  strict mode) so `/plugin marketplace add HelloThisWorld/specbridge` works
  straight from a clone.
- Isolated plugin bundle verification (`pnpm verify:plugin-bundle`): copies
  the built plugin to an isolated space-containing directory, runs the
  bundled CLI and wrappers against an outside fixture project, performs a
  real MCP stdio handshake, and proves no monorepo path is required — plus
  deterministic `pnpm validate:plugin` and the reproducible release ZIP
  artifact `dist/specbridge-claude-plugin-0.5.0.zip`.

Changed:

- Claude Code plugin task execution now uses the current session
  (task_begin/task_complete) instead of starting a nested Claude process;
  the v0.3 runner workflow remains fully supported from the standalone CLI.
- Shared core APIs are exposed consistently through CLI and MCP; the MCP
  server is a thin typed adapter with no duplicated workflow, verification,
  Git, evidence, approval, or Markdown-writing logic
  (docs/cli-mcp-parity.md).
- Run schemas now distinguish runner execution, interactive execution,
  interactive authoring, and deterministic verification (new optional
  `kind` values plus `lifecycleStatus`, `host`, and `abortReason`; every
  v0.3 record keeps validating unchanged).

Security:

- No arbitrary filesystem, shell, or Git MCP tool; no user-supplied
  executable or working directory; one pinned project root per server
  process.
- No model-controlled stage approval: approval is not an MCP tool or
  prompt, and the plugin approve skill sets disable-model-invocation.
- No nested Claude invocation from the plugin or MCP handlers — enforced by
  automated content scans and tests.
- No stdout logging under stdio (structured stderr only, verified
  process-level); no secrets, prompts, or file contents in logs; run views
  and resources never expose raw prompts or runner output;
  `.specbridge/config.json` is only ever reported as a redacted status.
- Candidate hash binding prevents validation/apply substitution; there is
  no force option.
- State-changing MCP operations serialize behind a per-project write mutex,
  with the repository lock file guarding cross-process interactive runs.
- No automatic Git commit, push, reset, stash, or rollback — including
  after protected-path violations, which are reported instead.

Deferred (documented on the roadmap, not claimed):

- production multi-runner support (v0.6)
- templates, plugin SDK, extension registry, community ecosystem (v0.7)
- remote MCP transports (HTTP/SSE/WebSocket), MCP OAuth, cloud hosting
- public marketplace submission; npm publication of the packages
- `spec sync` / `spec export`, SARIF output, Action PR comments

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
