# Overnight autonomy (vNext.10)

The evening: seal the intent, run one command.
The night: SpecBridge works.
The morning: read the report.

This document is the model. [Authority firewall](authority-firewall.md),
[supervisor](supervisor.md), [Toolsmith](toolsmith.md),
[environments](environments.md), [browser evidence](browser-evidence.md),
[contract closure](contract-closure.md), [control-plane
repair](control-plane-repair.md), and [telemetry](telemetry.md) go deeper on
each piece.

---

## The problem this solves

The previous long-horizon dogfood proved the models could finish a product.
It also produced a list of the things that stopped the night, and almost
none of them were about intelligence:

| What happened at 03:00                          | What it cost      |
| ----------------------------------------------- | ----------------- |
| the subscription quota ran out                   | the rest of the night |
| llama.cpp crashed                                | the rest of the night |
| the shell closed and the driver died with it     | the rest of the night |
| a package was missing                            | the rest of the night |
| a stage needed approving again                   | the rest of the night |
| the Claude CLI had changed its flags             | the rest of the night |
| a replan mentioned "architecture"                | the rest of the night |

Every one of those is a question whose answer is *the same every time*, and
every one of them was asked while the only person who could answer was
asleep. vNext.10 is the phase that stops asking them.

It also fixed the opposite failure, which is worse: that run initially
declared the product COMPLETE while seven approved requirements had no
implementation at all. Nothing lied. Every task was checked off, the build
was green, the tests passed, and the agent said done.

## The two rules

Everything below follows from two sentences.

**Difficulty is answered with intelligence, not with a question.**

    HIGH complexity          ->  use a stronger reasoner
    AUTHORITY BOUNDARY       ->  wake the human

Complexity, diff size, architectural weight, low confidence, unfamiliar
technology, and a pile of failed attempts are *never* reasons to stop. The
authority firewall physically cannot see any of them:
[`NON_AUTHORITY_SIGNALS`](authority-firewall.md#what-can-never-gate) is an
enumerable list, and `verifyNonAuthoritySignalsCannotGate()` proves at
runtime that passing all of them at once still yields `AUTONOMOUS`.

**Completion is decided by evidence, not by assertion.**

    IMPLEMENTED   something claims to implement this
    VERIFIED      trusted evidence demonstrates it holds

Only the second closes a contract item, and Mission COMPLETED is available
only when every sealed item closes. Task checkboxes are not evidence. A green
build is not evidence about a requirement nobody implemented. `AGENT_ASSERTION`
is a recordable evidence kind that closes nothing.

## The shape of a night

```
  evening
    specbridge autonomy setup --mode overnight
    specbridge autonomy seal <mission> --confirm      <- the one human gate
    specbridge overnight preflight <mission>          <- must say OVERNIGHT_READY
    specbridge overnight run <mission>

  night
    preflight -> bind seal -> build closure ledger -> supervise
        ^                                                |
        |                                                v
    telemetry <- closure lifecycle <- classify what stopped it

  morning
    COMPLETED, or NEEDS_AUTHORITY with one question
```

The only two normal terminal outcomes are `COMPLETED` and `NEEDS_AUTHORITY`.
Every operational state — waiting for a quota window, restarting a provider,
installing a package, repairing an environment, patching the control plane —
is internal, supervisor-owned, and non-terminal.

## The intent seal

A **MissionSeal** is the durable record that a human authorized a complete
product intent and delegated the engineering inside it. It captures, as a
snapshot with provenance:

- the goal and non-goals, verbatim
- the active mission decisions, constitution rules, and ADRs, by id
- every product contract **pinned to the revision that was authorized**
- the acceptance criteria, with the qualification surfaces each implies
- the resource policy: spending ceiling, allowed lanes
- the delegated authority policy, and its fingerprint

Three properties matter:

**It is a snapshot.** A mission that keeps evolving does not retroactively
change what a running job was allowed to do.

**It is immutable.** There is no update operation. Re-sealing writes a new
record naming its predecessor, so "which authorization was this built under"
always has an answer.

**It carries provenance, not prose.** The seal references mission records by
id and never restates a requirement in its own words — a restatement would
be a new requirement nobody approved.

### Why derived artifacts do not need re-approval

Compiling a seal is *deterministic*. It reads mission records and adds no
information. That is exactly why human authority can flow from canonical
product truth into derived artifacts without a second approval round: there
is nothing new to approve. If compilation ever needed a model, this would
become a proposal and the human would be right to re-read it.

### Policy drift

The seal records the autonomy policy fingerprint at authorization time.
If configuration later grants a **wider** delegation, executing under it
would be the runtime giving itself authority — quietly, exactly when nobody
is watching. A **narrower** live policy is also refused, for the mirror
reason: a job that believed it could provision containers and now cannot
would fail halfway through in a way nobody predicted. Either way the seal
must be re-authorized. Re-sealing is cheap; discovering it at 04:00 is not.

## The autonomous states

| Status                    | Means                                            | Who leaves it |
| ------------------------- | ------------------------------------------------ | ------------- |
| `RUNNING`                 | a dispatch is in flight                          | the driver    |
| `WAITING_RESOURCE`        | a named resource is unavailable and expected back | the supervisor |
| `RECOVERING_PROVIDER`     | a provider or local runtime is being restored    | the supervisor |
| `REPAIRING_TOOLCHAIN`     | a missing engineering tool is being provisioned  | the supervisor |
| `REPAIRING_ENVIRONMENT`   | a product runtime environment is being fixed     | the supervisor |
| `REPAIRING_CONTROL_PLANE` | a governed SpecBridge repair is running          | the supervisor |
| `REPAIRING`               | a diagnosed implementation defect is being fixed | the driver    |
| `REPLANNING`              | the approach was wrong                           | the driver    |
| `QUALIFYING`              | the closure lifecycle is deciding                | the oracle    |
| `NEEDS_AUTHORITY`         | continuing requires product authority            | **a human**   |
| `COMPLETED` / `FAILED`    | terminal                                         | nobody        |

`BLOCKED` still exists and still means what it always meant: an external
prerequisite only a person can satisfy. What changed is that operational
failure no longer lands there. That single conflation is what made the last
dogfood's failures *sticky*: the runtime knew exactly what it was waiting for
and had no way to say so.

Every operational status can return to `READY` on its own. That is asserted
by a test over the transition table, not merely intended.

## What is delegated, and what never is

Inside a sealed intent the runtime decides, without asking:

implementation structure · internal architecture · module layout ·
algorithms · internal APIs · UI framework · CSS strategy · state management ·
REST shape for new feature surfaces · database physical layout · dependency
choices · build tooling · test tooling · browser tooling · Docker topology ·
broker topology · local scripts · test harnesses · refactors · debugging
instrumentation · benchmark infrastructure · work decomposition ·
implementation plans · recovery strategy · environment provisioning ·
toolchain provisioning · context strategy · provider placement

These have **no configuration knob anywhere**:

- changing a sealed contract
- changing product semantics
- changing wire/protocol semantics
- changing persistence compatibility promises
- expanding a security boundary
- spending past the authorized ceiling
- anything needing a human-only credential
- an irreversible action outside the workspace

They are not defaults that could be overridden. They have no representation
in the configuration schema, so no config file, environment variable, or
agent proposal can express "let the machine decide this one".

## What zero-touch does NOT guarantee

Stated plainly, because a promise with no stated limits is not a promise.

SpecBridge **cannot**:

- work through permanent, total loss of every allowed compute lane. If no
  local model, no subscription, and no authorized API remains, and no future
  return can be identified, the run classifies that honestly and stops. It
  does not loop.
- invent a credential. It never creates accounts, enters passwords, or
  authenticates on your behalf. A run that discovers it needs one stops in
  `NEEDS_AUTHORITY`.
- spend past the authorized ceiling. An unknown cost or an unknown ceiling is
  treated as *outside* the authorization, not inside it.
- change sealed product authority. An agent may propose a contract change; no
  agent surface can apply one.
- survive machine failure. A disk that dies takes the durable state with it.
  Nothing here is a substitute for backups.
- guarantee the product is *good*. It guarantees every sealed contract item
  closed on trusted evidence. Whether the sealed contract described the right
  product is the human's judgment, made once, in the evening.
- prove reproducibility an environment cannot provide. A machine that cannot
  do a clean build reports `INCONCLUSIVE`, which is explicitly not a pass.

And two limits worth naming separately because they are easy to misread:

**A skipped browser scenario is not a passing one.** A workspace with no
browser runtime records `SKIPPED_NO_RUNTIME` with a reason, and any acceptance
criterion requiring browser evidence stays unclosed. The run does not
"succeed anyway".

**`humanInterventionsAfterSeal = 0` counts interventions, not questions.** A
correct `NEEDS_AUTHORITY` stop is counted separately as an authority
escalation, because it is governance working. Folding the two together would
make the primary metric unfalsifiable in both directions: a runtime could
claim zero by escalating everything, or claim failure by escalating once,
correctly.

## Where the state lives

```
.specbridge/autonomy/
  seals/<sealId>.json                 immutable authorization snapshots
  bindings/<jobId>.json               job -> seal
  supervisor/state.json               the registry
  supervisor/leases/<jobId>.json      one lease per supervised job
  supervisor/log.jsonl                append-only supervision actions
  preflight/<reportId>.json           overnight preflight reports
  toolsmith/<jobId>/                  capability requests, grants, ledger
  environments/plans|instances|logs/  environment lifecycle
  browser/                            scenarios, results, evidence
  critic/<critiqueId>.json            UX critiques
  closure/<jobId>/ledger.json         the contract closure ledger
  closure/<jobId>/audits/             append-only closure audits
  repairs/<repairId>.json             control-plane repairs
  telemetry/<jobId>.json              the autonomy report
  certification/<runId>.json          zero-touch certification runs
```

Same rules as every other SpecBridge state family: every path passes
`assertInsideWorkspace`, every write is atomic, a corrupt record is skipped
and preserved rather than rewritten. Seals additionally refuse to be
overwritten at all — an authorization that can be edited in place is a
suggestion, not an authorization.

## See also

- [Authority firewall](authority-firewall.md) — who decides what, and why
  difficulty can never gate.
- [Supervisor lifecycle](supervisor.md) — leases, restarts, and why a lease
  is never preempted.
- [Toolsmith](toolsmith.md) — building tools without creating authority.
- [Environment lifecycle](environments.md) — readiness that means something.
- [Browser evidence](browser-evidence.md) — and the UX critic's negative
  authority.
- [Contract closure](contract-closure.md) — the completion oracle and the
  gap-closure lifecycle.
- [Control-plane repair](control-plane-repair.md) — governed self-repair.
- [Autonomy telemetry](telemetry.md) — the honest report.
- [Zero-touch certification](certification.md) — how the claims are proven.
- [Operator setup](operator-setup.md) — the evening checklist.
