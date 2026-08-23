# The Authority Firewall

One pure function decides who owns every decision an unattended run faces.
It answers exactly one question:

> Does continuing require **product authority** the human did not delegate?

and it is deliberately unable to answer any other.

---

## What it cannot see

`evaluateAuthority()` takes a decision surface, the seal, the policy, and
some observations. It does **not** take complexity, diff size, attempt count,
model confidence, or architectural weight, because none of those are
parameters.

That is not an oversight. A firewall that could see difficulty would
eventually be asked to weigh it, and the weighing is the behaviour vNext.10
exists to remove.

### What can never gate

`NON_AUTHORITY_SIGNALS` is an enumerable, snapshotted list:

```
HIGH_COMPLEXITY      LARGE_DIFF          ARCHITECTURE_HEAVY
REPEATED_FAILURE     RISKY_PLAN          LOW_MODEL_CONFIDENCE
UNFAMILIAR_TECHNOLOGY  LONG_RUNNING      MANY_FILES_TOUCHED
NEW_DEPENDENCY
```

Callers *may* pass these; they are recorded on the decision for the audit
trail and they never change the verdict. A negative list is unusual, and it
earns its place: the failure mode being prevented is slow drift, in which a
plausible-sounding "this looks risky, better ask" creeps back into a code
path months from now.

`verifyNonAuthoritySignalsCannotGate(policy, seal)` proves the property at
runtime by passing every signal at once to every delegated surface and
asserting none of them produces `NEEDS_AUTHORITY`. It is exported rather than
kept in a test file because the guarantee is a product promise, and a
property asserted only in a test is a property that quietly stops being true.

## The three verdicts

| Verdict                 | Means                                          | Costs   |
| ----------------------- | ---------------------------------------------- | ------- |
| `AUTONOMOUS`            | the runtime decides and proceeds               | nothing |
| `ESCALATE_INTELLIGENCE` | the runtime decides, with a stronger reasoner  | tokens  |
| `NEEDS_AUTHORITY`       | only a human may decide                        | a night |

`ESCALATE_INTELLIGENCE` carries the whole thesis. A decision that is *hard*
is answered with a better reasoner, not with a question, and it consumes no
human time at all.

## The decision order

1. **A hard authority surface is one, sealed or not.** Nothing below can
   rescue it, and no amount of delegation can grant it.
2. **Without an executable seal there is no delegated authority.** An
   unsealed job falls back to asking. Autonomy is granted, never assumed.
3. **Inside a seal, a delegated surface is the runtime's.** If a stronger
   reasoner is available and untried, use it — that is what "hard" means
   operationally.
4. **A surface the policy reserves goes to the human**, because the human
   said so. This is the only path from configuration to a human gate, and it
   is opt-in rather than default under an unattended mode.

An **unclassified** surface fails closed towards asking. Forgetting to
classify a new enum member produces a question, not an action.

## The hard surfaces

These have no configuration representation anywhere:

| Surface                              | Why it is the human's                                          |
| ------------------------------------ | -------------------------------------------------------------- |
| `sealed-contract-change`             | a sealed contract is a promise a human made                     |
| `product-semantics-change`           | what the product does for its users is product authority        |
| `wire-protocol-change`               | promises to systems outside this repository                     |
| `persistence-compatibility-change`   | persisted data outlives the code that wrote it                  |
| `security-boundary-expansion`        | autonomy means responsibility inside authority, never expansion |
| `sealed-requirement-conflict`        | only whoever approved them can resolve a contradiction          |
| `contract-change-request`            | an agent may propose one; it may never apply one                |
| `human-only-credential`              | SpecBridge never authenticates on a person's behalf             |
| `external-irreversible-action`       | local engineering authority is local                            |
| `spend-beyond-ceiling`               | money is spent only inside an explicit pre-authorized bound     |
| `scope-beyond-seal`                  | work the seal never authorized is new product intent            |

### Spend is conditional, and unknowns are outside

`spend-beyond-ceiling` is the one hard surface that can resolve to
`AUTONOMOUS`: spending *inside* the authorized ceiling is ordinary bounded
execution, not an authority decision.

An **unknown cost** or an **unknown ceiling** is treated as outside the
authorization. The runtime cannot prove it is inside, so it is not.

## The two screens

An agent's own declaration that a change is safe is a proposal. Two
deterministic screens run behind it.

**The v1.2 intent screen** (`screenReplanForApprovedIntentImpact`) fires on
keyword classes in a replacement plan: public API, architecture, new
dependency, product behaviour. It is correct when a human is at the keyboard.

**The vNext.10 text screen** (`screenTextForAuthoritySurfaces`) looks for the
vocabulary of *promises* rather than of *difficulty*: wire format, message
schema, destructive migration, disable auth, deploy to production, obtain
credentials.

Under a seal, the first is re-read through the second's lens by
`refineIntentImpactUnderSeal`:

| v1.2 decision kind              | Under a seal with delegated internal architecture |
| ------------------------------- | -------------------------------------------------- |
| `public-api-change`             | stays: `sealed-contract-change`                     |
| `product-behavior-change`       | stays: `product-semantics-change`                   |
| `spec-conflict`                 | stays: `sealed-requirement-conflict`                |
| `architecture-contract-change`  | **dropped** — internal architecture is delegated     |
| `new-dependency`                | **dropped** — dependency selection is delegated      |

That table is the concrete answer to "a replan mentioned architecture and the
night ended". "Restructure the module layout" no longer wakes anyone;
"change the public API of the action SDK" still does.

## The driver seam

Orchestration defines the contract; autonomy implements it. The driver
consults an optional `DelegatedAuthorityResolver` **at points where it was
already about to stop**:

```ts
const delegated = resolveDelegatedAuthority(deps.authorityResolver, context);
if (delegated?.kind === 'AUTONOMOUS')      proceed();
if (delegated?.kind === 'NEEDS_AUTHORITY') escalateAuthority(...);
// otherwise: the v1.2 clarification, unchanged
```

Three consequences, all deliberate:

- A workspace with no seal has no resolver and behaves exactly as v1.2 did.
- A resolver that throws is treated as absent. The correct response to a bug
  in the thing that grants autonomy is to grant none.
- **The seam can only remove a false gate, never add a real one.** There is
  no path by which a resolver introduces a gate the v1.2 rules did not
  already have.

Orchestration does not import `@specbridge/autonomy`. The dependency points
one way.

## NEEDS_AUTHORITY is a first-class state

Not overloaded `BLOCKED`, and the difference matters:

- `BLOCKED` means "an external prerequisite is missing". Operational.
- `NEEDS_AUTHORITY` means "I need permission". Governance.
- `NEEDS_CLARIFICATION` means "I need information".

The durable `authorityRequest` on the job carries a question written for a
person reading it at breakfast, the rationale for why it is genuinely theirs,
and the ways forward SpecBridge can already see. The options are suggestions,
never a menu the runtime may pick from: every one of them requires an
operation no agent surface can reach.

An existing unresolved request is **not replaced**. A run that escalated once
and then found a second authority question surfaces the first one it hit —
overwriting it would mean the human answers the newest question and the run
stops again on the older one.

## Telemetry

Authority escalations are counted **separately** from human interventions.
An authority stop is the system working; an unnecessary clarification is the
system failing. Counting them together would make
`humanInterventionsAfterSeal` unfalsifiable in both directions.
