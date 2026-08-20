# Survival Runtime (vNext.1)

The Survival Runtime is the layer that lets a long-horizon SpecBridge job
outlive everything transient about its execution:

- an agent process terminates mid-task;
- a Claude Code (or any provider) session disappears;
- a model context window fills up;
- the active context is compacted, repeatedly;
- execution resumes in a new process;
- execution is handed to a different provider.

Two invariants define the design:

> **Agents and model sessions are disposable workers. SpecBridge owns the
> durable job state.**

> **Context windows are disposable working memory. SpecBridge state is
> durable memory.**

## Runtime ownership

| Owner | State |
| --- | --- |
| SpecBridge | Jobs, Tasks, ExecutionAttempts, Checkpoints, decisions, failed approaches, the execution ledger |
| Git / workspace | Source-code state |
| Run directories (`.specbridge/runs/`) | Raw execution evidence |
| Providers | Their own sessions, conversations, and native compaction — **disposable working memory, never canonical** |

Deleting every provider session and conversation deletes nothing SpecBridge
needs to continue a task. That independence is exercised directly by tests
(`tests/orchestration/survival-runtime.test.ts`, "Test F").

## Job / Task / Attempt

Three concepts, deliberately distinct:

```text
Job               the long-horizon user objective          jobs/state.ts (JobState)
  Task            durable intended work (one graph node,   jobs/state.ts (JobNode)
                  bound to one approved task)
    Attempt       ONE temporary execution of that Task     survival/state.ts (TaskAttempt)
                  by ONE worker/provider
```

A Task and an ExecutionAttempt are **not** the same thing. The Task is what
must get done; an attempt is one disposable try. One task accumulates many
attempts across workers, sessions, and providers:

```text
Task: Implement workflow validation
  Attempt #1  fake-provider-a   INTERRUPTED  (process died)
  Attempt #2  fake-provider-b   COMPLETED    (resumed from checkpoint)
```

Attempt records live at `.specbridge/jobs/<jobId>/task-attempts/<attemptId>.json`.
They are written **when the dispatch starts** (status `RUNNING`), finalized
when it ends, and are append-only history: a retry or a provider switch
creates a new attempt with `resumedFromAttemptId` lineage — it never
rewrites an old one.

### Crash recovery

An attempt persisted as `RUNNING` whose process later proves absent is
reconciled — visibly, never silently — at resume:

```text
RUNNING ── process disappears ──▶ INTERRUPTED ── resume ──▶ new Attempt
```

`resumeJob` performs this reconciliation (alongside the existing node/job
status reconciliation) and reports the interrupted attempt ids. Tasks are
never left stuck in `RUNNING`.

## Structured checkpoints

A checkpoint is **not** a natural-language summary. It is a schema
(`survival/state.ts`, `taskCheckpointSchema`) another worker — or another
provider — can continue from without the previous worker's conversation:

- `objective`, `pinned` (task contract, acceptance criteria, constraints,
  invariants),
- `completedWork` / `pendingWork`,
- `importantDecisions`,
- `failedApproaches` — **the single most valuable handoff field**: when one
  worker discovers an approach does not work, the next worker must not
  rediscover the same failure,
- `changedFiles`, `repositoryState` (branch, HEAD, dirty paths — grounded in
  a real Git snapshot; a checkpoint never requires a commit),
- `testResults`, `knownFailures`, `unresolvedIssues`,
- `nextActions` — resume continues exactly from here,
- `relevantArtifacts`, `relevantContextReferences`.

Checkpoints are append-only revisions per task
(`.specbridge/jobs/<jobId>/task-checkpoints/<nodeId>/<seq>.json`); the latest
readable revision is the resume point. Decisions and failed approaches
**carry forward** across revisions automatically, so a narrow later
checkpoint cannot lose an earlier discovery.

Checkpoints are created at milestones (a completed task checkpoints itself
automatically), before handoff or shutdown, before a context is discarded or
rebuilt (`pre-compaction`, `emergency-compaction`), and on demand. The
reason vocabulary has room for later quota/budget/provider-switch triggers —
additively.

## The context model

Workers receive an **assembled context package**, never an accumulated
conversation. `@specbridge/context` defines six layers:

```text
PINNED               task contract, acceptance criteria, rules, invariants
DURABLE_TASK_STATE   checkpoint-backed truth: completed work, decisions,
                     failed approaches, unresolved issues
COMPACTED_HISTORY    structured summaries of history already made durable
WORKING_SET          replaceable repository context (files, diff, latest tests)
RECENT_DELTA         recent high-value raw signal (latest diff/failure/result)
CURRENT_ACTION       what to do right now
```

`PINNED`, `DURABLE_TASK_STATE`, and `CURRENT_ACTION` are **protected**: no
compaction level may drop or summarize them away. When context is rebuilt,
pinned state is re-injected deterministically from the checkpoint — it is
immune to summarization by construction, because it never travels through
one.

### Budgets and health

A context budget (`ContextBudgetConfig`) reserves headroom for output,
reasoning, and growth, and maps usage onto a closed health vocabulary:

```text
< 55%   HEALTHY
55–70%  PREPARE
≥ 70%   PROACTIVE_COMPACT
≥ 85%   FORCE_COMPACT
≥ 90%   OVERFLOW (no large context operation may start)
```

Thresholds are configurable (`orchestration.jobs.context` in
`.specbridge/config.json`). Token estimation is a deterministic
provider-neutral heuristic (four characters per token, rounded up) used for
budget policy only — never reported as provider usage.

### Compaction — three different mechanisms, kept distinct

1. **SpecBridge pre-compaction** (`@specbridge/context`): micro (dedupe +
   compress bulk), milestone (drop what a checkpoint made durable),
   emergency (keep protected layers + newest deltas + a structural summary,
   drop the disposable rest — only ever against a persisted checkpoint).
   Emergency compaction is a normal runtime operation, not a failure.
2. **Provider-native compaction** (`NativeCompactionAdapter`): a provider
   compacting its own session working memory (Claude Code does this
   automatically; a future OpenAI provider may expose it explicitly). It is
   integrated through a provider-neutral adapter and it is **never**
   canonical: an opaque provider-A compacted session cannot carry a task to
   provider B.
3. **The structured Checkpoint**: the durable canonical state. Neither
   compaction mechanism replaces it.

If a budget cannot be satisfied without discarding protected state, assembly
**fails explicitly** (`ContextBudgetError` / `SBO051`) instead of producing
an incomplete or misleading context.

## Reconstruction and resume

A fresh worker starts through one deterministic path
(`survival/reconstruction.ts`):

```text
load Job → load Task → load latest Checkpoint → pinned context →
durable state → repository snapshot + working set → recent delta →
apply budget → compact if required → ContextPackage → dispatch
```

`prepareTaskResume` runs this end to end: it reconciles interrupted
attempts, captures the current Git snapshot, reconstructs the bounded
context, and reports the `nextActions` and the lineage attempt id for the
new dispatch. The previous full agent conversation is never replayed —
structurally, there is no input through which it could be.

Because cumulative context folds into checkpoints and compacts away, the
total context a task consumes can exceed a single model window by many
multiples; the repeated-compaction tests drive >5× a configured window while
preserving contract, decisions, and failed approaches.

## Provider neutrality

Execution providers implement the existing `AgentRunner` contract; the
survival runtime adds one additive declaration,
`declaredContextCapabilities` (window size when known, native-compaction
mode, session persistence). Runtime code branches on **capabilities and
declared modes — never on provider names**. A provider that declares nothing
gets the conservative default: configured budget, SpecBridge generic
compaction.

Metrics follow the same tolerance: every attempt produces an
`ExecutionLedger` entry (`readExecutionLedger` / `summarizeExecutionLedger`)
with whatever the provider reported — unknown metrics stay `null`, are never
fabricated, and never block execution.

## What survives what

| Event | Survives because |
| --- | --- |
| Process restart | Job/Task/Attempt/Checkpoint are files; `resumeJob` reconciles `RUNNING` state and interrupted attempts |
| Session loss | Sessions are working memory; checkpoints carry the durable state |
| Context exhaustion | Budget health triggers proactive/emergency compaction; protected layers and checkpoints survive every cycle |
| Provider handoff | Reconstruction reads durable state + repository state only; the new provider needs nothing from the old conversation |

The end-to-end proof is `tests/orchestration/survival-validation.test.ts` —
the full scenario: worker death, restart, deleted conversation, provider
handoff, repeated compaction, verified completion.
