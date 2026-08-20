# Long-running jobs: the local-first multi-agent orchestrator (v1.2)

v1.1 gave SpecBridge a governed control loop around a single interactive
session. v1.2 adds the persistent layer above it: a **job** takes an
approved spec, plans the work, schedules bounded agent executions, verifies
results, diagnoses failures, repairs defects, replans when assumptions turn
out to be false, escalates hard reasoning to Claude Code, checkpoints after
every step, survives process interruption, and continues until the approved
work is verified complete or honestly blocked.

The ownership boundary is unchanged and absolute:

> **SpecBridge owns** execution state, policy, scheduling, evidence,
> retries, replanning, budgets, and completion decisions.
> **Agents are replaceable workers.**
> **Git and the trusted verification commands own implementation truth.**

## Running a job

```
specbridge orchestrate run <spec>              # create and drive a job
specbridge orchestrate run <spec> --dry-run    # preview workers, routing, budgets
specbridge orchestrate run <spec> --resume <jobId>
specbridge orchestrate jobs                    # list jobs
specbridge orchestrate job <jobId> [--events 20]
specbridge orchestrate node-plan <jobId> <nodeId>
specbridge orchestrate review-plan <jobId> <nodeId> --approve|--reject
specbridge orchestrate answer <jobId> <questionId> <answer…>
specbridge orchestrate cancel-job <jobId>
```

`run` is a **foreground persistent process**. Ctrl+C checkpoints and stops;
the same job resumes with `--resume`. Multi-hour execution does not depend
on any conversation staying open: every decision lives in
`.specbridge/jobs/<jobId>/` as versioned, schema-validated, atomically
written state.

## The job model

```
.specbridge/jobs/<jobId>/
  job.json          versioned job state (status, budgets, counters, blockers)
  graphs/0001.json  runtime execution graph revisions (append-only)
  plans/<node>-0001.json   node plan revisions (append-only, full lineage)
  agents/…          bounded structured agent results (append-only)
  events.jsonl      append-only audit history
  checkpoint.json   the latest compact continuation point
```

Job statuses: `CREATED → PLANNING → READY → RUNNING → DIAGNOSING →
REPAIRING → REPLANNING → WAITING_RETRY → NEEDS_CLARIFICATION → BLOCKED →
COMPLETED | FAILED | CANCELLED` — a fail-closed transition table with one
deliberately missing edge: **`RUNNING → REPAIRING` does not exist.** A
failure must pass through `DIAGNOSING` first, so "no repair without a
reasoned diagnosis" is structural, not aspirational.

## The runtime execution graph

The approved `tasks.md` is never the mutable runtime plan. A job builds a
**runtime execution graph** — one node per open required leaf task, in
document order, with explicit dependencies — and refines HOW each task will
be implemented in per-node **execution plans** (the v1.1 plan documents,
with revisions, supersession lineage, staleness detection, and materiality
rules).

Replanning may revise a node's plan, or supersede a node entirely (a fresh
node for the SAME approved task, with the attempt history preserved and the
replan budget carried forward). Replanning may never add, remove, or reorder
approved tasks, and a replacement plan that would change approved behavior,
public API, architecture constraints, or product intent stops the job for a
human — enforced twice: the replanner must declare
`impactsApprovedIntent`, and a deterministic keyword screen checks the
replacement against the plan it replaces regardless of what the model
declared.

Runtime node ids never appear inside `.kiro`.

## Roles, tiers, and routing

Six core roles: `CLASSIFIER`, `PLANNER`, `CRITIC`, `DIAGNOSER`,
`REPLANNER` (read-only reasoning) and `EXECUTOR` (the only role that may
mutate source). Two reasoning tiers — `LOCAL_SMALL` (a managed llama.cpp
server) and `LARGE_AGENT` (Claude Code) — and two cost tiers, `LOCAL` and
`PAID`.

Mission-driven specs add five objective-runtime roles: `DECOMPOSER`,
`BUILDER` (writes only inside isolated worktrees), `EVALUATOR`
(local-first), `AGGREGATOR`, and `INTEGRATOR` (the single canonical
writer). For those specs the executor dispatch routes through the
[objective runtime](objective-decomposition.md); everything below — the
scheduler, budgets, diagnosis, replans, resume — governs it unchanged.

Routing is **local-first, escalate-on-evidence**:

- The scheduler assesses complexity deterministically first (see below).
  `HIGH` work never touches the local tier.
- The local `CLASSIFIER` may only *raise* the deterministic class, never
  lower it.
- Local plans are reviewed by the local `CRITIC`; `ACCEPT` clears them
  (subject to the human gate), `REVISE` sends them back with the critique,
  `ESCALATE` reroutes planning to Claude.
- Invalid local structured output gets one bounded correction round; a
  second failure escalates *stickily* — the node never routes back to the
  local tier for evidence-based reasons.
- The `EXECUTOR` resolves exclusively to a repository-writing `LARGE_AGENT`
  worker. The local worker never declares `repositoryWrite`, so no routing
  mistake can select it for source mutation; local execution is a future
  explicit opt-in (`routing.executor` accepts only `large-agent` today,
  and widening that enum is an additive, reviewable change).

Every escalation records a stable reason (`COMPLEXITY_HIGH`,
`INVALID_LOCAL_OUTPUT`, `CRITIC_ESCALATED`, `LOCAL_WORKER_UNAVAILABLE`, …)
in the job's audit state. A paid worker is never selected silently. With
`escalation: "manual"`, a would-be escalation stops the job and asks
instead of spending paid reasoning.

## Deterministic complexity assessment

The model does not decide whether it is capable enough. A pure function
scores documented signals — requirement-reference count, keyword classes
for public-API / architecture / security / distributed / concurrency /
persistence / new-dependency surface area, and per-task failure and replan
history — into `LOW / MEDIUM / HIGH`. Security, distributed-semantics,
public-API, and architecture signals force `HIGH` outright. The signal list
is recorded on the node, so "why was Claude used here?" always has a
structural answer.

## Failure handling

Every executor dispatch runs through the **existing evidence pipeline**
(`runApprovedTask`): pre/post Git snapshots, trusted verification commands
from configuration only, evidence evaluation, and the verified-only
checkbox update. Job orchestration adds no second completion path — an
unverified claim of success is classified as a verification failure.

On failure, the shared v1.1 taxonomy and policy table decide
deterministically:

- transients → `WAITING_RETRY` with bounded backoff (never more than
  `maxTransientRetries`);
- ambiguity and blocked prerequisites → `NEEDS_CLARIFICATION` with a
  concrete recorded question;
- terminal categories (authentication, permission, safety, protected
  paths) → `BLOCKED`, never auto-retried;
- repairable/replannable categories → `DIAGNOSING`.

The diagnoser (local-first) proposes `{category, rootCause, planValidity,
recommendedAction}`; **policy decides what is legal**: `REPAIR` requires a
repairable category, a valid plan, and repair budget; `REPLAN` requires
replan budget; anything the policy cannot follow degrades toward caution —
never toward continuation. Repair dispatches receive the diagnosis as
bounded, data-only prompt observations and always end in fresh verification.

No-progress detection is deterministic: normalized failure fingerprints
(masked paths, timings, pids, hex ids) plus changed-file-set fingerprints.
Two materially identical failures in a row trigger replan-or-block — never
"try harder".

## Budgets and decision authority

Per-job budgets, snapshotted at creation and enforced before every
dispatch: `maxAgentRuns`, `maxTaskAttempts`, `maxRepairCyclesPerTask`,
`maxReplansPerTask`, `maxJobReplans`, `maxNoProgressCycles`,
`maxTransientRetries`, `maxWallClockMs`, `maxLocalInferenceCalls`,
`maxEvents`, and optional `maxCostUsd` / `maxTokens` enforced against
provider-REPORTED usage only (nothing is fabricated; local inference is an
unpriced local resource, not "free"). Exhaustion is an explicit `BLOCKED`
outcome with evidence preserved.

The decision-authority table is code, not prompt text: compile/test
repairs, implementation details, internal refactors, and runtime replans
are autonomous; plan-strategy disagreements escalate; new dependencies are
policy-gated; public-API, architecture, product-behavior, and spec-conflict
decisions require a human; **approval is human-only and additionally has no
agent-reachable surface at all**.

## Checkpoints, interruption, resume

The driver checkpoints after every scheduler decision. On restart,
`resumeJob`:

1. reconciles in-flight statuses (an interrupted dispatch returns the node
   to `READY`; `DIAGNOSING`/`REPLANNING` re-derive their role runs from
   persisted state);
2. re-binds the current node's plan against the repository as it is NOW —
   task fingerprint, approved stage hashes, Git baseline, policy
   fingerprint — and forces `REPLANNING` when stale;
3. surfaces an orphaned repository lock for explicit recovery;
4. records `job_resumed` / `repository_reconciled` events.

A resumed job is the SAME job — same id, counters, graph, history. A
finalized job reports its outcome and never becomes runnable again.

## Surfaces

- **CLI**: the commands above; business logic lives in
  `@specbridge/orchestration` (`driveJob`, the scheduler, the job service),
  not in command handlers.
- **MCP**: `job_list`, `job_read`, `job_cancel` — thin, bounded, and
  deliberately narrow: jobs are driven by the standalone process, not by an
  MCP host. No tool can dispatch, approve, or complete anything.
- **Plugin**: `/specbridge:orchestrate` inspects jobs and relays human
  gates. The interactive-session boundary is explicit: the plugin session
  never launches the orchestrator or any nested agent; the standalone
  orchestrator invoking the Claude Code *runner* is the designed worker
  path. See docs/orchestration/enforcement-boundaries.md.

## Security posture (unchanged, verified by tests)

`.kiro` stays human-only and byte-safe; approvals have no agent-reachable
path; verification commands come only from trusted configuration; protected
paths, repository locking, and append-only evidence behave exactly as in
v1.0/v1.1; there is still no arbitrary shell, filesystem, or Git tool on
any surface; spec/repository text is data (fenced in worker packets, and
agent output schemas physically cannot carry commands, approvals, or
permissions); no chain-of-thought is requested, accepted, or persisted —
no schema has a field for it.

## Daemon readiness — honest status

There is **no daemon in v1.2**. The foreground persistent process already
provides multi-hour unattended execution with durable state and honest
resume. The architecture is daemon-shaped by construction — `driveJob` is a
pure entry point over persisted jobs; nothing reads a TTY; scheduling,
budgets, and recovery live in the shared package — so a future
`specbridge daemon` is an additional thin host (job queue + heartbeat +
delayed-retry timer) rather than a redesign. It is not implemented, and
nothing in this release pretends otherwise.
