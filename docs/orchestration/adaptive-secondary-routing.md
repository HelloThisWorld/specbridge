# Adaptive Secondary routing, repair, and Strong fallback

Phase 7 of vNext.10.2 turns the Phase 6 readiness decision into an
explainable Objective-builder route. Eligibility and preference remain two
different decisions:

> `ELIGIBLE` means Secondary is legitimate. It never means Secondary is
> mandatory.

```text
READY WorkUnit
      ↓ Phase 5 packet + Phase 6 readiness
SecondaryEligibilityDecision
      ├─ NEEDS_RESEARCH  → existing research/replan path
      ├─ NEEDS_AUTHORITY → existing human-authority path
      ├─ NEEDS_CONTEXT   → bounded context recovery
      ├─ NOT_READY       → wait for dependencies; no builder call
      ├─ STRONG_REQUIRED → Strong Builder
      └─ ELIGIBLE
             ↓ OFF / AUTO / PREFER + current availability/economics
        Secondary or Strong
             ↓
        trusted verification
             ├─ PASS → normal candidate lifecycle
             └─ FAIL → one bounded Secondary repair by default
                            ├─ PASS → normal candidate lifecycle
                            └─ FAIL → Strong repair-oriented fallback
```

The route is additive to the existing scheduler. It does not rename or
reinterpret `LOCAL`, `SUBSCRIPTION`, `API`, compute locality, or API Gap
Bridge concepts, and it cannot authorize spend or authority that the existing
hard policies forbid.

## Configuration

The compatibility default is `OFF`:

```json
{
  "orchestration": {
    "jobs": {
      "objectives": {
        "secondaryBuilder": {
          "strategy": "OFF",
          "maxRepairAttempts": 1
        }
      }
    }
  }
}
```

`strategy` accepts:

- `OFF`: the legacy Strong-only Objective path remains unchanged and does not
  compile a routing-only packet or readiness record. An explicit qualification
  selection may still exercise Secondary and its Phase 6 admission gate.
- `PREFER`: eligible work uses Secondary when its provider is usable. If it
  is absent, unhealthy, misconfigured, or times out during readiness probing,
  Strong runs immediately; the job never waits solely for optional Secondary.
- `AUTO`: eligible work uses the current deterministic subscription/economic
  mode. `HARVEST` may select Strong to use expiring prepaid capacity;
  `CONSERVE` and exhausted modes prefer Secondary; `NORMAL` currently selects
  Secondary for eligible, available work. Prior failures for the same content
  identity can make Strong sticky. There is no learned score or model router.

`maxRepairAttempts` is an integer from 0 through 3. It counts implementation
repairs after the initial Secondary attempt. The default chain is therefore:

```text
Secondary initial + 1 Secondary repair + 1 Strong fallback = at most 3
builder attempts for this Phase 7 chain
```

Existing job worker-run, elapsed-time, cancellation, safety, authorization,
and spend budgets remain hard ceilings. Phase 7 does not create additional
budget when one of those ceilings is exhausted. Structured-output correction
inside the existing Secondary executor remains separately and narrowly
bounded; it is not multiplied into an unbounded code-repair loop.

## Hard readiness routing

When Phase 7 routing is entered (`AUTO`, `PREFER`, or an explicit Secondary
qualification), Phase 6 hard gates run before strategy or availability. No
strategy, including `PREFER`, may route a non-eligible unit to Secondary.
Plain `OFF` with no explicit selection bypasses the new routing layer and
preserves the existing Strong-only behavior:

| Readiness | Route | Builder usage before recovery |
| --- | --- | --- |
| `ELIGIBLE` | apply OFF/AUTO/PREFER | Secondary or Strong |
| `STRONG_REQUIRED` | Strong | Strong only |
| `NEEDS_RESEARCH` | research/replan handoff | none |
| `NEEDS_AUTHORITY` | human-authority handoff | none |
| `NEEDS_CONTEXT` | bounded context recovery | none |
| `NOT_READY` | dependency wait/recovery | none |

Availability is observational routing input, not readiness. A local provider
outage does not rewrite an `ELIGIBLE` assessment. The next route records the
normalized status (`AVAILABLE`, `UNAVAILABLE`, `MISCONFIGURED`, `UNHEALTHY`,
`START_FAILED`, or `TIMEOUT`) and selects Strong when permitted. The health
check uses the existing managed local server startup/health boundary; it does
not run a coding inference as a probe.

## Repair and continuation

Secondary execution reuses the Phase 4 and Phase 5 path exactly: a bounded
Builder Packet enters the provider-neutral direct-model boundary, strict edits
are validated and applied in the isolated Objective worktree, and trusted
configured verification judges the result. A passing candidate proceeds
through deterministic and any required semantic evaluation, aggregation, and
single-writer integration. No Strong review is inserted merely because the
candidate came from Secondary.

For a repairable failure, the next fresh worktree deterministically replays
the prior candidate patch before inference. The repair packet carries bounded
delta evidence: the prior candidate summary, changed files, a patch excerpt,
the failure summary, refreshed selected source, dependency evidence, and an
instruction to repair the current implementation without redesigning
unrelated code. Full job history and unbounded logs are not included.

An explicit `NEEDS_MORE_CONTEXT` result may move Phase 5 once from
`ADJACENT_DEPENDENCIES` to `MODULE_CONTEXT`, recompile the packet, and use the
same repair budget. It cannot walk the entire expansion ladder.

Problem fingerprints bind the failure kind, bounded verification summary,
and candidate patch hash. Repeating the same fingerprint marks no progress
and makes the Strong fallback sticky. Provider unavailability and cancellation
do not consume the implementation-repair count. Cancellation never triggers a
Strong fallback.

After repair exhaustion, Strong receives the original approved WorkUnit
context plus the prior Secondary patch, changed files, verification failures,
and bounded attempt summaries. Its prompt explicitly continues the existing
WorkUnit and permits it to repair, partially replace, or fully replace bad
Secondary work. Strong gains reasoning capability, not product or contract
authority.

## Durability, resume, and inspection

Routing state is written atomically below:

```text
.specbridge/jobs/<jobId>/objectives/<nodeId>/routing/
  <workUnitId>-<workIdentity>.json
  telemetry.json
```

Each content-identity record contains the decisions, typed reasons,
availability/economic facts, attempt chain, consumed repair budget,
no-progress marker, escalation state, and final backend. Candidate proposals,
patches, changed files, verification evidence, and provider telemetry remain
in the existing candidate and `secondary-attempts` artifacts.

Ordinary resume reads this state. A chain that exhausted Secondary repair goes
to Strong rather than retrying Secondary. The identity excludes timestamps,
attempt numbers, prior-failure prose, and packet quality recalculated from the
candidate's own replayed bytes. It remains bound to the semantic WorkUnit,
approved contract snapshot, targets, verification policy, dependencies, and
relevant research. A material replan or approved-truth/dependency/research
change therefore starts a fresh chain without permanently blacklisting the
WorkUnit ID.

`renderBuilderRouting` exposes readiness, strategy, route, every attempt,
repair-budget use, escalation, and final backend. Typed reason codes include
policy, availability, subscription mode, verification/no-progress, repair
exhaustion, and Strong fallback causes.

Phase 8 keeps routing eligibility separate from temporary compute health. A
Strong decision made while the subscription is cooling remains a Strong
decision, but the WorkUnit is removed from the current runnable set without
consuming its attempt. Independent Secondary candidates continue, and sticky
`STRONG_FALLBACK_REQUIRED` state survives until Strong recovers. See
[Subscription cooldown continuation](subscription-cooldown-continuation.md).

## Telemetry

Routing telemetry records:

- `SecondaryEligible`, `SecondarySelected`, `SecondaryInitialPass`,
  `SecondaryRepairPass`, `SecondaryToStrongFallback`,
  `StrongRequiredDirect`, `SecondaryUnavailableFallback`, and
  `NoModelNeeded` counts;
- route counts, repair count, Strong fallback usage, observed Secondary input
  and output tokens, and Secondary latency; missing provider usage remains
  `null` rather than being invented;
- `StrongBuilderAvoidanceRatio`, defined as:

```text
eligible implementation content identities completed without any Strong attempt
───────────────────────────────────────────────────────────────────────────────
eligible implementation content identities completed
```

`STRONG_REQUIRED`, research, authority, context, and dependency-wait routes
are excluded from that denominator.

## Phase 8 boundary

Phase 7 supplies the bounded production routing and recovery mechanism. It
does **not** certify multi-hour Claude subscription cooldown continuation,
resume-after-reset behavior under a prolonged outage, or a long soak. That is
the dedicated Phase 8 qualification. Phase 7 also does not add an LLM Gateway,
remote or multiple Secondary targets, metered API fallback, learned routing,
OpenMind, vector RAG, or remote agent worktrees.
