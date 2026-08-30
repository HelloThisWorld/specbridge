# Production qualification and release freeze (vNext.10.2 Phase 10)

Phase 10 does not add another scheduler, provider, authority model, or repair
loop. It turns the existing qualification, autonomy, research, Secondary,
cooldown, closure, and telemetry evidence into one deterministic release
decision:

```text
READY
NOT_READY
```

`PRODUCTION_READY` is emitted only for `READY`. A fast suite, a large test
count, a model claim, or an operator assertion cannot produce it.

## Candidate first

Start a normal qualification run, then freeze the candidate before executing
release gates:

```bash
specbridge orchestrate qualify run --profile full --target /path/to/product
specbridge orchestrate qualify freeze <run-id>
```

`freeze` refuses a dirty SpecBridge checkout. The resulting
`production-candidate.json` records:

- version and exact Git commit;
- SHA-256 runtime digest over tracked package source, contracts, frontend
  runtime bundles, manifests, and lockfile;
- every public schema version;
- Claude and Codex bundle versions and checksum-manifest digests;
- file count, clean-tree fact, and freeze time.

Absolute local paths and credentials are not part of the identity. Runtime
paths are repository-relative, path traversal is rejected, and tracked
symlinks are refused by the release CLI.

Once frozen, do not change the candidate. Qualification logs and evidence
belong under `.specbridge/`, which is excluded from the clean-source check.
A source, contract, bundle, or commit change makes `runtimeMutation` nonzero
and Gate T fails. Fixes require a new commit and a new qualification run.

## The A-T matrix

Every report contains every gate. The only gate results are `PASS`, `FAIL`,
and `SKIPPED_NOT_ALLOWED`; omission becomes `SKIPPED_NOT_ALLOWED`.

| Gate | Required qualification |
| --- | --- |
| A | Full repository suite |
| B | Public contracts and generated artifacts |
| C | Greenfield zero-touch Mission |
| D | Brownfield zero-touch Mission |
| E | Workspace Bootstrap |
| F | Research lifecycle, avoidance, reuse, and real provider behavior |
| G | DeerFlow failure and fallback |
| H | Secondary Builder eligibility and governed execution |
| I | Real local model |
| J | Secondary failure and bounded repair |
| K | Strong fallback with preserved Secondary evidence |
| L | Strong subscription cooldown continuation |
| M | Restart and resume without lost or repeated work |
| N | Historical StepRelay fault replay |
| O | Long unattended soak |
| P | Security and authority |
| Q | Codex, Claude, and supported Windows frontend integration |
| R | Closure and authoritative completion |
| S | Telemetry and report integrity |
| T | Release reproducibility and runtime freeze |

All twenty gates are mandatory for the final vNext.10.2 marker. In
particular, a machine without the configured real local model or required
DeerFlow service produces `NOT_READY`; the release tool does not reinterpret
environment inconvenience as permission to skip.

## Evidence, not assertions

Each passing gate and historical fault has at least one candidate-bound
evidence reference. A reference records its kind, artifact path or immutable
reference, SHA-256 digest, observation time, producer, candidate commit, and
runtime digest. Accepted kinds are:

```text
TEST_RUN
REPORT
FIXTURE
LOG_ARTIFACT
QUALIFICATION_JSON
COMMIT
```

An evidence file consumed by the finalizer has this shape:

```json
{
  "gates": [
    {
      "id": "full-repository-suite",
      "result": "PASS",
      "summary": "Frozen install, lint, typecheck, build and full suite passed.",
      "evidence": [
        {
          "kind": "LOG_ARTIFACT",
          "ref": ".specbridge/qualification/RUN/evidence/full-suite.log",
          "digest": "<64 lowercase hex characters>",
          "observedAt": "2026-08-30T00:00:00.000Z",
          "candidateCommit": "<frozen commit>",
          "runtimeDigest": "<frozen runtime digest>",
          "producer": "release-ci"
        }
      ],
      "diagnostics": []
    }
  ],
  "historicalFaults": [],
  "metrics": {},
  "knownLimitations": []
}
```

The complete schema is exported by `@specbridge/orchestration` as
`productionQualificationEvidenceFileSchema`. Credential-shaped summaries,
diagnostics, references, and endpoint identities are rejected. Raw provider
logs must be redacted before becoming release evidence.

## Finalize exactly once

After all deterministic, real-provider, and soak executors have produced
evidence:

```bash
specbridge orchestrate qualify release <run-id> \
  --evidence .specbridge/qualification/<run-id>/evidence.json
```

Useful output forms are `--json`, `--markdown`, and `--no-write` for a
preview. The final write is intentionally one-shot. It preserves both failed
and successful results and refuses to replace the manifest; a rerun uses a
new run ID.

The reports directory contains:

```text
production-candidate.json
production-qualification-manifest.json
production-qualification-report.md
production-release-decision.json
historical-fault-coverage.json
PRODUCTION_READY.json              only when READY
```

The command never tags, publishes, spends money, changes authority, or starts
a second scheduler. Human release authority remains unchanged.

## Historical fault replay

The versioned `HISTORICAL_FAULT_CATALOG` names all fourteen StepRelay faults,
their symptoms, existing regression targets, and required outcomes:

1. supervisor backoff exit;
2. `CANDIDATE_READY` restart;
3. human answer routing;
4. dependency patch conflict;
5. stale dependency patch;
6. sibling invalidation;
7. unwritable bounded evidence;
8. Git index residue;
9. closure bypass;
10. closure handoff crash;
11. earned evidence missing from closure;
12. scenario-owned closure deadlock;
13. acceptance evidence attribution;
14. authentication/quota misclassification.

Gate N fails if any catalog entry is missing, skipped, failed, unbound to the
candidate, or lacks evidence. Run the named group with:

```bash
pnpm qualification:vnext-10-2:fault-replay
```

## Useful deterministic subsets

```bash
pnpm qualification:vnext-10-2:fast
pnpm qualification:vnext-10-2:fault-replay
pnpm qualification:vnext-10-2:secondary
pnpm qualification:vnext-10-2:research
pnpm qualification:vnext-10-2:cooldown
pnpm qualification:vnext-10-2:soak
```

Subsets produce evidence for their gates. They never mean release
qualification passed. Pull-request CI runs the fast Phase 10 group on one
representative Linux/Node combination in addition to the full cross-platform
suite.

## Zero-tolerance facts

The final decision requires measured values, not missing-as-zero defaults:

```text
humanInterventionsAfterSeal = 0
unexpectedBlocks = 0
unrecoveredDriverDeaths = 0
completedWorkRedoCount = 0
lostCandidates = 0
duplicateDispatches = 0
runtimeMutation = 0
zeroTouchAfterSeal = true
finalJobStatus = COMPLETED
controlPlaneSelfRepairEnabled = false
```

The Phase 9 execution report schema is now `1.1.0`. It exposes runtime start
and end digests plus `runtimeMutation`, `lostCandidates`, and real logical
`duplicateDispatches`. Replayed durable records are still deduplicated but
are not mislabeled as duplicate execution.

## Runtime pin for the first production project

`bindSealToJob` accepts an optional `runtimeIdentity` containing the version,
commit, runtime digest, and qualification run ID. It adds identity, not
authority. The execution report can therefore record the candidate bound at
Mission start and compare it with a digest observed at the end.

Recommended initial production policy:

```text
runtime: exact PRODUCTION_READY version / commit / digest
control-plane self-repair: disabled
research: configured but optional
Secondary: PREFER when healthy
Strong: fallback and strong-required work
automatic unauthorized metered API spend: disabled
runtime upgrades during Mission: disabled
```

If the first production project finds a control-plane defect, preserve the
target state, fix SpecBridge separately, create and qualify a new candidate,
then deliberately resume through the supported migration/restart path. Never
patch the running control plane in place.

DeerFlow failure degrades or falls back, Secondary failure repairs or falls
back, and Strong quota exhaustion waits while independent work continues.
None of those resource events changes the pinned runtime.

## Release authority and freeze

`READY` is a recommendation backed by the immutable candidate and evidence.
Publishing still follows the repository's human-controlled tag/release
process. Once released, the first production project must use that exact
version, commit, and digest—not a later `main` checkout.

Phase 10 deliberately does not add an LLM Gateway, OpenMind integration,
vector RAG, a remote Secondary registry, learned routing, or new scheduler or
authority semantics.
