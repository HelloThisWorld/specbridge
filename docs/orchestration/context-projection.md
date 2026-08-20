# Context projection

**Share truth, not context.** A worker never receives another worker's chat
transcript, the main session's history, hidden reasoning, or an unbounded
summary. What it receives is a **context projection** — an immutable,
hashed, bounded document of approved truth:

```text
WorkerContext =
    Mission Constitution Snapshot
  + Current Objective (task id, title, acceptance criteria)
  + Relevant Contract Versions
  + Relevant ADRs
  + Relevant Approved Spec Excerpts
  + Relevant Prior Decisions
  + Current Work Evidence (verified dependency candidates)
```

## Relevance is declared, truth still flows

Contracts, ADRs, and decisions are filtered to what the work unit declares
relevant (`relevantContractIds`, `relevantAdrIds`); unrelated project
content is excluded **by default**, not by luck. Two deliberate asymmetries:

- The **whole active constitution** always travels — it is small by design
  and binding for every worker.
- A unit that declares no contracts still receives the objective's contract
  set in its projection (truth always flows), while its *declared* empty set
  is what parallel-dispatch independence reasons over (independence is never
  assumed from silence).

Work evidence comes exclusively from **verified dependency candidates** —
their structured summaries and investigation reports — never from any
conversation.

## Identity: two hashes

Every projection is bound to exactly one `(workUnit, attempt)` and carries:

- `contentHash` — SHA-256 of the projection's canonical (sorted-key)
  serialization. Deterministic: identical inputs always produce the
  identical hash, which tests rely on.
- `contractSnapshotHash` — SHA-256 over the sorted
  `(contractId, revision)` pairs of the ACTIVE registry plus the
  constitution version.

Both hashes are stamped into the worker's identity record and must be
presented back with its result; the
[supervisor](subagent-isolation.md) rejects a result carrying different
hashes. Stored projections answer, forever: *exactly what approved truth did
this worker see?*

```bash
specbridge orchestrate workunit <jobId> <nodeId> <workUnitId>   # shows the projection identity
```

## Staleness

When any referenced contract gains a revision — or the constitution version
moves — the registry snapshot hash changes and every projection built
against the previous state is **stale**. `evaluateProjectionFreshness`
reports the specific reasons (`contract CTR-004 moved from revision 1 to
2`), the deterministic evaluation layer fails stale candidates with
`STALE_CONTEXT`, and affected work units replan against fresh truth on
their next attempt. Nothing continues silently on an outdated picture — the
StepRelay CCR test proves the full loop end to end.

## Bounds

A projection is bounded as one unit (`orchestration.jobs.objectives.
maxProjectionChars`, default 60 000 characters). An oversized projection is
trimmed from the least-load-bearing end — spec excerpts — never from
contracts, the constitution, or decisions. Per-field bounds cap list sizes
and text lengths at the schema level.
