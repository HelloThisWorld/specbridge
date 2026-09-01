# SpecBridge 2.0 architecture

SpecBridge is a design compiler, not an implementation control plane. Each operation is bounded, persisted, and exposed through a compact CLI/MCP surface. The conversational frontend owns the dialogue; SpecBridge owns the specification artifact.

## Repository Intelligence

Repository Intelligence creates a durable `CurrentSystemSnapshot` and deterministic retrieval index. Scanning is bounded by file count and byte limits, ignores symlinks, binaries, caches, dependencies, and generated output, and records the Git baseline when available.

Facts are classified as `SEALED_PRODUCT_TRUTH`, `DOCUMENTED_ARCHITECTURE`, `OBSERVED_IMPLEMENTATION`, `INFERRED_PATTERN`, or `ASSUMPTION`. Existing source code is observed implementation—not automatic product truth. Relevant context is retrieved through paths, symbols, imports, tests, module proximity, and token overlap instead of a vector database or whole-repository prompt.

## DesignSession

A `DesignSession` is the complete durable state needed to produce one specification. Its lifecycle is deliberately small:

```text
DRAFT → DISCOVERING → NEEDS_INPUT / RESEARCHING → DESIGNING
      → READY_FOR_REVIEW → APPROVED → SUPERSEDED
```

The session stores the repository baseline, stage outputs, material decisions, structured research reports, approval text, and revision. It contains no implementation tasks, workers, attempts, candidates, worktrees, agent sessions, or retry state.

## Product Authority

Question routing has five outcomes:

1. Repository evidence answers repository facts.
2. Stable technical facts are answered directly.
3. Ordinary engineering choices are decided by SpecBridge.
4. Current, uncertain, or version-dependent external facts go to research.
5. Decisions that define product behavior go to the human.

Only the fifth category blocks for product input. Research produces evidence and recommendations; it never silently creates product requirements.

## ResearchProvider and ResearchGate

`ResearchProvider` is a replaceable two-method interface: check availability and return a structured `ResearchReport`. Reports separate facts, constraints, options, and recommendations; record sources, access dates, relevant versions, contradictions, confidence, implications, and unresolved issues.

The `ResearchGate` chooses `ANSWER_DIRECTLY`, `USE_REPOSITORY`, `REUSE_RESEARCH`, `RESEARCH`, `ASK_HUMAN`, or `ENGINEERING_DECISION`. Fresh reports are reused by normalized question. External execution stays outside the domain model, allowing web, Claude, Codex, or future research providers without embedding another agent runtime.

## SystemDesignPipeline

The pipeline advances one validated stage at a time:

1. Problem framing
2. Functional requirements
3. Non-functional requirements
4. Scale and capacity
5. High-level architecture
6. Critical deep dives
7. Alternatives and trade-offs
8. Data design
9. APIs and events
10. Reliability
11. Security
12. Observability
13. Deployment and brownfield migration
14. Testing and acceptance

Each provider request receives only the current stage, rough idea, snapshot, bounded relevant repository context, completed stage outputs, decisions, and research. Schema validation prevents a single unconstrained prompt from becoming the product architecture.

## Spec Compiler

The compiler turns an approved `DesignSession` into a versioned, self-contained Spec Pack beneath `.specbridge/specs/<slug>/`. Markdown is authoritative for humans and coding agents; `spec.yaml` supplies indexing, baseline, revision, approval, goals, non-goals, and document paths. Previous revisions are archived before replacement.

`AGENT_HANDOFF.md` defines the implementation boundary and traceability expectations. Consuming it never requires the SpecBridge runtime. Revision archives retain the previous Spec Pack; manifest entity hashes and change metadata identify changed product decisions, requirements, and acceptance criteria without duplicating their prose.

## Spec Evaluator

The evaluator reports independent findings for completeness, grounding, product clarity, architecture coherence, trade-offs, research, security, reliability, implementation readiness, acceptance coverage, and open risks. Deterministic gates check blocking decisions, requirement-to-acceptance and component-to-requirement traceability, scope creep, contradictions, repository drift, research freshness, and required design sections. An optional model-assisted pass can add semantic warnings or failures but can never erase a deterministic failure. Evaluation is content-bound, so a changed design or repository baseline must be evaluated again before approval.

## Frontend integrations

Claude Code and Codex integrations are thin skill bundles connected to the same canonical MCP command. They recognize natural-language design requests, guide the conversation, invoke one bounded operation at a time, and record explicit natural-language approval. They do not bundle a second runtime or launch implementation agents.

## Product boundary

SpecBridge never launches coding agents, owns worktrees, schedules workers, resumes coding sessions, performs provider handoffs, or retries implementation. After approval, Claude Code, Codex, another coding harness, or human developers independently own all implementation work.
