# Secondary Work Readiness

Phase 6 of vNext.10.2 adds deterministic admission policy for the Secondary
Objective Builder. It answers whether one concrete Objective `WorkUnit` is a
legitimate Secondary candidate. It does not select a model or change default
routing.

```text
WorkUnit + approved ContextProjection
         + Phase 5 Builder Packet quality
         + trusted verification policy
         + dependency and relevant ResearchRecord identity
    ↓
WorkReadinessAssessment
    ↓ deterministic policy
SecondaryEligibilityDecision
```

The unit, rather than its parent Objective, is the policy boundary. Parent
Objective complexity is retained as advisory evidence only. A 17-file field
propagation can be bounded, mechanical, and strongly verified, so it may be
eligible. A three-line concurrency fix can leave several ordering and
duplicate-delivery semantics open, so it requires strong reasoning. File and
line counts are not proxies for intelligence difficulty.

## Assessment dimensions

`WorkReadinessAssessment` is a versioned derived execution record. It contains
the following auditable categories:

- `knowledgeState`: `KNOWN`, `RESOLVED_BY_RESEARCH`, `UNCERTAIN`, or
  `EXTERNAL_UNKNOWN`. Only completed, conflict-free engineering, compatibility,
  or domain facts can resolve a knowledge gap. A research recommendation does
  not grant product authority.
- `decisionEntropy`: `LOW`, `MEDIUM`, or `HIGH`. Explicit targets, established
  patterns, precise behavior, and tests reduce the open implementation choices.
  Design, architecture, concurrency, security, ambiguous ownership, and
  unresolved semantic choices are high entropy. This is deterministic pattern
  classification, not an LLM score.
- `implementationSpecificity`: `ABSTRACT`, `BOUNDED`, or `CONCRETE`. Phase 5
  target resolution and packet quality are the primary evidence; Phase 6 does
  not perform another repository retrieval.
- `verificationStrength`: `NONE`, `WEAK`, or `STRONG`. Only configured,
  SpecBridge-controlled verification counts. Tests, schemas, exact fixtures,
  and deterministic integration checks are strong; compile- or lint-only
  verification is weak; model claims never count.
- `contextState`: `SUFFICIENT`, `INSUFFICIENT`, or `AMBIGUOUS`, mapped from the
  Phase 5 compilation outcome and quality facts. `INSUFFICIENT_CONTEXT` and
  `AMBIGUOUS_TARGET` become context blockers, not intelligence blockers.
- `authorityRisk` and `contractMutationRisk`: implementing approved truth is
  allowed, but choosing product behavior or changing a compatibility/public
  contract without approved authority is not.
- `repositoryMutationScope`: `BOUNDED`, `BROAD`, or `UNKNOWN`. A known related
  module can remain bounded across many files; an architecture-wide migration
  or an unresolved impact surface cannot.
- `dependencyState`: `READY`, `INCOMPLETE`, `STALE`, or `AMBIGUOUS`, using the
  existing WorkGraph and verified dependency-candidate evidence.

Phase 5 facts such as `explicitTargetResolved`, `targetAmbiguity`,
`testsFound`, `referencePatternFound`, `dependencyContextComplete`,
`verificationHintsAvailable`, and `contextSufficient` are consumed directly.

## Decisions and precedence

`SecondaryEligibilityDecision` has six outcomes:

- `ELIGIBLE`: Secondary is a legitimate candidate; it is not a dispatch order.
- `STRONG_REQUIRED`: the work is known and ready but needs stronger reasoning,
  is abstract or broad, or lacks strong trusted verification.
- `NEEDS_RESEARCH`: material external knowledge is unresolved.
- `NEEDS_AUTHORITY`: an approved human/product or contract decision is missing.
- `NEEDS_CONTEXT`: Phase 5 context is insufficient or ambiguous.
- `NOT_READY`: dependency evidence is incomplete, stale, or ambiguous.

Blockers use deterministic precedence:

```text
NEEDS_AUTHORITY
  > NEEDS_RESEARCH
  > NOT_READY
  > NEEDS_CONTEXT
  > STRONG_REQUIRED
  > ELIGIBLE
```

Authority and contract risk, non-sufficient context, uncertain or external
knowledge, high entropy, abstract specificity, no trusted verification,
unknown mutation scope, and non-ready dependencies are hard non-eligibility
gates. Medium-entropy work may be eligible when the remaining evidence is
strong. Phase 6 deliberately treats weak verification conservatively as
`STRONG_REQUIRED`; there is no weak-verification opt-in policy yet.

Every decision carries typed reason codes and human-readable explanations.
Examples include `AUTHORITY_UNRESOLVED`, `CONTRACT_MUTATION_REQUIRED`,
`TARGET_AMBIGUOUS`, `KNOWLEDGE_EXTERNAL_UNKNOWN`,
`HIGH_DECISION_ENTROPY`, `NO_TRUSTED_VERIFICATION`,
`DEPENDENCY_NOT_READY`, `CONCRETE_TARGET`, `STRONG_VERIFICATION`,
`REFERENCE_PATTERN_AVAILABLE`, and `RESEARCH_RESOLVED`. The inspect rendering
shows categories and evidence references without exposing hidden reasoning.

## Durability, freshness, and telemetry

The Objective store writes one record per WorkUnit attempt beneath:

```text
.specbridge/jobs/<jobId>/objectives/<nodeId>/readiness/
```

The semantic identity binds the WorkUnit, Builder Packet and packet-quality
facts, approved projection, relevant ResearchRecords, verification policy, and
dependency evidence. Timestamps are excluded. Identical durable inputs reuse
the assessment; a changed packet/source, contract projection, dependency,
verification command, or relevant research record invalidates it.

Aggregate telemetry records the assessment count and distributions for status,
typed reasons, entropy, verification strength, and context state. These records
support later eligibility and success-rate analysis but do not implement a
numeric confidence score or learned routing.

## Runtime and compatibility boundary

For an explicitly selected Secondary path, packet compilation is followed by
readiness assessment before inference. A non-eligible decision records evidence
and stops that explicit attempt; it does not silently reroute or fall back.
Ordinary Objective execution without an explicit Secondary selection remains
on the existing builder path.

The earlier task-level `LOCAL_SAFE` / `LOCAL_TRY` / `STRONG_REQUIRED`
suitability policy remains in place for non-Objective scheduler flows. A small
compatibility bridge can translate an Objective readiness record where needed,
without reapplying parent-complexity vetoes.

Phase 7 owns automatic routing, availability, quota/economic policy, repair,
and fallback. Phase 8 cooldown continuation, LLM Gateway, remote-model
registries, learned routing, and OpenMind are also outside Phase 6.
