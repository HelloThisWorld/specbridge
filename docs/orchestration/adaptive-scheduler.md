# Adaptive compute scheduler (vNext.8)

SpecBridge accumulates a durable execution history: every attempt, its lane,
its execution mode, its runner and model, how long it took, what it consumed,
whether a trusted evaluation passed, and — since vNext.6 — why it failed when
it did. The adaptive compute scheduler turns that history into conservative,
explainable placement.

The question it lets SpecBridge ask changed in this phase. It used to be:

> Is this task LOW, MEDIUM, or HIGH?

It is now:

> For tasks like this, on this repository, with this execution shape, under
> current quota, budget, and context conditions: which **policy-eligible**
> execution target has historically produced the best verified engineering
> outcome for the least total wasted compute?

**The one invariant that governs everything below:**

> Adaptive optimization may rank allowed choices.
> It may never make a forbidden choice allowed.

Default mode is `HEURISTIC`, which reproduces vNext.7 scheduling exactly.

---

## 1. Where it sits

```text
                         Task
                          |
                          v
                   Hard Policy Layer          <- locality, quota, spend,
                          |                      budget, reliability, context
                eligible candidates
                          |
                          v
              Adaptive Prediction Layer
                          |
        +-----------------+-----------------+
        |                 |                 |
    success           resources          failure
  prediction          prediction        prediction
        |                 |                 |
        +-----------------+-----------------+
                          |
                          v
                  Expected Utility
                          |
                          v
                   Candidate Ranking
                          |
                    confidence OK?
                   /              \
                 yes               no
                  |                 |
                  v                 v
             adaptive choice   heuristic fallback
                  |
                  v
                Execute
                  |
                  v
          Evidence / Evaluation
                  |
                  v
          Observed Ledger Result
                  |
                  v
        update derived profiles
```

The policy layer is **outside and above** ranking, and this is enforced by the
call graph rather than by a check. `generateCandidates` takes an
already-decided `NodeLaneRouting` and can only enumerate ways to spend the
lane that decision selected. There is no code path from the adaptive layer to
a lane hard policy refused.

Concretely:

| Hard-policy outcome | Candidates generated |
| --- | --- |
| `DEFER` / `REQUIRE_APPROVAL` | none — the task keeps waiting |
| `LOCAL` | `DIRECT_MODEL` and/or `HARNESS`, both LOCAL |
| `SUBSCRIPTION` | the subscription runner |
| `API` | the bound API profile — reachable only after the Gap Bridge selected the lane |

So history can never move mechanical local-capable work onto prepaid quota,
never outrank available subscription capacity with "the API succeeds 4% more
often", and never turn a `REMOTE` harness into a LOCAL candidate.

---

## 2. Task signature

Historical data is only useful if comparable tasks group together. Two failure
modes bracket the design: a signature so specific every task is its own bucket
(nothing is ever learned), and one so coarse that unlike work is averaged
together (the number describes nothing).

The resolution is two layers, kept strictly apart:

**The key** — coarse, durable, deterministic. This is what profiles are keyed
by:

```text
category | complexity | localSuitability | executionShape | verificationStrength
```

**The features** — finer-grained observations about *this* task right now,
recorded for audit and future refinement and deliberately **not** part of the
grouping key: estimated files touched, multi-module, architecture-sensitive,
security-sensitive, migration, expected test-loop class, current reliability
health, blocked dependents, critical path, repository-size class,
context-size class.

Keeping the failure class out of the key matters: a task that fails twice must
not silently move to a different bucket because its health changed.

Everything is derived from structural classification SpecBridge already
performs. No chain of thought is representable, and repository text cannot
reach this file except through the same word-boundary category tables vNext.2
has always used.

The signature is computed on **every** scheduling pass, including in
`HEURISTIC` mode, and recorded on the attempt (`taskSignature`). A workspace
that switches the adaptive scheduler on later finds comparable history already
waiting rather than starting from zero.

---

## 3. Execution candidates

```ts
interface ExecutionCandidate {
  lane;             // LOCAL | SUBSCRIPTION | API
  executionMode;    // DIRECT_MODEL | HARNESS | null
  runner;           // "local-llamacpp", "deepseek-harness", …
  model;
  profile;          // API profile name
  contextStrategy;  // LEGACY | SELECTIVE | PROGRESSIVE
  computeLocality;  // verified, from vNext.4
  heuristicChoice;  // is this what the deterministic scheduler picked?
  strategyKey;      // the vNext.6 strategy identity
}
```

Every dimension is a separate field. A compound identity like
`QWEN_LOCAL_DSH_FAST` makes "was this local?", "did this use a harness?", and
"which model ran it?" unanswerable separately, and once history is keyed by
such a value it can never be re-sliced. `candidateId` exists only as a derived
map key and is never parsed back.

Candidates hard policy refused are kept as **rejected** candidates for
diagnostics — they can be inspected, and they can never execute.

---

## 4. Observed outcomes

Only executed attempts with real observations become evidence. A prediction, a
recommendation, an unexecuted candidate, or a shadow-mode counterfactual has
no representation in this layer at all — there is no constructor that takes
one.

| Label | Meaning |
| --- | --- |
| `VERIFIED_SUCCESS` | completed **and** evaluation `PASS` |
| `UNVERIFIED_SUCCESS` | completed with no `PASS` on record — counted separately, never rounded up |
| `IMPLEMENTATION_FAILURE` | the work was wrong |
| `INFRASTRUCTURE_FAILURE` | the machinery broke (harness, provider, sandbox, verifier) |
| `INCONCLUSIVE` | evaluation reached no verdict — never trained as failure |
| `CENSORED` | interrupted or cancelled — outcome unknowable, resource cost still counted |

Rate denominators differ by question, which is why six labels exist instead of
a boolean:

```text
intelligence success  VERIFIED_SUCCESS / (VERIFIED_SUCCESS + IMPLEMENTATION_FAILURE)
availability          1 - INFRASTRUCTURE_FAILURE / (all non-censored)
```

A provider with excellent intelligence and frequent outages reports both, and
neither number contaminates the other.

---

## 5. Performance profiles

`ExecutionPerformanceProfile` is **derived state**: rebuildable from the
ExecutionLedger, cacheable, versioned, and safe to delete. It is never
canonical Job state. Deleting `.specbridge/cache/adaptive-profiles.json` costs
a rebuild and nothing else.

Each profile carries sample counts by label, weighted counts, first-attempt
statistics, P50/P90 wall time, input tokens, context tokens, quota burn and
cost, attempts per success, stagnation / oscillation / runaway rates, context
expansion and context-miss rates, the failure-source distribution,
failed-work totals, runtime identities seen, and an undecayed count of
safety-class failures.

Nothing is fabricated. An attempt that reported no token usage contributes to
no token statistic — it does not contribute a zero, because a silent provider
must never look cheap.

### Cache lifecycle

Every failure mode collapses to one answer, **rebuild**:

| State | Response |
| --- | --- |
| absent | rebuild |
| schema-version mismatch | rebuild (never migrate — these are derived numbers) |
| unparseable / truncated | rebuild |
| stale fingerprint | rebuild |

A job never blocks on any of this. While a rebuild happens the scheduler uses
the heuristics that governed every phase before this one.

---

## 6. Smoothing, priors, and confidence

### Smoothing

```text
P(verified) = (weightedVerifiedSuccesses + priorStrength * priorMean)
              -------------------------------------------------------
              (weightedIntelligenceAttempts + priorStrength)
```

Only attempts that **resolved the intelligence question** appear in the
denominator: verified successes and implementation failures. A crashed
harness, an inconclusive verdict, and an interrupted run are real events with
real costs — priced elsewhere — but none of them is evidence about whether the
model can do the work.

With the default `priorStrength` of 4, one success out of one attempt yields
`(1 + 4 × prior) / (1 + 4)` — about 0.68 for a prior of 0.6, not 100%.

### The prior

`priorMean` is the **existing heuristic's own expectation** that one attempt
succeeds: `1 - retryProbability` from the vNext.2 workload estimate. It is
identical across every candidate on a task, so the prior can express
uncertainty and can never express provider favouritism.

### Recency

```text
weight = 0.5 ^ (age / recencyHalfLifeMs)
```

Continuous rather than a rolling window: a window boundary makes one
observation worth everything on Monday and nothing on Tuesday, which turns
placement into a function of the calendar.

Observations past `maxObservationAgeMs` are dropped — **except**
safety-class failures (`AUTHORIZATION`, `REQUIREMENT_CONTRACT`), which are
counted undecayed. Rare and serious is not the same as old and irrelevant.

### Confidence ladder

Base, by weighted evidence:

| Weighted samples | Level |
| --- | --- |
| ≥ 4× the decision floor | `HIGH` |
| ≥ the decision floor | `MEDIUM` |
| > 0 | `LOW` |
| none | `NONE` |

Cumulative demotions, floored at `NONE`:

| Condition | Demotion |
| --- | --- |
| answered at `TARGET_CATEGORY` | −1 |
| answered at `LANE_CATEGORY` / `LANE_GLOBAL` | −2 |
| answered at `HEURISTIC_PRIOR` | `NONE` |
| runtime identity `COMPATIBLE` | −1 |
| runtime identity `UNKNOWN` | −1 |
| runtime identity `CHANGED` | `NONE` |
| drift detected | −1 |
| wall-time P90/P50 > 4 | −1 |

Confidence is a **ceiling, not a vote**: a prediction below the configured
floor cannot place work however attractive its score.

---

## 7. Sparse-data fallback

Maintaining a profile for every Cartesian product of task, runner, model,
version, context strategy, and repository would produce thousands of
one-sample buckets, each confidently wrong. The lookup walks specific →
general and stops at the first level with enough evidence, recording which
level answered:

| Level | Key |
| --- | --- |
| `EXACT` | full signature × `lane/mode/runner/model/contextStrategy` |
| `TARGET_CATEGORY` | `category\|complexity` × `lane/mode` |
| `LANE_CATEGORY` | `category` × `lane` |
| `LANE_GLOBAL` | `*` × `lane` |
| `HEURISTIC_PRIOR` | no observations anywhere — cold start |

`TARGET_CATEGORY` drops runner and model deliberately. "Does the harness beat
direct inference for this kind of task?" must stay answerable when an operator
renames a worker profile or bumps a model point release.

---

## 8. Expected utility

```text
U = successWeight        * P(verified)
  - latencyPenalty       * norm(expectedTotalWallTime,      wallTimeScaleMs)
  - failedWorkPenalty    * failedWork
  - quotaPressurePenalty * quotaOpportunityCost
  - apiCostPenalty       * norm(expectedCostPerCompletion,  apiCostScaleUsd)
  - contextCostPenalty   * norm(contextPerCompletion,       contextTokenScale)
  - handoffPenalty       * norm(handoffOverhead,            wallTimeScaleMs)
```

**Normalization.** Seconds, dollars, tokens, and quota percentages are never
added in their own units. Each raw quantity passes through a saturating map
into `[0,1)`:

```text
norm(x, k) = x / (x + k)
```

Saturating rather than linear on purpose: the difference between a two-minute
and a twenty-minute task is decision-relevant; the difference between four and
five hours is not, and a linear penalty would let one outlier dominate.

An unknown quantity normalizes to `0` — it is not penalized, because guessing
a penalty is the same error as guessing a value.

**Quality dominates cheapness.** At the default weights the success term spans
1.0 while every penalty combined saturates below it. A candidate that is 10%
cheaper and 30% less likely to complete loses.

**Per completion, not per attempt.** Cost and context are priced across the
expected attempt count, so a strategy that sends a smaller package and then
needs two more attempts has not saved anything.

**Failure cost is amplified by no-progress history:**

```text
failedWork = norm(expectedFailedWallTime, failedWorkScaleMs)
             × (1 + stagnationRate + oscillationRate + runawayRate)
```

### Quota opportunity cost

A dimensionless pressure index in `[-1, 1]`. **Not money**, and deliberately
not convertible to it — SpecBridge has no exchange rate between a percentage
of a prepaid window and a dollar.

| Condition | Value |
| --- | --- |
| non-subscription lane | `0` |
| `HARVEST` | negative (a bonus) — capacity that expires unused is worth spending |
| `CONSERVE` | positive — scarce capacity costs more than face value |
| weekly pressure | positive |

The hard quota rules are not expressible here and did not need to be:
admission, the dynamic reserve, exhaustion, and weekly suppression of HARVEST
all ran before a candidate reached this function.

---

## 9. Rollout modes

| Mode | Predictions computed | Decision records written | Who places work |
| --- | --- | --- | --- |
| `HEURISTIC` (default) | no | no | the deterministic scheduler |
| `SHADOW` | yes | yes | the deterministic scheduler |
| `ADAPTIVE` | yes | yes | ranking, when every gate clears |

Four independent gates must all clear before adaptive displaces the incumbent:

1. **evidence** — both compared candidates carry enough weighted observations
2. **confidence** — the winner clears `minimumConfidence`
3. **margin** — the winner beats the incumbent by more than
   `minimumUtilityImprovement` (hysteresis)
4. **mode** — the scheduler is in `ADAPTIVE`

Failing any gate is not an error and is never silent: the heuristic executes
and the specific gate is persisted as the fallback reason.

### SHADOW makes no counterfactual claim

If ranking recommended `HARNESS` and the heuristic executed `DIRECT`,
SpecBridge records **that the recommendation differed** and nothing else. The
alternative was not run, so no outcome is attributed to it and no regret is
computed. `wouldApplyInAdaptiveMode` reports whether the gates would have let
it act — which is the number a rollout is actually judged on.

### Instant disable

```jsonc
{ "orchestration": { "jobs": { "scheduler": { "adaptive": { "mode": "HEURISTIC" } } } } }
```

One value restores pre-vNext.8 behavior. No migration, no loss of canonical
state. Derived caches may be left in place or deleted; neither matters.

---

## 10. What history also improves

**Conservative burn (P90).** vNext.2 admission compared a median-shaped
estimate multiplied by a configured safety factor, with the multiplier
standing in for uncertainty nobody had measured. vNext.8 supplies the
measurement. Admission compares the **larger** of the multiplied median and
the measured P90, so history can only make admission stricter, never more
permissive.

This is gated on the adaptive scheduler being enabled: an operator running in
`HEURISTIC` asked for vNext.7 behavior, and quietly tightening their admission
rule because a new phase shipped would not honor that.

**Calibration.** After each attempt resolves, the forecast made before it is
compared with what it did: relative errors on wall time, tokens, context, and
cost, plus a Brier score for the success forecast where the outcome was
resolvable. Calibration is derived metadata — a wrong forecast never edits the
attempt, the evaluation, or the ledger, and nothing reads calibration back to
place work.

**Drift.** Two windows of real observations are compared; a material success
drop, wall-time growth, context growth, failure-source shift, or runtime
identity change lowers confidence. Drift's only power is to make the system
*less* certain, which moves placement back toward the deterministic
heuristics. It never retrains anything.

---

## 11. Diagnostics

```bash
specbridge orchestrate adaptive
```

```bash
specbridge orchestrate adaptive <jobId> --node <nodeId>
```

```bash
specbridge orchestrate adaptive --rebuild
```

Shows mode and thresholds, profile-store provenance (source, freshness,
fingerprint, observation count), the profiles themselves with their full
label breakdown and P50/P90 distributions, per-decision candidate comparisons
with itemized score components, hard-policy vetoes, fallback reasons, and
recent prediction accuracy.

`orchestrate scheduler <jobId>` carries a compact adaptive summary and points
here for detail.

A score breakdown is rendered as an argument, not a number:

```text
LOCAL/HARNESS/deepseek-harness scores 0.712 against LOCAL/DIRECT_MODEL/local-llamacpp at 0.601 (margin 0.111).
verified success: 82% vs 27%
time to verified completion: 19m vs 27m (retries included)
expected attempts: 1.2 vs 3.7
economic lane: both LOCAL
confidence: MEDIUM (20 sample(s) at EXACT)
```

Events: `adaptive_prediction_created`, `adaptive_candidate_selected`,
`adaptive_candidate_vetoed`, `adaptive_shadow_disagreement`,
`adaptive_fallback_to_heuristic`, `adaptive_drift_detected`,
`adaptive_profile_rebuilt`, `adaptive_cache_invalidated`.

---

## 12. Configuration

Under `orchestration.jobs.scheduler.adaptive`:

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `HEURISTIC` | rollout state |
| `minimumSamplesForAdaptiveDecision` | `8` | weighted evidence before history may override |
| `minimumComparableSamples` | `4` | weighted evidence each compared candidate needs |
| `priorStrength` | `4` | Beta prior strength, in pseudo-observations |
| `recencyHalfLifeMs` | 14 days | recency weight half-life |
| `maxObservationAgeMs` | 180 days | hard age cutoff (safety events exempt) |
| `maxObservations` | `5000` | bounded rebuild work |
| `minimumConfidence` | `MEDIUM` | floor before a prediction may decide |
| `minimumUtilityImprovement` | `0.05` | hysteresis margin |
| `wallTimeScaleMs` | 30 min | latency saturation scale |
| `failedWorkScaleMs` | 30 min | failed-work saturation scale |
| `contextTokenScale` | `200000` | context saturation scale |
| `apiCostScaleUsd` | `2` | cost saturation scale |
| `driftSuccessDropRatio` | `0.25` | relative success drop counting as drift |
| `driftWallTimeGrowthFactor` | `1.5` | wall-time growth counting as drift |
| `driftMinimumSamples` | `4` | per-window floor before drift may be declared |
| `safetyFailuresExemptFromDecay` | `true` | safety events ignore recency and age |
| `maxDecisionRecords` | `500` | retained adaptive decisions per job |
| `maxCalibrationRecords` | `500` | retained calibration records per job |
| `weights.*` | see below | utility weights |

Weights: `successWeight` 1, `latencyPenalty` 0.2, `failedWorkPenalty` 0.3,
`quotaPressurePenalty` 0.15, `apiCostPenalty` 0.25, `contextCostPenalty` 0.1,
`handoffPenalty` 0.05.

Validation rejects a non-positive `successWeight` (a scheduler that weighs only
cost is not an improvement over a coin flip), an all-zero weight vector (every
candidate would score identically), negatives, NaN, and out-of-range values.

**Configuration is control-plane policy.** Nothing an agent writes into a
repository can change a weight, a budget, a quota bound, or a placement.

---

## 13. What vNext.8 does not claim

It does **not** claim optimal scheduling, causal knowledge of unexecuted
alternatives, perfect success or cost prediction, general reinforcement
learning, a global provider ranking, or benchmark equivalence across projects.

It provides **conservative, history-informed placement under hard policy
constraints.**

Explicit non-goals, none of which are implemented: reinforcement learning, a
neural predictor, an external ML service, autonomous paid exploration,
duplicate production attempts for A/B testing, new execution lanes, new
harness frameworks, a provider marketplace, dynamic price discovery, a billing
system, distributed scheduling, cross-user learning, automatic policy
mutation, and automatic budget increases.

### Exploration

The scheduler never spends money to collect training data. Sparse evidence for
an API profile produces low confidence and a heuristic fallback — never a paid
run to fill the gap. It likewise never issues duplicate subscription attempts
to gather scheduler data. Evidence comes from executions that were
independently justified by real task policy, plus the explicit benchmark
suite.

---

## 14. Benchmark results

Deterministic, offline, **simulated**. The workload is 40 synthetic
multi-file local tasks; the fixture world says `DIRECT_MODEL` verifies 20% of
attempts in 5 minutes and `HARNESS` verifies 85% in 14 minutes. Both
schedulers see the same 40 tasks and the same 40 observations of history.

| Metric | Heuristic | Adaptive |
| --- | --- | --- |
| tasks completed | 9 / 40 | **35 / 40** |
| attempts | 102 | **52** |
| failed attempts | 93 | **17** |
| attempts per completed task | 11.33 | **1.49** |
| simulated failed wall time | 465 min | **238 min** |
| simulated total wall time | **510 min** | 728 min |
| simulated context tokens | **2.55 M** | 6.24 M |
| simulated API spend | $0 | $0 |

Reported faithfully, including the part that is not flattering: the adaptive
scheduler consumes **more** total wall time and **more** context here, because
the candidate it selects is slower and more context-hungry per attempt. It
completes nearly four times as many tasks while doing so, and wastes roughly
half the wall time on attempts that never verify — which is the trade this
phase's objective actually asks for. A metric set that counted only prompt
size or total minutes would score this backwards.

**Cold start**, same 40 tasks with no history: adaptive is identical to
heuristic on every simulated total, with 40 recorded heuristic fallbacks.

**Historical replay** over 40 recorded decision points: 40 disagreements, 40
of which would also have cleared every gate, all at `MEDIUM` confidence. This
is recommendation analysis only — the alternatives were never executed, so the
report makes no claim about what they would have produced.

These numbers demonstrate that the ranking logic behaves as designed on a
world where the answer is known. They are not evidence about any real
provider, model, or repository.

---

## 15. Threat model

See [`docs/security/threat-model.md`](../security/threat-model.md) for the
adaptive-scheduler entries: history poisoning, self-reinforcing routing bias,
manual-acceptance bias, provider outage misclassified as intelligence failure,
stale version transfer, spend/quota/reliability veto bypass, metric gaming,
counterfactual claims, derived-analytics corruption, cross-workspace leakage,
and routing oscillation.

---

## 16. Extension point for vNext.9

`ExecutionCandidate` is the seam. Today the only dimension with a genuine
alternative in this checkout is the LOCAL execution mode; `contextStrategy` is
recorded on every candidate, profile, and observation but is not varied,
because vNext.7 exposes a single workspace-level strategy. When alternative
strategies become independently selectable, adding them as a candidate
dimension requires no change to prediction, utility, ranking, gating, or the
decision record — the profiles are already keyed for it.

The same seam accepts additional subscription-backed runners once their quota
telemetry exists, and additional authorized API profiles once more than one is
configured. Unknown capacity stays unknown until it is measured; this phase
adds no model for a resource pool it cannot observe.
