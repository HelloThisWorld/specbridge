# Governed Research Layer

SpecBridge vNext.10.2 Phase 2 adds an optional external-knowledge escalation.
It can ask a research provider a bounded question, preserve the evidence in a
durable record, reuse an exact prior request, and fail without changing the
control plane. DeerFlow is the first provider.

Research is evidence. It is not product authority, completion authority, or a
default search layer.

## Boundary

```text
structured caller signals
        |
        v
  ResearchGate  -- no model call
        |
        | explicit RESEARCH_QUICK / RESEARCH_DEEP
        v
  ResearchBridge  -- provider-neutral
        |
        v
  DeerFlow adapter
        |
        v
  ResearchReport + durable ResearchRecord
```

DeerFlow thread, memory, sandbox, and subagent state are disposable provider
working memory. The SpecBridge `researchId` and ResearchRecord under
`.specbridge/research/records/` are the durable provenance.

There is deliberately no `ResearchReport -> ProductContract`, Mission
approval, task completion, Contract Closure, or Completion Oracle API.
Provider prose such as “the task is complete” remains report content. A
`PRODUCT_OPTION` remains a recommendation until an existing human/product
decision path authorizes it.

## ResearchGate

`ResearchGate` is a pure deterministic decision over caller-supplied signals.
It never spends another LLM call to decide whether research should run. It
returns one decision and human-readable reasons:

- `ASK_HUMAN` when human product authority is required. This wins over every
  other signal.
- `ANSWER_DIRECTLY` when there is no declared knowledge gap, the repository
  already answers, the uncertainty is not material, or external facts are not
  involved.
- `REUSE_EXISTING` when prior durable research is available.
- `ENGINEERING_DECISION` for a pure engineering choice without material
  external uncertainty.
- `RESEARCH_QUICK` for a material bounded external/current fact gap.
- `RESEARCH_DEEP` when explicitly requested, or when the same unknown remains
  after materially different strategies.

User unfamiliarity is not a gate signal. A caller can answer from reliable
knowledge without research. The intended cost rule is: research is an
escalation, not the default path from every question.

## QUICK and DEEP

`QUICK` and `DEEP` are stable SpecBridge research intents, not DeerFlow mode
names.

- QUICK asks one bounded factual, version, API, compatibility, or operational
  question. The current adapter disables planning and subagents and bounds the
  run to a 100-step recursion limit.
- DEEP covers landscapes, conflicting sources, architectural alternatives,
  hard investigations, and high-impact compatibility research. The adapter
  enables thinking, planning, and subagents with a 300-step limit.

The mapping is private to the DeerFlow adapter. Callers and persisted records
only contain QUICK or DEEP.

## Bounded request and report

Every `ResearchRequest` is schema-validated and capped at 64 KiB. It contains:

- a SpecBridge `researchId`, QUICK/DEEP intent, question, and explicit topic
  tags;
- bounded known facts, observed failures, failed strategies, constraints, and
  context references;
- the exact questions the report must answer; and
- primary/source requirements.

It cannot carry a conversation transcript or repository dump: each array,
string, and the total object are bounded. Credential-shaped material and
private keys are rejected. Context references can point to Phase 1
CurrentSystemSnapshot evidence without copying repository bodies into the
record.

Every `ResearchReport` is provider-neutral, capped at 256 KiB, and contains
structured findings, bounded source metadata, recommendations, unresolved
questions, conflicts, classifications, timestamps, and only usage fields the
provider actually reported. Findings use this closed vocabulary:

- `DOMAIN_FACT`
- `ENGINEERING_CONSTRAINT`
- `COMPATIBILITY_FACT`
- `PRODUCT_OPTION`
- `UNRESOLVED_CONFLICT`

Source references retain a URL, title, provider source id, or short
attribution—not copied source documents. Finding references must resolve to a
source entry in the same report. When sources are required and any finding is
unsourced, the report is `INCONCLUSIVE`, not silently completed.

## Configuration

Research and DeerFlow are both disabled by default. A workspace with no
`research` block performs no provider health check and no research network
request during existing workflows.

```json
{
  "schemaVersion": "2.0.0",
  "research": {
    "enabled": true,
    "provider": "deerflow",
    "strategy": "ON_DEMAND",
    "maxQuickPerOperation": 5,
    "maxDeepPerOperation": 2,
    "maxResearchPerJob": 6,
    "providers": {
      "deerflow": {
        "enabled": true,
        "baseUrl": "http://127.0.0.1:2026",
        "timeoutMs": 300000,
        "maxEventBytes": 262144,
        "maxTotalResponseBytes": 2097152,
        "internalAuthTokenEnvironmentVariable": null,
        "ownerUserId": "specbridge"
      }
    }
  }
}
```

Only an environment-variable **name** may be stored for internal
authentication. At request time SpecBridge reads its value and sends the
current DeerFlow server-to-server headers:

```text
X-DeerFlow-Internal-Token
X-DeerFlow-Owner-User-Id
```

The value is never stored in a ResearchRecord, logged, placed in telemetry,
returned through MCP/CLI, or copied into an error. An unset configured token
maps to `AUTH_FAILED` / `AUTHENTICATION` without making a request.

Endpoint policy is shared with network runner safety: http/https only, no
embedded credentials, loopback HTTP allowed, remote HTTP refused by default,
and remote HTTPS allowed. `allowInsecureHttp` is an explicit development-only
override; it should not be used for production.

## DeerFlow 2.0 API contract

The adapter implements the official DeerFlow `main` API documented on
2026-08-29 in
[backend/docs/API.md](https://github.com/bytedance/deer-flow/blob/main/backend/docs/API.md):

- `GET /health` for an inexpensive health check;
- `POST /api/langgraph/runs/stream` for a stateless first run;
- `Content-Location: /api/threads/{thread_id}/runs/{run_id}` for provider
  provenance, with bounded `metadata` ids as a fallback; and
- SSE `values`, `messages-tuple`, `custom`, error/gap, and `end` events.

The current unified Nginx/Gateway rewrites the LangGraph-compatible path to
the native Gateway run route. SpecBridge does not depend on DeerFlow
persistence and does not continue a provider thread in Phase 2.

The SSE reader enforces a total timeout, external abort, per-event byte cap,
total-response byte cap, malformed JSON handling, provider error/gap events,
early-close detection, bounded final-result extraction, and safe
Content-Location ids. Raw provider streams are not retained.

Health is normalized to `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, `AUTH_FAILED`,
or `UNKNOWN`. Research failures are normalized to `INVALID_REQUEST`,
`DISABLED`, `PROVIDER_UNAVAILABLE`, `AUTHENTICATION`, `NETWORK`, `TIMEOUT`,
`MALFORMED_RESPONSE`, `INCONCLUSIVE_RESEARCH`, `BUDGET_EXHAUSTED`, or
`CANCELLED`, with an existing reliability `FailureSource` such as `PROVIDER`,
`AUTHORIZATION`, or `BUDGET`.

A provider outage produces a structured failed ResearchRecord when execution
started. It does not set a Mission or Job to BLOCKED and no fake report is
created. The caller can fall back to direct model reasoning or another path.

## Persistence, reuse, budget, and telemetry

Each provider execution first writes a RUNNING record and atomically replaces
it with COMPLETED, INCONCLUSIVE, FAILED, or CANCELLED state. All paths are
workspace-confined. Unknown major versions and corrupt JSON are refused,
skipped during enumeration with diagnostics, and preserved unchanged.
`specbridge state validate --research` (and the default full scan) reports
these records through the normal read-only state-health surface; it never
repairs or quarantines research evidence.

Exact reuse hashes a normalized bounded request without `researchId` or topic
metadata. Whitespace/case-only question changes can reuse the existing report
with no provider call. A different request never reuses automatically.
Explicit topic-tag overlap returns candidates only; it is not semantic proof
that the prior answer applies. There is no vector cache, embedding search, or
semantic Research Cache.

Callers can provide an `operationId` and `jobId`. QUICK and DEEP counts are
bounded per operation, and all provider executions are bounded per Job.
Budget refusal is explicit `BUDGET_EXHAUSTED` and occurs before the provider
call.

`.specbridge/research/telemetry.json` makes these aggregate diagnostics
available: gate decisions, provider calls, successes, inconclusive results,
failures, exact reuse, budget refusals, provider-reported tokens/cost/subagent
count, and duration. Unknown provider usage remains absent from a report; it
is never invented.

## Manual CLI and MCP surfaces

```bash
specbridge research status
specbridge research investigate "Does current platform X require Y?" \
  --depth QUICK --answer "Is Y required?" --topic platform-x
specbridge research show <research-id>
specbridge research list --topic platform-x
```

The agent-facing MCP tools are:

- `research_gate`
- `research_start`
- `research_get`
- `research_list`
- `research_provider_status`

There is intentionally no research approval, contract-application, or task-
completion tool.

## Optional live qualification

Normal CI uses a local fake HTTP/SSE server. To qualify a real deployment:

```powershell
$env:SPECBRIDGE_TEST_DEERFLOW_URL = 'http://127.0.0.1:2026'
node_modules\.bin\vitest.cmd run tests/research/deerflow-live.test.ts
```

Set `SPECBRIDGE_TEST_DEERFLOW_DEEP=1` only when a DEEP qualification run and
its additional cost are intended.

## Phase boundary

Phase 2 does not automatically invoke research from a Claude/Codex
conversation, `spec-draft`, Spec Intake, an UNKNOWN/STALLED runtime state, or
an `investigation` WorkUnit. Phase 3 may call these explicit primitives from
those lifecycles. This phase also does not add a Secondary/Qwen Builder, LLM
Gateway, ModelTarget Registry, OpenMind, vector RAG, reusable Tool Registry,
remote agent execution, or new completion/authority semantics.
