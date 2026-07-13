# Interactive task execution

The v0.5 lifecycle that lets the **current** agent session (Claude Code, or
any MCP client) implement an approved task directly — no nested agent
process, no `claude -p`, no `specbridge spec run`. SpecBridge brackets the
session's work with exactly the machinery the v0.3 runner path uses: Git
snapshots, trusted verification commands, deterministic evidence
evaluation, append-only evidence, and the verified-only surgical checkbox
update. What the session *says* it did is recorded as a claim and never
treated as proof.

```text
task_begin                       lock + pre-run snapshot + approved context
        ↓
the CURRENT session edits source files
        ↓
task_complete                    post-run snapshot → actual changed files
        ↓
trusted verification commands (argv arrays from .specbridge/config.json)
        ↓
evidence evaluation (v0.3 rules) → append-only evidence record
        ↓
verified → exactly one checkbox flips        anything else → checkbox unchanged
```

## task_begin

Preconditions (each failing with a precise `SBMCP` code): valid workspace,
existing managed spec, all stages approved with current hashes, an
existing incomplete executable leaf task (explicit `taskId` or the next
deterministic one), no active interactive run, a usable Git repository, and
a clean working tree unless `allowDirty: true` (pre-existing changes are
then hash-baselined and never attributed to the task). The fail-closed
configuration reader refuses an invalid `.specbridge/config.json`.

On success it: acquires the repository lock, captures the pre-run Git
snapshot **after** locking, records an `interactive-execution` run
(`lifecycleStatus: AWAITING_AGENT_CHANGES`, `host: mcp`) with the task
fingerprint and approved-hash context, and returns bounded context plus the
verbatim instructions:

> Implement only the selected task. Do not edit `.kiro`. Do not edit
> `.specbridge`. Do not change task checkboxes. Do not commit. Do not push.
> Do not reset user changes. Stop and report blockers when information is
> missing. Call `task_complete` only after source changes are ready. Call
> `task_abort` when the task cannot continue.

`task_begin` modifies no source files and invokes no model.

## task_complete

Preconditions: the run exists, is interactive, is still
`AWAITING_AGENT_CHANGES`, the lock still references it, spec approvals are
still current (SBMCP005 otherwise), and the selected task is unchanged —
fingerprint and exact line text (SBMCP013 otherwise). A finalized run
returns its recorded result idempotently: evidence is never duplicated and
the checkbox never flips twice.

The finalize pipeline then captures the post-run snapshot, attributes
changes hash-exactly (pre-existing vs during-run; ambiguous attribution can
never auto-verify), detects protected-path modifications (`.kiro/**`,
`.specbridge` config/state, `.git`, configured paths) and HEAD motion, runs
the trusted verification commands (unless disabled at begin or per call),
evaluates evidence with the v0.3 rules, writes the append-only evidence
record, and — only for `verified` evidence — performs the surgical one-line
checkbox update. Outcomes:

`verified` · `implemented-unverified` · `failed` · `blocked` · `no-change`
· `protected-path-violation` · `repository-diverged`

Nothing is ever rolled back: a protected-path violation or divergence is
reported honestly with every file left exactly where the session put it.

## task_abort

Requires a non-empty reason. Captures the current Git summary, marks the
run `ABORTED` with the reason, releases the lock, and reports the
working-tree paths still changed relative to the run baseline — resetting
nothing, deleting no evidence, touching no checkbox. Aborting a finalized
run returns its status without mutation.

## Locking and recovery

One interactive run per repository, enforced by
`.specbridge/locks/interactive-task.lock` — acquired atomically (exclusive
create; Windows-safe) and containing schema version, run id, spec, task,
pid, created time, and heartbeat. A crashed process leaves the lock behind
**by design**: nothing steals a lock silently.

```text
specbridge run recover-lock              # diagnose only
specbridge run recover-lock --remove     # explicit confirmation
specbridge run recover-lock --json
```

Recovery inspects the referenced run record, the owner process (where pids
are meaningful), and the heartbeat age, then explains its finding. Removal
requires positive staleness evidence (finalized run, provably dead owner,
or unverifiable owner with an old heartbeat) **and** the explicit
`--remove` flag; an ambiguous or actively held lock is never removed, and
MCP never removes a lock automatically. Removing a stale lock also marks
its still-open run `ABORTED` so state stays consistent.

## Run records

Interactive runs reuse the v0.3 run and evidence schemas, extended with
`kind: interactive-execution` / `interactive-authoring`, `lifecycleStatus`,
`host`, and `abortReason` — all optional fields, so every v0.3 record keeps
validating. The coarse `runType` discriminator maps kinds onto
`runner-execution` / `runner-authoring` / `interactive-execution` /
`interactive-authoring` (with `deterministic-verification` reserved for
verification runs, which persist reports rather than run records). Evidence
records from interactive runs carry `runner: "interactive"`, the claims
verbatim under `runnerClaims`, and the same `specContext` freshness fields
v0.4 verification consumes.
