# StepRelay: the mission-driven walkthrough

StepRelay is the dogfood scenario the whole mission capability is proven
against — a realistic middleware product, not a toy task. The complete flow
below runs offline in CI against fake model fixtures
(`tests/orchestration/steprelay-mission-e2e.test.ts` and
`objectives-aggregation-e2e.test.ts`); with a real Claude Code installation
the same commands drive real workers.

It starts with only this:

> Build StepRelay: a lightweight, config-driven, distributed workflow
> engine for event-driven systems. Workflow owns orchestration. Actions own
> business logic. The engine should be broker-neutral and extensible.

## 1. Discovery

```bash
specbridge mission begin steprelay --goal "Build StepRelay: …"
```

Then, in Claude Code, `/specbridge:discover steprelay`. The session records
every material visible exchange and proposes structure; SpecBridge governs
it. Discovery surfaces the unresolved **material** topics — may an action
determine the next workflow state? what are the delivery semantics? is
execution state durable? how are duplicates and late results handled? what
binds an execution to a definition version? — while implementation-detail
questions (heap vs sorted list in the scheduler) are recorded as
non-blocking and never stall anything. The deterministic irreversibility
screen classifies "what is the wire protocol of action results?" as
blocking even if it was proposed as a detail.

The user answers the blocking questions
(`specbridge mission answer steprelay Q-001 "The workflow definition owns
all control flow…"`), and decisions accumulate with turn-level provenance.

## 2. Contract synthesis

As decisions crystallize, the session records the durable artifacts:

- the **Architecture Constitution** — `CON-001 Workflow definition is the
  sole authority for control flow`, `CON-002 Actions never determine
  workflow transitions` (with the machine-checkable guard pattern
  `nextState\s*[:=]`), duplicate/late-result safety, …
- **ADRs** — e.g. definition-version binding with alternatives and revisit
  conditions;
- the **Contract Registry** — the canonical workflow model, the action
  request/result protocols, the broker-neutral transport SPI.

When coverage is complete:

```bash
specbridge mission synthesize steprelay
specbridge spec approve steprelay --stage requirements   # human
specbridge spec approve steprelay --stage design         # human
specbridge spec approve steprelay --stage tasks          # human
git add .kiro && git commit -m "steprelay: approved mission spec"
```

`tasks.md` now holds objectives ("Event-driven execution") with acceptance
criteria — not coding steps.

## 3. Autonomous execution

```bash
specbridge orchestrate run steprelay
```

The persistent job takes over. For each objective:

- the **DECOMPOSER** proposes a work graph (e.g. canonical message envelope
  → transport adapter seam → integration); validation accepts it, or the
  deterministic single-unit fallback proceeds;
- each **builder** runs in its own worktree with its own context projection
  — provably different projections per unit, same contract snapshot,
  no conversation anywhere;
- candidates are evaluated **deterministically first** (identity, protected
  paths, freshness, local verification, scope, contract guards), then
  semantically where judgment is genuine;
- structural aggregation decides integration readiness; the single-writer
  integrator applies verified candidates and the unchanged evidence
  pipeline flips the checkbox — or refuses.

## 4. The governed failure paths, each proven by a test

| Scenario | What happens |
| --- | --- |
| a builder proposes `nextState` inside `ActionResult` | the deterministic guard screen records a `CONTRACT_CONFLICT` (architecture-contract-change), the unit blocks, nothing integrates, the job stops `NEEDS_CLARIFICATION` |
| a transport builder discovers missing `nack` semantics | a `ContractChangeRequest` lands `NEEDS_HUMAN`; execution stops; `specbridge mission ccr steprelay CCR-001 --approve` creates contract revision 2; the old projection is provably stale; the retry builds against revision 2 and the job completes |
| Kafka and RabbitMQ investigations contradict each other | the AGGREGATOR's synthesis records the conflict with both attributed claims; integration stops for a decision — nobody silently picks a side |
| the verifier fails persistently | the unit fails after bounded attempts, structural aggregation refuses integration, the checkbox stays `[ ]`, the job stops honestly |
| the process is killed mid-build | resume supersedes the interrupted worker identities (late results refused), prunes worktrees, and the SAME job continues to completion |
| parallelism enabled | independent units build concurrently in isolated worktrees; one integration run; one evidence-verified completion |

## 5. Completion

The objective completes only when the unchanged evidence pipeline verifies
the integrated result — `- [x] 1. Event-driven execution` is flipped by
trusted verification, never by a claim. Inspect everything after the fact:

```bash
specbridge orchestrate job <jobId>
specbridge orchestrate objective <jobId> <nodeId>
specbridge orchestrate workunit <jobId> <nodeId> wu-1
specbridge mission show steprelay
```
