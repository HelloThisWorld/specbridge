# Local Agentic Runtime (vNext.4)

vNext.2 gave the `LOCAL` lane a small model that returns a complete file and
hopes it compiles. vNext.4 gives that same lane the option of a **bounded
agentic worker**: a harness runtime that reads the repository, edits several
files, runs the project's commands, reads the failure, repairs, and tries
again — inside **one** SpecBridge attempt, at zero marginal monetary cost.

Nothing about who is in charge changes.

```text
                         SpecBridge
                             |
                      Economic Scheduler
                             |
               +-------------+-------------+
               |                           |
             LOCAL                    SUBSCRIPTION
               |                           |
        Execution Mode               Strong Worker
        +------+-------+             +-----+------+
        |              |             |            |
 DIRECT_MODEL       HARNESS      Claude Code   Codex CLI
        |              |
        |         DeepSeek Harness
        |              |
        +-------> Local Model
                  e.g. Qwen
```

## Four things that are not the same thing

The single most important property of this phase is that these stay separate,
in the vocabulary, in the records, and in the code paths:

| Concept | Question it answers | Values |
| --- | --- | --- |
| **Economic lane** | Who pays, and from which budget? | `LOCAL`, `SUBSCRIPTION` |
| **Execution mode** | How does the lane spend that budget? | `DIRECT_MODEL`, `HARNESS` |
| **Harness** | Which tool loop runs the attempt? | a runner profile (`deepseek-harness`) |
| **Compute locality** | Where does inference physically run? | `LOCAL`, `REMOTE`, `UNKNOWN` |

So:

- **DeepSeek Harness ≠ LOCAL.** A harness is a tool loop. It can drive a
  loopback llama.cpp server or a metered cloud API; only verification decides
  which.
- **Qwen ≠ harness.** The same local model still answers one-shot structured
  requests with no tool loop at all, and that remains the right shape for most
  bounded work.
- **A model name is never evidence of anything.** `qwen3-coder` behind
  `https://api.example.com` is remote paid compute.

Records keep these orthogonal. There is deliberately no `LOCAL_DSH`-style
compound value anywhere: it would make "was this free?" and "did this use a
harness?" unanswerable separately, which is precisely the question this phase
exists to keep answerable.

## Execution shape: a second, independent classification

vNext.2's `LOCAL_SAFE` / `LOCAL_TRY` / `STRONG_REQUIRED` answers *can local
intelligence reasonably do this?* It says nothing about *does doing it require
tools?* — so vNext.4 adds a second classifier
(`scheduling/execution-shape.ts`), deterministic and table-driven like every
other routing input:

| Shape | Signals | Mode |
| --- | --- | --- |
| `ONE_SHOT` | bounded transformation, known target, small complete context, no repository search, no expected test loop | `DIRECT_MODEL` |
| `AGENTIC` | repository exploration, unknown implementation site, several related files, expected edit → test → repair cycle | `HARNESS` |

They are genuinely independent. A task can be `LOCAL_SAFE` and `AGENTIC`
("summarize the logs emitted across the worker modules" — easy, but it has to
go looking), or `STRONG_REQUIRED` and `ONE_SHOT` (a single subtle edit).

Precedence inside the shape classifier, most decisive first:

1. a recorded "the direct attempt lacked repository knowledge" escalation
2. an explicit agentic pattern in the task title
3. a one-shot task category (from the suitability classifier)
4. an explicit one-shot pattern
5. `MEDIUM`/`HIGH` complexity with no bounded-transformation signal
6. otherwise `ONE_SHOT` — the conservative default, because a wrong guess
   costs one cheap local attempt rather than money

## Lane first, then mode — never the other way round

```text
Task → Economic Scheduler → LOCAL → LocalExecutionResolver → DIRECT_MODEL | HARNESS
```

`decideLane` (vNext.2) has no harness input at all, and that is the guarantee:
selecting a harness can never pull work into (or out of) the LOCAL lane, and
`HARVEST`, `CONSERVE`, cross-reset admission, and the dynamic reserve behave
exactly as they did in vNext.2. `LocalExecutionResolver`
(`scheduling/local-resolver.ts`) runs *after* the lane decision and only for
`LOCAL`.

## The LOCAL harness binding

Installing a harness grants it nothing. Enabling a harness profile grants it
nothing either — it becomes an explicitly selectable runner, exactly as in
vNext.3. **Automatic** execution on the LOCAL lane additionally requires all
of:

1. an operator binding (`scheduler.localExecution.harnessProfile`)
2. an enabled, complete, execution-capable profile (`workspaceBoundary` attested)
3. compute **verified** `LOCAL`
4. no paid-provider credentials forwarded into the runtime

Every refusal is a named status rather than silence, so "why did my harness
not run?" always has an answer:

| Status | Meaning |
| --- | --- |
| `BOUND` | usable for automatic LOCAL harness execution |
| `NOT_CONFIGURED` | no profile is bound (the default) |
| `PROFILE_MISSING` / `PROFILE_NOT_HARNESS` / `PROFILE_DISABLED` / `PROFILE_INCOMPLETE` | configuration problems, named |
| `BOUNDARY_UNCONFIRMED` | the runtime profile's write boundary is unattested (vNext.3 fail-closed) |
| `NOT_VERIFIED_LOCAL` | locality is `UNKNOWN`; not admitted |
| `REMOTE_COMPUTE` | locality is `REMOTE`; never admitted, override or not |

## Compute-locality verification (fail closed)

**Upstream limitation, stated plainly:** the tested public DSH SDK exposes no
provider-endpoint introspection. The launched runtime profile (`cordis.yml`)
owns its routes and the `initialize` handshake returns runtime identity only.
SpecBridge therefore cannot *discover* where inference runs.

So it asks for an attested **mechanism** and verifies the structural evidence
that mechanism implies (`runners/deepseek-harness/locality.ts`, pure and
offline — no request, no DNS resolution, no credential read):

| `computeLocality` | Verified how | Result |
| --- | --- | --- |
| `unconfirmed` (default) | nothing to verify | `UNKNOWN` |
| `loopback-endpoint` | `providerEndpoint` is parsed; must be `127.0.0.0/8`, `::1`, `localhost`, a local socket, or a `file:`/`unix:` path | `LOCAL` |
| `loopback-endpoint` with a public host | parsed and rejected | `REMOTE` |
| `managed-local-model` | the SpecBridge-managed llama.cpp server is enabled and coherent (the manager binds it to `127.0.0.1`, and no configuration can widen that) | `LOCAL` |

Additional fail-closed rules:

- `0.0.0.0` / `::` is a **bind** address, not a destination: it proves nothing
  and yields `UNKNOWN`.
- A hostname that merely *resolves* to loopback today is not evidence. DNS is
  not a safety boundary, so nothing is resolved.
- Credential-shaped `environmentPassthrough` **names** (`OPENAI_API_KEY`,
  `*_API_KEY`, `*_ACCESS_TOKEN`, …) disqualify a local binding even when the
  endpoint is loopback: a runtime that can authenticate to a metered provider
  is one edit away from billing the "free" lane. Names only — values are never
  read, compared, or logged.
- `allowUnverifiedLocality` is an explicit experimental override for
  `UNKNOWN`. It does **not** apply to `REMOTE`: the override exists for
  "cannot be proven", never for "proven to bill money". When used, the
  decision record carries `localityOverridden: true`.

## Rollout strategies

`orchestration.jobs.scheduler.localExecution.strategy`:

| Strategy | Behavior |
| --- | --- |
| `DIRECT_ONLY` **(default)** | vNext.2 behavior exactly. The harness path is not in play, whatever is installed. |
| `HARNESS_ONLY` | Every local **task** dispatch that can use the verified-local harness does. For benchmarking and A/B work. |
| `ADAPTIVE` | The execution-shape policy chooses per task. The intended long-term mode. |

Local **preprocessing** (context compression, `scheduling/preprocess.ts`) is
not a task dispatch and always uses the direct path — wrapping a single
compression request in an agent loop is pure overhead. `HARNESS_ONLY` does not
change that.

The default is `DIRECT_ONLY` deliberately: installing DeepSeek Harness must
never change how an existing workspace routes work. Enable `ADAPTIVE` when you
have measured your own local model on your own repository (see
[Measuring it yourself](#measuring-it-yourself)).

Per-run diagnostic override: `driveJob(..., { localExecutionMode })` forces one
mode for eligible local work. It cannot pull `STRONG_REQUIRED` work local and
cannot bypass locality verification.

## One shared local attempt budget

Two execution modes must never mean two budgets. `maxLocalAttempts` (default
2) bounds the **whole LOCAL lane** for a task:

```text
Task local budget = 2

Attempt #1  LOCAL / DIRECT_MODEL   fails
Attempt #2  LOCAL / HARNESS        fails
            ↓
        SUBSCRIPTION
```

Attempt numbers are one continuous history; there is no per-mode counter
anywhere.

### DIRECT → HARNESS (a LOCAL → LOCAL transition)

A direct attempt that fails for lack of *repository knowledge* has not shown
that the task needs a stronger model — it has shown that a model with no tools
cannot see the repository. When a verified-local harness is bound and the
shared budget still has room, that becomes a mode change, recorded as the
`LOCAL_DIRECT_TO_HARNESS` escalation, consuming **no** subscription quota.

The trigger list is short and closed on purpose (`directFailureNeedsRepositoryTools`):

- the local executor **declined** (it is instructed to decline exactly when it
  lacks repository knowledge)
- it produced **no repository change at all** (evidence `no-change`) — the
  signature of a model that did not know where to write
- its applied edits **failed trusted verification** — the case an
  edit → test → repair loop exists for

Invalid structured output, cancellation, transient tool failures, stale
context, and a diverged repository are *not* repository-knowledge evidence and
follow the existing policy unchanged.

### HARNESS → SUBSCRIPTION

Bounded, and split by cause:

| Failure kind | Examples | Consequence |
| --- | --- | --- |
| `INFRASTRUCTURE` | runtime crash, dead transport, missing executable, timeout, sandbox startup, auth/quota errors from the runtime | **Not** evidence about the task. No sticky escalation; the shared budget still bounds retries. |
| `INTELLIGENCE` | malformed final result, blocked, no progress, verification failure after bounded repair | Contributes to `LOCAL_EXECUTION_ESCALATED`; once the shared budget is spent the next eligible attempt routes `SUBSCRIPTION`, stickily. |

There is no "restart the harness and try again forever" path. Free compute is
not a reason to loop.

## Harness context is leaner than direct context

A direct model has no tools, so everything it could need must be in the
request. A harness agent can read the repository itself — so the bootstrap
package carries what SpecBridge knows and the repository does **not**, plus
pointers to everything else:

```text
Task contract + acceptance criteria + invariants
Decisions already made
Approaches already tried and ruled out
Known test state / known failures
Next actions, in order
Protected paths and the completion boundary
   +
pointers:  .kiro/specs/<spec>/requirements.md, design.md, tasks.md, steering
```

The approved documents are **pointed at, not pasted**. The SpecBridge
checkpoint remains canonical memory; the harness session, its native
compaction, and its tool history are working memory that may vanish at any
time. Every attempt starts a fresh session bootstrapped from the checkpoint —
losing the runtime costs nothing.

## Evidence still owns completion

```text
begin (repository lock + trusted baseline snapshot)
      ↓
harness runtime: inspect → edit → run → read → repair      (its loop)
      ↓
harness CLAIMS completion
      ↓
complete (post snapshot + protected paths + trusted verification)
      ↓
evidence decides whether the task is done                  (our authority)
```

- The harness's own test runs are tactical observations. They are **not**
  SpecBridge evidence; the configured trusted verification commands run
  afterwards and decide.
- Protected paths are enforced twice: prevented by the attested runtime
  profile boundary (vNext.3) and *detected* byte-exactly by the evidence
  pipeline (`.kiro/**`, `.specbridge/config.json`, `.specbridge/state/**`,
  HEAD movement). A violation is never verified, and nothing is rolled back
  behind your back.
- The harness never writes task checkboxes, approvals, or SpecBridge runtime
  state. SpecBridge writes the checkbox, and only for verified evidence.
- Every attempt has an external wall-clock bound
  (`localExecution.maxHarnessWallTimeMs`, default 30 min). The runtime owns
  its internal turn/tool loop; SpecBridge owns the deadline and the teardown.

## What gets recorded

`SchedulingDecision` gains an orthogonal `localExecution` block:

```json
{
  "selectedLane": "LOCAL",
  "reasonCode": "LOCAL_TRY_FIRST",
  "localExecution": {
    "mode": "HARNESS",
    "reasonCode": "LOCAL_HARNESS_SELECTED",
    "shape": "AGENTIC",
    "runner": "deepseek-harness",
    "model": "qwen3-coder-30b",
    "computeLocality": "LOCAL",
    "harnessBindingStatus": "BOUND"
  }
}
```

`ExecutionAttempt` and the `ExecutionLedger` gain `executionMode`,
`executionShape`, and `computeLocality`, plus `commandRuns` and `compactions`
metrics. **Unknown stays unknown**: a runtime that reported nothing
contributes nothing, because a fabricated zero would quietly corrupt every
later direct-vs-harness comparison.

Mode-selection reason codes (`LOCAL_EXECUTION_MODE_REASONS`), kept separate
from the lane reason codes:

`LOCAL_DIRECT_SELECTED`, `LOCAL_DIRECT_ONLY_STRATEGY`,
`LOCAL_HARNESS_SELECTED`, `LOCAL_HARNESS_FORCED`, `LOCAL_HARNESS_UNAVAILABLE`,
`LOCAL_HARNESS_NOT_VERIFIED_LOCAL`, `LOCAL_DIRECT_TO_HARNESS_ESCALATION`.

Job events: `local_execution_mode_selected`, `local_harness_selected`,
`local_harness_unavailable`, `local_harness_locality_rejected`,
`local_direct_to_harness_escalated`,
`local_harness_to_subscription_escalated`.

## Configuration

```jsonc
{
  "runnerProfiles": {
    "dsh-local": {
      "runner": "deepseek-harness",
      "enabled": true,
      "command": { "executable": "node", "args": ["./dsh/bin/agent.js", "./dsh/cordis.yml"] },
      "provider": "local-llamacpp",
      "model": "qwen3-coder-30b",
      "workspaceBoundary": "runtime-profile",
      // vNext.4: where this profile's inference actually runs.
      "computeLocality": "loopback-endpoint",
      "providerEndpoint": "http://127.0.0.1:8080/v1"
    }
  },
  "orchestration": {
    "jobs": {
      "scheduler": {
        "localExecution": {
          "strategy": "DIRECT_ONLY",          // ADAPTIVE once measured
          "harnessProfile": null,             // "dsh-local" to bind it
          "maxHarnessWallTimeMs": 1800000,
          "allowUnverifiedLocality": false    // experimental; UNKNOWN only
        }
      }
    }
  }
}
```

With no `localExecution` block, an existing workspace behaves exactly as it
did in vNext.2. No migration enables a harness; installation is not
authorization.

`maxLocalAttempts` is **not** duplicated per mode — it is the lane's budget.

## Inspecting it

```bash
specbridge orchestrate scheduler <jobId>
```

shows the strategy, the binding status with its locality evidence, the
per-ready-task predicted mode (suitability + shape + reason), DIRECT vs
HARNESS attempt counts with verification pass rates, and how many local tasks
later escalated to the subscription lane. `--json` carries all of it.

```bash
specbridge runner doctor dsh-local
```

shows the profile's `compute-locality` row alongside the vNext.3 boundary and
resume attestations, and warns when a profile forwards credential-shaped
environment names.

## Measuring it yourself

`ADAPTIVE` is a policy recommendation, not a measurement. To make it one:

```bash
specbridge orchestrate local-benchmark --spec settings-persistence --task 3 --task 4
```

Each task runs through **both** modes in its own detached git worktree at
`HEAD`. The arms never share a mutable workspace and your working tree is
never touched. The report compares trusted-evidence outcome, wall time,
changed files, unexpected control-plane changes, and whatever token/tool
metrics the runtimes actually reported.

Production dispatch never runs twice — A/B evaluation is a command you run,
never something the scheduler does behind you.

## Deliberately not in this phase

- No `API` lane and no PAYG fallback (vNext.5 owns the API Gap Bridge). A
  harness profile with remote/PAYG compute cannot participate in automatic
  LOCAL routing at all.
- No general harness subagent/workflow orchestration: one SpecBridge attempt
  is one harness root agent with a bounded tactical loop. SpecBridge stays the
  global orchestrator.
- No learned routing. vNext.4 collects the evidence a later adaptive scheduler
  would need; nothing tunes itself yet.
- A harness-only LOCAL lane is not supported: the lane's worker slot is the
  configured local model worker, so local inference must be enabled for the
  LOCAL lane to exist at all. In the intended setup (direct model and harness
  driving the *same* local model) this is already true.

## See also

- [Quota-aware scheduling (vNext.2)](quota-scheduling.md) — the lane decision
  this phase sits underneath
- [Survival runtime (vNext.1)](survival-runtime.md) — attempts, checkpoints,
  and why sessions are disposable
- [DeepSeek Harness runner](../deepseek-harness-runner.md) — the vNext.3
  adapter, its attestations, and its upstream limitations
- [Threat model](../security/threat-model.md) — the local agent authority
  expansion and its mitigations
