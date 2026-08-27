# Changelog

## 1.10.1 (unreleased) — vNext.10.1 Zero-Touch Spec Intake

vNext.10 made a long-horizon run survive without a person. It started at a
Mission Seal — and creating one took eight commands.

This release removes the eight commands, not the authority.

```text
existing repository + one new specification
        ↓
repository-grounded discovery
        ↓
only genuine product questions
        ↓
ONE human approval  ─────────────  the zero-touch boundary starts here
        ↓
synthesis · derived approvals · seal · preflight · launch
        ↓
the vNext.10 unattended runtime
        ↓
COMPLETED
```

**Nothing was removed.** `mission begin`, `mission contract-ready`,
`mission synthesize`, `spec approve --stage`, `autonomy seal`,
`overnight preflight`, and `overnight run` all behave exactly as they did.
The new path is a higher-level orchestration of those authorities; a
workspace that never uses it is byte-identical in behaviour.

### The workflow

```bash
specbridge spec start airport-demo --file ./demo-spec.md
specbridge spec answer airport-demo Q-001 "Strict: an existing definition must run unchanged."
specbridge spec approve airport-demo --build
```

Four commands and one flag, of which exactly **one** carries human authority.
The Claude Code plugin exposes the same path as `/specbridge:build`.

### New package: `@specbridge/intake`

`vocabulary.ts` (all closed enums), `document.ts` (deterministic parsing),
`grounding.ts` (repository-grounded discovery), `delta.ts` (Delta Authority
Analysis), `questions.ts` (generation + six refusal screens), `compile.ts`
(canonical truth → mission records), `convergence.ts` (the four gates),
`approval.ts` (the single authorization), `derived-approval.ts` (projection
equivalence), `lifecycle.ts` (the nine-step transition), `service.ts`,
`telemetry.ts`.

It sits ON TOP of mission, autonomy, orchestration, and workflow, and
`IntakeDeps` is structurally an `AutonomyDeps` — a bundle that could not be
handed straight to them would mean the intake had built parallel versions of
things that already exist.

### Full spec intake

`mission begin --goal "one or two sentences"` was never going to carry a real
specification. `spec start` takes the whole document, stores it **verbatim**
and content-addressed under `.specbridge/intake/<id>/source/<sha256>.md`
before anything is parsed, and indexes it by byte offset. The parse is
SpecBridge's *reading* of the document; if the two ever disagree, the
document wins. A model summary never replaces it.

List items are cut individually, because a specification enumerates its edge
cases as a bullet list and treating the list as one chunk would let a
discovery pass account for "the edge cases" collectively while dropping four
of them. And **a bullet is an obligation** unless it is plainly an
illustration: an earlier version demanded a modal verb and quietly filed
"Sequential execution is deterministic" as narrative, which dropped it out of
the coverage gate that exists to stop exactly that.

### Repository-grounded discovery

Discovery in an existing repository is not product design. Two categories
come out and keeping them apart is the whole job: **authoritative** evidence
is existing product truth (sealed contracts, constitution rules, ADRs, prior
seals, approved specs, feature lineage) and can answer a product question;
**context** is everything else (modules, build system, test surfaces, public
interface files) and informs engineering decisions, which are delegated and
never asked about. Read-only and offline throughout — the head commit comes
from reading `.git` rather than spawning git.

### Delta Authority Analysis

Seven classes, and only three need human attention:

```text
NEW_DELEGATED_SURFACE            a new public surface THIS spec authorizes
IMPLEMENTATION_DETAIL            engineering latitude inside the seal
EXISTING_CONTRACT_COMPATIBLE     an existing contract already promises it
EXISTING_CONTRACT_EXTENSION      adds to a contract whose policy permits it
EXISTING_SEALED_CONTRACT_CHANGE  would change an existing sealed promise ← human
CONTRADICTION                    collides with an active contract or rule  ← human
UNKNOWN_PRODUCT_AUTHORITY        blocked on an open product question       ← human
```

Both failure directions are expensive and look nothing alike. Over-
classifying puts a human gate in front of every new endpoint — a new REST
route, console screen, or configuration format for a NEW feature is public
and modifies no old promise. Under-classifying silently rewrites a promise
the product already made. A `frozen` contract has no additive form, so an
item that would extend one is a change to it.

A feature intake **never writes into a prior mission's registry**: an
extension becomes a requirement on the feature's own contract and is recorded
on the approval, and the older contract stays byte-identical.

### Question discipline

A question is generated only when the document is structurally unresolved: a
hedged compatibility promise (`X-compatible or X-like`), a semantically
loaded verb used without a definition (`replay`, `redrive`, `exactly-once`),
a sensitive payload with no stated visibility policy, an author-flagged
ambiguity, or a would-be sealed-contract change.

Every admitted question carries `kind`, `productSurface`, `evidenceGap`, and
`resolves` — and the generator cannot produce one without all four. Then six
screens run on every candidate, including any an agent proposes through the
`DiscoveryProposer` seam, and **every refusal is recorded**:
`ENGINEERING_DECISION`, `ELABORATION_NOT_DECISION`, `IMMATERIAL_TO_PRODUCT`,
`DUPLICATE`, `ANSWERED_BY_EVIDENCE`, `ANSWERED_BY_SPECIFICATION`.

`ENGINEERING_QUESTION_SURFACES` is a negative list — the mirror of
`NON_AUTHORITY_SIGNALS` — and a test enumerates all fifteen members and
proves none reaches a human.

### Convergence

Four deterministic gates: every normative statement accounted for, no open
question, delta analysis complete, mission coverage gate holds. When all four
hold the intake is `READY_FOR_APPROVAL` and discovery **stops**. There is no
fifth gate a model could argue itself into. A specification carrying more
material public statements than one mission record can hold says so and asks
to be split, rather than crashing on a schema bound.

### One approval, and derived approval

The approval is one immutable record whose every field is a reference or a
digest. `authorityDigest` hashes exactly the approved product truth: ordering
is not authority, a contract revision is.

`requirements.md`, `design.md`, and `tasks.md` are deterministic projections
of that truth, so their authority **derives** — under one condition this
proves rather than assumes: *the projection must contain no semantic
authority the human did not approve*. Every normative line is traced back to
an approved element, and a line that traces to nothing **fails** the derived
approval rather than warning about it.

What gets recorded is honest about what it is — `approvalMode:
DERIVED_FROM_INTENT_APPROVAL` plus `sourceApprovalId` and `authorityDigest`,
never a forged manual receipt. An absent `approvalMode` means `HUMAN`, so
every approval recorded before this release reads exactly as it did.

### The atomic seal-and-build transition

Nine durable transactions behind one product operation:

```text
CONTRACT_READY → SYNTHESIZE → VALIDATE_PROJECTION → DERIVE_APPROVALS
   → SEAL → PREFLIGHT → RESOLVE_PREREQUISITES → CREATE_JOB → LAUNCH
```

A durable step ledger records each step `RUNNING` before it acts. On re-entry
the lifecycle does **not trust that record**: it asks durable reality whether
the effect already exists and marks the step `RECONCILED` when it does.
Reality is the authority; the ledger is the plan. `spec intake <name>
--resume` continues idempotently from the first unsettled step.

A human-only prerequisite stops **before the job exists** — preflight is step
6 and job creation is step 8, deliberately. A diverging projection stops
before the seal. And a `SATISFIABLE_AUTONOMOUSLY` capability is pre-authorized
through the Toolsmith broker while somebody is still awake, so a denial is
found now rather than at 03:00.

### The telemetry boundary

```text
discoveryHumanTurns                  answers given BEFORE authorizing — never a failure
productQuestionsAsked                what discovery asked
questionsRefused                     what it declined to ask — the honesty check
authorityApprovalCount               exactly 1 for a completed intake
humanInterventionsAfterSeal          the vNext.10 metric, from the approval forward
humanAuthorityEscalationsAfterSeal   correct authority stops after it
```

`null` means unknown, never zero. `computeAutonomyTelemetry` now places the
boundary at the seal's `sealedAt` instant when one is bound; when it cannot
be placed, everything counts, which is the conservative direction.

### Feature lineage

`.specbridge/intake/baseline.json` records, per feature, the baseline commit,
the seals already in force, and the contracts created, extended, or changed.
Grounding reads it — which is what makes the second specification discovery
sees get smarter rather than start over.

### Surfaces

- **CLI**: `spec start`, `spec discover`, `spec answer`, `spec intake
  [--resume]`, `spec abandon-intake`, and `spec approve <name> --build`. The
  `--build` flag lives on the same command as `--stage` so the relationship
  between approving a document and approving a product is visible; `--stage`
  moved from `requiredOption` to `option` with the identical refusal one line
  later, so every existing invocation is unchanged.
- **MCP**: `spec_intake_start`, `spec_intake_read`, `spec_intake_answer`
  (64 → 67 tools). There is deliberately **no** `spec_intake_approve`, and
  the bundled plugin is verified to expose no approval tool of any kind.
- **Plugin**: the `build` skill (14 → 15), driving those three tools and
  ending at a summary and a command it cannot run.
- **Contracts**: new `contracts/intake-contract.json`; eight new schema
  families; `stageApprovalSchema` gains three optional provenance fields.

### Tests

`tests/intake/` (60) — ingestion and provenance, repository-grounded
discovery, question discipline, convergence, delta classification, prior-seal
protection, the single approval, derived approval and its refusals, the
lifecycle, crash-resume, and the telemetry boundary — plus
`tests/cli/cli-vnext101-intake.test.ts` (13) covering the product workflow
and backward compatibility. Suite: 196 files / 2,630 tests.

### Defects this release found and fixed

- **`{...EMPTY_MAP}` is a shallow copy.** The projection map's module-level
  empty literal shared its nested objects across every intake in a process, so
  one feature's decision ids leaked into the next one's map and produced a
  contract citing a decision from a different mission.
- **A declarative requirement bullet read as narrative**, dropping it out of
  the normative set and therefore out of the coverage gate.
- **Topic resolution ignored prose and headings**, so a specification with a
  `## Canonical model` section was asked to restate it.
- **`complete` on the delta analysis meant "classified"**, which would have
  let a caller checking one boolean walk past a would-be sealed-contract
  change. It now means classified *and* nothing needs authority nobody gave.
- **A very long specification crashed on the mission's decision bound.** It
  now degrades honestly: only contract-bearing statements become decisions,
  the rest become facts, and an overflow leaves statements `UNACCOUNTED` with
  a reason rather than raising `SBM006`.

### Defects the StepRelay dogfood found

The Golden Spec ran against the real StepRelay repository — an existing
product with an approved mission, nine sealed contracts, and 84 pieces of
durable evidence. Six defects surfaced that 2,630 tests had not.

- **A linked worktree resolved no baseline commit.** A worktree's `.git` is a
  file naming a per-worktree gitdir with its own `HEAD`, but the ref it points
  at lives in the COMMON directory named by `commondir`. Feature lineage could
  not say what the work started from.
- **`--resume` short-circuited on the stale outcome.** The build stopped on
  `HUMAN_PREREQUISITE_REQUIRED` because a container daemon was not running;
  the operator started it, ran `--resume`, and got the same refusal verbatim.
  Only `COMPLETED` is terminal now — every other outcome is a state a resume
  exists to leave.
- **The ledger displayed a preflight verdict the launch did not act on.** A
  resumed run takes a fresh preflight, and that verdict is now written back
  onto the step, so a report never shows `HUMAN_ACTION_REQUIRED` beside a
  build that proceeded.
- **Answered questions did not reach the requirement text.** The task plan
  handed a builder "Step Functions-compatible or Step Functions-like" AFTER
  the human had chosen — the exact ambiguity the conversation existed to
  remove. Requirements now carry the recorded decision alongside the source
  sentence.
- **A non-goal became a requirement.** "…must not contain airport-specific
  workflow topology" appeared as an acceptance criterion, asking a builder to
  implement an exclusion. Exclusions are carried by the mission's non-goals
  and never by a contract.
- **A list-introducing line was sealed instead of its list.** "The console
  must support:" was an unclosable acceptance criterion while its ten
  capabilities became neither a requirement nor a criterion. A colon-
  terminated intro now belongs to the list beneath it: the sealed ledger went
  from 19 criteria to 27, with every console capability individually
  closable.

Also surfaced and fixed: contract ids are unique only within a mission, so
the approval summary read "CTR-001 would be extended" directly above the
feature's own "CTR-001 Observable Behaviour". Affected contracts are now
qualified by their owning mission, title, and revision.

Three more surfaced once the run reached real compute:

- **An unusable plan killed the driver.** The local planner returned a
  schema-valid `PLAN` decision with no goal and no steps;
  `plannerOutputToCandidate` threw SBO037 out of the driver, the supervisor
  logged `DRIVER_DIED`, and the restart put the same planner in front of the
  same empty plan. It is an INTELLIGENCE failure of that attempt, so it now
  escalates through `INVALID_LOCAL_OUTPUT` to a worker that can plan. This is
  a pre-existing orchestration defect the intake path exposed, fixed with a
  driver test that fails with the exact dogfood error without it.
- **A positive promise carrying "never" read as an exclusion.** "fields may
  be added, never removed" is a compatibility COMMITMENT; classifying it as a
  non-goal dropped the only contract-bearing statement in a specification,
  which then failed synthesis — after the approval was already written. A
  genuine exclusion says "must not"; a `## Non-goals` heading still marks
  everything beneath it however it is phrased.
- **An objective-role failure threw away what the worker returned.** "The
  response is not a single valid JSON document" is technically true and the
  least useful sentence available. The dogfood lost a work unit to it three
  times over: the builder finished in nineteen seconds, the record kept
  nothing, and neither a person nor the runtime could tell an expired
  credential from a rate limit from a model that wrapped its JSON in prose.
  The task driver already carried the observed text for exactly this reason;
  the objective path did not, and now does.
- **Sibling progress invalidated in-flight work.** The semantic-resume path
  recomputed the deterministic evaluation against LIVE mission truth, so
  when n-3 completed and the mission recorded its facts, every projection
  hash moved and n-4’s stored candidate — built and deterministically
  PASSED against the truth of its own build — began failing identity
  binding on every resume. The evaluator reported that mismatch verbatim
  and honestly, and was initially read as fabricating; the burn was blamed
  on the messenger. The resume now uses the STORED deterministic record for
  the attempt and recomputes only when none exists (the first pass, when
  live truth IS build truth). Identity binds a candidate to the snapshot it
  was built against; whether moved truth demands a rebuild is the
  projection-freshness check’s question, answered by what actually changed
  rather than by any byte of the world having moved.
- **A semantic verdict could overturn the deterministic layer.** The
  evaluator asserted, three attempts running, that the identity-binding
  check had FAILED — while its own evidence packet said "passed", and that
  layer had run the real hash comparison. One fabricated blocking reason
  cost the unit its whole attempt budget. The evaluator prompt now states
  the deterministic evidence is settled fact, and a blocking reason that
  re-adjudicates a passed deterministic check triggers one bounded re-ask
  naming the contradiction (recorded as `evaluation_contradiction_screened`).
  If the re-ask stands its ground the verdict is kept — a screen must not
  become a rubber stamp in the other direction.
- **Resume now diagnoses and repairs what a previous incident broke, by
  itself.** The dogfood proved the checkpoint model right and the RE-ENTRY
  wrong: every artifact needed to continue was on disk, and a person still
  performed the same state surgeries by hand before `--resume` would move.
  `selfHealOnResume` now runs before launch — it removes a run lock whose
  owner is provably dead (the same diagnosis `run recover-lock` performs),
  re-derives a recorded BUDGET_EXHAUSTED verdict and keeps it only if it
  still holds under current rules, revives work units whose every failure
  was transient infrastructure (a quota window, a dead transport — nothing
  was built on those attempts), and banks a dangling human-wait clock. An
  explicit resume also resets the supervisor’s give-up ledger: a person
  present and asking is the opposite of the unattended loop GIVE_UP
  protects. Every repair is a machine-readable `self_heal_applied` event.
  Verdicts about the WORK are never touched — a failing test stays failed,
  an ambiguity still waits for its person. The shape follows deer-flow’s
  lease reconciliation (repair as part of takeover, not as human ceremony)
  and its doctor stance (findings plus applied repairs, never prose to
  interpret).
- **Reconciling a conflicting candidate was capped at ten minutes.**
  Integration hands a conflicting candidate to a worker that must read the
  conflict, understand two change sets, and re-apply one against the other
  in a real repository — a build-sized job on a question-sized ceiling. Four
  reconciliations in a row died at exactly 600000 ms with the same failure
  fingerprint, one task attempt each, while the operator’s configured
  builder timeout sat at an hour. The reconciliation now gets the same
  budget a build gets (`builderTimeoutMs`). The timed-out run also left the
  repository run-lock held, which the next dispatch reported as a
  dependency block; `run recover-lock --remove` is the designed recovery and
  worked, but a terminated reconciliation should release its own lock — an
  open item, recorded here rather than silently.
- **The overnight runtime could not survive its own backoff sleep.** The
  supervisor’s sleep timer was unref()’d, so whenever a backoff or recheck
  wait was the only pending work — no driver child yet, no other live handle
  — the event loop drained and the whole process exited 0 mid-supervision,
  with nothing logged anywhere. Every unexplained overnight stop traced back
  to this one call: runs that "kept dying" were exiting cleanly inside their
  own retry pause. The environment service carried the identical sleep. Both
  timers now hold the process open, and a child-process regression test
  proves a process awaiting the sleep survives to wake up — in-process the
  test runner itself hides the bug.
- **A stored candidate was invisible to the drive loop.** `CANDIDATE_READY`
  is not READY (never dispatched), not EVALUATING (never resumed), and not
  final (aggregation counts it as pending) — so a drive that found one had
  nothing it could do and fell through to "cannot integrate: unit(s) still
  in progress", which burned a task attempt. Five attempts died that way on
  a unit whose candidate was sound and whose ambiguity a person had already
  resolved; the same hole swallowed any unit whose process died between the
  deterministic and semantic evaluation layers, because crash reconciliation
  maps interrupted evaluations back to exactly this state. The loop now
  resumes a stored candidate into the same evaluation path a fresh build
  uses; missing artifacts send the unit back to READY for a rebuild, and
  evaluating an existing candidate consumes no builder attempt.
- **The wall-clock budget existed twice, and only one copy learned to skip
  human waits.** The scheduler subtracted time parked on a person; the
  recovery path still computed `now - createdAt`, so the same job passed one
  check and was refused by the other — 7.5 hours waiting on two product
  decisions turned 4 hours of real work into BUDGET_EXHAUSTED. One function,
  `workedMsOf`, now feeds both.

- **A human answer to an evaluator question was write-only.** `orchestrate
  answer` recorded the decision on the job, but the objectives path reads
  mission decisions, never job decisions: the work unit stayed
  FAILED(AMBIGUITY) carrying a question a person had already answered, and
  each re-dispatch re-observed the stale unit, spent a task attempt doing
  nothing, and reported IMPLEMENTATION_DEFECT — four attempts burned to
  BUDGET_EXHAUSTED with the answer sitting on disk. Three coordinated fixes:
  an answered question now revives the units it named (with the decision
  attached to the unit), the re-run evaluator is SHOWN the recorded decision
  so it does not ask again, and aggregation reports a FAILED-on-AMBIGUITY
  unit as AMBIGUITY rather than as an implementation defect.
- **The scope check compared file paths against the prose an area was
  written in.** The DECOMPOSER contract lets an expected area be free text,
  and models use it that way: "settings.gradle.kts (root multi-project
  registration)", "the new demo module directory and its build.gradle.kts".
  Compared literally, no real path can ever match either, so a candidate
  that changed exactly what the areas described was refused three times
  running on an identical verdict and the objective was forced into a
  replan. An objective whose decomposer wrote descriptive areas could not be
  built at all — and the one that succeeded in the same run succeeded only
  because its area list was empty, which skips the check entirely.
  Each area now yields the path it names, if it names one; areas that name
  none are dropped, and when none survives the check records that scope was
  NOT JUDGED rather than passing silently. A check that cannot make its
  comparison must not fail the work.
- **A product decision was made and the job never noticed.** The
  clarification question says "change request(s) CCR-001 await a human
  decision. Resolve the prerequisite, then resume the job." A person does
  exactly that, resumes — and nothing happens. The question and the decision
  that answers it were never bound together: the CCR id lived only in the
  question's prose, the job knew only that it was NEEDS_CLARIFICATION, and
  the supervisor gates on status alone. A question raised FOR change
  requests now records them, and a resume closes it once every one has left
  NEEDS_HUMAN (reading the ids back out of the question text for questions
  stored before this). A question a person must answer in words is
  untouched.

- **Time spent waiting for a person was charged to the compute budget.**
  `elapsed = now - createdAt`, so a job that asked one product question at
  midnight and was answered at eight woke with its whole eight-hour
  wall-clock budget spent without having run anything. In the dogfood the
  split was 7.8 hours waiting against 1.5 hours of work. The budget bounds
  how long a job may WORK, and a job parked on a decision only a person can
  make is not working; that time is now banked on entry to a human-only
  status and subtracted. For a long-horizon run this is the difference
  between a product question costing one command and costing the night.
- **An oversize evaluator packet rejected the work unit instead of asking a
  bigger model.** A packet too large for the small tier is not a failure of
  anything — it is a ROUTING fact, and the answer is the tier that can hold
  it. The task driver has always known this: a `context-exceeded` local
  result escalates with `CONTEXT_LIMIT_EXCEEDED` and never fails the task.
  The objective driver had no such path, so a candidate that had passed local
  verification AND deterministic evaluation was thrown away because nobody
  asked the model that could read it — 35,287 characters against a 14,745
  ceiling in the dogfood. The objective driver now escalates too.
- **A transient tool failure was reported as an implementation defect, and
  burned a whole task budget.** The builder produced a candidate; local
  verification passed; the deterministic evaluation passed; then the semantic
  evaluator's endpoint answered HTTP 400. The unit was rejected as
  `TRANSIENT_TOOL`, and aggregation dropped that category on the floor and
  reported `IMPLEMENTATION_DEFECT`. The DIAGNOSER and the REPLANNER then
  spent four attempts rewriting code that had already passed every trusted
  check, converged on the same failure fingerprint each time, and handed the
  job to a person. An objective now reports the category its units actually
  carried — but only when NO failed unit blames the implementation, because
  one genuinely failing check makes `IMPLEMENTATION_DEFECT` the honest answer
  whatever else also broke.

- **The local prompt ceiling bore no relation to the context window.**
  `maximumInputCharacters` (48,000) and `contextSize` (8,192) are configured
  independently and their defaults contradict each other — 48,000 characters
  is roughly 14,000 tokens. A packet between the two limits passed every
  check SpecBridge made and was then refused by the server as a bare HTTP
  400. That is what triggered the failure above, and the difference matters:
  an oversize packet caught by SpecBridge reports `context-exceeded` and
  escalates to the large tier without failing anything, while the same packet
  caught by the server rejected the work unit. The ceiling is now the LOWER
  of the configured limit and what the context can hold, leaving room for the
  answer as well as the question; it only ever tightens.
- **An instruction to go and ask product sealed as a product requirement.**
  The Golden Spec said, under a `## Compatibility` heading, "if the degree of
  Step Functions compatibility is ambiguous, ask a product question during
  discovery". That is guidance to whoever writes the specification, and it
  sealed as the ONLY requirement of a contract named "Compatibility
  Promise". The unattended build then stopped on it — correctly: the builder
  could satisfy the requirement in full while promising nothing, so it raised
  `CCR-001` and waited for a human, which is the one thing this path exists to
  prevent. Such a statement is now its own chunk kind, `process-guidance`: it
  is neither normative nor narrative, never becomes a requirement, and still
  feeds the author-flagged-ambiguity marker that asks the question. The answer
  is the durable truth; the instruction to ask is spent once asked.
- **Re-submitting an unchanged specification invented a question.** The
  Golden Spec, sent again at the repository its own first run had sealed,
  stopped and asked a human whether to change `CTR-005 R9` — quoting back at
  them a sentence it matched BYTE FOR BYTE. The sealed text ends "without
  frontend code changes", and the word "changes" read as an intent to
  change. A restatement now outranks every change branch, and restatement
  means text-identical rather than similar, so an altered number still gates.
- **The heading an author files a statement under was ignored.** A section
  headed `## Compatibility` whose sentence names no durable surface is still
  a compatibility promise. The heading is now a FALLBACK consulted only for
  PROSE, and the limit took two corrections to find: letting it always
  participate first collapsed five separated contracts into one with
  fifty-seven requirements, and then turned all thirty delegated
  implementation details into public contract requirements — promising a
  framework choice to users. A normative bullet says what it is in its own
  words; a paragraph under a section heading is where an author states a
  policy without repeating the heading in the sentence.

The approval gate also grew a condition it should always have had: an intake
that compiled NO product contract cannot converge. Reaching a human with one
writes an immutable approval pointing at a mission that cannot synthesize.

Then three more, once the run reached a large-tier worker:

- **A blocked job discarded the evidence it blocked on.** `persistAgentResult`
  runs only on the success path, so a job that blocked on "the response is not
  a single valid JSON document" retained nothing — a message with no evidence
  behind it. `RoleWorkerFailure` now carries a bounded `observed` excerpt and
  the blocker shows it. Retained for a human to read, never parsed and never
  repaired.
- **An expired credential read as garbage output.** The excerpt paid for
  itself immediately: the worker had exited ZERO with "Failed to authenticate.
  API Error: 401 OAuth access token has expired." as its result body. It is
  now classified `worker-unavailable` with the credential named. The guard is
  narrow — a JSON document is never an authentication error, because a
  perfectly good plan for an identity-verification feature says "reject an
  unauthorized passenger with a 401-shaped response", and the test asserts
  that false positive directly.
- **A surface contract had no size bound.** The Golden Spec compiled one with
  FORTY-ONE requirements, which is not a promise anybody can read and compiles
  to one objective a planner must plan in a single shot. A surface now splits
  into numbered parts at twelve.

And `spec status` now says WHICH human decision authorized a stage: it
rendered a bare "✓ Approved" for a derived stage, hiding the one difference
`approvalMode` exists to make visible.

And one gap the dogfood made unavoidable: **there was no way to say "I fixed
it, continue".** The build blocked on an expired token — five seconds to fix —
and the supervisor then answered `WAIT_FOR_HUMAN` forever, because nothing
could tell it the machine had changed. The only other command was
`cancel-job`, which is final. `spec intake --resume` now clears an
ENVIRONMENTAL blocker (`CAPABILITY_UNAVAILABLE`, `AUTHENTICATION`,
`PERMISSION`, `BLOCKED_DEPENDENCY`, the transient pair,
`INVALID_CONFIGURATION`) and returns the job to the schedulable path. The
failure history is untouched, so a job genuinely out of road runs out of road
again immediately, and an `IMPLEMENTATION_DEFECT` or a budget stop is never
cleared by fixing the machine. New job event: `job_unblocked`.

### A new non-claim

**An already-expired credential is not detectable before launch.** The
dogfood reached `OVERNIGHT_READY`, launched, and died on an expired OAuth
token — while the worker CLI's own `auth status` reported a live session and
exited zero. The preflight verifies what the mission DECLARES it needs; it
cannot revalidate a credential the worker already holds, and only a real call
finds out. `KNOWN_CREDENTIALS_PRESENT` now says exactly that instead of
implying a guarantee it cannot make.

## 1.10.0 (unreleased) — vNext.10 Overnight Autonomous Product Runtime

Nine phases made a long-horizon run SURVIVE. This one makes it not need a
person.

That is a different problem, and it fails in a specific way. A runtime that
cannot recover stops honestly. A runtime that recovers but keeps ASKING is
worse than useless overnight: the human is asleep, so a question costs eight
hours whether it was a good question or not.

**Nothing here changes how an ordinary job behaves.** Every autonomy default
is the conservative one — `mode: INTERACTIVE`, `humanGate: ALL`, supervisor
off, Toolsmith off, environments off, browser off, critic disabled — so
upgrading cannot make an existing workspace more autonomous than it was. A
workspace with no seal has no authority resolver and behaves exactly as v1.2
did.

### The two rules

**Difficulty is answered with intelligence, not with a question.**

```text
HIGH complexity      ->  use a stronger reasoner
AUTHORITY BOUNDARY   ->  wake the human
```

Complexity, diff size, architectural weight, low confidence, and a pile of
failed attempts are never reasons to stop. `evaluateAuthority` does not take
any of them as parameters, `NON_AUTHORITY_SIGNALS` enumerates them, and
`verifyNonAuthoritySignalsCannotGate` proves at runtime that passing all of
them at once still yields `AUTONOMOUS`.

**Completion is decided by evidence, not by assertion.**

```text
IMPLEMENTED   something claims to implement this
VERIFIED      trusted evidence demonstrates it holds
```

Only the second closes a contract item.

### The failure that motivated the completion oracle

The previous dogfood declared a product COMPLETE while seven approved
requirements had no implementation at all. Nothing lied: every task was
checked off, the build was green, the tests passed, the agent said done. All
four statements were true and the product was not finished, because "the task
list is complete" and "the contract is satisfied" were the same fact in the
runtime.

The Contract Closure Ledger holds one entry per SEALED item, built once from
the seal. `AGENT_ASSERTION` is a recordable evidence kind deliberately absent
from `CLOSING_EVIDENCE_KINDS`. Evidence captured against a different git head
is stale. A UI acceptance criterion carries `requiresBrowserScenario` frozen
from the seal, so a unit test cannot close it. An empty ledger cannot
complete — `closureRatio` returns `null` rather than `1.0`, because a seal
that promised nothing has a ratio that means nothing.

### What was added

**`@specbridge/autonomy`** — the new package.

- **MissionSeal.** A human authorizes a complete product intent ONCE, and the
  delegated engineering latitude is recorded with it. Immutable; re-sealing
  supersedes rather than edits. Compilation from mission state is
  deterministic, which is exactly what lets human authority flow into derived
  artifacts without a second approval round. The policy fingerprint is
  recorded, and drift in EITHER direction refuses execution.
- **Authority firewall.** A pure function over frozen tables. Eleven hard
  authority surfaces with no configuration representation anywhere; twenty-six
  delegated engineering surfaces. `refineIntentImpactUnderSeal` re-reads the
  v1.2 intent screen through the seal, so "restructure the module layout"
  stops being a 03:00 question while "change the public API" still is.
- **Supervisor.** Durable job ownership through a lease with an expiry and a
  generation counter. A live lease is never preempted and there is no force
  flag. Restart backoff resets on PROGRESS, not on a successful start —
  treating a start as success is how a crash loop runs all night at full
  speed.
- **Overnight preflight.** Twenty-four capability probes with a third answer
  most readiness checks lack: `SATISFIABLE_AUTONOMOUSLY`. A missing browser
  runtime the Toolsmith may install is work, not a blocker. `INDETERMINATE`
  refuses a launch, because "we could not tell" is not "probably fine".
- **Toolsmith.** Capability classes, not commands; a fixed argv shape with one
  variable position; scope preference from PROJECT_LOCAL to USER_LOCAL with no
  machine-global option. Agents may create TOOLS, never AUTHORITY.
- **Environment lifecycle.** Plan / instance / evidence, a readiness
  DEPENDENCY graph rather than a list, restarts inside the readiness window,
  and diagnostics retained on failure. Evidence separates
  `applicationLevelReady` from `livenessOnlyReady`, because a container with
  an open port is not a ready Kafka broker.
- **Browser evidence.** A closed step vocabulary with no "evaluate JavaScript"
  step — a scenario that could script the DOM could fabricate what it asserts.
  Isolated contexts per participant. Playwright by dynamic import, never a
  declared dependency; absence is `SKIPPED_NO_RUNTIME` with a reason.
- **UX critic with negative authority only.** No `PASS` verdict exists.
  `AESTHETIC_PREFERENCE` is forced to `COSMETIC`. The verdict is computed from
  normalized findings rather than taken from the critic.
  `critiqueEffect` refuses to act on an already-failed scenario.
- **Control-plane self-repair.** Strict stage ordering, a mandatory regression
  test, a mandatory canary, and an invariant screen that runs BEFORE the tests
  so a patch disabling the verification gate never gets to make the suite
  green. The running control plane is never overwritten.
- **Autonomy telemetry.** `humanInterventionsAfterSeal` is the product metric.
  Authority escalations are counted separately, so the metric stays falsifiable
  in both directions. Unknown measurements are `null` and render `n/a`.

**Job vocabulary and state machine** gain the autonomous operational statuses
— `WAITING_RESOURCE`, `RECOVERING_PROVIDER`, `REPAIRING_TOOLCHAIN`,
`REPAIRING_ENVIRONMENT`, `REPAIRING_CONTROL_PLANE`, `QUALIFYING` — plus
`NEEDS_AUTHORITY` as a first-class durable state. Deliberately NOT overloading
`BLOCKED`, which is what made operational failure sticky. Every operational
status can return to `READY` on its own, asserted by a test over the table.

**The driver** gains one seam: an optional `DelegatedAuthorityResolver`
consulted where it was already about to stop. It can remove a false gate; it
structurally cannot add a real one.

### The zero-touch certification

Sixteen fault classes. Fifteen must `SELF_RECOVER`; the sixteenth must reach
`NEEDS_AUTHORITY` with the seal's authority digest unchanged. A certification
that only proved the first fifteen would certify a runtime that never asks —
including when it should.

**It found three real defects before it went green:**

- `CREATED` could not reach any operational status, so a job meeting a dead
  provider on its first dispatch threw `Invalid job transition` instead of
  waiting. Seven of sixteen scenarios crashed on it.
- The local-runtime signature missed the most common phrasing: `\bexit\b`
  does not match "exited", so `local model server exited with code 139` fell
  through to an unclassified backoff instead of restarting the process.
- Control-plane repair transitioned nowhere: the classifier named the status
  and nothing performed it, so the repair record opened against a job still in
  `CREATED`.

Result: `CERTIFIED`, `humanInterventionsAfterSeal = 0`.

### The dogfood, and the five defects it found

A real unattended run against a StepRelay worktree — sealed intent, real
Claude on the subscription lane, a real llama.cpp classifier, real Docker.
It ran for an hour and stopped on its own attempt budget, honestly, with one
intervention reported.

It found five defects that 2,552 tests did not, two of them in code written
phases ago:

1. **The plan-review gate was a complexity gate.** `planReview: 'high-risk'`
   at `complexity: HIGH` stopped the run after a successful plan — the exact
   03:00 question this phase exists to remove, kept alive by the one layer
   nobody had revisited.
2. **A resumed attempt could not re-derive its own projection.** The
   objective runtime's immutability check killed the driver on every restart;
   only the supervisor's no-progress budget stopped the loop.
3. **Windows batch verification commands could not be spawned at all.** Node
   20.12+/22 rejects `.bat`/`.cmd` without a shell, so `["./gradlew.bat",
   "test"]` was `spawn-failed` every time. This explains the whole run.
4. **An unstartable verifier was treated as an implementation defect.** The
   consequence of (3): the runtime repaired code that had never been tested,
   three times. The task path had kept `did not run` and `failed` apart since
   v0.3; the objective path had not.
5. **The primary metric under-reported.** A job sitting in `BLOCKED` reported
   `humanInterventionsAfterSeal: 0`, because the block was recorded as
   `budget_exhausted` and the event map listed only `job_blocked`. A list of
   known causes can be incomplete; a job's current status cannot be.

The fifth is the one worth dwelling on: the measurement itself was wrong, so
nothing downstream could have caught it. It is fixed, and the same run now
reports `1`.

Honest non-claims from that run are documented in
[the dogfood record](docs/autonomy/dogfood.md): the product was not built,
the browser and environment paths were not exercised against it, and the
control-plane repair path — configured — was never triggered, because nothing
classified those three recoverable SpecBridge defects as control-plane
defects. Detection is narrower than the defects a real run produces.

### Public CLI

```text
specbridge autonomy setup [--mode overnight] [--specbridge-source <path>]
specbridge autonomy policy
specbridge autonomy seal <mission> --confirm [--max-spend <usd>] [--lanes ...]
specbridge autonomy seals | revoke <sealId> --reason <text>
specbridge overnight preflight <mission>
specbridge overnight run <mission> [--job <id>]
specbridge autonomy status | report <jobId> | toolsmith <jobId>
specbridge autonomy supervision | repairs | certification
```

Four commands do everything an operator needs. Everything else is inspection,
and a test holds those to being read-only — a runtime whose progress depended
on somebody watching would not be unattended. `autonomy seal --confirm` is
CLI-only, exactly like stage approval.

### Configuration

New optional `autonomy` block. Engineering latitude is configurable; product
authority is not. The authority boundaries have no schema representation at
all, so no configuration file, environment variable, or agent proposal can
express "let the machine decide this one".

### Security

Threat model gains T108–T120 covering assumed autonomy, delegation widening
after authorization, agents editing their own policy, difficulty laundered
into a gate (and a gate laundered away), silent contract modification,
self-repair weakening its own constraints, tooling as an installation vector,
concurrent supervisors, unauthorized spend, skipped checks reported as passes,
completion without evidence, unbounded subjective critique, and unfalsifiable
metrics. Three new explicit non-claims state what zero-touch does NOT
guarantee.

## 1.9.0 (unreleased) — vNext.9 StepRelay Dogfood & Release Qualification

Eight phases each added a capability. This one adds none. It adds the
machinery for answering, with evidence, whether those eight work together as
one coherent autonomous engineering runtime — and the discipline that stops
the answer from being flattering.

**Nothing here changes how an ordinary job behaves.** Qualification is opt-in:
a workspace that never runs it creates no file, changes no policy, and
behaves exactly as it did before.

### The governing distinction

A release qualification's failure mode is not "the run failed". It is "the run
passed and nobody can say what it demonstrated". Every vocabulary in this
phase is chosen so an exaggerated claim has no representation:

```text
a skipped scenario is not a PASS
a simulated resource is not a REAL one
an operator's manual code fix is not "human approval"
a Mission that finished is not by itself a release
```

### The scenario matrix

51 scenarios across Survival, Context, Local, Quota, API, Reliability,
Adaptive, Governance, and Mission. Each declares the invariant it proves, the
fault classes it injects, the resources it touches, its requirement, and —
critically — **how it can honestly be executed**:

| Kind | Where it runs |
| --- | --- |
| `POLICY` | Pure production policy functions. Anywhere, including the operator CLI. |
| `RUNTIME` | The real driver over a temporary workspace with deterministic doubles. The regression suite. |
| `REAL_RESOURCE` | Needs a real provider, a real quota window, or real money. Cannot be simulated. |

The CLI executes `POLICY` scenarios; the regression suite executes `RUNTIME`
ones. Neither can claim the other's coverage, and a `REQUIRED` scenario in any
skipped state blocks the verdict. Two tests keep the matrix honest from
opposite directions: every fault class SpecBridge claims to survive must be
injected by some scenario, and every `RUNTIME` scenario must be recorded as
`PASS` by the file that actually observes it.

### The deterministic scenarios execute real policy

The 27 `POLICY` scenarios call `decideLane`, `planApiGapBridge`,
`assessApiBudget`, `assessHealth`, `assessFailure`, `planRecovery`,
`generateCandidates`, `rankCandidates`, `offerContextExpansion`, and the
decision-authority table directly. A scenario that carried its own copy of a
rule would keep passing after the rule changed; these import the rule itself.

### The release gate

Computed in strict order, and the order is the policy:

1. **Zero-tolerance integrity conditions** — counted, not judged.
2. **Required scenarios** — where a skip is not a pass.
3. **The real-product release gate** — which a fixture can never satisfy.
4. Only then **limitations**, which can downgrade but never upgrade.

Nine zero-tolerance counts (unauthorized paid execution, canonical state loss,
adaptive hard-policy bypass, evidence-bypass completion, unrecoverable
injected fault, accepted protected-state mutation, unbounded retry loop,
manual durable-state repair, dependent work on a failed predecessor). Any
non-zero count is `FAIL`, whatever else passed.

`computeVerdict` takes **no policy parameters**. There is no argument by which
a caller can make a gate more permissive for one run than for another.

`PASS_WITH_LIMITATIONS` is not a softer landing for a real failure: it is
unavailable whenever a zero-tolerance condition was observed, a required
scenario failed, or the real-product gate is anything other than `PASSED`.

### Real versus simulated

Every resource is `REAL`, `SIMULATED`, or `NOT_EXERCISED`. There is no fourth
value and no "equivalent": a fake clock that advanced five hours produced
*simulated* evidence about a five-hour window. Attribution folds
conservatively — `REAL` beats `SIMULATED` beats `NOT_EXERCISED` — and
attribution from a scenario that did not run is ignored, so one fake reset can
never make a report claim a real quota window.

`realTargetQualification` is reported separately from the verdict as
`PASSED`, `FAILED`, or `NOT_RUN`. A run that built and proved all the
machinery but never met the external prerequisite reports `NOT_RUN` and
`FAIL` — it demonstrated the machinery, not the release.

### Human intervention accounting

Nine closed intervention kinds, partitioned by whether governance worked or
autonomy failed. `REQUIRED_BY_POLICY` must name the boundary that required it
— recording one without a boundary is refused, so the most consequential
distinction in the report cannot rest on an adjective. `MANUAL_CODE_FIX` and
`MANUAL_STATE_REPAIR` are distinct members, counted separately, and never
filed as approvals; a recorded state repair is a zero-tolerance condition.

### State invariant auditing

Eleven invariants over durable state, read-only by construction — an auditor
able to write could launder the corruption it exists to find. Taken before and
after every restart and after every injected fault, because the durability bug
most likely to be found is state that is valid before a restart and invalid
after hydration; `restartRegressions()` tells that apart from state that was
already wrong.

### Fault injection, and its scope

33 fault classes, injected only at SpecBridge-controlled boundaries:
telemetry providers, injected inference, injected clocks, the runner
registry, verification commands, durable state, derived caches, and the
orchestrating process. Injection is **explicit dependency injection only** —
no configuration key, environment variable, CLI flag, or MCP tool constructs a
fault plan, and a structural test asserts no production module imports the
fault module. An armed plan's entire runtime surface is `shouldFire()`; it
cannot kill a process, delete a file, or change a budget.

### Reports

Four derived reports — economic, reliability, context, adaptive — plus an
autonomy scorecard, a timeline projected from durable job events, and the
`DogfoodQualificationReport` that assembles them. All pure projections of
durable records, so the report is reproducible from a run directory alone.

**An unreported measurement is `unknown`, never `0`.** A provider that said
nothing about token usage must not look cheaper than one that reported
honestly. Context is reported **per verified task**, not only per attempt: a
first-prompt reduction paid back in retries is not a saving. Shadow
recommendations stay recommendations — no counterfactual outcome is attributed
to an unexecuted candidate anywhere.

### CLI (additive, opt-in)

```text
specbridge orchestrate qualify scenarios    the matrix
specbridge orchestrate qualify preflight    fail-closed safety + economics
specbridge orchestrate qualify run          execute and record
specbridge orchestrate qualify runs         list runs
specbridge orchestrate qualify report       build the release artifacts
specbridge orchestrate qualify economics    the economic configuration alone
```

Real dogfood execution *is* `orchestrate run` — there is no second driver, no
second scheduler, and no second state engine. Start, stop, inspect, restart,
resume, and survival across a reboot come from the Job durability that already
existed.

Preflight **fails closed**: an unresolvable target, a dirty non-worktree tree,
an undetermined repository state, spending with no budget ceiling,
`AUTO_BOUNDED` with no pricing, or a workspace with no trusted verification
all refuse. Preflight **authorizes nothing**: showing the economic
configuration is not approval, and vNext.5 spend semantics are unchanged.

A profile is a ceiling, never a grant. `full` against `spendMode: DISABLED`
legitimately spends nothing, and that is a valid result.

### Durable state (additive, opt-in)

`.specbridge/qualification/<runId>/` — `run.json`, `scenarios/`, `faults/`,
`audits/`, `interventions/`, `defects/`, `reports/`. Scenario results are
keyed by scenario and replaced on re-run, so a fix genuinely turns a `FAIL`
into a `PASS`; everything else is append-only, because an injected fault, an
audit taken, and a human who intervened are facts about the past. No
credentials are stored. No canonical state migration.

### Threat model

Section 16 adds T97–T107: dogfood mode bypassing governance, qualification
accidentally spending money, fault-injection hooks exposed in production, a
report claiming simulated behaviour as real, manual fixes hidden from autonomy
metrics, Mission scope reduced without provenance, target-specific hacks
contaminating general policy, a dogfood branch corrupting the operator's
workspace, derived-cache corruption mistaken for canonical state loss,
operator intervention misclassified as autonomous success, and a gate relaxed
to achieve a pass. Non-claim 15 states plainly that a qualification report is
evidence of what was observed, not a guarantee of what will happen.

### Real StepRelay qualification

`REAL_STEPRELAY_QUALIFICATION = NOT_RUN`. The dogfood target repository is not
present in this execution environment, so the reusable dogfood infrastructure
is built and the deterministic qualification runs, while the real-product
release gate remains an unmet external prerequisite. It is not converted into
a pass under any circumstances.

### Backward compatibility

Fully additive and opt-in. No configuration key was added, no default
changed, and no existing behaviour was modified. A workspace that never runs
`orchestrate qualify` is byte-identical to vNext.8.

## 1.9.0 (unreleased) — vNext.8 Adaptive Compute Scheduler

Seven phases built a long-horizon job that survives its worker, its quota, an
outage, its own failed attempts, and its own context window. Every routing
decision in those phases was made from deterministic rules applied to the
current moment. This phase adds the first layer that reads the past.

> For tasks like this, on this repository, with this execution shape, under
> current quota, budget, and context conditions: which policy-eligible
> execution target has historically produced the best verified engineering
> outcome for the least total wasted compute?

**The invariant that governs everything:**

```text
Adaptive optimization may RANK allowed choices.
It may never make a forbidden choice ALLOWED.
```

This is not an ML project. The first adaptive scheduler is history-informed,
statistically conservative, deterministic given the same data, explainable,
rebuildable from the ExecutionLedger, safe under sparse data, and disabled by
one configuration value. There is no reinforcement learning, no neural
predictor, no external ML service, no vector store, no online training, and no
opaque routing.

**Default mode is `HEURISTIC`, which reproduces vNext.7 scheduling exactly.**

### Hard policy runs first, structurally

```text
Task -> Hard Eligibility/Policy -> Candidate Set -> Adaptive Prediction
     -> Candidate Ranking -> Selected ELIGIBLE Candidate
```

Candidates are generated **from** the hard-policy routing, never alongside it.
`generateCandidates` takes an already-decided `NodeLaneRouting` and can only
enumerate ways to spend the lane that decision selected — so the economic
invariants hold by construction rather than by convention:

- `DEFER` and `REQUIRE_APPROVAL` produce **no executable candidate**. A task
  waiting for quota, an authorization, or a gap too short to bridge keeps
  waiting.
- A `LOCAL` routing never yields a SUBSCRIPTION or API candidate, so history
  cannot move mechanical local-capable work onto prepaid quota, and HARVEST
  cannot be talked into wasting Max on it.
- A `SUBSCRIPTION` routing never yields an API candidate, so "the API succeeds
  4% more often" cannot outrank prepaid capacity that is already available.
- An API candidate exists only after the vNext.5 Gap Bridge already selected
  the API lane — meaning spend mode, budget, approval, pricing, and gap
  duration all passed first.
- A harness whose compute is not verified `LOCAL` is **rejected**, not ranked,
  however good its history looks.
- A candidate whose vNext.6 strategy key is in the task's
  `exhaustedStrategies` is removed before ranking.

Every veto is persisted with a code and surfaced in diagnostics.

### Task signature and execution candidates

`TaskSignature` groups comparable work through a coarse, durable key —
`category | complexity | localSuitability | executionShape | verification` —
with fine-grained current features (multi-module, security-sensitive,
migration, blocked dependents, critical path, current reliability health,
repository- and context-size class) recorded **beside** it for audit rather
than folded into the key. A task that fails twice must not silently move to a
different bucket because its health changed.

The signature is computed on every pass, including in `HEURISTIC` mode, and
recorded on the attempt — so a workspace that enables adaptive scheduling
later finds comparable history already waiting.

`ExecutionCandidate` keeps lane, execution mode, runner, model, profile,
context strategy, and verified compute locality as **separate orthogonal
fields**. No compound identity like `QWEN_LOCAL_DSH_FAST` exists anywhere;
`candidateId` is a derived map key and is never parsed back.

### Observed outcomes, and what counts as success

Only executed attempts with real observations become evidence. A prediction, a
recommendation, an unexecuted candidate, and a shadow-mode counterfactual have
no representation in the outcome model — there is no constructor that accepts
one, which is the structural block on a scheduler that learns from its own
guesses.

Six labels, not a boolean:

| Label | Meaning |
| --- | --- |
| `VERIFIED_SUCCESS` | completed **and** evaluation `PASS` |
| `UNVERIFIED_SUCCESS` | completed with no `PASS` on record — counted, never rounded up |
| `IMPLEMENTATION_FAILURE` | the work was wrong |
| `INFRASTRUCTURE_FAILURE` | the machinery broke |
| `INCONCLUSIVE` | no verdict — never trained as failure |
| `CENSORED` | interrupted — cost counted, outcome not guessed |

```text
intelligence success  VERIFIED / (VERIFIED + IMPLEMENTATION_FAILURE)
availability          1 - INFRASTRUCTURE_FAILURE / (all non-censored)
```

A crashed harness never lowers a model's measured capability, and a broken
verifier never does either.

### Profiles: derived, rebuildable, disposable

`ExecutionPerformanceProfile` aggregates by label, with weighted counts,
first-attempt statistics, P50/P90 wall time, tokens, context, quota burn and
cost, attempts per success, stagnation/oscillation/runaway rates, context
expansion and miss rates, failure-source distribution, failed-work totals,
runtime identities, and an undecayed count of safety-class failures.

Nothing is fabricated: an attempt that reported no token usage contributes to
no token statistic — never a zero, because a silent provider must not look
cheap.

The cache lives under `.specbridge/cache/` and is **never canonical**. Absent,
unparseable, schema-mismatched, and stale all collapse to one response:
rebuild. A schema bump rebuilds rather than migrating. Deleting the cache
costs a rebuild and nothing else, and a job never blocks on any of it.

### Smoothing, priors, confidence

```text
P(verified) = (weightedVerifiedSuccesses + priorStrength * priorMean)
              -------------------------------------------------------
              (weightedIntelligenceAttempts + priorStrength)
```

One success out of one attempt yields ~0.68, not 100%. The prior mean is the
**existing heuristic's** own expectation (`1 - retryProbability`), identical
across candidates on a task, so the prior expresses uncertainty and never
provider favouritism.

Recency is a continuous half-life decay rather than a rolling window — but
safety-class failures (`AUTHORIZATION`, `REQUIREMENT_CONTRACT`) are exempt
from both decay and the age cutoff. Rare and serious is not the same as old
and irrelevant.

Confidence is explicit (`NONE` / `LOW` / `MEDIUM` / `HIGH`) with a documented
demotion ladder for coarser profile levels, changed or unknown runtime
identity, detected drift, and unstable wall-time distributions. It is a
**ceiling, not a vote**.

Sparse data walks a hierarchy — `EXACT` → `TARGET_CATEGORY` → `LANE_CATEGORY`
→ `LANE_GLOBAL` → `HEURISTIC_PRIOR` — and records which level answered.

### Expected utility

```text
U = successWeight        * P(verified)
  - latencyPenalty       * norm(expectedTotalWallTime,     wallTimeScaleMs)
  - failedWorkPenalty    * failedWork
  - quotaPressurePenalty * quotaOpportunityCost
  - apiCostPenalty       * norm(expectedCostPerCompletion, apiCostScaleUsd)
  - contextCostPenalty   * norm(contextPerCompletion,      contextTokenScale)
  - handoffPenalty       * norm(handoffOverhead,           wallTimeScaleMs)
```

Every raw quantity passes through a saturating `x / (x + k)` map into `[0,1)`
before it is weighted — seconds, dollars, tokens, and quota percentages are
never added in their own units. Unknown normalizes to zero: guessing a penalty
is the same error as guessing a value.

Quality dominates cheapness at the default weights: a candidate 10% cheaper
and 30% less likely to complete loses. Cost and context are priced **per
verified completion**, so a strategy that sends a smaller package and then
needs two more attempts has saved nothing. Failed work is amplified by
observed no-progress rates.

`QuotaOpportunityCost` is a dimensionless `[-1, 1]` pressure index — explicitly
**not money**, and not convertible to it. HARVEST makes expiring prepaid
capacity a *bonus*; CONSERVE and weekly pressure make scarce capacity a
penalty. The hard quota rules are not expressible here and did not need to be:
admission, the reserve, exhaustion, and weekly HARVEST suppression all ran
first.

### Rollout: HEURISTIC / SHADOW / ADAPTIVE

Four independent gates must clear before adaptive displaces the incumbent:
evidence floors on **both** compared candidates, confidence above the floor,
utility margin above the hysteresis threshold, and the mode being `ADAPTIVE`.
Failing any gate is never silent — the specific gate is persisted as the
fallback reason.

`SHADOW` computes and records recommendations while the heuristic executes,
and records **disagreement only**. The alternative was not run, so no outcome
is attributed to it and no regret is computed. `wouldApplyInAdaptiveMode`
reports whether the gates would have let it act, which is the number a rollout
is actually judged on.

Hysteresis (`minimumUtilityImprovement`) keeps placement stable: long-horizon
reproducibility matters more than chasing a fraction of a point.

### History also improves the existing estimators

Subscription admission has always compared a median-shaped estimate against a
configured safety multiplier standing in for uncertainty nobody had measured.
vNext.8 supplies the measurement: admission now compares the **larger** of the
multiplied median and the measured **P90** burn, so history can only make
admission stricter. Gated on the adaptive scheduler being enabled — an
operator in `HEURISTIC` asked for vNext.7 behavior.

### Calibration and drift

After each attempt resolves, the forecast made before it is compared with what
it did: relative errors on wall time, tokens, context, and cost, plus a Brier
score where the outcome was resolvable. Only the candidate that **actually
ran** is scored.

Calibration is derived metadata in both directions: a wrong forecast never
edits the attempt, the evaluation, or the ledger, and nothing reads
calibration back to place work.

Drift compares two windows of real observations. Its only power is to lower
confidence — which moves placement back toward the deterministic heuristics.
It never retrains anything.

### Diagnostics

`specbridge orchestrate adaptive [jobId]` shows mode and thresholds,
profile-store provenance, profiles with their full label breakdown and
P50/P90 distributions, per-decision candidate comparisons with itemized score
components, hard-policy vetoes, fallback reasons, and recent prediction
accuracy. `--node` adds the full per-candidate breakdown; `--rebuild`
discards and recomputes the derived cache.

`orchestrate scheduler` gained a compact adaptive summary.

A score breakdown is rendered as an argument, not a number:

```text
LOCAL/HARNESS/deepseek-harness scores 0.712 against LOCAL/DIRECT_MODEL/local-llamacpp at 0.601 (margin 0.111).
verified success: 82% vs 27%
time to verified completion: 19m vs 27m (retries included)
expected attempts: 1.2 vs 3.7
economic lane: both LOCAL
confidence: MEDIUM (20 sample(s) at EXACT)
```

New events: `adaptive_prediction_created`, `adaptive_candidate_selected`,
`adaptive_candidate_vetoed`, `adaptive_shadow_disagreement`,
`adaptive_fallback_to_heuristic`, `adaptive_drift_detected`,
`adaptive_profile_rebuilt`, `adaptive_cache_invalidated`.

### Benchmark results (simulated)

Deterministic offline benchmark, 40 synthetic multi-file local tasks in a
fixture world where `DIRECT_MODEL` verifies 20% of attempts in 5 minutes and
`HARNESS` verifies 85% in 14 minutes:

| Metric | Heuristic | Adaptive |
| --- | --- | --- |
| tasks completed | 9 / 40 | **35 / 40** |
| attempts | 102 | **52** |
| failed attempts | 93 | **17** |
| attempts per completed task | 11.33 | **1.49** |
| simulated failed wall time | 465 min | **238 min** |
| simulated total wall time | **510 min** | 728 min |
| simulated context tokens | **2.55 M** | 6.24 M |
| simulated API spend | $0 | $0 |

Reported faithfully, including the unflattering part: adaptive consumes more
total wall time and more context, because the candidate it selects is slower
and hungrier per attempt. It completes nearly four times as many tasks and
wastes about half the wall time on attempts that never verify — the trade this
phase's objective asks for. A metric set counting only prompt size or total
minutes would score it backwards.

**Cold start** with no history: adaptive is identical to heuristic on every
simulated total, with 40 recorded fallbacks. **Historical replay** over 40
recorded decision points: 40 disagreements, all of which would also have
cleared every gate, at `MEDIUM` confidence — recommendation analysis only,
typed `RECOMMENDATION_ONLY` and carrying its disclaimer as data.

These numbers show the ranking logic behaves as designed on a world where the
answer is known. They are not evidence about any real provider or repository.

### What this phase does not claim

Not optimal scheduling, not causal knowledge of unexecuted alternatives, not
perfect prediction, not general reinforcement learning, not a global provider
ranking, and not benchmark equivalence across projects. It provides
conservative, history-informed placement under hard policy constraints.

The scheduler never spends money or prepaid quota to collect training data.
Sparse evidence produces low confidence and a heuristic fallback — there is no
exploration branch anywhere in the code.

### Configuration (additive; defaults preserve vNext.7 behavior)

`orchestration.jobs.scheduler.adaptive` — `mode` (default `HEURISTIC`),
evidence floors, `priorStrength`, recency half-life and age cutoff,
`minimumConfidence`, `minimumUtilityImprovement`, four normalization scales,
three drift thresholds, `safetyFailuresExemptFromDecay`, retention bounds, and
seven utility weights. Validation rejects a non-positive `successWeight`, an
all-zero weight vector, negatives, NaN, and out-of-range values.

Adaptive settings are control-plane policy. Nothing an agent writes into a
repository can change a weight, a budget, a quota bound, or a placement.

### Durable state (additive)

`TaskAttempt` and `ExecutionLedgerEntry` gained `taskSignature`,
`contextStrategy`, and `runnerVersion` — absent on every pre-vNext.8 record,
which simply falls back to coarser profile levels. New derived, disposable
state: `.specbridge/cache/adaptive-profiles.json`,
`jobs/<jobId>/adaptive/decisions.jsonl`, and
`jobs/<jobId>/adaptive/calibration.jsonl`. No canonical state migration.

### Threat model

Section 15 of the threat model adds T82–T96: history poisoning through
repository content, self-reinforcing routing bias, manual-acceptance bias,
provider outage misclassified as intelligence failure, survivorship bias,
stale version transfer, spend/quota/locality/reliability veto bypass,
historical cost inferred as current price, autonomous paid exploration, metric
gaming, counterfactual claims in shadow mode, derived-analytics corruption,
cross-workspace leakage, tiny-score oscillation, and agent mutation of
adaptive policy.

### Backward compatibility

With `mode: HEURISTIC` — the default — no profile is loaded, no prediction is
computed, no adaptive record is written, no event is emitted, and admission
uses the same figures it used in vNext.7. One configuration value restores
pre-vNext.8 behavior with no migration and no loss of canonical state.

## 1.9.0 (unreleased) — vNext.7 Context Efficiency Runtime

The previous six phases made a long-horizon job survivable: it outlives its
worker, its quota, an outage, and its own failed attempts. This phase answers
a narrower question.

> How little can a worker be told, and still succeed?

The distinction from vNext.1 is easy to blur and worth stating once:

```text
vNext.1:   Do not die when the context window fills.
vNext.7:   Avoid filling it unnecessarily.
```

vNext.1's AutoCompact machinery is untouched. `ContextLifecycleManager`,
`ContextBudget`, the three compaction levels, delta context, and the
native-compaction adapter all still do exactly what they did; this phase sits
in front of them and decides what goes in, so compaction has less to do.

Three invariants govern everything below:

1. **Context is disposable working memory; SpecBridge state is canonical
   memory.** Unchanged from vNext.1, and the reason retrieval only ever
   produces `WORKING_SET` items.
2. **Retrieval and compression may reduce working context; they may never
   rewrite or replace canonical engineering truth.** Pinned and durable
   layers are assembled from durable state by the same code under every
   strategy, including `LEGACY`.
3. **Send context according to execution shape.** A tool-capable harness
   receives pointers and durable state; a direct model with no tools receives
   the bounded working set. Sending both pays for the same information twice.

**Off by default.** `orchestration.jobs.context.efficiency.strategy` defaults
to `LEGACY`, which reproduces vNext.6 assembly exactly — same items, same
order, and no new files written into the job namespace. `SELECTIVE` and
`PROGRESSIVE` are explicit opt-ins. `LEGACY` is a single branch rather than a
set of disabled flags, which is what makes it a genuine rollback.

### Repository context index

- A derived, rebuildable, **offline** index of workspace metadata:
  workspace-relative path, file kind, language, module association, size, line
  count, content hash, conservatively extracted symbols and import specifiers,
  resolved import edges, path tokens, and test/source pairing. It stores no
  file bodies — an index that cached content would be a second copy of the
  repository that goes stale.
- Persisted at `.specbridge/cache/context-index.json`, deliberately **outside**
  the job namespace: deleting it is obviously safe, costs a rebuild, and
  cannot affect job recovery.
- **Freshness is a content hash, never a timestamp.** Stat data finds
  candidates for re-hashing; whether content is current is always a hash
  comparison. At selection time each chosen file is re-read and hash-checked,
  and a mismatch yields the *current bytes* plus a recorded staleness signal —
  an old body is never shipped under a claim that it is what the repository
  says now.
- Incremental refresh driven by the Git snapshot's changed paths. A snapshot
  that could not *observe* anything — Git unavailable, a summarized directory
  entry — is treated as unknown scope and triggers full re-verification rather
  than being read as "nothing changed".
- Any doubt resolves to **rebuild**: unreadable file, invalid JSON, schema
  failure, format-version mismatch, or a different workspace root.
- Boundaries applied **before any read**: `.git`, `.kiro`, `.specbridge`,
  dependency caches, build output, binaries, lockfiles, oversized files,
  configured `execution.protectedPaths`, `.gitignore` rules, and
  credential-shaped paths. Symlinks are recorded and never followed.

### Deterministic retrieval

- A structured `ContextRetrievalQuery` built **only from durable state**:
  contract, acceptance criteria, current action, latest failure, recovery
  decision, changed files, and prior selections. Never from a conversation.
- Deterministic ranking over checkable facts with configurable integer
  weights, ties broken on path. The same durable state plus the same index
  produces the same plan, forever.
- Four **mandatory** selection reasons that neither ranking, reranking, nor
  the budget may drop: contract reference, failure reference, action
  reference, and changed file — the last bounded to the first N (default 12),
  because a branch-wide diff says something about the branch, not the task.
- Per-role weighting profiles (`EXECUTOR`, `DIAGNOSER`, `REPLANNER`,
  `EVALUATOR`, `PLANNER`, `CRITIC`): roles get different context, not the same
  package at different sizes.
- File-section selection where a structural boundary can be located
  confidently, with the import preamble and the enclosing declaration
  included. Where structure cannot be read reliably, the **whole bounded
  file** is sent — a fabricated "relevant region" looks authoritative and is
  missing the part that mattered.
- An optional, off-by-default local reranker that sees **metadata only**,
  cannot introduce or remove candidates, cannot displace a mandatory
  reference, and falls back to the deterministic order. The deterministic
  candidate set is preserved on the plan whether or not it ran.

### Execution-shape-aware assembly

- `MATERIALIZED` for a worker with no repository tools; `POINTER` for one that
  reads the repository itself. The shape is decided by capability, never by
  provider name.
- Harness bootstraps carry canonical state the repository cannot tell them
  plus ranked repository pointers, and no file bodies. Measured on the
  benchmark fixture: 3,020 → 192 estimated tokens for the same working set.
- Direct-model packets now carry selected source at all. Previously a local
  direct attempt received steering, approved documents, and the task plan —
  and no code, leaving it to invent whole files from the spec.
- The paid lane uses the pointer shape with a much smaller ceiling: unrelated
  repository content does not leave the machine.

### Compression, deduplication, staleness

- Deterministic structured compression first — `test-log-v1`,
  `compiler-log-v1`, `lint-log-v1`, `diff-summary-v1`,
  `repetition-collapse-v1` — preserving the fields a failure fingerprint is
  computed from, so vNext.6 no-progress detection still recognises a repeated
  failure after compression.
- The existing local preprocessor is **strengthened rather than duplicated**:
  it now runs deterministic extraction first and calls the local model only
  for unstructured bulk the parsers could not read. When the local lane is
  unavailable it falls back to the bounded deterministic view rather than
  shipping raw bulk.
- Compression is derived data: it records `sourceHashes` and `sourceRefs`, and
  the canonical raw artifact stays where it already lives. Source files are
  never compressed.
- Authority-aware deduplication (`CANONICAL > TRUSTED > DERIVED > CLAIM`).
  Conflicting facts are never merged into an invented compromise: the higher
  authority survives verbatim and the drop is recorded.
- Freshness semantics per item, with stale content removed before dispatch.
  An item whose freshness cannot be *checked* is kept — removing context on a
  suspicion is its own kind of context miss.

### Bounded progressive expansion

- Five expansion levels from `MINIMAL_BOOTSTRAP` to `BOUNDED_FALLBACK`,
  default ceiling `MODULE_CONTEXT`. Widening advances **one level**, never a
  jump to the ceiling and never "the repository".
- Requires **observed** evidence of insufficiency. Six signals, each one
  something SpecBridge watched happen. A worker asserting it needs more
  context without naming an artifact produces no signal — otherwise a worker
  could request its own budget increase.
- Bounded per attempt and per task in **durable** state, so a restart cannot
  reset the counter, and refused once the working set has grown past a
  configured multiple of its first size.

### Reliability integration (additive to vNext.6)

- `FailureSource` becomes `CONTEXT` on observed insufficiency, which
  `permitsIntelligenceEscalation` already excludes from escalation — so a
  missing file is no longer billed as an intelligence failure.
- New recovery action `EXPAND_CONTEXT`, distinct from `RESTART_FRESH_CONTEXT`:
  a restart rebuilds the *same* package (right for a degraded session), while
  expansion widens retrieval (right for an insufficient one).
- New reason codes `CONTEXT_INSUFFICIENT_EXPAND` and
  `CONTEXT_EXPANSION_EXHAUSTED`. When widening is spent the decision changes
  strategy rather than re-sending a package already proven inadequate.
- The separation of authority is preserved: **Context prepares. Reliability
  decides. The Scheduler places.** The context layer produces an *offer*; a
  hard boundary, an exhausted budget, or broken verification all outrank it.

### Budgets, prefixes, metrics, diagnostics

- Intentional per-layer allocation with reserves for pinned, durable,
  recovery, and delta context. Reserves are floors, not quotas: retrieval can
  never take the last token a pinned item needed. A mandatory working item may
  exceed its allocation deliberately; when even that will not fit, assembly
  raises `ContextBudgetError` rather than silently omitting it.
- Stable-prefix ordering with component identity hashes for observability. An
  item whose freshness tracks the repository is structurally barred from the
  prefix, so a stale body can never be pinned into every subsequent prompt.
  **No caching is ever claimed**: `cachedInputTokens` is recorded only when a
  provider reports it, and `null` means unknown, never zero.
- Per-attempt `ContextEfficiencyMetrics`: strategy, shape, expansion level,
  lane/mode/runner, per-layer composition, retrieved/selected/pointer/excluded
  counts, compression and deduplication savings, expansion count, and —
  separately — provider-reported input and cached tokens. Deliberately
  un-aggregated, so later analysis can ask *what did context cost per
  successful task*, which is not the same question as "did we send fewer
  tokens".
- `specbridge orchestrate explain-context <jobId> <nodeId>` — what was
  selected, why each file was included, why each candidate was excluded, what
  was compressed, what was stale, how large the package was. Diagnostics show
  **metadata only**: paths, hashes, ranges, reasons, sizes. Never source
  bodies or assembled prompts.
- Seven additive job events: `context_index_built`, `context_index_refreshed`,
  `context_selected`, `context_stale_artifact_detected`,
  `context_insufficient`, `context_expanded`,
  `context_expansion_exhausted`.

### Measured results

Benchmark (`tests/context/context-benchmark.test.ts`), 146-file fixture, each
scenario against the baseline it actually reduces:

| Scenario | Baseline | vNext.7 | Reduction |
| -------- | -------- | ------- | --------- |
| single-file bug (DIRECT_MODEL) | whole source tree, 38,096 tokens | 1,640 | 95.7% |
| multi-file feature (HARNESS) | same set materialized, 3,020 | 192 | 93.6% |
| test-failure diagnosis | raw verifier log, 46,539 | 173 | 99.6% |
| repair after failure | rule injected 4×, 124 | 31 | 75.0% |
| architecture-constrained | every ranked candidate, 38,096 | 4,888 | 87.2% |

Comparing `SELECTIVE` against `LEGACY` on total tokens would score retrieval
as a regression, because `LEGACY` sends no repository content at all — the two
are not doing the same job. The release gate is not "fewer tokens": a strategy
passes only when it reduces redundant context *and* preserves the
deterministic outcome.

Performance (`tests/performance/context-perf.test.ts`), 4,001-file repository:
initial index build ~1,530 ms; index size 5.14 MiB (~1.3 KiB/file, metadata
only); incremental refresh of one changed file ~55 ms; retrieval ranking over
the full index ~13 ms; selection ~40 ms; full assembly ~58 ms.

### Backward compatibility

Every schema and configuration field is additive, and `LEGACY` is the default.
`ContextItem` gains optional `provenance`, `freshness`, `authority`,
`selectionReason`, and `compression` fields; items written before this release
parse unchanged and behave exactly as before. The repository index is derived
state with no migration path by design — a version mismatch rebuilds. Deleting
the entire context cache leaves every job recoverable from durable SpecBridge
state plus the repository.

`contracts/context-contract.json` gains the vNext.7 vocabularies additively;
`contracts/orchestration-contract.json` gains one recovery action and two
reason codes; `contracts/cli-commands.json` gains one command.

### Threat model

Thirteen new threats documented in
[docs/security/threat-model.md](docs/security/threat-model.md) §14: stale
context causing incorrect edits, retrieval omitting a critical constraint,
malicious repository text manipulating the reranker, a sensitive file selected
for a remote model, a compressed summary hiding failure identity,
summary-of-summary decay, index corruption treated as canonical truth, the
index escaping the workspace, diagnostics leaking source, expansion becoming a
token-amplification loop, stable-prefix construction pinning stale state, a
context miss misread as an intelligence failure, and a worker requesting its
own context budget increase. Three new explicit non-claims.

---

## 1.9.0 (unreleased) — vNext.6 Reliability, Eval & Recovery Runtime


Every earlier phase answered the same question in a different way: *can
SpecBridge keep running?* This one answers a different question — **should
it?**

> Can SpecBridge stop a long-running agent from repeatedly doing the wrong
> thing: wasting quota, expanding errors, or declaring success without
> sufficient evidence?

The two goals pull in opposite directions. A runtime optimized purely for
continuity will always find something to run next, which is exactly how a
week of prepaid quota disappears into forty attempts at one task, each one
confident and each one identical.

Two invariants govern everything below:

1. **No retry without a reasoned failure classification.** There is no path
   from "attempt failed" to "run it again" that does not pass through a
   structured failure assessment first.
2. **Repeated failure must change strategy, not consume more compute.** When
   loop detection proves the same experiment is about to run a third time,
   the recovery planner refuses it.

And one that was already true, now enforced on every lane equally: a model's
completion claim is never completion evidence. Paid or stronger compute buys
better implementations; it never buys weaker governance.

**Backward compatible.** Every schema and config field is additive. With
`reliability.enabled` set to `false`, evaluation records are still written —
governance is off, observability is not — and the pre-vNext.6 decision
cascade governs transitions exactly as before. An attempt the reliability
layer did not govern carries `null` attribution in the ledger rather than a
fabricated verdict.

### Added

- **Unified execution evaluation** (`reliability/evaluation.ts`): one durable
  verdict per ExecutionAttempt, on the same terms for every lane, over a
  deterministic-first stack — execution integrity, repository integrity,
  build/static, tests, acceptance criteria, and only then a bounded semantic
  review. `PASS` / `FAIL` / `INCONCLUSIVE`, where the third is load-bearing:
  a required check that could not run means the implementation was never
  judged, not that it was judged wrong.
- **Semantic review that cannot outrank evidence.** The deterministic verdict
  is computed before a reviewer's proposal is read, so a reviewer can only
  ever move a passing attempt to failing. On a failing attempt its opinion is
  recorded with outcome `NOT_RUN` and a detail saying it cannot override —
  the invariant is auditable in the record, not merely true in the code.
- **Deterministic acceptance-criteria evaluation** (`reliability/criteria.ts`):
  six machine-checkable criterion forms over approved state — product-contract
  invariant guard patterns and criteria pinned on the canonical checkpoint. A
  change can compile, pass every test, and violate approved intent; that is a
  failed task. Criteria with no structural form are reported unchecked, never
  assumed to hold.
- **Cross-lane failure assessment** (`reliability/assessment.ts`): the stable
  failure taxonomy is unchanged, and an orthogonal `FailureSource` is added
  beside it. A crashed harness and a wrong implementation can share a
  category and demand opposite responses, so escalation consults
  `NON_INTELLIGENCE_FAILURE_SOURCES` before it may even be considered.
  Assessments carry a `basis` — where the conclusion came from — rather than
  a confidence number a model would invent.
- **Execution health and loop detection** (`reliability/health.ts`):
  `HEALTHY` / `DEGRADED` / `STALLED` / `OSCILLATING` / `RUNAWAY`, computed
  from failure fingerprints, diff fingerprints, and a strategy key. Detects
  repeated failure, same-diff no-progress, and edit oscillation (a state
  revisited with the failure unchanged) — the last of which a
  consecutive-pair comparison misses entirely.
- **Attempt-level runaway handling**: per-attempt ceilings on tool calls,
  command runs, test loops, and context growth. `RUNAWAY` outranks every
  other health state; the attempt is stopped, checkpointed, assessed, and
  recovered from. Metrics a runtime did not report stay unknown and never
  fire.
- **A pure recovery planner** (`reliability/recovery.ts`): given the same
  durable state, assessment, budget position, policy, and history it returns
  the same action, forever. Eleven actions from `RETRY_TRANSIENT` through
  `WAIT_FOR_RESOURCE` to `FAIL_TASK`, chosen in a strict priority order that
  reads as the argument for it.
- **Durable recovery decisions**: written before they are returned, carrying
  the action, reason code, failure fingerprint, budget snapshot, and both
  strategies. A crash between deciding and acting leaves the reasoning on
  disk, and a restart continues the recorded decision rather than inventing a
  different one.
- **Unified budget governance as a read model** (`reliability/budget.ts`):
  no new counters. Attempts, repairs, replans, retries, wall clock, shared
  local attempts, API dollars, and subscription quota are each read from the
  component that already owns them, with a new soft/hard distinction so a
  task reconsiders its approach before discovering a wall by hitting it.
- **Reliability attribution on the ExecutionLedger**: evaluation status,
  failure source and fingerprint, execution health, recovery action and
  reason code, and the strategy dimension that changed — plus a
  cost-of-failure summary (attempts, wall time, tokens, and dollars spent
  without a verified completion).
- **`specbridge orchestrate explain-node <jobId> <nodeId>`**: why a task is
  not complete, which checks failed, its execution health, the repeating
  failure fingerprint, remaining budget, why the current recovery action was
  selected, what failure has cost so far, and what would unblock it.
  `--json` for the same content machine-readably.
- **Policy block** `orchestration.jobs.reliability`, deliberately small: only
  genuinely new signals appear in it. Existing bounds stay in
  `jobs.budgets`, `jobs.scheduler.maxLocalAttempts`, and
  `jobs.scheduler.api.budget` rather than being restated under new names.

### Changed

- Task completion now requires **two** independent gates: the evidence
  pipeline (did the trusted verifiers pass over real Git state?) and the
  evaluation (is this attempt's work acceptable?). An attempt that satisfies
  the verifiers but fails evaluation is governed like any other failure.
- `applyDiagnosis` treats a persisted recovery decision as a **ceiling**. A
  diagnoser may narrow toward caution — turning a repair into a replan when
  it finds the plan itself invalid — but can never widen a replan back into
  another identical repair.
- A `REPLAN` decision records no lane at all. Recovery decides what kind of
  attempt is required; the economic scheduler decides where and when it runs.
  On the paid lane, carrying the failed lane forward would read as
  authorization to spend again.
- A paid attempt that failed deterministically is not retried on the API lane
  (`allowApiDeterministicRetry` defaults to `false`). Escalation produces a
  requirement, never an authorization: vNext.5 spend authorization, the API
  budget, and the gap-bridge planner each keep an independent veto.
- `ExecutorDispatchResult` carries the individual verifier outcomes, so
  evaluation can distinguish "failed" from "could not run" instead of reading
  one collapsed boolean.

### Documentation

- New [reliability runtime](docs/orchestration/reliability-runtime.md).
- Threat model section 13 (T54-T68): false completion claims, semantic
  override, repair loops and retry amplification, cross-provider ping-pong,
  paid retry amplification, tool-loop runaway, oscillation, fingerprint
  collision, stale recovery decisions, agents mutating policy or hiding
  failed approaches, replanners changing approved intent, verification
  infrastructure misclassified as implementation failure, and compaction
  losing recovery-critical state. Two new explicit non-claims.

## 1.8.0 (unreleased) — vNext.5 API Gap Bridge

A long-horizon job runs for days; Claude Max quota does not. vNext.2 handled
an exhausted window by **waiting**, which is correct, cheap, and occasionally
useless — a critical task that blocks the whole job does not become less
blocking because waiting is free.

vNext.5 adds a third economic lane whose *only* automatic purpose is carrying
a job across that gap:

```text
LOCAL           zero-marginal-cost compute
      ↓
SUBSCRIPTION    prepaid strong intelligence
      ↓
API             PAYG continuity bridge
```

The API lane is **not** a third equal-priority lane, and that is enforced by
the call graph rather than by convention: `decideLane` is unchanged by this
phase and has no way to name the API lane, so the paid path is unreachable
except through a gap-bridge planner that runs only over a routing the
subscription lane already refused for a capacity reason. There is no
provider comparison anywhere in the scheduler.

Three invariants govern everything: never pay for work Local can reliably
complete or Max can reasonably execute; keep doing useful Local work while
Max is unavailable; and never execute paid work automatically without
explicit spend authorization and bounded budget admission.

**Backward compatible by default.** `api.spendMode` defaults to `DISABLED`
and `api.harnessProfile` to `null`, so an upgraded vNext.4 workspace is
structurally incapable of spending: no planner runs, no `api_*` event is
emitted, and routing is byte-identical. A configured API profile, a binding,
and spend authorization are three INDEPENDENT controls, and all three must be
right before money moves.

### Added

- **`API` execution lane** (`EXECUTION_LANES` += `API`, `LANE_DECISIONS` +=
  `API` / `REQUIRE_APPROVAL`) plus 15 additive `SCHEDULING_REASON_CODES` —
  most of which describe declining to spend, because those are the codes that
  run in production.
- **`ApiGapBridgePlanner`** (`scheduling/api-gap-bridge.ts`) — the one place
  that may conclude "pay". Pure and deterministic; every non-spending path is
  written first and explicitly.
- **`ApiHarnessBinding`** (`scheduling/api-binding.ts`) — the mirror of the
  vNext.4 LOCAL binding, with 10 named refusal statuses. The two are mutually
  honest: a verified-LOCAL profile is refused for the paid lane
  (`LOCAL_COMPUTE`), a verified-REMOTE profile is refused for the free lane
  (`REMOTE_COMPUTE`), `UNKNOWN` qualifies for neither by default, and one
  profile may not serve both economies (`BOUND_TO_LOCAL_LANE`).
- **`ApiSpendMode`** `DISABLED` (default) | `MANUAL` | `AUTO_BOUNDED`, and
  **bounded spend approvals** (`scheduling/api-approval.ts`) scoped to one
  task FINGERPRINT, one profile, one maximum cost, and an expiry — re-checked
  at the moment of spend, single-use, and decided only by a human through the
  CLI. SpecBridge never asks "Allow API?".
- **`SubscriptionGapForecast`** (`scheduling/api-gap.ts`) — reason, expected
  return time, duration, and confidence, over 5 `SUBSCRIPTION_GAP_REASONS`.
  Nothing is fabricated: an unobserved reset stays `null`/`UNKNOWN`, and
  unknown availability makes `AUTO_BOUNDED` *more* cautious.
- **`DelaySensitivity`** `LOW` | `MEDIUM` | `HIGH`
  (`scheduling/delay-sensitivity.ts`) — derived from blocked dependents,
  critical-path membership, ready alternatives, and the ready local backlog.
  Never from a model's opinion about urgency.
- **`ApiCostEstimate`** (`scheduling/api-cost.ts`) over an **operator-supplied**
  price table. SpecBridge ships no prices and fetches none at runtime.
  Unknown cost is `null`, never `0`, and refuses automatic spend outright.
  Budget admission compares a safe figure (mean × `costSafetyMultiplier`).
- **`ApiBudgetController`** (`scheduling/api-budget.ts`) — per-job / per-task /
  per-attempt USD ceilings and bounded attempt counts, with **atomic
  reservation** (read-modify-write behind an exclusive lock, re-checked
  against fresh durable state) so two tasks cannot spend the same dollar.
- **API dispatch through the existing `DeepSeekHarnessRunner`** — no
  `ApiAgentLoop`, no `ApiShellRuntime`, no second harness dependency. Lane is
  a label on the same begin → execute → verify pipeline; the wall-clock bound,
  protected paths, failure taxonomy, and completion authority are identical.
- **Checkpoint before the paid handoff** — a `handoff` checkpoint carrying
  decisions, failed approaches, and known test state, so a fresh remote
  session never needs the Claude conversation that preceded it.
- 14 additive `JOB_EVENT_TYPES` (`api_gap_detected`, `api_budget_reserved`,
  `api_task_dispatched`, `api_budget_reconciled`, `api_max_returned`,
  `api_next_task_returned_to_subscription`, …).
- CLI: `orchestrate scheduler` gains an API section (binding, verified
  locality, pricing status, reserved/committed/unknown/remaining budget,
  pending approvals, and **why each waiting task is not bridging**); new
  `orchestrate api-approve` / `api-deny` — human-only, CLI-only, with no MCP
  tool and no agent-reachable path.
- Docs: [API gap bridge](docs/orchestration/api-gap-bridge.md); threat-model
  section 12 (T42–T53) and a new explicit non-claim about mid-run cost
  enforcement.

### Changed

- `WorkloadProfiler` now also estimates `expectedInputTokens` /
  `expectedOutputTokens` with an honest `tokenBasis`; ledger burn
  observations carry reported token usage. Token estimates take the LARGER of
  history and heuristic — sparse cheap samples must not talk a spending
  decision into risk.
- `SchedulingDecision` gains an `apiBridge` block, present on every decision
  the planner touched *including the ones that declined to spend*, so one
  record answers why API was or was not selected, why Local was not enough,
  why Subscription was not used, how long the gap was, whether the task was
  critical, what it would have cost, and what budget remained.
- `TaskAttempt` / `ExecutionLedgerEntry` gain `apiSpendMode`, `gapReason`,
  `subscriptionAvailableAt`, `estimatedGapDurationMs`, `costSource`,
  `pricingProfile`, `apiBudgetReservationId`, `apiApprovalId`,
  `delaySensitivity`, and separate `estimatedCostUsd` / `reservedCostUsd` /
  `reconciledCostUsd` metrics. Estimated and observed cost are never merged.
- Ready-task selection prefers free or prepaid runnable work over an
  API-bridged task in the same pass.
- `resumeJob` reconciles interrupted API budget reservations to `UNKNOWN` and
  **keeps them charged** — SpecBridge cannot know whether the provider was
  billed before a crash, and releasing such a hold would let a job exceed its
  budget by crashing.

### Deliberately not implemented

API as a normal equal-priority strong lane; best-model or tournament routing;
automatic provider price discovery; runtime price fetching; a billing system;
ML cost prediction; self-learning provider selection; a second generic harness
framework. **Mid-run cost enforcement is not claimed** — the harness/provider
stack exposes no incremental usage, so control is preflight estimation,
reservation, bounded wall time, bounded attempts, and post-run reconciliation.

## 1.7.0 (unreleased) — vNext.4 Local Agentic Runtime

The `LOCAL` economic lane gains a second execution mode. Alongside the
vNext.2 direct path — one bounded structured request whose edits SpecBridge
applies — a task may now run as a **bounded agentic attempt** inside a
verified-local harness runtime that inspects the repository, edits several
files, runs the project's commands, reads the failure, and repairs, all
inside ONE SpecBridge ExecutionAttempt at zero marginal monetary cost.

Nothing about authority moves. Four concepts stay strictly orthogonal in the
vocabulary, the records, and the code paths:

```text
Economic lane  !=  Execution mode  !=  Harness  !=  Model  !=  Compute locality
```

A harness is a tool loop, not a location; a model named `qwen` behind a
public endpoint is remote paid compute. There is deliberately no compound
`LOCAL_DSH`-style value anywhere — "was this free?" and "did this use a
harness?" must stay separately answerable.

Backward compatible by default: `localExecution.strategy` defaults to
`DIRECT_ONLY` and no harness is bound to the lane, so an existing workspace
routes work exactly as it did in vNext.2 whether or not a harness is
installed. **Installation is not authorization.**

### Added

- **LOCAL execution modes** (`DIRECT_MODEL` / `HARNESS`) with a deterministic
  **execution-shape** classifier (`ONE_SHOT` / `AGENTIC`,
  `orchestration/scheduling/execution-shape.ts`) that is independent of the
  vNext.2 suitability class: suitability answers *can local intelligence do
  this?*, shape answers *does doing it need tools?*. Table-driven, pure, and
  never produced by a model.
- **`LocalExecutionResolver`** (`scheduling/local-resolver.ts`) — resolves
  strategy + suitability + shape + binding + prior attempts into
  `DIRECT_MODEL`, `HARNESS`, or `LOCAL_UNAVAILABLE`. Kept out of the quota
  scheduler on purpose: the lane is decided first, and mode resolution can
  never change it.
- **Verified compute locality** (`runners/deepseek-harness/locality.ts`,
  `COMPUTE_LOCALITIES = LOCAL | REMOTE | UNKNOWN`) — pure, offline, fail
  closed. New DSH profile fields `computeLocality`
  (`unconfirmed` | `loopback-endpoint` | `managed-local-model`) and
  `providerEndpoint`, which SpecBridge parses itself and requires to be
  loopback. `REMOTE` is refused for the LOCAL lane outright; `UNKNOWN` is
  admitted only by an explicit experimental override, recorded on the
  decision. Credential-shaped `environmentPassthrough` NAMES disqualify a
  local binding (names only — values are never read or logged).
- **LOCAL harness binding** (`scheduling/local-binding.ts`) with named
  refusal statuses (`NOT_CONFIGURED`, `PROFILE_MISSING`,
  `PROFILE_NOT_HARNESS`, `PROFILE_DISABLED`, `PROFILE_INCOMPLETE`,
  `BOUNDARY_UNCONFIRMED`, `NOT_VERIFIED_LOCAL`, `REMOTE_COMPUTE`), so "why
  did my harness not run?" always has one structured answer.
- **Harness dispatch** (`scheduling/local-harness.ts`) — one bounded agentic
  attempt through the EXISTING interactive evidence pipeline: repository
  lock, trusted baseline snapshot, agentic run, then post snapshot,
  protected-path comparison, trusted verification, verified-only completion.
  A harness claim is a claim. Failures are split into `INFRASTRUCTURE` and
  `INTELLIGENCE`, because a crashed runtime says nothing about the task.
- **Mode-aware context**: the harness bootstrap package carries canonical
  SpecBridge memory (task contract, acceptance criteria, invariants,
  decisions, failed approaches, known test state, next actions, protected
  paths) plus POINTERS to the approved documents — an agent with tools
  fetches those itself. The checkpoint stays canonical; the harness session
  and its native compaction remain disposable working memory, and every
  attempt starts a fresh session bootstrapped from the checkpoint.
- **Within-LOCAL escalation**: a direct attempt that failed for lack of
  repository knowledge (declined, produced no change, or failed verification)
  continues on the harness path via the new `LOCAL_DIRECT_TO_HARNESS`
  escalation — `LOCAL → LOCAL`, no subscription quota, same shared budget.
- **Rollout strategy** `orchestration.jobs.scheduler.localExecution`:
  `strategy` (`DIRECT_ONLY` default / `HARNESS_ONLY` / `ADAPTIVE`),
  `harnessProfile`, `maxHarnessWallTimeMs`, `allowUnverifiedLocality`. Plus a
  per-run diagnostic override (`driveJob({ localExecutionMode })`) that can
  never pull `STRONG_REQUIRED` work local or bypass locality verification.
- **Records**: `SchedulingDecision.localExecution` (mode, mode reason, shape,
  runner, model, computeLocality, locality evidence, binding status),
  `ExecutionAttempt`/`ExecutionLedger` `executionMode` / `executionShape` /
  `computeLocality`, and `commandRuns` / `compactions` metrics. Unknown
  stays unknown — a fabricated zero would corrupt every later comparison.
- **Observations and A/B evaluation**:
  `summarizeLocalRuntime` compares modes by attempts, verification pass rate,
  median wall time, and reported tokens/tool calls per task category;
  `evaluateLocalRuntime` runs the same task through both modes in separate
  detached git worktrees at HEAD (never the working tree, never concurrently
  in one workspace). New `specbridge orchestrate local-benchmark` exposes it,
  and `specbridge orchestrate scheduler <jobId>` now shows the strategy, the
  binding with its locality evidence, the predicted mode per ready task, and
  DIRECT-vs-HARNESS outcomes.
- New scheduling vocabulary: `LOCAL_EXECUTION_MODES`,
  `LOCAL_EXECUTION_STRATEGIES`, `LOCAL_EXECUTION_SHAPES`,
  `LOCAL_EXECUTION_MODE_REASONS`, `COMPUTE_LOCALITIES`; job events
  `local_execution_mode_selected`, `local_harness_selected`,
  `local_harness_unavailable`, `local_harness_locality_rejected`,
  `local_direct_to_harness_escalated`,
  `local_harness_to_subscription_escalated`,
  `local_runtime_evaluation_recorded`.
- Documentation: [Local agentic runtime](docs/orchestration/local-agentic-runtime.md),
  threat-model entries T37–T41 (silent paid billing on a "free" lane,
  credential inheritance, control-plane mutation, unbounded tool loops,
  prompt injection reaching an agent that can act), and a new non-claim:
  verified locality is an attestation check, not a network monitor.

### Changed

- `maxLocalAttempts` is now explicitly the **whole lane's** budget: two
  execution modes never mean two budgets, and attempt numbers remain one
  continuous history (`DIRECT` then `HARNESS` then strong escalation).
- The DeepSeek Harness profile is still PREVIEW, still disabled by default,
  and still never selected automatically — it additionally requires an
  explicit LOCAL binding and verified-local compute before the scheduler will
  use it. `runner doctor` reports the verified locality as its own capability
  row and warns about credential-shaped passthrough names.

### Explicit non-goals (deferred to vNext.5 and later)

- No `API` lane, no API Gap Bridge, no automatic PAYG fallback. A harness
  profile with remote/PAYG compute cannot participate in automatic LOCAL
  routing at all.
- No general harness subagent/workflow orchestration: one SpecBridge attempt
  remains one harness root agent with a bounded tactical loop.
- No learned routing, bandit selection, or predictive success model. vNext.4
  collects the evidence a later adaptive scheduler would need.
- A harness-only LOCAL lane (no local model configured) is not supported: the
  lane's worker slot is the configured local model worker.

## 1.6.0 (unreleased) — vNext.3 DeepSeek Harness Integration

DeepSeek Harness (DSH) becomes an isolated, replaceable agent-harness
backend behind the existing frozen `AgentRunner` contract: SpecBridge stays
the engineering control plane (Job/Task, contracts, ExecutionAttempts,
Checkpoints, canonical context, quota, scheduling, evidence, completion
authority); DSH owns only attempt-local mechanics (agent loop, tools,
sandbox, agent-local session/context, native compaction). The governing
invariant, proven end to end by the new validation scenario: **DSH state is
disposable working state** — killing the runtime, deleting its sessions, or
replacing its version never destroys a Job, Task, Checkpoint, Decision, or
Evidence.

Integration, not migration: the profile is PREVIEW, disabled by default,
never selected automatically, and changes no scheduler behavior — vNext.2
LOCAL/SUBSCRIPTION routing and the direct LocalExecutor path are
byte-identical with DSH enabled or not. Automatic `LOCAL → HARNESS` routing
is explicitly deferred to vNext.4; API-lane gap routing to vNext.5.

### Added

- **`deepseek-harness` runner** (`packages/runners/src/deepseek-harness/`)
  — task execution and (attested, verified) session resume through the
  official `@deepseek-ai/dsh-sdk-client`, exact-pinned at `0.1.1-rc.1`
  (developer preview) and isolated inside `@specbridge/runners`. One narrow
  `DshSdkAdapter` owns every SDK call — launch, `initialize` handshake
  (wire-stable `deepseek-harness-sdk-runtime` identity verified, runtime
  version recorded), receipt-to-idle run collection, bounded teardown —
  so a breaking SDK change lands in one file and no DSH/Cordis type leaks
  into core domain packages. The runtime runs out-of-process, launched
  from an explicit argv command spec with an allowlist-REPLACED child
  environment (never inherited credentials).
- **Fail-closed safety attestations** — the public DSH SDK exposes no
  sandbox/tool-restriction configuration (the runtime's own `cordis.yml`
  owns its tools), so task execution is unavailable
  (`sandbox_unavailable`, pre-spawn) until the operator attests
  `workspaceBoundary: "runtime-profile"`; authoring is refused outright
  (no enforceable read-only boundary); the adapter is `preview` and can
  never be confirmed production by conformance. SpecBridge protected-path
  checks and evidence evaluation still verify every run independently.
- **Resume with a continuity guard** — `sessionPersistence:
  "runtime-managed"` enables the fast path, and every resume is verified
  by session-log `seq` continuity: a runtime that silently recreated the
  session empty (seq 0) is stopped before any agentic work and normalized
  as `session_unavailable`, falling back to the canonical path (SpecBridge
  Checkpoint + repository state + ContextLifecycle reconstruction → fresh
  session). A lost DSH session never loses a Task.
- **Bounded cancellation/timeout/crash semantics** — the DSH wire has no
  mid-turn cancel, so aborts and deadlines close the runtime through the
  SDK's shutdown → EOF → SIGTERM → SIGKILL ladder (idempotent, no orphan
  processes); crashes classify as worker failures that preserve the
  attempt, checkpoint, and Job.
- **Event normalization + strict reasoning redaction** — safe lifecycle
  notifications map into `NormalizedRunnerEvent` (plus the additive
  `compaction.occurred` type for observed native compaction — working
  memory only, never canonical); reasoning blocks/deltas are never
  persisted anywhere (occurrence metadata only; retained raw notification
  logs are deep-redacted and `request/header` prompts elided). Usage is
  provider-reported per `assistant/message` accounting; cost is never
  computed.
- **Deterministic fake DSH runtime**
  (`tests/fixtures/fake-dsh/fake-dsh.mjs`) — speaks the real stdio
  JSON-RPC protocol to the REAL pinned SDK client in CI: success,
  false-claim, malformed/prose output, reasoning, compaction, subagents,
  RPC errors, hang, crash, EOF-refusing teardown, and cross-process
  session persistence for resume/lost-session scenarios.
- **vNext.3 validation scenario**
  (`tests/orchestration/dsh-validation.test.ts`) — workspace → explicit
  DSH profile → Attempt/Checkpoint/ContextPackage → real subprocess run →
  independent evidence → native compaction with durable context
  byte-identical → mid-attempt crash → restart/reconcile → lost session →
  checkpoint reconstruction → fresh session → verified completion →
  delete ALL DSH state → everything canonical survives → disabled profile
  changes nothing. Plus runner-level (`tests/runners/deepseek-harness.
  test.ts`) and evidence-boundary/conformance suites
  (`tests/execution/deepseek-harness-execution.test.ts`).

### Changed

- **Additive public contracts** (deliberate, snapshot-regenerated): runner
  kind `deepseek-harness`; normalized error code `session_unavailable`
  (non-retryable); normalized event type `compaction.occurred`;
  `deepseekHarnessProfileSchema` in the profile union with a disabled
  built-in profile (existing workspaces load unchanged, no migration).
- **Execution-layer conformance** now selects the profile under test
  explicitly (`runnerName`), so preview adapters — explicit-selection-only
  by design — are exercised exactly like `runner conformance <profile>`;
  production adapters are unaffected.

## 1.5.0 (unreleased) — vNext.2 Free & Prepaid Optimizer

SpecBridge's job runtime becomes an intelligent scheduler over two compute
resources: **local model compute** (zero marginal cost, no subscription
quota) and the **prepaid Claude Max subscription** (the primary
strong-intelligence engine, limited by rolling five-hour and weekly quota
windows whose unused capacity expires at reset). The governing policy: use
local compute for work it can reliably perform, use Max productively while
it is available, harvest capacity that is about to expire, and never let a
subscription cooldown stall local-capable work. The PAYG API lane is
explicitly **not** part of this release — when Max is unavailable and local
execution cannot handle a task, the task stays durably pending with a
recorded scheduling reason.

Additive throughout: the scheduler block is optional and defaulted
(`orchestration.jobs.scheduler.enabled: false` restores vNext.1 scheduling
byte-identically), every vocabulary and event addition is append-only, new
schema families are versioned from day one (`quotaSnapshot`,
`schedulingDecision`), and attempt-metric extensions are nullable
observations — nothing fabricated, no migration required.

### Added

- **Execution lanes** — the scheduler reasons about the economic lane
  (`LOCAL` / `SUBSCRIPTION`) first, then the concrete provider
  (`scheduling/vocabulary.ts`).
- **Local task execution** (`scheduling/local-execution.ts`) — the local
  model becomes a first-class execution provider with SpecBridge driving
  the loop: one bounded structured request returns complete replacement
  file contents (or an explicit escalation), SpecBridge validates and
  applies them, and the EXISTING interactive evidence pipeline verifies
  (lock, Git snapshots, trusted verification, verified-only completion).
  Local attempts are ordinary durable ExecutionAttempts on the `LOCAL`
  lane; the model itself never writes, has no tools, and no shell.
- **Deterministic local suitability** (`scheduling/suitability.ts`) —
  `LOCAL_SAFE` / `LOCAL_TRY` / `STRONG_REQUIRED` from documented keyword
  tables plus the deterministic complexity class. `LOCAL_TRY` requires
  trusted verification commands: verifiability, not perceived difficulty,
  is the criterion.
- **Bounded local retries** — `scheduler.maxLocalAttempts` (default 2)
  local execution attempts per task, then a sticky
  `LOCAL_EXECUTION_ESCALATED` escalation routes the task to the strong
  lane. Failed local attempts stay visible in attempt history and ledger.
- **Subscription quota model** (`quota/`) — independent five-hour and
  weekly window snapshots (never combined into one percentage), a
  `QuotaTelemetryProvider` abstraction (manual file-backed adapter kept
  current via the CLI, deterministic fake for tests, a documented seam for
  future machine-readable adapters — no UI scraping, no invented APIs),
  freshness handling (`FRESH`/`STALE`/`UNKNOWN`), and a pure
  `QuotaForecast` the scheduler consumes as a value.
- **Workload profiler** (`scheduling/profiler.ts`) — wall time, five-hour
  burn, weekly burn, and context growth estimated independently, with
  explicit confidence and basis; heuristic complexity defaults replaced
  conservatively by subscription-lane ledger history (medians, observation
  floor). Burn-over-time is a profile (`linear` today) — the extension
  point for measured curves.
- **Cooldown-aware scheduler** (`scheduling/scheduler.ts`) — modes
  `NORMAL` / `CONSERVE` / `HARVEST` / `EXHAUSTED_5H` / `EXHAUSTED_WEEKLY`
  as explicit domain state; weekly scarcity suppresses five-hour
  harvesting; pure lane decisions (`LOCAL`/`SUBSCRIPTION`/`DEFER`) with a
  closed reason-code vocabulary.
- **Cross-reset admission** (`scheduling/admission.ts`) — admission
  compares expected **burn before the reset** (plus a configurable safety
  multiplier) against remaining capacity minus the dynamic reserve;
  `taskDuration <= timeToReset` is deliberately not a rule anywhere. The
  mandatory scenario (50% remaining, reset in 20 minutes, 50-minute task
  burning 35%) starts immediately and continues across the reset.
- **Dynamic reserve** (`scheduling/reserve.ts`) — interpolates from
  `baseRatio` far from the reset to `minRatio` near it; weekly pressure and
  stale telemetry add reserve.
- **Ready-task selection and cooldown overtake** — the scheduler inspects
  every READY node; runnable work beats deferring work, HARVEST prefers
  admissible strong work, and a LOCAL-lane node whose only unfinished
  predecessors are quota-deferred is promoted (recorded) so local work
  continues through a subscription cooldown. Deferred strong work parks the
  job in `WAITING_RETRY` with `retryAt` at the reset — resumable, never
  blocked.
- **Context-aware admission** — quota capacity and context capacity are
  both required; heavy durable context triggers the vNext.1
  checkpoint → compact → reconstruct path before the dispatch
  (`context_compaction_before_dispatch`).
- **Local preprocessing** (`scheduling/preprocess.ts`) — bulky regenerable
  context items (test logs, tool output) compressed into structured
  summaries via the local lane before strong work sees them; pinned and
  durable layers untouched.
- **SchedulingDecision records** — every routing/admission decision
  persisted (`jobs/<id>/scheduling/decisions.jsonl`, bounded) with the
  forecast, estimate, reserve, context status, and reason code it saw.
- **ExecutionLedger extensions** — optional nullable attempt metrics
  (five-hour/weekly remaining before and after, context usage before and
  after, test loops) plus lane, suitability, category, and decision id;
  `quota/observations.ts` derives burn, burn-per-minute, wall time, and
  success aggregates without fabricating gaps (a reset crossed mid-attempt
  makes burn honestly unknown).
- **Observability** — seventeen additive job events
  (`quota_snapshot_updated`, `scheduler_mode_changed`, `harvest_entered`,
  `cross_reset_admitted`, `task_routed_local`, `task_deferred`,
  `local_escalation_triggered`, …) and three CLI commands:
  `orchestrate quota`, `orchestrate quota-set`, `orchestrate scheduler`.
- **Configuration** — `orchestration.jobs.scheduler` (additive, defaulted,
  documented; outside the job policy fingerprint like the context block).
- **Documentation** — `docs/orchestration/quota-scheduling.md`.

### Explicit non-goals (deferred to vNext.3)

PAYG API gap bridge and automatic API fallback, predictive/ML scheduling,
semantic repository indexing, multi-agent collaboration, distributed
scheduling, billing.

## 1.4.0 (unreleased) — vNext.1 Survival Runtime

The first stage of SpecBridge's evolution into a provider-neutral
long-horizon engineering runtime. A job now survives agent death, session
loss, provider handoff, process restart, and repeated model-context
compaction without losing the durable information required to continue
correctly. Two invariants govern the design: **agents and model sessions
are disposable workers — SpecBridge owns the durable job state**, and
**context windows are disposable working memory — SpecBridge state is
durable memory**.

Additive throughout: no persisted schema version moved, every new schema
family is versioned from day one (`taskAttempt`, `taskCheckpoint`,
`contextPackage`, `runnerContextCapabilities`), existing CLI/MCP/plugin
surfaces are unchanged, and v1.0–v1.3 workspaces load with no migration.

### Added

- **Durable ExecutionAttempts** (`@specbridge/orchestration` `survival/`) —
  Job, Task, and ExecutionAttempt are now three distinct durable concepts. A
  Task (job graph node) is durable intended work; an attempt is ONE
  disposable worker run against it, persisted at `.specbridge/jobs/<jobId>/
  task-attempts/` **when the dispatch starts** (status `RUNNING`), finalized
  when it ends, and reconciled `RUNNING → INTERRUPTED` by `resumeJob` when
  the owning process disappeared. Attempts are append-only history with
  `resumedFromAttemptId` lineage; retrying or switching providers never
  overwrites a previous attempt.
- **Structured task checkpoints** — `taskCheckpointSchema`: objective,
  pinned context (task contract, acceptance criteria, constraints,
  invariants), completed/pending work, important decisions, **failed
  approaches**, changed files, repository state (Git-snapshot grounded, no
  commit required), test results, known failures, unresolved issues,
  next actions, artifact references. Append-only revisions per task;
  decisions and failed approaches carry forward automatically; a completed
  task auto-checkpoints as a milestone. Corrupt newest revisions fall back
  to the newest readable one.
- **`@specbridge/context`** — the provider-neutral context lifecycle as a
  pure, deterministic domain package: six context layers (`PINNED`,
  `DURABLE_TASK_STATE`, `COMPACTED_HISTORY`, `WORKING_SET`, `RECENT_DELTA`,
  `CURRENT_ACTION`; the protected layers can never be compacted away),
  configurable context budgets with reserved output/reasoning/growth
  headroom, a closed health vocabulary (`HEALTHY` → `PREPARE` →
  `PROACTIVE_COMPACT` → `FORCE_COMPACT` → `OVERFLOW` at configurable
  ~55/70/85/90% thresholds), three compaction levels (micro / milestone /
  emergency — emergency is a normal operation that only discards state a
  persisted checkpoint already made durable), a bounded recent-delta log,
  a pluggable summarizer boundary, and a `ContextLifecycleManager`
  composing them. Over-budget assembly with no checkpoint **fails
  explicitly** rather than silently dropping context.
- **Deterministic context reconstruction and resume** —
  `reconstructTaskContext` / `prepareTaskResume`: load Job → Task → latest
  checkpoint → pinned → durable → repository snapshot/working set → delta →
  apply budget → compact if required → `ContextPackage`. A fresh worker (or
  a different provider) starts from SpecBridge durable state plus current
  repository state; the previous agent conversation is structurally
  unreachable. Cumulative task context can exceed one model window by many
  multiples (exercised at >5× in tests).
- **Execution ledger** — every attempt yields a normalized
  `ExecutionLedgerEntry` (`readExecutionLedger`,
  `summarizeExecutionLedger`): provider, model, timings, tokens, tool
  calls, files changed, cost — all null-tolerant. Missing provider metrics
  never block execution and are never fabricated.
- **Provider context capabilities** (`@specbridge/runners`) — additive
  optional `declaredContextCapabilities` on the runner contract (window
  size when known, native-compaction mode `none`/`automatic`/`explicit`,
  session persistence), declared by the Claude Code adapter (automatic
  native compaction, sessions) and the mock adapter (deterministic small
  window, no native compaction). Provider-native compaction integrates
  through the `NativeCompactionAdapter` boundary and remains session
  working memory — it can never become canonical SpecBridge state, and
  cross-provider continuity never depends on it.
- **Context policy** — additive `orchestration.jobs.context` configuration
  block (default window, reservations, compaction thresholds, delta
  bounds). Operational tuning only; nothing here can weaken a safety
  boundary or configure pinned state away.
- **Observability** — additive job events (`attempt_started`,
  `attempt_completed`, `attempt_interrupted`, `task_checkpoint_created`,
  `task_resumed`, `context_threshold_reached`, `context_compacted`) with
  stable ids; new SBO049–SBO051 error codes; new `context-contract.json`
  snapshot and schema-version registrations.
- **Tests** — `tests/context/context-lifecycle.test.ts` (budgets, health,
  compaction levels, >5× repeated-compaction survival, emergency pressure
  as normal operation), `tests/orchestration/survival-runtime.test.ts`
  (attempt lifecycle, checkpoint carry-forward and corruption fallback,
  process restart, provider handoff, canonical-state independence,
  failed-approach preservation, crash recovery, ledger tolerance), and
  `tests/orchestration/survival-validation.test.ts` (the full end-to-end
  survival scenario against a real Git workspace).
- **Documentation** — `docs/orchestration/survival-runtime.md`: runtime
  ownership, Job/Task/Attempt, the context model, the three compaction
  mechanisms and why they are different things, recovery semantics.

### Changed

- `beginExecutorDispatch` also persists the durable attempt (and accepts
  optional `provider`/`model`/`providerSessionId`); `completeExecutorDispatch`
  finalizes it and auto-checkpoints verified completions;`resumeJob`
  additionally reconciles interrupted attempts and reports their ids. All
  signatures remain backward compatible.
- `JobState` gains optional `currentAttemptId` (additive; schema version
  unchanged).

## 1.3.0 (unreleased)

Mission-driven development. v1.2 drives an approved spec as a persistent
job; v1.3 adds everything **around** and **inside** that: how a high-level
product direction becomes an approved spec worth driving (**Mission
Discovery** → contracts → synthesis), and how one approved objective
executes as governed multi-agent work (**dynamic work graphs → isolated
builders → evaluation → aggregation → single-writer integration**) — while
completion authority, human approval, Kiro byte-preservation, and the
evidence pipeline stay exactly where they were.

Two principles run through every addition. *Share truth, not context*:
agents collaborate through approved, versioned artifacts — immutable
context projections — never by sharing conversational context, and no
schema anywhere can carry chain-of-thought. *Model proposes, SpecBridge
governs, evidence decides*: every model output is a schema-validated
proposal that deterministic code accepts, refuses, or routes to a human.

Additive throughout: no persisted schema version moved, no public contract
changed meaning, v1.0/v1.1/v1.2 workspaces load with no migration, and
legacy workflows (`spec run`, `/specbridge:implement`, `/specbridge:develop`,
non-mission orchestration jobs) are byte-identical. Mission-driven
development is an additional mode, never forced.

### Added

- **`@specbridge/mission`** — Mission Discovery as a domain package. A
  fail-closed lifecycle (`IDEA → DISCOVERING ⇄ NEEDS_DECISION →
  CONTRACT_READY → SPEC_SYNTHESIS → SPEC_REVIEW → APPROVED`, plus final
  `ABANDONED`) persisted under `.specbridge/missions/<id>/` — versioned,
  atomic, workspace-confined, append-only where history matters. `.kiro` is
  never touched.
- **Conversation provenance** — every material user-visible discovery
  exchange persists verbatim as a bounded turn; decisions carry structural
  provenance, and a `known-from-user` decision must cite a confirming USER
  turn (an agent turn is refused — the injection boundary is structural).
  Unsafe provenance (`inferred`/`unknown`/`conflicting`) can never back a
  decision. Full lineage: turn → decision → constitution rule → contract →
  requirement → implementation evidence.
- **Deterministic coverage and materiality** — coverage is computed over a
  closed 24-topic taxonomy (never asserted); a deterministic
  irreversibility screen classifies questions touching public API, wire
  protocol, persisted state, configuration language, SDK contract,
  extension SPI, compatibility, security boundaries, delivery semantics, or
  cross-module architecture as **blocking** (it may only RAISE declared
  materiality). Only open blocking questions and unaddressed required
  topics gate `CONTRACT_READY`; implementation detail never stalls
  discovery.
- **Architecture Constitution** — few, strong, durable invariants
  (`CON-###`) with versions, provenance, supersession history kept in-file,
  and optional machine-checkable **guard patterns** the deterministic
  evaluator greps candidate diffs for.
- **ADRs** — immutable `ADR-####` files with context, alternatives,
  rationale, consequences, revisit conditions, and DERIVED supersession
  (old history is never rewritten).
- **Product Contract Registry** — versioned engineering contracts
  (`CTR-###`) with immutable per-revision files, public/internal
  classification, compatibility policies, dependencies, requirements,
  invariants, and provenance. Deliberately separate from the repository's
  own `contracts/` snapshots.
- **Contract change requests** — durable `CCR-###` artifacts
  (`PROPOSED/NEEDS_HUMAN/APPROVED/REJECTED/SUPERSEDED`). Anyone may raise
  one (workers, aggregators, MCP, CLI); **only the human decides one**, and
  the decision path is CLI-only (`specbridge mission ccr … --approve|
  --reject`). Approval writes the next immutable revision, records the
  decision in the provenance chain, and makes every projection built
  against the old revision stale — affected work replans, never continues
  silently.
- **Mission → spec synthesis** — a deterministic compiler (no model) from
  the contract set to Kiro candidates through the existing creation
  machinery, archived with a provenance map before creation. For
  mission-driven projects `tasks.md` contains **Objectives with acceptance
  criteria**, not coding steps. Approval remains the unchanged human
  workflow.
- **The objective runtime** (`@specbridge/orchestration` `objectives/`) —
  between an approved objective and worker dispatches: a **dynamic work
  graph** (append-only revisions, fail-closed unit state machine in which
  `INTEGRATED` is reachable only from `VERIFIED_CANDIDATE`), proposed by a
  new DECOMPOSER role and validated deterministically (bounds, acyclicity,
  depth, terminal integration unit, contract-ownership surfacing) — with a
  deterministic single-unit fallback, so a model outage cannot stall an
  objective. Runtime replanning may split/supersede units within the
  approved objective; it can never silently change approved behavior.
- **Context projections** — immutable, hashed, bounded worker context:
  constitution snapshot + objective + relevant contract revisions + ADRs +
  decisions + spec excerpts + verified dependency evidence. Identity is two
  hashes (content, contract snapshot) stamped into the worker record;
  staleness is structural and fails closed.
- **AgentSupervisor** — durable worker identity per attempt and fail-closed
  result acceptance: wrong identity, duplicate, late/superseded, forged or
  stale hashes are all rejected even when content looks valid; two workers
  can never own one attempt.
- **Isolated builder worktrees** — one detached git worktree per
  (workUnit, attempt) under the sidecar, dependency patches applied on top;
  SpecBridge observes the diff against the recorded baseline (a worker
  committing locally hides nothing), runs trusted verification inside the
  worktree, refuses protected-path changes, never pushes or merges, and
  prunes on resume with interrupted workers superseded.
- **Candidate artifacts** — durable results (observed changed files,
  normalized patch, local verification, bounded claims incl. discovered
  assumptions and contract change requests). No field can encode commands,
  permissions, or authority.
- **Evaluation engine** — deterministic layer always first (identity,
  protected paths, projection freshness, local verification, non-empty
  change, scope, contract guard patterns; a guard hit is a CONFLICT), then
  a semantic EVALUATOR (local-first) only where judgment is genuine, with
  schema-constrained verdicts routed through the existing decision-authority
  table. A worker is never the sole evaluator of its own work.
- **Aggregation engine** — structural aggregation is deterministic (a
  failed required unit prevents integration, no model involved); semantic
  aggregation runs one bounded AGGREGATOR dispatch only over ≥2 verified
  investigation reports, may surface cross-report contract conflicts
  (first-class `CONTRACT_CONFLICT` records — never a silently picked side)
  and recommend contract changes (as CCRs, never approvals).
- **Single-writer integration** — the INTEGRATOR applies verified
  candidates in dependency order inside the existing interactive-run
  bracket (lock, snapshots, protected paths, trusted verification,
  verified-only completion); one bounded reconciliation dispatch may make
  minimal integration edits on a genuine patch conflict. No second
  completion path exists.
- **Conservative opt-in parallelism** — `orchestration.jobs.objectives.
  parallelism` (default disabled). Concurrency only for provably
  independent units (disjoint declared contracts and areas; unresolved
  decisions serialize everything; unprovable independence runs alone), and
  only the isolated builder dispatches run concurrently — graph writes stay
  sequential, and integration remains exactly one run.
- **New agent roles** (additive enum): DECOMPOSER, BUILDER, EVALUATOR,
  AGGREGATOR, INTEGRATOR — with deterministic routing (BUILDER/INTEGRATOR
  structurally require the repository-writing large agent; DECOMPOSER/
  AGGREGATOR default large-agent; EVALUATOR local-first), 18 new semantic
  job event types, and SBO039–SBO048.
- **Configuration** (additive, defaulted): `orchestration.jobs.objectives`
  (bounds, builder attempts/timeout, semantic-evaluation mode, parallelism,
  candidate/projection ceilings) and routing entries for the new reasoning
  roles.
- **CLI**: the `specbridge mission` group (begin, status, show, events,
  coverage, answer, contract-ready, synthesize, contracts, adr, ccr,
  decisions, reopen, abandon) plus `orchestrate objective` and
  `orchestrate workunit` inspection.
- **MCP**: 14 tools (50 → 64) — `mission_begin/status/read/record_turn/
  assess/questions/answer/synthesize`, `contract_list/read/
  change_request`, `objective_read`, `workunit_read`, `evaluation_read`.
  Deliberately absent: stage approval, CCR decisions, filesystem, shell,
  git, or any automatic human-decision API.
- **Plugin**: `/specbridge:discover` (13 → 14 skills) — the discovery
  interlocutor; it records and proposes, approves nothing, and never
  becomes the long-running executor.
- **Contracts**: new `contracts/mission-contract.json` snapshot; schema
  versions snapshotted for all mission and objective families (and the
  v1.2 job families); orchestration snapshot gains the objective vocabulary
  additively.
- **StepRelay dogfood** — offline end-to-end scenarios proving the full
  §Definition-of-Done flow: discovery with blocking-question gating,
  contract synthesis, human approval, dynamic decomposition, isolated
  parallel builders, deterministic `nextState` conflict detection, the
  missing-`nack` CCR loop with stale-projection replanning, investigation
  aggregation with contradiction stops, persistent-failure honesty, and
  mid-objective interruption resumed to completion.

### Fixed

- The shared model-API HTTP client no longer composes its total timeout
  with `AbortSignal.any([AbortSignal.timeout(ms), external])`. On Node 20
  the composite holds only weak references to its sources, so an
  otherwise-unreferenced timeout signal could be garbage collected before
  its timer fired — and a request against an endpoint that never answers
  (Ollama, OpenAI-compatible, the managed local model, registry downloads)
  then hung forever instead of timing out. This was the intermittent
  node-20 CI failure where "a timeout aborts the request deterministically"
  burned the full 30-second test budget. The client now uses one explicit
  `AbortController` with a real timer per request — no GC dependence on any
  Node version — released in a `finally`, which also fixes the 'abort'
  listener `any()` leaked on long-lived external signals per request, and
  makes the timeout genuinely TOTAL across redirect hops and body
  streaming, as the contract always documented.

## 1.2.0 (unreleased)

The persistent, local-first, multi-agent orchestrator. v1.1 governed how a
single interactive session works through one task; v1.2 adds the layer
above it: a **long-running job** that takes an approved spec, plans the
work, schedules bounded agent executions, verifies results, diagnoses
failures, repairs defects, replans invalid assumptions, escalates hard
reasoning to Claude Code, checkpoints continuously, survives process
interruption, and continues until the approved work is verified complete or
honestly blocked. SpecBridge owns state, policy, scheduling, budgets, and
completion; agents are replaceable ephemeral workers.

Additive throughout: no persisted schema version moved, no public contract
changed meaning, and v1.0/v1.1 workspaces load with no migration. New
schema families (job state 1.0.0, job graph 1.0.0, job checkpoint 1.0.0)
and new SBO codes (SBO025–SBO038) are appended, never renumbered.

### Added

- **Persistent jobs** under `.specbridge/jobs/<jobId>/` — versioned,
  atomic, workspace-confined state; append-only graph/plan/agent-result/
  event history; compact checkpoints; a 13-status fail-closed state machine
  in which `RUNNING → REPAIRING` deliberately does not exist (a failure
  must pass through `DIAGNOSING` first).
- **Runtime execution graphs** independent of the approved `tasks.md`: one
  node per open required leaf task, explicit dependencies, per-node plan
  revisions with supersession lineage, and graph-revision node supersession
  that carries attempt history and replan budgets forward. Runtime ids
  never touch `.kiro`, and no replan can change approved intent — the
  replanner must declare impact AND a deterministic keyword screen checks
  the replacement regardless of the declaration.
- **A deterministic scheduler** (`scheduleNext`): one pure function from
  (job, graph, policy, workers, clock) to the single next action —
  reproducible in tests and quoted verbatim in the audit trail. Sequential
  source mutation (`maxConcurrentTasks` fixed at 1) matches the evidence
  model; the field exists so future parallelism is a config change.
- **Agent roles and tiers**: CLASSIFIER / PLANNER / CRITIC / DIAGNOSER /
  REPLANNER (read-only) and EXECUTOR (the only writing role) across
  LOCAL_SMALL and LARGE_AGENT reasoning tiers with LOCAL/PAID cost tiers.
  Routing is **local-first, escalate-on-evidence** with sticky, recorded
  escalation reasons — a paid worker is never selected silently, and
  `escalation: "manual"` stops for the user instead.
- **Deterministic complexity assessment**: documented signal classes
  (public API, architecture, security, distributed semantics, concurrency,
  persistence, new dependencies, failure/replan history) scored into
  LOW/MEDIUM/HIGH routing classes; hard signals force HIGH; a local
  classifier may only RAISE the class.
- **Structured local-agent contracts** for all five reasoning roles:
  versioned zod schemas plus strict JSON Schemas for constrained decoding,
  complete-response validation (no substring extraction, no silent
  repair), one bounded correction round, and conversion into the existing
  v1.1 execution-plan lifecycle. No schema has a field for
  chain-of-thought.
- **LocalModelManager** — a managed llama.cpp server lifecycle: validated
  executable/model paths, loopback-only binding (not configurable;
  reserved flags rejected in `extraArgs`/`executableArgs`), observed
  /health readiness, bounded log capture, idle shutdown, graceful stop,
  and bounded LAZY restarts. One server serves all roles; a local model
  crash is a worker failure, never a task failure.
- **`specbridge orchestrate run <spec>`** — the foreground persistent
  driver (Ctrl+C checkpoints; `--resume` continues the SAME job), plus
  `jobs`, `job`, `node-plan`, `review-plan`, `answer`, `cancel-job`, and
  `--dry-run`/`--json`. Executor dispatches run through the UNCHANGED
  evidence pipeline: git snapshots, trusted verification, verified-only
  checkbox completion — job orchestration adds no second completion path.
- **`specbridge local-model doctor|status`** — read-only diagnostics; no
  spawn, no inference.
- **MCP**: `job_list`, `job_read`, `job_cancel` — thin and deliberately
  narrow; jobs are driven by the standalone process, never from MCP.
- **Plugin**: `/specbridge:orchestrate` — inspect jobs, surface gates,
  relay human decisions; the interactive session never launches the
  orchestrator or nested agents (the standalone orchestrator invoking the
  Claude Code runner is the designed worker path).
- **Configuration** (additive, defaulted): `localInference` block and
  `orchestration.jobs` policy (routing, plan review `high-risk|always|
  auto`, escalation mode, complexity thresholds, budgets incl. optional
  reported-usage cost/token ceilings). Config migration carries both
  blocks; the v1/v2 schema versions are unchanged.

### Fixed

- `TaskRunRequest` gained additive `extraObservations` so a repair dispatch
  can hand the executor the latest diagnosis as bounded, data-only
  repository observations; absent, the prompt is byte-identical.

## 1.1.0

Governed agent orchestration. v1.0 controlled **what** may be executed and
whether a result counts as complete; v1.1 governs **how** an agent gets
there — with a bounded, observable, resumable control loop.

This is an additive minor release. Every v1.0 contract is unchanged, no
persisted schema version moved, and a v1.0 workspace keeps working with no
migration.

### Added

- **`@specbridge/orchestration`** — a reusable domain package holding the
  whole capability: a 12-phase fail-closed state machine with a per-phase
  allowed-action table, intent and clarification contracts, the
  execution-plan lifecycle, an 18-category failure taxonomy, the
  deterministic retry/repair/replan decision engine, budgets, progress
  fingerprinting, and versioned persistence. CLI, MCP, and plugin skills are
  thin adapters over it.
- **Intent assessment** with four strictly distinct outcomes (`READY`,
  `NEEDS_CLARIFICATION`, `REJECTED`, `BLOCKED`). The host agent submits a
  structured assessment; SpecBridge validates it against approvals,
  staleness, task existence, lock ownership, and hard product boundaries,
  and may override it — always towards caution, never towards `READY`.
- **Structural provenance instead of confidence scores.** A `READY` claim
  resting on `inferred`, `unknown`, or `conflicting` facts is downgraded
  automatically. No numeric model-confidence value is used as a safety
  mechanism anywhere.
- **Bounded clarification** with durable structured decisions: required
  justification per question, refused duplicates and re-asks, bounded rounds,
  supersession, and an explicit refusal to resolve an ambiguity by inference.
  A decision never amends an approved `.kiro` document — the tooling routes
  spec-changing answers back to re-authoring and human approval.
- **Execution plans** bound to the task fingerprint, approved stage hashes,
  the Git baseline, and the policy fingerprint, with staleness detection and
  a **plan review gate** (`review` by default, `auto` and `disabled` as
  explicit opt-ins). A review is bound to the exact plan hash.
- **Material-change replanning:** a changed goal, non-goal, constraint,
  subsystem, strategy, or step set re-opens review; a reorder or a wording
  fix does not.
- **Deterministic no-progress detection** from normalized failure
  fingerprints, diff fingerprints, plan revision, and action category —
  never natural-language similarity.
- **Explicit budgets** for iterations, repair cycles, replans, transient
  retries, no-progress cycles, clarification rounds, elapsed time, and event
  history. Each exhaustion names the budget, preserves evidence, and leaves
  the task incomplete.
- **`specbridge orchestrate status | show | explain | policy show |
  policy validate | events | phases`** — deterministic, read-only, JSON-capable
  inspection. No orchestrate command invokes a model or advances a run.
- **Ten MCP tools** (`orchestration_status`, `_begin`, `_assess_intent`,
  `_clarify`, `_resolve_clarification`, `_submit_plan`, `_review_plan`,
  `_record_action`, `_checkpoint`, `_finalize`) with versioned schemas,
  annotations, bounds, and stable `SBMCP021`–`SBMCP030` error mapping over
  the `SBO###` domain registry.
- **`/specbridge:develop`** — the governed Claude Code workflow.
  `/specbridge:implement` keeps its historical direct lifecycle unchanged;
  `/specbridge:continue` is now orchestration-aware.
- **Honest resume and compact checkpoints:** a resumed run keeps its real
  identity, counters, and history; a finalized run reports its outcome and
  refuses to continue; a stale plan is never executed silently.
- **`orchestration` configuration block** (additive; accepted by both the v1
  and v2 config schemas, no migration required), plus
  `contracts/orchestration-contract.json` and three new versioned sidecar
  schemas (`orchestrationState`, `executionPlan`, `orchestrationCheckpoint`).
- **StepRelay readiness fixture and scenarios A–L** covering ambiguity,
  approved-spec conflict, planned implementation, implementation defect,
  transient failure, no-progress, stale plan, repository divergence,
  interruption, auto-approval refusal, prompt injection, and budget
  exhaustion.
- Documentation: [agent orchestration](docs/orchestration/agent-orchestration.md),
  [intent and clarification](docs/orchestration/intent-clarification.md),
  [execution planning](docs/orchestration/execution-planning.md),
  [retry and repair](docs/orchestration/retry-and-repair.md),
  [ReAct/TAO execution discipline](docs/orchestration/react-tao-execution.md),
  [orchestration recovery](docs/orchestration/orchestration-recovery.md),
  [configuration](docs/orchestration/configuration.md), and
  [enforcement boundaries](docs/orchestration/enforcement-boundaries.md).

### Unchanged (and asserted by tests)

- `.kiro` remains the source of truth. No orchestration metadata is written
  into any Kiro document; byte-identical round trips still hold.
- Stage approval remains human-only. There is no agent-accessible approval
  path, and the MCP catalog is tested against a forbidden-name list.
- `task_complete` remains the sole completion authority. Orchestration
  refuses to mark a task complete without a `verified` or
  `manually-accepted` evidence status it actually returned.
- No arbitrary shell, filesystem, or Git tool; no automatic Git mutations; no
  automatic provider fallback during implementation; no nested coding agent
  from the plugin; no hidden network access; no telemetry.
- No private chain-of-thought is persisted. No schema has a field for it —
  see [why](docs/orchestration/react-tao-execution.md#why-no-chain-of-thought-is-stored).

### Notes

- The two rules that are only *skill-guided* rather than enforced — that the
  user was genuinely asked before a plan review is recorded, and that a
  clarification question is genuinely load-bearing — are documented as such
  in [enforcement boundaries](docs/orchestration/enforcement-boundaries.md).
  No Claude Code hooks are used; the rationale is documented there too.

## 1.0.0

The first stable release. The primary promise is unchanged — start in Kiro,
continue anywhere, return whenever you want — and it is now backed by
documented, machine-checked contracts.

### Stable (frozen for v1.x under [the versioning policy](docs/stability/versioning-policy.md))

- CLI command and exit-code contract
- Kiro-compatible filesystem contract (`.kiro/steering`, `.kiro/specs`,
  byte-identical no-op round trips, surgical checkbox updates)
- SpecBridge sidecar schemas (config, spec state, approvals, runs, evidence,
  policies, templates, extensions, registries)
- Verification rule IDs `SBV001`–`SBV026` and the report/diagnostic schemas
- Runner adapter contract (operations, capability keys, support levels,
  normalized events/results/errors)
- Template manifest and extension protocol (`1.0.0`)
- MCP server name, tool names, resource URIs, and prompt names
- Claude Code plugin and marketplace namespace

Every stable contract has a machine-readable snapshot under
[`contracts/`](contracts/), enforced in CI by `pnpm check:public-contracts`.

### Added

- Unified state-migration framework and `specbridge migrate status | plan |
  apply | verify` (hash-bound plans, dry-run, atomic writes, backups,
  rollback, and a migration report under `.specbridge/migrations/<id>/`)
- `specbridge state validate` — read-only diagnosis across every persisted
  state family
- Recovery planning and hash-bound `specbridge state recover --plan` /
  `--apply <id>` (acknowledgement-token gated; corrupted originals are
  preserved in quarantine, never destroyed), plus `specbridge doctor
  --repair-plan`
- `specbridge setup` — preview-first, safe workspace initialization
- Public contract inventory ([docs/stability/public-contracts.md](docs/stability/public-contracts.md))
  and versioning/deprecation policy
- Large-repository performance suite and documented budgets
  ([docs/performance.md](docs/performance.md))
- Consolidated threat model ([docs/security/threat-model.md](docs/security/threat-model.md))
  and a deterministic repository security scan (`pnpm check:security`)
- Cross-platform release packaging and a tag-driven release workflow
- npm package `specbridge-cli` (the command remains `specbridge`)
- Maintained example projects and reproducible offline demo scripts
- Public release documentation, community files, and issue/PR templates

### Changed

- Documentation reorganized around a hub ([docs/README.md](docs/README.md))
  without breaking existing links
- Release assets carry stable manifests and `SHA256SUMS`; the npm package
  uses an explicit `files` allowlist
- `specbridge config migrate` is deprecated in favor of `specbridge migrate`;
  it keeps working and prints a deprecation notice to stderr (removal no
  earlier than v2.0.0)
- GitHub Action metadata aligned to `1.0.0`
- Template and extension compatibility ranges widened to `<2.0.0`

### Security

- Migration and recovery actions are hash-bound and refuse stale plans
- Release assets are checksum-verified
- Archive, symlink, and path-traversal protections are consolidated and
  documented; credentials and provider environments remain isolated
- Extension and MCP protocol limits are enforced

### Limitations

- Extension process isolation is **not** an operating-system sandbox
- Checksums verify integrity, **not** publisher identity
- Released binaries may be unsigned
- Model-assisted authoring and execution remain nondeterministic
- Antigravity integration remains experimental

## 0.7.1

Added:

- Versioned extension manifest (`specbridge-extension.json`, schema 1.0.0)
  covering five stable extension kinds: template-provider, analyzer,
  verifier, exporter, and runner.
- Publishable extension SDK (`@specbridge/extension-sdk`): manifest,
  protocol, permission, and diagnostic schemas; a stdio extension server
  with input/output validation, cancellation, and clean shutdown; typed
  helpers per kind; in-process testing utilities.
- Out-of-process extension protocol (JSON-RPC 2.0 over JSON Lines, protocol
  1.0.0): initialize handshake with identity and capability validation,
  invocation, cancellation, shutdown, structured errors, bounded messages.
- Explicit extension permission model (specRead, repositoryRead,
  repositoryWrite, network, childProcess, explicit environment-variable
  names) with permission-aware input boundaries per kind.
- Permission-hash acceptance: enabling requires
  `--accept-permissions <hash>`, deterministically bound to the extension
  ID, version, manifest hash, and normalized permissions; any manifest
  change invalidates prior grants (SBE018).
- Analyzer extensions (`spec analyze --extension <id>`, repeatable) with
  namespaced rule IDs (`<extension-id>/<RULE>`) that never overwrite
  built-in diagnostics.
- Verifier extensions via explicit per-spec policy (`extensionVerifiers`);
  results land in the verification report and reach the gate only through
  the new built-in rollup rule SBV026 (required failure fails, optional
  warns).
- Exporter extensions (`spec export --extension <id> --output <dir>`):
  candidate files only, previewed by default, written atomically after
  explicit `--yes`, never overwriting, recorded append-only.
- Runner extensions behind an extension-runner proxy implementing the
  frozen v0.6.0 `AgentRunner` contract, wired through a new
  backward-compatible `"runner": "extension"` profile variant (disabled by
  default, preview support level, never auto-selected).
- Template-provider extensions: data-only v0.7.0-format template packs
  contributed to the catalog as `extension:<extension-id>/<template-id>`,
  with ambiguity errors instead of shadowing.
- Local extension installation from directories and archives (atomic,
  versioned side-by-side, disabled after install, zero code execution),
  plus explicit enablement/disablement and recoverable uninstall.
- Extension conformance framework (`extension conformance --yes`) with
  common protocol checks and kind-specific checks, recorded per install.
- Deterministic extension packaging
  (`<id>-<version>.specbridge-extension.zip`, store-method, fixed
  timestamps, sorted entries, regenerated checksums, printed SHA-256).
- Local (built-in + `--file`) and HTTPS registry indexes with a validated
  atomic cache under `.specbridge/registry-cache/` and explicit
  `registry update <name> --network`.
- Extension and registry CLI command groups (`specbridge extension …`,
  `specbridge registry …`) including scaffold for every kind.
- Seven read-only MCP discovery tools: extension_list, extension_search,
  extension_show, extension_doctor, registry_list, registry_search,
  registry_show (37 MCP tools total).
- Claude Code `/specbridge:extensions` Skill (discovery only).
- Generated extension gallery (`docs/extensions.md`) with CI drift check,
  repository registry index (`registry/`), and five maintained reference
  extensions under `examples/extensions/`.
- Stable error code registries: SBE001–SBE030 (extensions) and
  SBR001–SBR015 (registry), every error with remediation.

Security:

- No in-process third-party code execution: no dynamic import of installed
  extensions, no `eval`, no `Function`; the only executable surface is the
  declared entrypoint launched as `node <entrypoint>` (argv array, no
  shell) in a child process.
- No package-manager lifecycle scripts: install/postinstall/prepare
  declarations in a bundled package.json are validation errors and are
  never executed.
- No automatic enablement, no automatic updates, no automatic registry
  network access; remote installs and updates require an explicit
  `--network`.
- Manifest-bound permission grants with stale-grant detection.
- SHA-256 archive and per-file integrity checks; installed files are
  revalidated after extraction.
- Symlink and path-traversal rejection everywhere packages are read,
  extracted, installed, or exported.
- Bounded archive extraction (50 MB archive, 100 MB extracted, 1,000
  files) with CRC verification and declared-size enforcement.
- Protocol stdout isolation: stdout is protocol-only, logs go to stderr,
  corruption terminates the process without crashing SpecBridge.
- Startup (10 s) and operation (default 5 min) timeouts, cooperative
  cancellation, SIGTERM→SIGKILL cleanup, bounded stdout/stderr capture.
- Sanitized child environment with an explicit variable allowlist; granted
  secret values are redacted from retained logs.
- Extensions cannot approve stages, complete tasks, change evidence, or
  disable built-in protected-path rules.

Limitations:

- Process isolation and permission declarations are safety boundaries and
  audit mechanisms, not an OS sandbox; enabled executable extensions run
  as local code with the user's operating-system permissions.
- Checksums prove integrity, not publisher identity.
- Registry listing is not endorsement.
- Registry archive URLs in the repository index use a documented
  placeholder host until a real hosted registry exists.

Deferred to v1.0:

- Stable publishing workflow and release automation.
- Cross-platform installation verification.
- Final security audit and performance hardening.
- Schema migration guarantees and public launch assets.

## 0.7.0

Added:

- Versioned template manifest (`specbridge-template.json`, schema 1.0.0)
  with strict validation: template IDs, semver versions, kinds, workflow
  modes, file sets, typed variables (string/boolean/integer/enum with
  constraints), compatibility ranges, and safe optional metadata.
- Restricted deterministic template renderer: `{{variableName}}`
  substitution only — one pass, no expressions, no conditionals, no
  includes, no environment access, values never re-scanned.
- Built-in template catalog bundled with SpecBridge (immutable at runtime,
  embedded at build time so every bundle ships it).
- Project-local template packs under `.specbridge/templates/<id>/`.
- Deterministic local template search over IDs, display names,
  descriptions, and tags (exact ID > ID prefix > exact tag > display-name
  token > description token; no model, no network).
- `template list | search | show | validate | preview | apply` CLI
  commands; preview and `apply --dry-run` share the exact rendering path
  with apply and write nothing.
- Local template installation and uninstallation
  (`template install <local-path>` / `template uninstall project:<id>`):
  validated, script-free, atomic (temp directory + rename), never
  overwriting; built-in templates cannot be uninstalled.
- `template scaffold` — generates a complete community-ready template pack
  (manifest, README with validation instructions and a contribution
  checklist, plain-Markdown template files); no TypeScript required.
- `spec new --template <reference> [--var key=value]`, delegating to the
  same template application service (existing non-template `spec new`
  behavior unchanged).
- Append-only template operation records in
  `.specbridge/template-records.jsonl` (apply/install/uninstall/scaffold)
  storing variable names and rendered-content hashes, never values.
- MCP template tools: `template_list`, `template_search`, `template_show`,
  `template_preview` (read-only), and `template_apply` (candidate-hash
  bound, acknowledgement-gated). Install/uninstall/scaffold remain
  CLI-only.
- Claude Code `/specbridge:templates` Skill: list/search/show/preview, and
  apply only after explicit confirmation with the previewed candidate
  hash.
- Generated template gallery in `docs/templates.md`
  (`pnpm generate:template-gallery`) with a CI drift check
  (`pnpm check:template-gallery`); built-in packs are likewise embedded via
  `pnpm generate:builtin-templates` with `pnpm check:builtin-templates`.
- Template contribution workflow and documentation
  (`docs/creating-templates.md`, `docs/template-manifest.md`,
  `docs/template-rendering.md`, `docs/template-security.md`,
  `docs/template-installation.md`, `docs/template-contribution-guide.md`).
- Stable template error codes SBT001–SBT025 with remediation in every
  message.

Built-in templates:

- REST API (`rest-api`)
- CLI tool (`cli-tool`)
- Database migration (`database-migration`)
- Authentication (`authentication`)
- Background job (`background-job`)
- Event-driven service (`event-driven-service`)
- Bugfix regression (`bugfix-regression`)
- Performance optimization (`performance-optimization`)
- Security hardening (`security-hardening`)
- Refactoring (`refactoring`)

Security:

- No executable template code, lifecycle scripts, or shell execution.
- No environment interpolation and no network access anywhere in the
  template system (no remote registry, no URL or npm installation).
- Path traversal and symlinks rejected; targets restricted to the exact
  Kiro spec file set; variables never allowed in target paths.
- One-pass rendering: substituted values are never re-rendered.
- Bounded packs and output (20 files, 256 KB manifest, 1 MB per template
  file, 5 MB per pack, 1 MB per rendered document).
- Candidate-hash binding and an explicit acknowledgement for MCP apply.
- Atomic installation and atomic spec creation; existing specs are never
  overwritten; generated stages always start unapproved.

Deferred to v0.7.1:

- Extension/plugin SDK, runner SDK distribution, analyzer/verifier/exporter
  SDKs.
- Remote extension registry and community ecosystem index.

## 0.6.1

Added:

- Gemini CLI adapter (`gemini-cli`, built-in profile `gemini-default`):
  headless invocation through the frozen v0.6.0 runner contract with
  bounded read-only capability detection (`--version`/`--help` token
  probes; never a model request, login, or trusted-folder change).
- Capability-gated Gemini authoring, task execution, and resume: authoring
  through the plan approval mode or a read-only tool allowlist; task
  execution only when the installed CLI proves a bounded edit policy
  (auto_edit plus tool allowlist or sandbox) without arbitrary shell
  access; resume only by explicit session UUID with session-identity
  verification.
- OpenAI-compatible authoring adapter (`openai-compatible`, built-in
  profile `openai-compatible-local`): production stage generation and
  refinement against chat-completions and responses API styles.
- Configurable structured-output modes (`json-schema`, `json-object`,
  `strict-json-prompt`) with complete-response Zod validation in every
  mode and an explicit, warned, opt-in-only downgrade
  (`allowStructuredOutputFallback`).
- Experimental Antigravity CLI capability adapter (`antigravity-cli`,
  built-in profile `antigravity`): executable/version/documented-capability
  detection and transparent diagnostics only — no automation of any kind.
- Read-only MCP runner diagnostic tools: `runner_list` (paginated),
  `runner_show`, `runner_doctor`, `runner_matrix` — thin adapters over the
  same shared runner services the CLI uses.
- Claude Code `/specbridge:runners` Skill: list profiles, explain
  categories and boundaries, diagnose one profile, and recommend
  compatible profiles — driven exclusively by the MCP diagnostic tools.
- Additional provider conformance fixtures: process-level fake Gemini and
  Antigravity executables and a fake OpenAI-compatible loopback server
  covering authentication, quota, rate-limit, timeout, cancellation,
  oversized output, malformed/prose/fenced output, protected-path writes,
  resume identity, and redirect scenarios — CI needs no real provider and
  no network.
- Explicit remote endpoint and redirect protections in the shared HTTP
  client: opt-in bounded redirect following with cross-origin
  authorization stripping, HTTPS-downgrade rejection, scheme validation,
  and recorded safe redirect metadata (default behavior unchanged:
  redirects rejected).

Changed:

- The runner capability matrix (CLI `runner matrix`, MCP `runner_matrix`,
  README, docs) includes Gemini, OpenAI-compatible, and Antigravity and is
  generated from one shared implementation in @specbridge/runners.
- Provider diagnostics are available through both the CLI and MCP.
- The plugin bundle includes the runner inspection workflow (nine skills).
- Network-backed authoring reports exact data boundaries (endpoint, API
  style, model, structured-output mode, documents, input size, whether a
  network request will occur) before execution; dry-run performs no
  request.
- Additive contract extensions (no existing field, value, or code
  changed): optional `AgentRunner.declaredSupportLevel` (absent =
  production, the v0.6.0 behavior) and new `AgentRunnerKind` values
  (`gemini-cli`, `openai-compatible`, `antigravity-cli`). All v0.6.0
  contract snapshot tests pass unchanged.

Security:

- Gemini YOLO mode is forbidden at three layers (config schema enum plus
  config-wide fragment rejection, argv assembly, pre-spawn assertion).
- Gemini task execution requires a bounded safe edit policy; shell tools
  are excluded from every allowlist and the policy is never relaxed.
- Antigravity TUI and PTY automation are forbidden (no PTY library, no
  keystroke injection, no ANSI parsing — enforced by tests).
- API-key values are never stored: profiles hold an environment-variable
  NAME only; the value is read at request time, redacted from every
  retained byte, and never logged or passed to verification commands.
- Authorization is never forwarded across origins on redirects, and
  HTTPS-to-HTTP downgrades are rejected.
- Generic API runners cannot modify source (authoring-only by capability;
  task execution is rejected before any request).
- No new provider is selected implicitly: all new profiles default
  disabled, network profiles require explicit selection, experimental
  profiles require explicit opt-in.
- Provider claims remain non-authoritative: Git evidence and trusted
  verification decide task completion, whatever runner executed.

Deferred to v0.7:

- templates and the template registry
- plugin SDK and runner extension SDK distribution
- analyzer SDK and verifier SDK
- extension registry and community ecosystem

## 0.6.0

Added:

- Capability-driven runner platform: core orchestration selects and gates
  runners by DECLARED CAPABILITIES (17 stable keys), never by provider
  names. Runner categories (`agent-cli`, `model-api`, `mock`,
  `experimental`) and support levels (`production`, `preview`,
  `experimental`, `unavailable`, `incompatible`) are explicit everywhere.
- Versioned, FROZEN runner adapter contract for v0.6.1
  (docs/runner-adapter-contract.md) with snapshot tests guarding categories,
  support levels, operation names, capability keys, normalized outcomes,
  normalized error codes, event types, and required adapter methods — plus a
  minimal-adapter test proving new providers register without core changes.
- Operation-specific capability validation: `stage-generation`,
  `stage-refinement`, `task-execution`, `task-resume`, `model-list`,
  `runner-test`, each with required capabilities and (for execution) a
  required safe boundary (`sandbox` OR the documented `toolRestriction`
  equivalent). Incompatible selections stop BEFORE any process spawn, HTTP
  request, run record, or file change, and list the missing capabilities and
  compatible configured profiles.
- Normalized provider events (17 types, size-limited flat payloads, no
  reasoning content), normalized execution results (13 outcomes), normalized
  runner errors (24 stable codes with safe messages, remediation, and
  retryability), and normalized usage/cost metadata (cost is
  provider-reported, configured-estimate, or unavailable — never computed
  from hardcoded pricing; local Ollama reports `unavailable`, not zero).
- Versioned runner profiles (configuration schema 2.0.0): named
  configurations of implementations (`codex-default`, `codex-fast`,
  `ollama-qwen`, …) with per-profile executable/endpoint, model, timeout,
  sandbox, and output limits; unique names; unknown implementations
  rejected.
- Configuration migration tools: `specbridge config doctor` (read-only) and
  `specbridge config migrate --dry-run|--apply` (atomic write, recoverable
  `config.v1.backup.json`, validated result). The v1 schema remains fully
  readable before explicit migration; migration preserves the Claude Code
  default behavior and trusted verification commands, adds Codex/Ollama
  profiles DISABLED, and creates no credentials.
- Deterministic runner selection with precedence explicit `--runner` →
  operation default → global default, a capability-checked selection plan
  (`--show-runner-plan`, dry-run output), and network-policy enforcement
  (network-backed profiles are never selected implicitly).
- Explicit authoring fallback policy: per-operation chains
  (`fallbacks.stageGeneration/.stageRefinement`), bounded correction and
  transport retries, and hard stop conditions (auth/permission/config
  failures, cancellation, quota, repository modification, real results).
  Disabled by default; never during task execution or resume.
- Generated runner capability matrix: `specbridge runner matrix`
  (`--json`, `--markdown`) from registered runner metadata; plus
  `runner show <profile>`, `runner test <profile> [--network]`,
  `runner conformance <profile> [--network]`, and
  `runner models <profile>`.
- Reusable runner conformance framework (detection, structured-output,
  process-control, stage-generation, stage-refinement, task-execution,
  resume) with capability-derived applicability; a runner is production only
  when every applicable group passes. Conformance uses throwaway fixture
  workspaces, requires `--network` for real-provider invocations, and runs
  fully against fake providers in CI.
- Production Codex CLI runner (`codex-cli`): read-only probes for
  version/help/`exec --help`/`login status` (never a model request, never
  credential files), JSONL event capture and normalization, JSON Schema
  structured output with strict validation, read-only sandbox for authoring,
  workspace-write sandbox for task execution, explicit-session resume
  (`codex exec resume <id>`, never "latest"), and full failure
  classification (auth, permission, sandbox, quota, rate limit, timeout,
  cancellation, output limits).
- Production Ollama authoring runner (`ollama`): loopback-default native
  HTTP API with strict URL safety (no credentials in URLs, no file/ftp
  schemes, HTTPS-by-default for remote endpoints with a labeled insecure
  development override, redirects never followed), model listing without
  inference, schema-validated non-streaming structured output at
  temperature 0, ONE bounded correction retry, input/output size limits,
  thinking-content redaction, and task execution refused by capability
  before any request.
- Append-only per-invocation attempt records under
  `.specbridge/runs/<run-id>/attempts/<attempt-id>/`: capability snapshot,
  operation, local/network boundary, model, normalized events and result,
  process observation, error classification, and fallback lineage. Failed
  attempts (including invalid structured-output candidates) are retained.
- Fake-provider test infrastructure: a process-level fake Codex CLI
  (26 scenarios) and a real loopback fake Ollama HTTP server (20 scenarios);
  CI needs no real providers, no network, no models, no credentials.

Changed:

- The existing Claude Code runner now implements the shared capability
  contract (category `agent-cli`, declared capability set, detection-derived
  support level) with its v0.3–v0.5 behavior, process safety, permission
  modes, resume, structured-output validation, and configuration semantics
  preserved unchanged.
- Runner selection validates operation capabilities before execution; task
  execution is restricted to compatible agent CLI runners and model API
  runners are authoring-only.
- Provider output is normalized (events, results, errors, usage) before it
  enters shared orchestration; run records now reference per-attempt
  capability snapshots and attempt metadata.
- The shared prompt contract (v1.1.0) parameterizes repository access:
  agent CLIs receive read-only repository tools for authoring; model APIs
  receive an explicit no-repository-access variant. The same core safety
  sections appear for every provider (tested for semantic equivalence).
- `runner list`/`doctor`/`show` are profile-based; the v0.3 `unsupported`
  stub registrations (codex/ollama/openai-compatible) were replaced by real
  disabled-by-default profiles, and deferred providers are no longer
  registered at all.

Security:

- No provider credentials stored; credential-looking configuration keys are
  rejected; no credential-file parsing anywhere.
- No automatic paid or network-provider selection; no automatic
  task-execution fallback or provider switching.
- No unrestricted Codex execution mode (`danger-full-access`, bypass flags,
  and repo-check skips rejected at three layers).
- No source editing by Ollama (no repository access by construction).
- No provider claims treated as task evidence; Git snapshots and trusted
  verification remain the only completion authority.
- No shell interpolation for runner commands (argv arrays only, both
  schemas).
- Explicit local and network data boundaries in every plan and attempt
  record; provider reasoning content never exposed; provider event payloads
  size-limited.

Deferred to v0.6.1:

- Gemini CLI runner.
- OpenAI-compatible authoring runner.
- Antigravity capability adapter.
- MCP runner diagnostics.
- Claude Code runner-management Skill (`/specbridge:runners`).

Deferred to v0.7:

- Templates, plugin SDK, runner extension SDK distribution, analyzer and
  verifier SDKs, extension registry, community ecosystem.

## 0.5.0

Added:

- Local stdio MCP server (`specbridge mcp serve`) built on the official
  `@modelcontextprotocol/sdk` 1.29.0 (pinned; stable protocol baseline
  2025-11-25): 21 typed tools with versioned Zod input/output schemas,
  annotations, and the stable SBMCP001–SBMCP020 error envelope; 7 read-only
  resources (`specbridge://…`); 4 workflow prompts for non-Claude clients;
  bounded structured responses (pagination cursors, 1 MB documents, 2 MB
  responses, 500-diagnostic cap); `specbridge mcp doctor|manifest|tools`.
- Direct interactive task execution: `task_begin` → the CURRENT host session
  edits source → `task_complete` (plus `task_abort`), reusing the v0.3 Git
  snapshots, trusted verification commands, evidence evaluation, append-only
  evidence, and the verified-only surgical checkbox update. Model-reported
  fields are recorded as claims, never proof.
- Interactive execution locking (`.specbridge/locks/interactive-task.lock`):
  atomic acquisition, heartbeats, crash-tolerant staleness diagnosis, and
  the explicit `specbridge run recover-lock [--remove] [--json]` recovery
  command. Ambiguous or actively held locks are never removed.
- Candidate stage authoring over MCP: `spec_stage_validate` (deterministic
  analysis + diff + approval effects + candidate hash, read-only) and
  `spec_stage_apply` (atomic, hash-bound to the reviewed bytes, dependent
  approvals invalidated per workflow rules, append-only
  `interactive-authoring` run record, no force option). Preview-first
  `spec_create` (apply: false renders without writing).
- Self-contained Claude Code plugin
  (`integrations/claude-code-plugin/specbridge`): bundled `dist/cli.cjs` and
  `dist/mcp-server.cjs` (no node_modules, no workspace resolution, no
  monorepo paths), POSIX + Windows CLI wrappers, eight namespaced skills
  (`/specbridge:doctor·status·new·author·approve·implement·continue·verify`),
  third-party license report, and a SHA-256 checksum manifest.
- Repository-local plugin marketplace (`.claude-plugin/marketplace.json`,
  strict mode) so `/plugin marketplace add HelloThisWorld/specbridge` works
  straight from a clone.
- Isolated plugin bundle verification (`pnpm verify:plugin-bundle`): copies
  the built plugin to an isolated space-containing directory, runs the
  bundled CLI and wrappers against an outside fixture project, performs a
  real MCP stdio handshake, and proves no monorepo path is required — plus
  deterministic `pnpm validate:plugin` and the reproducible release ZIP
  artifact `dist/specbridge-claude-plugin-0.5.0.zip`.

Changed:

- Claude Code plugin task execution now uses the current session
  (task_begin/task_complete) instead of starting a nested Claude process;
  the v0.3 runner workflow remains fully supported from the standalone CLI.
- Shared core APIs are exposed consistently through CLI and MCP; the MCP
  server is a thin typed adapter with no duplicated workflow, verification,
  Git, evidence, approval, or Markdown-writing logic
  (docs/cli-mcp-parity.md).
- Run schemas now distinguish runner execution, interactive execution,
  interactive authoring, and deterministic verification (new optional
  `kind` values plus `lifecycleStatus`, `host`, and `abortReason`; every
  v0.3 record keeps validating unchanged).

Security:

- No arbitrary filesystem, shell, or Git MCP tool; no user-supplied
  executable or working directory; one pinned project root per server
  process.
- No model-controlled stage approval: approval is not an MCP tool or
  prompt, and the plugin approve skill sets disable-model-invocation.
- No nested Claude invocation from the plugin or MCP handlers — enforced by
  automated content scans and tests.
- No stdout logging under stdio (structured stderr only, verified
  process-level); no secrets, prompts, or file contents in logs; run views
  and resources never expose raw prompts or runner output;
  `.specbridge/config.json` is only ever reported as a redacted status.
- Candidate hash binding prevents validation/apply substitution; there is
  no force option.
- State-changing MCP operations serialize behind a per-project write mutex,
  with the repository lock file guarding cross-process interactive runs.
- No automatic Git commit, push, reset, stash, or rollback — including
  after protected-path violations, which are reported instead.

Deferred (documented on the roadmap, not claimed):

- production multi-runner support (v0.6)
- templates, plugin SDK, extension registry, community ecosystem (v0.7)
- remote MCP transports (HTTP/SSE/WebSocket), MCP OAuth, cloud hosting
- public marketplace submission; npm publication of the packages
- `spec sync` / `spec export`, SARIF output, Action PR comments

## 0.4.0

Added:

- Deterministic spec drift rule engine (`@specbridge/drift`) with 25 stable,
  documented rule IDs (`SBV001`–`SBV025`) across workspace, approval,
  requirements, design, tasks, evidence, impact-area, verification-command,
  protected-path, mapping, and git categories. Every diagnostic carries a
  versioned schema, severity, category, message, remediation, source
  location, structured evidence, and a deterministic/heuristic confidence
  label. Heuristic rules never default to error severity.
- `specbridge spec verify [name] | --changed | --all` — read-only
  verification against a git comparison: `--diff base...head`,
  `--base/--head`, `--working-tree` (default), or `--staged`, with
  `--fail-on error|warning|never`, `--strict`, `--policy`, `--json`,
  `--format terminal|json|markdown|html`, and `--output`. Exit codes:
  0 passed, 1 threshold reached, 2 invalid input/policy/state, 3 comparison
  unavailable, 4 command failed to start, 5 command timeout.
- Requirement-to-task traceability extraction: requirement and acceptance
  criterion IDs (`R1`, `R1.1`, `REQ-001`, `Requirement 1`, `AC-1`, `AC1.2`),
  task references (`_Requirements: 1.1_`, `Requirements: R1`, `[R1]`,
  keyword phrases as heuristics), explicit design path references, source
  lines, and extraction-method provenance.
- Task evidence freshness validation: recorded approved-content hashes,
  checkbox-invariant task fingerprints, commit lineage, repository-path
  safety, and timestamp fallbacks for v0.3 records. New evidence records a
  `specContext` (approved hashes + task fingerprint) for exact drift checks.
- Spec-specific verification policies under `.specbridge/policies/<spec>.json`
  (versioned Zod schema; validated globs; advisory/strict modes; per-rule
  severity overrides) with `spec policy init|show|validate`. `.git/**`
  protection can never be configured away.
- Affected-spec resolution (`spec affected`, `spec verify --changed`): spec
  files, sidecar state, policy files, impact areas, accepted task evidence,
  and explicit design references; unmapped files (SBV014) and ambiguous
  mappings (SBV022) are reported, never silently ignored.
- Trusted verification command orchestration for CI: policy-required
  commands run by default, `--run-verification` runs everything configured,
  `--no-run-verification` reuses passing results only from valid, fresh
  evidence recorded at the exact current HEAD.
- Verification reports: terminal, versioned JSON (`schemaVersion 1.0.0`,
  validated before writing), GitHub-flavored Markdown (Step Summary ready),
  and a self-contained HTML report (no scripts, no external requests,
  CSS-only severity/spec filters).
- Production GitHub Action (`integrations/github-action`, node20, bundled,
  no pnpm or model required): pull_request/push/workflow_dispatch diff
  resolution, validated inputs, ten documented outputs, bounded file/line
  annotations with rule IDs, and a Step Summary. The committed bundle is
  rebuilt and diffed in CI.
- `specbridge verify rules` and `specbridge verify explain <rule-id>` —
  deterministic, read-only rule inspection.

Changed:

- Task-plan approval hashing distinguishes checkbox progress from plan
  changes (hash semantics v2): approving `tasks.md` now records an
  `approvedPlanHash` (checkbox state normalized) beside the exact
  `approvedHash`. `[ ]` → `[x]` progress keeps the approval effective; task
  text, ID, hierarchy, or reference changes still invalidate it.
  Requirements and design approvals remain exact-byte. Pre-v0.4 sidecar
  state keeps validating with exact-byte semantics until the next sanctioned
  write migrates it.
- Verification reports use versioned schemas; reports are validated with Zod
  before they are written.

Security:

- Verification needs no model, no API key, and no network access.
- Verification commands come only from `.specbridge/config.json` — never
  from spec text or model output; argv arrays only, no shell interpolation.
- Git refs are validated (no option injection); git runs argv-only with
  timeouts and output limits; SpecBridge never fetches, commits, or pushes.
- Verification never writes to `.kiro`, approval state, task checkboxes, or
  evidence; report artifacts are its only writes.
- Policy globs reject absolute paths, traversal, null bytes, and malformed
  patterns; evidence paths escaping the repository are flagged (SBV024);
  symlinks escaping the repository are detected.
- HTML reports escape all dynamic content and load nothing external.

Deferred (documented on the roadmap, not claimed):

- MCP server, Claude Code plugin bundle, additional production runners
  (codex/gemini/ollama), extension SDK, template registry, SARIF output.

## 0.3.0

Added:

- Generic agent runner contract (`detect` / `generateStage` / `executeTask`
  / `resumeTask`) with a runner registry, discriminated statuses
  (available/unavailable/unauthenticated/incompatible/misconfigured/error),
  and structured execution outcomes.
- Claude Code local CLI runner: executable/authentication detection,
  help-based capability probing with graceful degradation, non-interactive
  JSON invocation built as an argv array with prompts over stdin, session
  ids, timeouts, cancellation, and stdout/stderr size limits.
- Runner diagnostics: `runner list`, `runner doctor [name]`,
  `runner show <name>` — read-only, `--json`, never echo credentials.
- Model-assisted spec authoring: `spec generate <name> --stage <stage>` and
  `spec refine <name> --stage <stage> --instruction …` with versioned prompt
  contracts, workflow-mode prerequisites, read-only generation tools,
  deterministic candidate validation (invalid candidates are retained under
  the run directory and never applied), unified diffs, atomic writes, and
  dependent-approval invalidation. Nothing is ever auto-approved.
- Approved task execution: `spec run <name>` (`--task`, `--next`, `--all`,
  `--dry-run`, `--allow-dirty`, `--no-verify`) — one task per run, twenty
  pre-run checks, bounded task context, sequential `--all` that stops on the
  first unverified task.
- Git before/after snapshots with hash-exact changed-file attribution,
  protected-path hashing (`.kiro/**`, sidecar config/state), patch capture
  with size limits, and a clean-working-tree policy with a precise
  `--allow-dirty` baseline.
- Trusted verification commands from `.specbridge/config.json` (argv arrays,
  per-command timeouts, required/optional), never derived from spec content
  or model output.
- Append-only task evidence under `.specbridge/evidence/<spec>/<task>/`,
  deterministic evidence evaluation, and verified-only surgical checkbox
  completion (one character on one line; the tasks approval hash is
  re-recorded for SpecBridge's own sanctioned edit).
- Manual task acceptance: `spec accept-task --task … --reason …`, recorded
  as `manually-accepted` (actor `local-user`), always distinct from
  automated verification.
- Run records under `.specbridge/runs/<run-id>/` (prompt, raw output,
  snapshots, verification, evidence, report) plus `run list`, `run show`,
  and resumable Claude Code sessions via `run resume <run-id>` with
  divergence detection and `parentRunId` lineage.
- Versioned runner configuration schema (v0.2 config files upgrade with safe
  defaults), a deterministic mock runner with failure/rogue scenarios, and a
  fake Claude CLI process fixture — CI needs no Claude installation and no
  network.
- Documented exit codes 3–6 (runner unavailable / runner failure /
  timeout–cancel / safety) extending the unchanged 0/1/2 contract.

Security:

- No embedded authentication: the local user installs and authenticates
  Claude Code independently; SpecBridge never stores or prints credentials.
- No dangerous permission bypass: `bypassPermissions` and
  `dangerously-skip-permissions` are rejected at the config schema, argv
  assembly, and pre-spawn layers.
- No model-controlled verification: commands come only from trusted project
  configuration; spec files and model output are treated as data.
- No automatic git commit, push, reset, stash, or rollback.
- Protected-path modifications (`.kiro`, sidecar state, moved HEAD,
  configured paths) prevent verification and are reported, with evidence
  preserved.

Deferred (see docs/roadmap.md):

- full spec-to-code drift verification CLI, GitHub Action gates, MCP server,
  additional production runners (codex/ollama/openai-compatible remain
  honest stubs), parallel task execution.

## 0.2.0

- Offline Kiro-compatible spec creation: `spec new` renders plain-Markdown
  templates for feature and bugfix specs — no model, no API key, no network.
- Requirements-first, design-first, quick, and bugfix workflows with an
  explicit state machine and per-stage approval gates.
- Deterministic spec analysis: `spec analyze` reports structural and
  consistency problems (placeholders, missing criteria, malformed EARS,
  vague wording, task-plan gaps) with error/warning/info levels and
  `--strict` mode. Same bytes, same findings, every time.
- Approval state and document hashing: `spec approve` records the SHA-256 of
  the exact approved file bytes in versioned sidecar state
  (`.specbridge/state/specs/<name>.json`, schema 1.0.0). Approved Markdown
  files are never rewritten.
- Stale approval detection: `spec status`, `spec list`, and `doctor` report
  approved files that changed after approval and invalidate dependent
  approvals in memory; re-approving repairs the hash and cascades honestly.
- Approval revocation: `spec approve --revoke` clears a stage and every
  approval that depended on it, keeping all files.
- Existing Kiro workspace support: specs without SpecBridge state stay fully
  usable (reported as `unmanaged`); the first successful approval initializes
  sidecar state with `origin: existing-kiro-workspace`.
- `spec status` (new), plus extended `spec list` (mode/status/approval
  health), `spec show` (`--state`, `--analysis`, `--status`), and `doctor`
  (sidecar validation, orphan and stale state detection).
- No model or API key required for any v0.2 command; `.kiro` files carry no
  SpecBridge metadata and the byte-identical no-op round trip is unchanged.

## 0.1.0

- Read-only Kiro compatibility: workspace detection, steering discovery,
  spec discovery and classification, tolerant Markdown parsers.
- `doctor`, `steering list/show`, `spec list/show/context`, `compat check`.
- Line-preserving document model with a byte-identical no-op round-trip
  guarantee and a surgical checkbox patcher.
- Deterministic drift-check library primitives, runner interfaces with an
  offline mock runner, terminal/JSON/HTML report helpers.
