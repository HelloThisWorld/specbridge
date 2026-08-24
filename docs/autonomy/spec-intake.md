# Zero-Touch Spec Intake (vNext.10.1)

vNext.10 made a long-horizon run survive without a person. It started at a
**Mission Seal** — and creating one took eight commands.

vNext.10.1 removes the eight commands, not the authority. The user submits a
specification, answers whatever genuinely needs their judgment, and approves
once. Everything from that instant is the vNext.10 unattended runtime.

```
existing repository + one new specification
        ↓
repository-grounded discovery
        ↓
only genuine product questions
        ↓
ONE human approval  ──────────────────  the zero-touch boundary starts here
        ↓
synthesis · derived approvals · seal · preflight · launch
        ↓
vNext.10 unattended runtime
        ↓
COMPLETED
```

## The workflow

```bash
specbridge spec start airport-demo --file ./demo-spec.md
specbridge spec answer airport-demo Q-001 "Strict: an existing definition must run unchanged."
specbridge spec approve airport-demo --build
```

Four commands and one flag, of which exactly **one** carries human authority.

| Command | What it does | Authority |
| --- | --- | --- |
| `spec start <name> --file\|--text\|--stdin` | Ingest a specification and run discovery | none |
| `spec discover <name>` | Re-run discovery; show open questions | none |
| `spec answer <name> <Q> "…"` | Record one human product answer | records the human's words |
| `spec approve <name> --build` | **Approve and build** | the one authorization |
| `spec intake [name] [--resume]` | Inspect; resume an interrupted build | none |

The Claude Code plugin exposes the same path as `/specbridge:build`, over
three MCP tools — `spec_intake_start`, `spec_intake_read`,
`spec_intake_answer`. There is no `spec_intake_approve` and there will not be
one: the approval authorizes an unattended build and belongs on the CLI
beside `autonomy seal` and `mission ccr`.

**Nothing was removed.** `mission begin`, `mission contract-ready`,
`mission synthesize`, `spec approve --stage`, `autonomy seal`,
`overnight preflight`, and `overnight run` all still work exactly as they
did. The new path is a higher-level orchestration of those authorities, and a
workspace that never uses it behaves as it always has.

## Full spec intake

`mission begin --goal "one or two sentences"` was never going to carry a real
specification. `spec start` takes the whole document.

The submitted document is stored **verbatim**, content-addressed, under
`.specbridge/intake/<id>/source/<sha256>.md`, before anything is parsed. That
ordering is the point: the parse is SpecBridge's *reading* of the document,
and if the two ever disagree, the document wins. A model summary never
replaces it.

The parse is a deterministic index over those bytes:

- one chunk per heading, fenced block, **list item**, and paragraph;
- byte offsets, so the original text is always recoverable exactly;
- a kind per chunk: `normative`, `non-goal`, `scenario`, `example`,
  `narrative`, `heading`.

List items are cut individually on purpose. A real specification enumerates
its edge cases as a bullet list, and treating the list as one chunk would let
a discovery pass account for "the edge cases" collectively while quietly
dropping four of them.

**A bullet is an obligation** unless it is plainly an illustration. An earlier
version demanded a modal verb and filed "Sequential execution is
deterministic" as narrative — which dropped it out of the coverage gate that
exists to stop exactly that. Erring toward normative errs toward accounting
for more of the document.

## Repository-grounded discovery

Discovery in an existing repository is not product design. The product
already exists, it already made promises, and somebody already decided how it
is laid out. So: read first, ask later, and only about what reading could not
settle.

Two categories come out, and keeping them apart is the whole job.

**Authoritative** evidence is existing product truth — sealed contracts,
constitution rules, ADRs, prior seals, approved specs, prior feature lineage.
It can answer a product question, and a new feature never overwrites it.

**Context** is everything else — modules, the build system, test surfaces,
public interface files. It informs engineering decisions, which are delegated
and therefore never asked about.

Everything is read-only and offline. The head commit comes from reading
`.git` directly rather than spawning git.

## Delta Authority Analysis

For every material statement: *does this need authority somebody already
gave, authority this specification itself gives, or authority nobody has
given yet?*

| Class | Meaning | Human attention |
| --- | --- | --- |
| `NEW_DELEGATED_SURFACE` | A new public surface **this specification authorizes** | no |
| `IMPLEMENTATION_DETAIL` | Engineering latitude inside the seal | no |
| `EXISTING_CONTRACT_COMPATIBLE` | An existing contract already promises it | no |
| `EXISTING_CONTRACT_EXTENSION` | Adds to an existing contract its policy permits adding to | no |
| `EXISTING_SEALED_CONTRACT_CHANGE` | Would change an existing sealed promise | **yes** |
| `CONTRADICTION` | Contradicts an active contract, invariant, or constitution rule | **yes** |
| `UNKNOWN_PRODUCT_AUTHORITY` | Blocked on an open product question | **yes** |

Getting this wrong is expensive in both directions, and the two failures look
nothing alike.

**Over-classifying** puts a human gate in front of ordinary product work. A
new REST endpoint, a new console screen, a new configuration format for a NEW
feature are all public, and none of them modifies an old promise. Being
public does not make something a change to an older promise.

**Under-classifying** silently rewrites a promise the product already made.
That is worse, and it is what the last three classes exist to make
impossible.

A `frozen` contract has no additive form: an item that would extend one is a
change to it, which is exactly what "frozen" means.

A feature intake **never writes into a prior mission's registry**. An
extension becomes a requirement on the feature's own contract and is recorded
on the approval so it is visible; the older contract stays byte-identical.

## Question discipline

Questions before the approval are legitimate. Questions after it are a
defect.

A question is generated only when something in the document is structurally
unresolved: a hedged compatibility promise (`X-compatible or X-like`), a
semantically loaded verb used without a definition (`replay`, `redrive`,
`exactly-once`), a sensitive payload with no stated visibility policy, an
author-flagged ambiguity, or a would-be change to an existing sealed
contract.

Every admitted question carries four fields, and the generator cannot produce
one without all four:

- `kind` — why this is product authority at all
- `productSurface` — what a different answer would permanently affect
- `evidenceGap` — why repository and specification evidence were not enough
- `resolves` — what decision the answer settles

Then **six screens** run on every candidate — including any an agent proposes
through the `DiscoveryProposer` seam — and each refusal is recorded:

1. `ENGINEERING_DECISION` — asks about a delegated surface. Runs first and
   unconditionally.
2. `ELABORATION_NOT_DECISION` — asks for detail, not a decision.
3. `IMMATERIAL_TO_PRODUCT` — every valid answer produces the same authority.
4. `DUPLICATE` — an equivalent question is already open.
5. `ANSWERED_BY_EVIDENCE` — existing product authority settles it.
6. `ANSWERED_BY_SPECIFICATION` — the document settles it.

`ENGINEERING_QUESTION_SURFACES` is a **negative list**, the mirror of
`NON_AUTHORITY_SIGNALS` in the Authority Firewall: framework choice, library
choice, build tool, package naming, module decomposition, transport, database
schema, broker topology, test framework, test structure, retry
implementation, tooling creation, file layout, code style, deployment
topology. A test enumerates it and proves no member reaches a human.

Inspect the refusals any time:

```bash
specbridge spec intake <name> --json    # includes every refusal and its reason
```

## Convergence

More detail is always obtainable, so "have we asked enough?" cannot be a
judgment call. Four deterministic gates, all derived from durable state:

1. every normative statement is accounted for — carried, questioned, already
   true, or explicitly excluded;
2. no product question is open;
3. delta authority analysis is complete;
4. the mission's own coverage gate holds.

When all four hold, the intake is `READY_FOR_APPROVAL` and discovery
**stops**. There is no fifth gate a model could argue itself into.

Gate 1 is what makes a long specification safe: a reading that dropped
section 9 leaves nine `UNACCOUNTED` chunks and the gate refuses. If a
specification carries more material public statements than one mission record
can hold, the gate says so and asks for it to be split — rather than crashing
on a schema bound or building three-quarters of it.

## The single approval, and derived approval

`spec approve <name> --build` writes one immutable record under
`.specbridge/intake/<id>/approval.json`. Every field is a **reference or a
digest** — a record that restated the requirements in its own words would be
a new set of requirements nobody read.

`authorityDigest` hashes exactly the approved product truth: goal, non-goals,
decision ids, constitution rule ids, ADR ids, contracts with revisions and
element ids, acceptance criteria, and the human's recorded answers. Ordering
is not authority; a contract revision is.

The compiler then projects that truth into `requirements.md`, `design.md`,
and `tasks.md`. Asking the same person to approve the same truth three more
times because three files came out is ceremony, not governance — so the
authority **derives**, under one condition this proves rather than assumes:

> the projection must contain no semantic authority the human did not
> approve.

Every normative line in the three documents is extracted and traced back to
an approved element. If one traces to nothing, the derived approval **fails**
— not warns. An artifact carrying an unapproved promise is exactly the
artifact a human needs to read.

What is recorded is honest about what it is:

```jsonc
"requirements": {
  "status": "approved",
  "approvedHash": "…",                              // the real byte hash
  "approvalMode": "DERIVED_FROM_INTENT_APPROVAL",   // NOT a forged human receipt
  "sourceApprovalId": "approval-…",                 // which human decision
  "authorityDigest": "…"                            // over what truth
}
```

An absent `approvalMode` means `HUMAN`, so every approval recorded before
vNext.10.1 reads exactly as it did, and `spec approve --stage` still writes
one. The question *which human decision authorized this artifact?* has an
answer under both modes.

## The atomic seal-and-build transition

From the user's side this is one thing. Underneath it is nine durable
transactions:

```
CONTRACT_READY → SYNTHESIZE → VALIDATE_PROJECTION → DERIVE_APPROVALS
   → SEAL → PREFLIGHT → RESOLVE_PREREQUISITES → CREATE_JOB → LAUNCH
```

A durable step ledger (`lifecycle.json`) records each step as `RUNNING`
before it acts and settles it after. On re-entry the lifecycle does **not
trust that record**: it asks durable reality whether the effect already
exists — is the mission `CONTRACT_READY`, does the spec exist, is the seal
authorized, does the job exist — and marks the step `RECONCILED` when it
does. Reality is the authority; the ledger is the plan.

```bash
specbridge spec intake <name> --resume   # idempotent; continues from the first unsettled step
```

Two refusals are worth naming:

- **A human-only prerequisite stops before the job exists.** Preflight is step
  6 and job creation is step 8, deliberately. Discovering at 02:40 that docker
  was never installed is the failure this phase exists to prevent, and a job
  nobody launched is a worse artifact than a clear refusal.
- **A diverging projection stops before the seal.** Sealing an artifact that
  carries unapproved authority would authorize it.

Preflight also **pre-authorizes** what the runtime says it will provide. A
`SATISFIABLE_AUTONOMOUSLY` capability is put through the Toolsmith broker
while somebody is still awake; a denial becomes a human prerequisite instead
of a surprise at 03:00.

## The telemetry boundary

```
discoveryHumanTurns                  answers given BEFORE authorizing — never a failure
productQuestionsAsked                what discovery asked
questionsRefused                     what it declined to ask — the honesty check
authorityApprovalCount               exactly 1 for a completed intake
humanInterventionsAfterSeal          the vNext.10 metric, measured from the approval
humanAuthorityEscalationsAfterSeal   correct authority stops after it
```

`null` means unknown, never zero. An intake with no job has not achieved zero
interventions; it has not been measured.

The boundary is the approval instant. Before it, a question is the product
working. After it, an ordinary engineering question is a **bug**.

## Feature lineage

A repository receives many specifications over time, and the second one must
see what the first promised. `.specbridge/intake/baseline.json` records, per
feature: the baseline commit, the seals already in force, and the contracts
created, extended, or changed. Grounding reads it — which is what makes
discovery get smarter rather than start over.

## Persistence

```
.specbridge/intake/
  baseline.json                  product baseline + feature lineage
  <intakeId>/
    intake.json                  the intake state
    source/<sha256>.md           the submitted specification, VERBATIM
    source.json                  provenance + deterministic chunk index
    grounding.json               repository-grounded discovery report
    delta.json                   delta authority analysis
    questions.jsonl              admitted product questions (fold by id)
    refusals.jsonl               candidates declined, and why
    approval.json                THE human authorization (immutable)
    projection.json              projection equivalence verdict
    mission-map.json             delta item → mission record (idempotence)
    lifecycle.json               the seal-and-build step ledger
    events.jsonl                 append-only intake history
```

## Security invariants

Every vNext.10 invariant holds, and the intake path adds none of its own
latitude:

- **Agents cannot approve.** No MCP tool authorizes a build. The approval is
  CLI-only, and the bundled plugin is verified to expose no approval tool of
  any kind.
- **Agents cannot forge a seal.** The seal is created by the lifecycle from an
  immutable approval record and records its channel honestly as
  `intake-approval:<id>`.
- **New authority never rewrites old.** A feature intake writes only its own
  mission's registry; a prior contract stays byte-identical.
- **Derived approval proves provenance** or fails.
- **The Authority Firewall is unchanged.** A seal the machine created behaves
  exactly like one a person created: `sealed-contract-change` is still
  `NEEDS_AUTHORITY`, and every `NON_AUTHORITY_SIGNAL` at once still cannot
  produce a human gate.
- **Ingested text is data.** A sentence inside a submitted document that
  addresses the reader can, at most, cause one bounded question record to be
  written for a human. Nothing in a document can close a question, lower a
  materiality, or approve anything.

## The Golden Spec dogfood

The path was proven on the real thing: a raw airport passenger identity /
boarding validation workbench specification submitted into the **StepRelay**
repository, which already carries an approved mission, nine sealed contracts,
and an approved spec.

```text
3,462 bytes  ->  67 sections  ->  84 pieces of repository evidence
             ->  59 material statements classified
             ->  4 product questions, 1 refused
             ->  4 recorded answers
             ->  ONE approval
             ->  9 contracts · 27 acceptance criteria · 84 closure items
             ->  55/55 normative statements traced
             ->  seal · preflight · launch
```

**The four questions it asked**, all genuinely product authority, all
predicted in advance by the person who wrote the specification:

1. How strictly must this match Step Functions — an exact compatibility
   promise, a named subset, or an authoring resemblance?
2. What does *replay* promise: a new execution seeded from the original, or
   the original resumed in place?
3. What does *redrive* promise: only the failed states, or the whole
   execution?
4. The specification carries passport, boarding-pass, and face-photo
   payloads and states no visibility policy — may they be persisted, returned
   by the API, and shown in operational views?

**What it did not ask.** "Use one Spring Boot demo application. Different
REST controllers/services inside the same application should simulate
multiple microservices" — thirty statements of that kind classified
`IMPLEMENTATION_DETAIL` and were delegated. No question about Spring Boot,
controller decomposition, Docker Compose topology, the broker, the frontend
framework, or the test runner.

**What it protected.** `CTR-001 r1 "Workflow Definition Schema" (from
steprelay)` was reported as *extended*, not changed. The prior mission's
registry was left byte-identical.

**What it found.** Nine defects that 2,600 tests had not — listed in the
[CHANGELOG](../../CHANGELOG.md#1101-unreleased--vnext101-zero-touch-spec-intake).
Three of them were pre-existing runtime defects the intake path merely
exposed: a driver that died on an unplannable plan instead of escalating, a
blocked job that discarded the evidence it blocked on, and a surface contract
with no size bound.

## Related

- [Overnight autonomy](./overnight-autonomy.md) — what happens after the approval
- [Authority firewall](./authority-firewall.md) — who decides what
- [Contract closure](./contract-closure.md) — how a build finishes
- [Telemetry](./telemetry.md) — the zero-touch metric
- [Mission discovery](../mission/README.md) — the interactive workflow this orchestrates
