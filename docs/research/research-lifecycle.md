# Research-Augmented Lifecycle

SpecBridge vNext.10.2 Phase 3 makes the governed Phase 2 research layer
available at four lifecycle seams: product conversation, `spec-draft`, Formal
Intake decision preparation, and runtime investigation. Research remains a
sparse escalation. Stable model knowledge, current repository truth, and an
exact reusable ResearchRecord all come before a new provider call.

## Lifecycle architecture

Brownfield:

```text
Workspace Bootstrap -> CurrentSystemSnapshot -> conversation / spec-draft
                                                |
stable knowledge -> repository truth -> prior ResearchRecord -> ResearchGate
                                                |
                                      optional bounded DeerFlow
                                                |
                         evidence / DecisionBrief / investigation report
                                                |
                    existing human authority and completion gates
```

Greenfield:

```text
user intent -> stable model knowledge -> prior ResearchRecord -> ResearchGate
                                                        |
                                              optional bounded DeerFlow
                                                        |
                     recommendation + choices -> human decision -> product truth
```

All phases use the same provider-neutral `ResearchRequest`, `ResearchReport`,
`ResearchRecord`, exact-hash reuse policy, provider bridge, store, and budgets.
The lifecycle label is provenance, not part of the request hash, so a still
applicable report can be reused across phases.

The explicit phases are:

- `CONVERSATION`
- `SPEC_DRAFT`
- `INTAKE_DECISION`
- `RUNTIME_INVESTIGATION`

Each use writes an immutable record under `.specbridge/research/uses/` with
the phase, reason, ResearchRecord id, new-vs-reused status, intended effect,
consumer, and `authority: EVIDENCE_ONLY`.

## Shared sparse-routing policy

For a potentially relevant unknown, the frontend uses this order:

1. Answer from stable model knowledge when sufficient.
2. Use the CurrentSystemSnapshot or focused repository inspection.
3. Reuse an exact durable ResearchRecord.
4. Delegate a pure engineering decision to the implementation pipeline.
5. Prepare a human product decision without choosing it.
6. Research only material external/current uncertainty.
7. Otherwise continue ordinary reasoning.

User unfamiliarity alone is never a research trigger. Callers validate a
small explicit unknown classification and structured gate signals; no extra
model call is required just to decide whether research is permitted.

## Conversation and spec drafting

Conversation research is one coherent bounded brief, not a query per
sub-question. The frontend synthesizes what was learned, product relevance,
facts, recommendations, and remaining choices rather than dumping provider
output.

`spec-draft` classifies gaps as product authority, repository fact, stable
model knowledge, external knowledge, engineering decision, or unresolved.
A research fact never becomes a requirement by itself. For example, a report
that platforms commonly provision asynchronously may inform options; only a
human choice through the existing authority path can create an asynchronous
product promise.

Claude Code skills are canonical. The deterministic Codex plugin builder
derives equivalent Codex skills, and parity tests fail on missing behavior.

## Formal Intake decision preparation

Formal Intake's deterministic question admission and authority analysis are
unchanged. After it creates a real product question,
`prepare_intake_decision` can produce a bounded `DecisionBrief` containing:

- question and context;
- zero or more options and consequences;
- an optional recommendation;
- repository and ResearchRecord references;
- an honest research outcome, including unavailable or budget-limited;
- `requiresHumanDecision: true`.

Decision preparation has no dependency on `spec_intake_answer`, Mission
approval, contracts, or completion. The frontend presents the brief and
relays only the user's actual answer through the existing intake tool.
Follow-up explanations reuse the current brief/report unless explicitly
current-sensitive facts require refresh.

## Freshness and cross-phase reuse

Research requests record `currentFactSensitive` and optional
`subjectVersion`. Stable-domain research reuses normally. Current/version
sensitive research also reuses exactly by default, but a caller that needs a
new current check must set the explicit refresh flag. There is no invented
time-based TTL.

## Runtime investigations

An `investigation` WorkUnit builds a bounded packet from its hashed context
projection: goal, known facts, relevant contracts, snapshot/projection refs,
observed failures and strategies when present, constraints, sources, and
questions. It never sends a whole repository, conversation, event history,
unbounded logs, credentials, or secrets.

With research enabled, an eligible investigation first reuses an exact
ResearchRecord or calls the configured ResearchBridge. A successful report
becomes a zero-diff CandidateArtifact and then passes through the unchanged
identity, deterministic-evaluation, semantic-evaluation, aggregation, and
replan pipeline. It is evidence, not build output and not completion evidence.

If DeerFlow is disabled or unavailable, SpecBridge records the structured
degradation and falls back to the existing isolated strong-reasoning
investigator. Provider outage alone does not block a job.

Repeated-failure eligibility is deterministic. The same durable failure
fingerprint must persist across at least two materially distinct strategy
keys. Identical retries do not count. Explicit external gaps, contradicted
external assumptions, and unknown platform behavior not resolved by the
repository are also eligible. Authentication, permissions, Docker/tool
availability, quota, compilation, ordinary deterministic tests, product
ambiguity, and insufficient selected repository context keep their existing
recovery paths. Existing `REPLAN` remains the recovery action; no new enum was
added.

## Authority and completion boundaries

Research may recommend. It may not:

- answer an Intake or Mission question;
- create or approve a Product Contract or CCR;
- authorize a compatibility promise;
- mutate canonical repository files during investigation;
- mark a task, objective, closure item, or job complete.

If research exposes a new product choice or conflict, the normal human/CCR
path receives it. The Completion Oracle and Contract Closure semantics are
unchanged.

## Budgets, telemetry, and explainability

Phase 2 QUICK/DEEP per-operation and per-job budgets remain authoritative.
Exact reuse runs before budget checks and makes no provider call. Telemetry
records considered and avoided questions, gate decisions, new QUICK/DEEP,
reuse, phase distribution, success/inconclusive/failure, reported tokens,
latency, decisions prepared with research, and runtime replans caused by
research. Unsupported cost is never invented.

`researchAvoidanceRatio = avoided / considered` is diagnostic, not routing
policy. Qualification expects new provider calls to remain a minority without
hiding necessary research.
