# Mission Discovery

Mission Discovery is the lifecycle that starts **before** spec authoring: a
high-level product direction ("build StepRelay: a lightweight, config-driven,
distributed workflow engine") is deeply clarified with the human until the
material product and architecture decisions are confirmed, then compiled into
durable contracts and a Kiro spec of approved Objectives.

Two principles govern everything in this document:

> **Share truth, not context.** Agents collaborate through approved,
> versioned artifacts — never by sharing conversational context.
>
> **Model proposes. SpecBridge governs. Evidence decides.**

Mission-driven development is an **additional mode**. Nothing about it is
forced on existing projects: `spec new`, `spec run`, `/specbridge:implement`,
`/specbridge:develop`, and plain orchestration jobs work exactly as before.

## The lifecycle

```text
IDEA
 ↓            first recorded turn
DISCOVERING
 ↕            blocking questions open / resolve
NEEDS_DECISION
 ↓            coverage gate satisfied + explicit call
CONTRACT_READY
 ↓            mission synthesize
SPEC_SYNTHESIS
 ↓            spec created through the existing creation machinery
SPEC_REVIEW
 ↓            every stage approved by the HUMAN (specbridge spec approve)
APPROVED
```

`ABANDONED` is reachable from every non-final status and is final. The
transition table is frozen and fail-closed
(`packages/mission/src/state-machine.ts`); a transition not in the table is
refused with a stable `SBM###` error.

Two transitions deserve emphasis:

- **`CONTRACT_READY` is computed, not claimed.** It is reachable only when
  the deterministic coverage analysis finds no open blocking question and
  every required topic resolved (or explicitly marked not applicable by a
  recorded decision). A model cannot argue its way past this gate, and the
  gate re-evaluates: recording a new blocking question moves the mission
  backwards.
- **Discovery reopens.** From `CONTRACT_READY`, `SPEC_REVIEW`, and even
  `APPROVED`, a material change moves the mission back to `DISCOVERING`
  (`specbridge mission reopen`) — the approval lifecycle restarts for
  whatever changed instead of papering over the gap.

## Where mission state lives

```text
.specbridge/missions/<mission-id>/
  mission.json          versioned state (atomic writes)
  events.jsonl          append-only history
  conversation.jsonl    append-only visible turns
  facts.jsonl           append-only; current view folds by id
  questions.jsonl       append-only; current view folds by id
  decisions.jsonl       append-only; current view folds by id
  coverage.json         the computed coverage snapshot
  constitution.json     the Architecture Constitution (history kept in-file)
  adrs/ADR-####.json    immutable ADR files
  contracts/CTR-###-r###.json   immutable contract revisions
  ccrs/CCR-###.json     contract change requests
  spec-candidates/      synthesized documents + provenance map (audit)
  checkpoint.json       compact structured checkpoint
```

Everything is schema-versioned (all families start at `1.0.0`,
snapshotted in `contracts/schema-versions.json`), bounded, atomic,
workspace-confined, and append-only where history matters. `.kiro` is never
touched by mission state: the zero-migration promise and byte-identical
round trip hold exactly as before.

## Coverage: how gaps are named

Discovery is **not a fixed questionnaire**. Coverage is a pure function from
the recorded facts, questions, and decisions to a per-topic status over a
closed topic taxonomy (goal, non-goals, use cases, system boundaries,
architecture ownership, canonical model, concurrency/failure/retry/timeout
semantics, idempotency, durability, crash recovery, distributed ownership,
protocol identity, public API, configuration semantics, persistence model,
extension seams, compatibility, evolution rules, observability, security,
performance).

Each topic computes to `unknown`, `open`, `resolved`, or `not-applicable`.
A **required floor** (goal, use-cases, system-boundaries, canonical-model,
public-api, failure-semantics, compatibility) must be resolved or explicitly
marked not applicable before `CONTRACT_READY`; every other topic is surfaced
information, never a silent gate. Inspect it any time:

```bash
specbridge mission coverage <missionId>
```

## Materiality and irreversibility

Every recorded question passes a deterministic irreversibility screen
(`packages/mission/src/materiality.ts`). A question is **blocking** when its
answer could materially affect an irreversible surface:

public API · wire protocol · persisted state · configuration language ·
SDK contract · extension SPI · compatibility promise · security boundary ·
failure/delivery semantics · cross-module architecture

The screen merges the proposer's declared surfaces with keyword analysis of
the question text, and **may only raise** the declared materiality — a model
that under-declares "what is the wire protocol?" as an implementation detail
still gets a blocking question. Implementation-detail questions are recorded
and surfaced but can never stall discovery.

Only open **blocking** questions prevent `CONTRACT_READY`.

## Who does what

| Action | Authority |
| --- | --- |
| Talk to the user, propose facts/questions/decisions/artifacts | the interactive agent (`/specbridge:discover`) |
| Validate provenance, screen materiality, compute coverage, assign ids | SpecBridge (`mission_assess`) |
| Answer blocking questions | the human (`mission answer`, `mission_answer`) |
| Reach `CONTRACT_READY` | the deterministic coverage gate |
| Synthesize the spec | SpecBridge (deterministic compiler) |
| Approve the spec stages | the human only (`specbridge spec approve`) |
| Approve a contract change request | the human only (`specbridge mission ccr --approve`) |

No MCP tool, no skill, and no worker can approve anything. The mission MCP
surface exposes creation and reading; the two human decision paths (spec
approval, CCR decisions) exist only as explicit CLI actions.

## CLI surface

```bash
specbridge mission begin <name> --goal "<direction>"
specbridge mission status [--json]
specbridge mission show <id>
specbridge mission events <id>
specbridge mission coverage <id>
specbridge mission answer <id> <questionId> <answer…>
specbridge mission contract-ready <id>
specbridge mission synthesize <id> [--spec-name <name>]
specbridge mission contracts <id>
specbridge mission adr <id> [adrId]
specbridge mission ccr <id> [ccrId] [--approve|--reject] [--note <text>]
specbridge mission decisions <id>
specbridge mission reopen <id> --reason "<why>"
specbridge mission abandon <id> --reason "<why>"
```

All business logic lives in `@specbridge/mission`; the CLI and the MCP
server are thin adapters over the same functions.

## Related

- [Conversation provenance](conversation-provenance.md) — how every decision
  traces to a visible exchange.
- [Architecture Constitution and ADRs](architecture-constitution.md)
- [Contract Registry and change requests](contract-registry.md)
- [Mission → spec synthesis](spec-synthesis.md)
- [StepRelay walkthrough](steprelay-walkthrough.md) — the full dogfood flow.
