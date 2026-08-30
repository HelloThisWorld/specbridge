# Secondary Objective Builder

Phase 4 of vNext.10.2 adds a second implementation backend to the governed
Objective runtime. A bounded direct model can propose concrete file edits for
one build WorkUnit, while SpecBridge retains every authority-bearing action:

```text
ContextProjection (approved truth) + bounded repository context
        ↓ one SecondaryModelInference request
strict CREATE/REPLACE proposal
        ↓ SpecBridge validates and writes
isolated Objective worktree
        ↓ trusted configured verification
normal candidate → evaluation → aggregation → single-writer integration
```

Phase 4 creates capability. By itself it does **not** automatically route
Objective work to the secondary backend. Phase 5
adds deterministic [Builder Packet compilation](builder-packet-compilation.md)
without changing this explicit-only selection rule. Phase 6 adds
[Secondary Work Readiness](secondary-work-readiness.md): an explicitly selected
attempt must be eligible before inference, but eligibility still does not mean
Secondary is mandatory. Phase 7 adds opt-in
[Adaptive Secondary routing](adaptive-secondary-routing.md). Its compatibility
default is `OFF`; `AUTO` and `PREFER` may select this same governed backend and
use bounded repair plus repair-oriented Strong fallback.

## Not an Agent Harness

`SecondaryModelInference` is a provider-neutral, one-request inference
boundary. The first production adapter reuses the configured managed
llama.cpp service and therefore preserves its existing meaning: disabled by
default, same-host, loopback-only, a local GGUF model, and no credentials.
The Objective runtime does not know whether that local model is Qwen, and a
future provider can implement the same boundary without changing candidate
execution.

The model receives no shell, git, filesystem tools, MCP tools, arbitrary
repository reads or writes, package-manager/test authority, or credentials.
Its complete output must be one schema-valid JSON document. Markdown fences,
prose, multiple JSON documents, unknown fields, delete/rename/chmod/symlink
operations, and command/tool fields are refused rather than recovered
heuristically.

## Input and source freshness

`SecondaryBuilderPacket` is versioned, bounded, schema-validated, and hashed.
It carries WorkUnit and Objective identity, goal, expected artifacts/areas,
acceptance criteria, projected contracts, ADRs and approved decisions,
constitution constraints, verified dependency evidence, fixed forbidden
changes, trusted verification names, and compiler-selected source sections,
tests, dependency evidence, and reference patterns.

`ContextProjection` remains approved durable truth. Source is deliberately a
separate repository context with repository identity, path, selection reason,
whole-file hash, exact section hash/range, and bounded current UTF-8 content.
Legacy Phase 4 callers may still provide `sourceContext` explicitly. When an
explicit Secondary selection omits it, Phase 5 compiles the packet from the
WorkUnit and existing `RepositoryContextIndex`.
Immediately before inference, SpecBridge reloads approved Mission truth and
checks projection freshness, then re-reads every source file and checks its
hash and bytes. Stale approved truth or source fails the attempt before the
model runs.

## Edit and authority firewall

`SecondaryBuilderResult` permits only a summary, optional bounded notes, and
bounded full-file `CREATE` or `REPLACE` edits. The shared direct-model
validator rejects:

- absolute, empty, duplicate, traversal, and workspace-escaping paths;
- `.git`, `.kiro`, `.specbridge`, `.codex`, and `.claude` control-plane paths;
- configured protected paths and credential-shaped paths;
- symlink targets or existing symlink ancestors;
- missing `REPLACE` targets, existing `CREATE` targets, non-regular files,
  NUL/binary content, and per-file/total/output size excesses.

This blocks generic direct-model mutation of Mission state, Product Contracts,
approved decisions, approvals, Mission Seals, closure/autonomy records, and
SpecBridge/Claude/Codex configuration. Those domains retain their dedicated
governed mechanisms.

## Worktree, verification, and candidate compatibility

The driver creates the same detached Objective worktree used by the large
builder and applies already-verified dependency patches through the existing
path. SpecBridge applies accepted edits only there. It observes the actual Git
diff against the recorded baseline and runs the existing configured trusted
verification commands; provider notes and completion claims are never
evidence. The canonical checkout changes only later through the existing
single-writer integrator.

A successful result becomes the ordinary `CandidateArtifact`. Evaluation,
aggregation, integration, evidence, and closure contain no secondary-specific
branch. Optional `builderProvenance` identifies the backend, provider/profile,
model label, packet/source hashes, duration, sizes, and token usage without
changing candidate meaning.

## Durable attempts and failures

Each explicitly selected attempt is updated atomically under:

```text
.specbridge/jobs/<jobId>/objectives/<nodeId>/secondary-attempts/
```

The record retains the packet, bounded raw response, validated proposal,
actually applied files, trusted verification tails, telemetry, and a structured
failure. This remains after disposable worktree cleanup and lets normal resume
reconcile an interrupted `BUILDING` unit without claiming completion. A
persisted candidate resumes through the existing candidate evaluation path;
it is not rebuilt merely because the process restarted.

Failure kinds distinguish inference unavailability, timeout, cancellation,
invalid structured output, empty edits, forbidden edits, stale approved/source
context, insufficient or ambiguous retrieval, application failure,
verification failure, and an oversized context. A model may return the
structured `NEEDS_MORE_CONTEXT` status; this records an insufficient attempt
and creates no candidate.
An explicit Phase 4 qualification under the default `OFF` policy remains a
one-shot path. Phase 7 `AUTO`/`PREFER` production routing adds the separately
persisted bounded attempt chain described in
[Adaptive Secondary routing](adaptive-secondary-routing.md). A readiness
blocker retains its research, authority, context, dependency, or
strong-reasoning meaning and is never converted into a silent Secondary call.

## Qualification

Deterministic tests cover strict parsing, bounds, authority and traversal
refusal, symlink escape, source freshness, managed-local unavailability,
worktree isolation, failure preservation, ordinary candidate evaluation, and
full evaluator/aggregator/integrator compatibility. The real managed-local
coding qualification is opt-in:

```powershell
$env:SPECBRIDGE_TEST_LOCAL_BUILDER = '1'
$env:SPECBRIDGE_TEST_LLAMA_SERVER = 'C:\tools\llama.cpp\llama-server.exe'
$env:SPECBRIDGE_TEST_QWEN_GGUF = 'D:\models\qwen.gguf'
pnpm vitest run tests/orchestration/secondary-objective-builder.test.ts
```

The qualification uses the same managed loopback adapter and asks the model
to update a small DTO/mapper. It is gated because CI does not carry a local
GGUF model.
