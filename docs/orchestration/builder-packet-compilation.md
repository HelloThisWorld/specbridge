# Builder Packet compilation

Phase 5 of vNext.10.2 prepares the implementation evidence a bounded direct
model needs. It does not choose a model. An Objective WorkUnit reaches this
path only after a caller explicitly selects the Secondary Objective Builder.

```text
WorkUnit + ContextProjection + verified dependency candidates
                              + trusted verification configuration
        ↓ deterministic query
existing RepositoryContextIndex metadata
        ↓ ranking + bounded structural expansion
fresh bytes from the isolated Objective worktree
        ↓ sectioning + category/character budgets
small, explainable SecondaryBuilderPacket
        ↓ one provider-neutral inference request
normal worktree → verification → candidate lifecycle
```

## Compiler boundary

`BuilderPacketCompiler` is provider-neutral and independently testable.
`SecondaryBuilderContextCompiler` is the managed implementation. Compilation
does not invoke an LLM, run tests, execute commands, or grant repository
tools. It receives the WorkUnit, approved `ContextProjection`, attempt and
baseline identity, verified dependency summaries, bounded prior failure
evidence, trusted verification hints, and a capability-neutral budget.

The compiler returns either a packet or an honest `INSUFFICIENT_CONTEXT` /
`AMBIGUOUS_TARGET` result. It does not guess a target and it does not decide
whether a strong model should run instead.

## Existing index and deterministic retrieval

There is no second search engine. Phase 5 reuses the context package's
`RepositoryContextIndex`, retrieval query, ranking, section extraction,
freshness, budget, and `ContextSelectionPlan` contracts. No vector database,
embedding model, semantic search service, or model reranker is required.

The query is derived from durable WorkUnit evidence: title, goal, expected
artifacts and areas, contract/acceptance text, named paths and symbols,
verified dependency paths, prior selected paths, and bounded failure output.
Ranking preserves the existing hierarchy: explicit and failure references
are mandatory; symbol and test/source evidence outrank dependency and module
proximity; token overlap is only a hint. Nearby same-module implementations
with the same suffix/convention or shared imports may receive the bounded
`REFERENCE_PATTERN` reason. They are labeled as examples, never requirements.

Default expansion stops at `ADJACENT_DEPENDENCIES`: target source, direct
dependencies/dependents, and paired tests. The API exposes the existing
closed expansion levels for a later bounded widening decision; Phase 5 does
not implement an agentic search loop.

## Freshness and worktree state

The canonical repository index is reusable metadata. For an Objective
attempt, the compiler overlays only paths changed between the canonical
checkout and the isolated worktree, including already-verified dependency
patches. This keeps dependency interfaces current without scanning the full
worktree. Unfinished sibling worktrees are never an input.

Only selected files are materialized. Selection re-reads current worktree
bytes and compares SHA-256 hashes. Each packet section carries the complete
file hash plus a hash of the exact supplied whole file or section. Execution
checks those hashes again immediately before inference. A stale cache may be
refreshed, but stale source is never presented as current.

## Packet contents and budgets

Approved truth stays in `ContextProjection`; repository evidence does not
duplicate or replace it. Packet 1.1 contains:

- objective and WorkUnit identity, approved requirements, constraints, ADRs,
  decisions, and verified prior-work summaries;
- explicit targets;
- current implementation source or deterministic source sections;
- relevant tests as a first-class section;
- clearly labeled reference patterns;
- verified dependency-candidate summaries and changed paths;
- bounded prior failure evidence and trusted verification hints;
- retrieval-plan references, expansion level, retrieval metrics, and quality
  facts.

Category and character limits preserve targets and tests before low-value
siblings. Large files use deterministic declaration/line-centred sections;
small files may be included whole. Generated, vendor, ignored, binary,
credential-shaped, protected, unreadable, and oversized artifacts retain the
existing index exclusions. Compilation never runs verification; hints come
only from configured commands and actual verification remains after edits.

## Explainability and semantic identity

Every source, test, and reference item records repository identity, path,
selection reason, file hash, section hash, optional line range, and symbols.
The exact metadata plan is stored under the existing job-scoped context plan
store; source bodies remain repository-derived and are not copied into a new
cache.

`contentHash`/`packetHash` canonically bind WorkUnit and approved-truth
identity, selected repositories/paths/hashes/ranges, dependency evidence,
verification hints, and packet schema. `createdAt` and observational timing
metrics are excluded, so recompiling unchanged logical inputs has the same
semantic identity.

## Multi-repository behavior

Repository identity namespaces every path. A justified cross-repository
WorkUnit may supply multiple bounded indexes and roots, and its packet can
therefore distinguish `backend:src/client.ts` from
`frontend:src/client.ts`. Secondary repositories must be explicitly supplied
and justified; compilation does not make all discovered repositories
available automatically. Edit authority remains with the primary isolated
worktree.

## Context insufficiency

Missing explicit targets, unresolved verified dependencies, protected or
unmaterializable target source, and equal plausible targets stop compilation.
During inference the model may also return `NEEDS_MORE_CONTEXT` with bounded
reasons and no edits. Both paths create no candidate. Phase 6 consumes the
recorded quality facts for
[Secondary Work Readiness](secondary-work-readiness.md); Phase 7 may decide
widening, repair, or fallback. Neither policy exists in Phase 5.

Metrics record indexed files considered, ranked candidates, selected files
and sections, source/test characters, reference/dependency counts, budget
use, mandatory references retained, expansion depth, stale entries,
selection duration, and index reuse. Quality facts record target resolution,
ambiguity, tests, verification hints, reference patterns, dependency
completeness, budget utilization, and structural sufficiency. They are facts,
not routing eligibility.

## Qualification

Deterministic tests cover explicit target retrieval, dependency/test
expansion, reference patterns, budget pressure, sectioning, stale indexes,
missing and ambiguous targets, protected paths, multi-repo identity, stable
hashes, `NEEDS_MORE_CONTEXT`, large-index boundedness, and the automatic
compiler → Secondary Builder → verified candidate flow.

The opt-in real llama.cpp/Qwen qualification now compiles the target source
automatically before inference and records packet metrics. CI skips it unless
the local server/model environment variables documented in
[Secondary Objective Builder](secondary-objective-builder.md#qualification)
are present.

Builder Packet compilation does not decide which model should execute the
task. Phase 6 consumes its results as admission evidence; Phase 7
routing/repair/fallback, LLM Gateway, Vector RAG, and OpenMind are not
implemented here.
