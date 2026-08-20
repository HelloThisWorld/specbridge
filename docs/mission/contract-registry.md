# The product Contract Registry and change requests

## Two registries, deliberately separate

The repository's `contracts/` directory snapshots **SpecBridge's own**
public surface. The registry described here is the **product's**: the
engineering contracts of the software a mission is building, stored under
`.specbridge/missions/<id>/contracts/`. They never mix.

## Contracts

A product contract (`CTR-###`) is one versioned engineering promise:

```text
CTR-001 Canonical Workflow Model
CTR-002 Action Request Protocol
CTR-003 Action Result Protocol
CTR-004 EventTransport SPI
CTR-005 ExecutionStore SPI
CTR-006 Workflow Configuration Contract
CTR-007 Runtime State Contract
```

Each revision records:

- stable identity (`contractId`) and a monotonic `revision`;
- `classification` (`public` / `internal`) and a `compatibilityPolicy`
  (`frozen`, `additive-only`, `evolving`, `internal`);
- `dependsOn` (other contract ids — synthesis orders objectives by this DAG);
- `requirements` (`R1`, `R2`, …) and `invariants` (`I1`, … — optionally with
  machine-checkable [guard patterns](architecture-constitution.md));
- provenance (`decisionIds`, `turnIds`) and, for revisions born from a
  change request, `changeRequestId`;
- supersession lineage (`supersedesRevision`).

Revisions are **individually immutable files**
(`contracts/CTR-001-r001.json`, `-r002.json`, …); the current registry view
is the highest revision per id. Every revision stays readable forever.

Contracts are proposed during discovery through `mission_assess`, which
requires decision provenance and validates guard patterns. Inspect with:

```bash
specbridge mission contracts <missionId>
```

## Contract change requests (CCRs)

Execution discovers contract gaps. When a builder finds the approved
contract cannot express what the implementation needs, it does **not**
deviate — it reports a change request, which becomes a durable artifact:

```text
CCR-018
Contract: CTR-004 EventTransport SPI
Problem:  Current contract cannot represent negative acknowledgement.
Proposal: Add nack(message, requeuePolicy)
Affected: runtime, Kafka adapter, RabbitMQ adapter, tests, SDK
```

Statuses: `PROPOSED → NEEDS_HUMAN → APPROVED | REJECTED | SUPERSEDED`.

**Anyone may raise one; only the human decides one.**

- Raised by: a worker (its candidate claims), an aggregator's
  recommendation, the `contract_change_request` MCP tool, or the CLI. The
  creator is recorded (`raisedBy`, `originJobId`, `originWorkUnitId`) as
  audit, never authority.
- Materiality is deterministic: a request against a `public` contract, a
  `frozen`/`additive-only` policy, or whose text trips the irreversibility
  screen lands `NEEDS_HUMAN` — and execution touching that contract stops
  for human authority.
- The decision path is **CLI-only** (no MCP tool exposes it, asserted by
  tests):

```bash
specbridge mission ccr <missionId> <ccrId> --approve [--note "…"]
specbridge mission ccr <missionId> <ccrId> --reject  [--note "…"]
```

## What approval does

Approving a CCR:

1. records the human decision as a discovery decision (the provenance
   chain stays intact);
2. writes the **next immutable contract revision** (by default the previous
   content plus the proposal as an appended requirement; a fully revised
   body can be supplied);
3. flips the CCR to `APPROVED` with `resultingRevision`.

The revision bump changes the registry's snapshot hash, which makes every
[context projection](../orchestration/context-projection.md) built against
the previous revision **stale**: affected work units replan against the new
truth on their next attempt — never continue silently. The StepRelay
end-to-end tests prove the whole loop: builder discovers the nack gap →
CCR `NEEDS_HUMAN` → job stops → human approves → revision 2 → the retry's
projection provably carries revision 2.
