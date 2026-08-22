# Context Efficiency Runtime (vNext.7)

The six phases before this one made a job survivable. vNext.1 made it survive
its worker, vNext.2 its quota, vNext.3 and vNext.4 gave the local lane real
execution, vNext.5 bridged a subscription outage with governed spend, and
vNext.6 made it stop doing the wrong thing repeatedly.

vNext.7 answers a narrower question:

> How little can a worker be told, and still succeed?

The distinction from vNext.1 matters, because the two are easy to confuse:

```text
vNext.1:   Do not die when the context window fills.
vNext.7:   Avoid filling it unnecessarily.
```

vNext.1's AutoCompact machinery is untouched here. `ContextLifecycleManager`,
`ContextBudget`, the three compaction levels, delta context, and the
native-compaction adapter all still do exactly what they did. This phase sits
*in front* of them: it decides what goes in, so compaction has less to do.

## The one invariant everything follows from

```text
Context window   = disposable working memory.
SpecBridge state = canonical memory.
```

vNext.7 adds two more:

```text
Retrieval and compression may REDUCE working context.
They may never rewrite or replace canonical engineering truth.

Send context according to EXECUTION SHAPE.
A tool-capable harness gets pointers; a direct model gets bytes.
```

## The pipeline

```text
                    Durable Task State
                            |
              +-------------+-------------+
              |                           |
        Canonical Context            Repository State
        (contract, criteria,               |
         checkpoint, failures)       RepositoryContextIndex
              |                            |
              |                        Retrieval
              |                            |
              +-------------+--------------+
                            |
                    ContextSelectionPlan
                            |
                     Context Strategy
              +-------------+-------------+
              |                           |
          DIRECT_MODEL                 HARNESS
       (MATERIALIZED shape)         (POINTER shape)
              |                           |
     bounded working set        pointers + durable state
              |                           |
              +-------------+-------------+
                            |
                  staleness removal
                            |
                     deduplication
                            |
                      compression
                            |
                 stable-prefix ordering
                            |
              vNext.1 budget + compaction
                            |
                      ContextPackage
```

And, critically:

```text
context miss  ->  Reliability diagnosis  ->  bounded progressive expansion

NOT

context miss  ->  the whole repository into the prompt
```

## Strategies

`orchestration.jobs.context.efficiency.strategy` selects one of three:

| Strategy      | Retrieval | Compression / dedupe / staleness | Widening |
| ------------- | --------- | -------------------------------- | -------- |
| `LEGACY`      | none      | none                             | none     |
| `SELECTIVE`   | yes       | yes                              | none     |
| `PROGRESSIVE` | yes       | yes                              | bounded, evidence-driven |

**`LEGACY` is the default.** An upgraded workspace keeps byte-identical
vNext.6 context behaviour — same items, same order, and no new files written
into the job namespace — until its owner opts in. That is the same
conservative-rollout policy the API gap bridge follows, and for the same
reason: a phase that changes what every worker sees should not change it
during an upgrade nobody asked for.

`LEGACY` is a single branch in `buildEfficientContext`, not a pile of disabled
flags, which is what makes it a genuine rollback rather than a configuration
of the new behaviour.

## The repository context index

A derived, rebuildable, offline map of what the workspace contains.

```text
repository baseline -> index -> file changes -> invalidate affected entries
                                             -> incrementally refresh
```

Three properties define what it is, and more importantly what it is not:

- **Derived.** Computed from the repository plus canonical SpecBridge state,
  and never either of them. Deleting it costs a rebuild. Corrupting it is
  answered by rebuilding, never by trusting it. It lives in
  `.specbridge/cache/context-index.json` — deliberately *outside* the job
  namespace, so "delete the cache" is obviously safe.
- **Bounded.** It stores metadata: paths, hashes, sizes, declared symbols,
  import specifiers, module association, test/source pairing. It never stores
  file bodies. An index that cached content would be a second copy of the
  repository that goes stale — the exact failure this phase exists to prevent.
- **Offline.** No network, no hosted service, no vector database, no embedding
  model. Everything is a deterministic function of bytes on disk.

### Freshness is a hash, never a timestamp

Every entry records a SHA-256 of the exact file bytes. Stat data (size,
mtime) is recorded too, and used *only* as a cheap way to find candidates for
re-hashing. Whether content is current is always a hash comparison, because a
restored backup, a checkout, or clock skew can all produce a plausible
timestamp over different bytes.

At selection time each chosen file is re-read and hash-checked. A mismatch
does not produce the indexed snapshot — it produces the **current bytes**,
plus a recorded `SELECTED_ARTIFACT_STALE` signal. An old body is never shipped
under a claim that it is what the repository says now.

### Boundaries

The scan never leaves the workspace, never follows symlinks, and applies its
exclusions *before* any read — so an excluded file is never opened, not merely
filtered from the results.

Excluded: `.git`, `.kiro`, `.specbridge`, `node_modules` and friends, build
output, dependency caches, binary extensions, lockfiles, files above the size
bound, anything matching the configured `execution.protectedPaths`, anything
`.gitignore` excludes, and credential-shaped paths.

`.kiro` and `.specbridge` are excluded for a specific reason: approved spec
documents and SpecBridge's own state reach a worker through the **canonical**
path (pinned contract, durable checkpoint). Indexing them would let approved
intent arrive a second time as a probabilistically retrieved artifact.

## Retrieval

The query is built **only from durable state** — the task contract, the
acceptance criteria, the current action, the latest failure, the recovery
decision, the changed files. Never from a conversation: a query grounded in
chat would drift with the conversation and would not survive a restart.

Two kinds of signal, kept strictly apart:

- **References** — literal paths and symbols that durable state *names*.
  These are facts.
- **Tokens** — lexical material for similarity. These are hints.

Ranking is deterministic: integer weights over checkable facts (this path was
named, this file is changed, this test covers that source, this module imports
that one), with ties broken on path so the order never depends on map
iteration. Same durable state plus same index produces the same plan, forever.

### Mandatory references

Four reasons are **mandatory** — neither heuristic ranking nor the optional
reranker may drop them:

```text
EXPLICIT_CONTRACT_REFERENCE
EXPLICIT_FAILURE_REFERENCE
EXPLICIT_ACTION_REFERENCE
CHANGED_FILE        (bounded — see below)
```

`CHANGED_FILE` is bounded to the first N changed paths (default 12, sorted).
A changed file is strong evidence when a handful are in play. It stops being
evidence when the working tree has two hundred dirty paths — at that point
"changed" says something about the branch, not the task, and an unbounded
mandatory set would let the working tree overrule the budget and squeeze out
the contract itself. Beyond the bound, changed files still score their full
weight; they simply stop being undroppable.

The three reasons that come from *policy* rather than from disk stay mandatory
however many there are.

### Optional local reranking

A bounded local model may refine the **order** of the top candidates. It is
off by default and constrained by construction:

- it sees **metadata only** — paths, kinds, sizes, declared symbols, and the
  deterministic reasons. Never file bodies. Sending the repository to a local
  model to decide what to send to another model would spend the very budget
  this phase saves, and would hand repository text an injection surface into
  ranking;
- it returns an ordering over ids it was given. Invented ids are discarded;
  omitted ones keep their deterministic rank;
- it can never remove a mandatory reference;
- unavailable, slow, or invalid output falls back to the deterministic order,
  which was always a complete answer.

The deterministic candidate set is preserved on the plan alongside the
reranked one, and `localRerankApplied` records that the model had an opinion.

## Execution-shape-aware assembly

The shape is decided by what the worker can do for itself, never by which
provider it is.

| Shape          | Worker                          | Receives |
| -------------- | ------------------------------- | -------- |
| `MATERIALIZED` | no repository tools             | the bounded working set, with paths and hashes |
| `POINTER`      | reads the repository itself     | canonical state it cannot recover, plus high-value pointers |

Sending both — a full working set *and* tools — pays for the same information
twice, which is the largest avoidable context cost in an agentic runtime. A
pointer costs a line; the file it names can cost thousands of tokens, and a
tool-capable worker fetches it at the moment it needs it, with content that is
current by construction rather than current as of assembly.

Mandatory status governs **selection**, not materialization. A reference
durable state named always reaches the worker and cannot be ranked away — but
in a POINTER package it arrives as a pointer, placed first and flagged
"read first", because that worker can fetch current bytes and a copy in the
prompt would only be current as of assembly.

### The paid lane

For `lane = API`, `executionMode = HARNESS`, the same POINTER shape applies
with a much smaller working-set ceiling. Unrelated repository content never
leaves the machine — which is simultaneously a token-efficiency property and a
data-minimization one.

## File sections

For a large file with a locatable structural boundary, retrieval selects a
section rather than the whole body: the enclosing declaration, plus the
import/header preamble, plus a margin.

Where the structure cannot be read reliably, the **whole bounded file** is
included instead. A fabricated "relevant region" is worse than a big one — it
looks authoritative, it is missing the part that mattered, and nothing
downstream can tell.

## Compression

Deterministic extraction first; the local model only for the residue.

| Artifact         | Method                    | Preserved |
| ---------------- | ------------------------- | --------- |
| test output      | `test-log-v1`             | failing tests, assertions, first stack frames, counts |
| compiler output  | `compiler-log-v1`         | error code, file, line, message, per-code counts |
| lint output      | `lint-log-v1`             | rule, location, message, per-rule counts |
| diff             | `diff-summary-v1`         | files, insertions/deletions, hunk headers |
| anything else    | `repetition-collapse-v1`  | distinct line signatures with counts |
| unstructured bulk| `local-model-v1`          | a bounded local summary, source-referenced |

Two invariants govern every extractor:

- **Identity is preserved.** The fields a failure fingerprint is computed from
  survive verbatim, so vNext.6 no-progress detection still recognises a
  repeated failure after compression.
- **Deterministic.** Same bytes in, same bytes out — which is what makes a
  fingerprint computed over compressed output comparable across attempts.

Compression is **derived** data. The canonical raw artifact stays where it
already lives under its existing retention policy; the prompt gets the
compressed representation plus the references to fetch the original. Source
files are never compressed: a lossy version of the code being edited is worse
than no saving at all.

Small artifacts are not compressed. Spending compute to turn a 500-byte error
into a 450-byte summary is a loss on both axes.

## Deduplication and staleness

Deduplication keeps the highest-**authority** representation:

```text
CANONICAL  >  TRUSTED  >  DERIVED  >  CLAIM
```

Conflicting facts are never merged into an invented compromise: the higher
authority survives verbatim and the drop is recorded, so a diagnostic can say
"an old model summary contradicted the current checkpoint and was discarded".

Staleness removes what has stopped being true *before* dispatch — an old file
body after an edit, a diff against a superseded baseline, a test failure a
rerun has since resolved. Each item declares what would invalidate it
(`freshness`), and an item whose freshness cannot be *checked* is kept:
removing context on a suspicion would be its own kind of context miss.

Freshly retrieved items skip this check entirely. They were read and
hash-verified microseconds earlier, so re-checking them against the index
would let a lagging index invalidate content provably fresher than itself.

## Progressive expansion

```text
Level 0  MINIMAL_BOOTSTRAP
Level 1  TOP_WORKING_SET            <- default
Level 2  ADJACENT_DEPENDENCIES
Level 3  MODULE_CONTEXT             <- default ceiling
Level 4  BOUNDED_FALLBACK
```

Widening is deliberately hard to trigger and easy to stop. It requires
**observed** evidence of insufficiency, advances exactly one level, consumes a
budget (per attempt and per task), and is refused once the working set has
grown past a configured multiple of its first size.

The ceiling is a bounded fallback, never "the repository". A task whose
working set genuinely will not fit is a decomposition problem, and Reliability
and Planning own that decision. The context layer reports the pressure; it
does not route around it.

### Context miss is not intelligence failure

This is the distinction the phase exists for. Six observable signals:

```text
WORKER_REPORTED_MISSING_CONTEXT     the worker named an artifact it lacked
UNKNOWN_SYMBOL_REFERENCE            it referenced a symbol nothing sent declares
SELECTED_ARTIFACT_STALE             a selected file's hash had already moved
MANDATORY_REFERENCE_DROPPED         the budget could not fit a named reference
DIRECT_MODEL_REQUESTED_REPOSITORY   a tool-less model declined for want of code
FAILURE_IN_UNSELECTED_FILE          the failure points into a file never sent
```

Every one is something SpecBridge *watched happen*. A worker asserting "I need
more context" without naming anything produces **no** signal — that claim is
exactly what an underperforming model says, and acting on it would let a
worker request its own budget increase.

When signals are present, the failure `source` becomes `CONTEXT`, which
vNext.6 already treats as a reason to fix the context rather than to buy a
bigger model. The recovery planner then decides:

```text
EXPAND_CONTEXT              widening is available -> one bounded level
CONTEXT_EXPANSION_EXHAUSTED widening is spent     -> change strategy instead
```

`EXPAND_CONTEXT` is distinct from `RESTART_FRESH_CONTEXT` on purpose. A
restart rebuilds the *same* package from durable state — right for a degraded
session that had what it needed and lost it, wrong for an insufficient one
that never had it.

The separation of authority is preserved throughout: **Context prepares.
Reliability decides. The Scheduler places.** The context layer computes what
widening would mean and whether its budget allows it, and hands that over as
an *offer*. A hard boundary, an exhausted recovery budget, or broken
verification machinery all outrank it.

## Budget allocation

```text
total usable input
├── pinned reserve            contract, criteria, invariants
├── durable-state reserve     checkpoint-backed truth
├── recovery reserve          current failure, assessment, decision
├── recent-delta reserve      newest raw signal
└── working-set budget        retrieved repository context  <- the flexible one
```

Reserves are **floors**, not quotas: a layer that needs less leaves the
remainder to the working set. What a reserve guarantees is that retrieval can
never take the last token a pinned item needed.

Under pressure the drop order is: optional working context first, then
compacted history, then deltas — never pinned, durable, or current-action
state. A mandatory working item may exceed the allocation, deliberately: the
contract named that file, and a budget heuristic does not overrule the
contract. When even that will not fit, assembly fails loudly with
`ContextBudgetError` rather than silently omitting it.

## Stable prefixes and caching

Assembly orders long-lived material first, in a consistent order: runtime
policy, tool boundary, repository conventions, architecture contract, stable
task definition — then checkpoint, working set, delta, current action.

The honesty rule, stated as plainly as it deserves:

> Designing for cache reuse is not the same as observing cache reuse.

Nothing here claims a cache hit, estimates a saving, or reports a discount.
`cachedInputTokens` is recorded **only** when a provider actually reports
cached tokens; when no provider says so, the field is `null` and means
UNKNOWN, never zero. A prefix hash is an observability aid — "did the stable
part actually stay stable between these two attempts?" — and is not a cache
protocol.

An item whose freshness tracks the repository is structurally barred from the
stable prefix, so a stale file body can never be pinned into every subsequent
prompt.

## Metrics

Per attempt, under `.specbridge/jobs/<jobId>/context/metrics/<attemptId>.json`:
strategy, shape, expansion level, lane/mode/runner, per-layer token
composition, retrieved/selected/pointer/excluded counts, compression and
deduplication savings, expansion count, and — separately — the provider's own
reported input and cached tokens.

Two rules keep the numbers honest:

- `estimatedContextTokens` is SpecBridge's conservative heuristic;
  `providerReportedInputTokens` is what a provider actually said. Neither ever
  overwrites the other, and absence is `null`, never zero.
- No caching is ever inferred.

Collected deliberately un-aggregated, so the later adaptive scheduler can ask
questions this phase did not think to pre-compute — above all *what did
context cost per **successful** task*, which is not the same question as
"did we send fewer tokens".

## Explainability

```bash
specbridge orchestrate explain-context <jobId> <nodeId>
```

Answers: what was selected, why each file was included, why each candidate was
excluded, what was compressed, whether anything was stale, how big the package
was, and which runner strategy produced it. `--attempt` targets one attempt;
`--json` emits the machine-readable report.

Diagnostics show **metadata only** — paths, hashes, ranges, categories,
reasons, sizes. Never source bodies or assembled prompts: that is the material
an operator is least likely to expect a diagnostic to emit and the most likely
to paste somewhere public. Anyone who needs the bytes already has the path and
the hash to fetch them.

## Measured results

From `tests/context/context-benchmark.test.ts`, produced on each run against
the fixture repository (146 indexed files):

| Scenario | Baseline | vNext.7 | Reduction |
| -------- | -------- | ------- | --------- |
| single-file bug (DIRECT_MODEL) | whole source tree, 38,096 tokens | 1,640 | 95.7% |
| multi-file feature (HARNESS) | same set materialized, 3,020 | 192 | 93.6% |
| test-failure diagnosis | raw verifier log, 46,539 | 173 | 99.6% |
| repair after failure | rule injected 4×, 124 | 31 | 75.0% |
| architecture-constrained | every ranked candidate, 38,096 | 4,888 | 87.2% |

Each scenario names the baseline it is actually reducing. Comparing SELECTIVE
against LEGACY on total tokens would score retrieval as a regression, because
LEGACY sends no repository content at all — the two are not doing the same
job.

The release gate is **not** "fewer tokens". A strategy passes only when it
reduces redundant or duplicated context *and* preserves the deterministic
outcome: contract, criteria, recovery-critical state, and mandatory references
all still present.

### Performance

From `tests/performance/context-perf.test.ts`, on a 4,001-file repository:

| Operation | Measured |
| --------- | -------- |
| initial index build | ~1,530 ms |
| index size | 5.14 MiB (~1.3 KiB/file, metadata only) |
| incremental refresh (1 changed file) | ~55 ms |
| retrieval ranking over the full index | ~13 ms |
| selection (freshness-verified reads) | ~40 ms |
| full context assembly | ~58 ms |

The shape matters more than the numbers: index build is O(files) and
cacheable, incremental refresh is O(changed files), ranking touches metadata
only and never reads a file body, and selection reads only the handful of
files it chose.

## Configuration

```json
{
  "orchestration": {
    "jobs": {
      "context": {
        "efficiency": {
          "strategy": "PROGRESSIVE",
          "maxSelectedItems": 12,
          "maxPointers": 24,
          "localRerank": false,
          "maxExpansionsPerTask": 3,
          "maxExpansionLevel": "MODULE_CONTEXT"
        }
      }
    }
  }
}
```

Every value is an **operational** bound: it can only make context smaller or
its selection more conservative. Nothing here can drop pinned or durable
state, weaken a protected-path boundary, or let retrieval reach outside the
workspace — those are structural properties of the runtime, not settings.

## Explicit non-claims

1. **Retrieval relevance is not proof that omitted files are irrelevant.**
   Selection is a ranked judgement over metadata. The system handles being
   wrong through provenance, freshness, progressive expansion, and recovery —
   not by pretending retrieval is perfect.
2. **Local reranking is advisory, never authoritative.** It reorders a bounded
   candidate set and cannot remove a mandatory reference.
3. **Compression is lossy derived data.** It preserves failure identity and
   names its sources; it does not preserve everything.
4. **Stable prefixes do not guarantee provider cache hits.** They make caching
   possible. Only a provider's own reported usage records one.
5. **The repository index is derived and rebuildable, never canonical.** No
   job recovery depends on it.
6. **Selective context cannot guarantee the first attempt has every necessary
   artifact.** That is why progressive expansion exists, and why it is bounded.
7. **Symbol and import extraction is conservative and pattern-based.** It is
   not compiler-grade semantic analysis. An entry with no extractable symbols
   ranks on path, token, module, and change evidence instead.
8. **The `.gitignore` matcher implements a documented subset**, not the full
   gitignore language.
9. **Credential-shaped path exclusion is a deterministic path filter, not a
   secret scanner.** It stops files whose *path* advertises credentials from
   becoming remote prompt content. It cannot find a key pasted into an
   ordinary source file.

## Related

- [Survival Runtime (vNext.1)](survival-runtime.md) — the context lifecycle
  this phase sits in front of
- [Reliability, Eval & Recovery Runtime (vNext.6)](reliability-runtime.md) —
  the layer that owns recovery decisions
- [Local Agentic Runtime (vNext.4)](local-agentic-runtime.md) — where
  DIRECT_MODEL and HARNESS execution modes come from
- [API Gap Bridge (vNext.5)](api-gap-bridge.md) — the paid lane whose context
  this phase minimizes
- [Threat model](../security/threat-model.md) — §14, context efficiency
