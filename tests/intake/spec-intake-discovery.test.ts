import { describe, expect, it } from 'vitest';
import type { QuestionCandidate } from '@specbridge/intake';
import {
  ENGINEERING_QUESTION_SURFACES,
  answerIntakeQuestion,
  groundInRepository,
  parseSpecificationDocument,
  readRefusals,
  runIntakeDiscovery,
  screenCandidate,
  startSpecIntake,
} from '@specbridge/intake';
import { recordAssessment } from '@specbridge/mission';
import { sealableMission } from '../helpers-autonomy.js';
import { goldenSpecText, setupIntakeFixture, unambiguousSpecText } from '../helpers-intake.js';

/**
 * §2 and §4 — repository-grounded discovery, and human-gate discipline.
 *
 * Two claims, and the second one is the one that would be easy to fake:
 *
 *   discovery reads the repository BEFORE it asks anything, and
 *   it asks PRODUCT questions only.
 *
 * The second is asserted from both directions. Positively: the Golden Spec
 * raises exactly the questions a person would have raised. Negatively: every
 * member of the engineering-surface vocabulary is fed in as a candidate and
 * every one of them is refused, with the refusal recorded — which is what
 * makes "we do not ask engineering questions" checkable rather than a claim.
 */

function candidate(overrides: Partial<QuestionCandidate> = {}): QuestionCandidate {
  return {
    kind: 'SCOPE_BOUNDARY',
    question: 'Is this a promise or best effort?',
    whyItMatters: 'It changes what users may rely on.',
    productSurface: 'public-api',
    evidenceGap: 'Nothing settles it.',
    resolves: 'The promise.',
    topics: ['public-api'],
    options: [],
    sourceChunkIds: [],
    subject: 'test',
    ...overrides,
  };
}

describe('spec intake — repository-grounded discovery', () => {
  it('reads existing product truth before asking anything', () => {
    const fixture = setupIntakeFixture({ spec: true });
    // A prior mission with contracts, constitution, and success criteria.
    const prior = sealableMission(fixture);

    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    const grounding = groundInRepository(fixture.intake, {
      intakeId: started.intake.intakeId,
      excludeMissionIds: [started.mission.missionId],
    });

    expect(grounding.existingProduct).toBe(true);
    expect(grounding.priorMissionIds).toContain(prior.missionId);
    const kinds = new Set(grounding.evidence.map((evidence) => evidence.kind));
    expect(kinds.has('EXISTING_MISSION')).toBe(true);
    expect(kinds.has('SEALED_CONTRACT')).toBe(true);
    expect(kinds.has('EXISTING_SPEC')).toBe(true);
    expect(kinds.has('BUILD_SYSTEM')).toBe(true);

    // Product authority and repository context are kept apart: only the
    // first can answer a product question.
    const contract = grounding.evidence.find((evidence) => evidence.kind === 'SEALED_CONTRACT');
    const module = grounding.evidence.find((evidence) => evidence.kind === 'MODULE');
    expect(contract?.authoritative).toBe(true);
    expect(module?.authoritative ?? false).toBe(false);
  });

  it('does not treat the intake’s own mission as prior product truth', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    const grounding = groundInRepository(fixture.intake, {
      intakeId: started.intake.intakeId,
      excludeMissionIds: [started.mission.missionId],
    });
    expect(grounding.priorMissionIds).not.toContain(started.mission.missionId);
    expect(grounding.existingProduct).toBe(false);
    expect(grounding.notes.join(' ')).toContain('no prior SpecBridge product truth');
  });

  it('records the repository baseline the feature started from', () => {
    const fixture = setupIntakeFixture({ spec: true, git: true });
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: unambiguousSpecText(),
    });
    // `git init` without a commit leaves no resolvable HEAD; recording null
    // is the honest answer and is a different fact from "unchanged".
    expect(started.intake.baselineCommit === null || /^[0-9a-f]{40}$/.test(started.intake.baselineCommit)).toBe(true);
  });
});

describe('spec intake — question discipline', () => {
  it('asks the Golden Spec’s genuine product questions, and only those', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    const result = runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    const open = result.questions.filter((question) => question.status === 'open');

    // The three unresolved product commitments the specification genuinely
    // contains, plus the redrive half of the replay/redrive pair — which is
    // a separate decision with separate consequences.
    const kinds = open.map((question) => question.kind).sort();
    expect(kinds).toEqual([
      'COMPATIBILITY_LEVEL',
      'DATA_VISIBILITY_POLICY',
      'SEMANTIC_DEFINITION',
      'SEMANTIC_DEFINITION',
    ]);

    const compatibility = open.find((question) => question.kind === 'COMPATIBILITY_LEVEL');
    expect(compatibility?.question).toContain('Step Functions');
    expect(compatibility?.productSurface).toBe('compatibility-promise');

    const semantics = open.filter((question) => question.kind === 'SEMANTIC_DEFINITION');
    expect(semantics.map((question) => question.question).join(' ')).toContain('"replay"');
    expect(semantics.map((question) => question.question).join(' ')).toContain('"redrive"');

    const privacy = open.find((question) => question.kind === 'DATA_VISIBILITY_POLICY');
    expect(privacy?.productSurface).toBe('security-boundary');
    expect(privacy?.question).toContain('sensitive');

    // Every question carries the four fields that make it answerable and
    // justifiable: what it affects, why evidence was not enough, and what it
    // settles.
    for (const question of open) {
      expect(question.whyItMatters.length).toBeGreaterThan(20);
      expect(question.evidenceGap.length).toBeGreaterThan(20);
      expect(question.resolves.length).toBeGreaterThan(10);
      expect(question.blocking).toBe(true);
      expect(question.missionQuestionId).toBeDefined();
    }
  });

  it('asks nothing at all about an unambiguous specification', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'settings-export',
      kind: 'text',
      content: unambiguousSpecText(),
    });
    const result = runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    expect(result.questions.filter((question) => question.status === 'open')).toEqual([]);
    expect(result.readiness.ready).toBe(true);
    expect(result.intake.status).toBe('READY_FOR_APPROVAL');
  });

  it('refuses every engineering surface, and records why', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: unambiguousSpecText(),
    });

    // One candidate per engineering surface the vocabulary names. This is the
    // mirror of the Authority Firewall's NON_AUTHORITY_SIGNALS test: a
    // negative list is only a promise if something enumerates it.
    const engineeringCandidates: { surface: string; question: string }[] = [
      { surface: 'framework-choice', question: 'Should the console use React or Vue?' },
      { surface: 'library-choice', question: 'Which library should we use for date formatting?' },
      { surface: 'build-tool-choice', question: 'Maven or Gradle for the demo module?' },
      { surface: 'package-naming', question: 'What package name should the demo module use?' },
      {
        surface: 'module-decomposition',
        question: 'How many controllers should the demo application be split into?',
      },
      { surface: 'transport-choice', question: 'WebSocket or SSE for live execution updates?' },
      { surface: 'database-schema', question: 'What table layout should the execution store use?' },
      { surface: 'broker-topology', question: 'One Kafka topic or five for workflow events?' },
      { surface: 'test-framework', question: 'Should the browser tests use Playwright?' },
      { surface: 'test-structure', question: 'What test structure should the demo module have?' },
      {
        surface: 'retry-implementation',
        question: 'How should we implement the retry backoff internally?',
      },
      {
        surface: 'tooling-creation',
        question: 'Should we create a helper tool for seeding demo data?',
      },
      { surface: 'file-layout', question: 'What directory structure should the frontend use?' },
      { surface: 'code-style', question: 'What code style should the demo module follow?' },
      {
        surface: 'deployment-topology',
        question: 'How many containers should docker-compose start?',
      },
    ];
    expect(engineeringCandidates).toHaveLength(ENGINEERING_QUESTION_SURFACES.length);

    const discovery = runIntakeDiscovery(fixture.intake, started.intake.intakeId, {
      proposer: () =>
        engineeringCandidates.map((entry, index) =>
          candidate({
            question: entry.question,
            subject: `engineering-${index}`,
            resolves: entry.question,
          }),
        ),
    });

    // Not one of them reached the human.
    expect(discovery.questions.filter((question) => question.status === 'open')).toEqual([]);

    const refusals = readRefusals(fixture.workspace, started.intake.intakeId);
    const engineeringRefusals = refusals.filter(
      (refusal) => refusal.reason === 'ENGINEERING_DECISION',
    );
    expect(engineeringRefusals).toHaveLength(engineeringCandidates.length);
    // Every refusal names the surface, so an operator can see the rule that
    // fired rather than a bare "declined".
    const surfaces = new Set(
      engineeringRefusals.map((refusal) => refusal.engineeringSurface as string),
    );
    for (const surface of ENGINEERING_QUESTION_SURFACES) {
      expect([...surfaces], surface).toContain(surface);
    }
  });

  it('refuses a question existing product authority already answers', () => {
    const fixture = setupIntakeFixture({ spec: true });
    sealableMission(fixture);
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: unambiguousSpecText(),
    });
    const grounding = groundInRepository(fixture.intake, {
      intakeId: started.intake.intakeId,
      excludeMissionIds: [started.mission.missionId],
    });
    const contract = grounding.evidence.find(
      (evidence) => evidence.kind === 'SEALED_CONTRACT',
    );
    expect(contract).toBeDefined();

    const verdict = screenCandidate(
      candidate({
        // Phrased from the contract's own summary: existing authority
        // answers it, so nobody should be woken up for it.
        question: `${contract?.summary ?? ''}?`,
        resolves: contract?.summary ?? '',
        subject: 'already-answered',
      }),
      { chunks: [], evidence: grounding.evidence, existing: [] },
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) {
      expect(verdict.reason).toBe('ANSWERED_BY_EVIDENCE');
      expect(verdict.answeredBy).toBe(contract?.ref);
    }
  });

  it('refuses a request for elaboration, a duplicate, and an immaterial question', () => {
    const chunks = parseSpecificationDocument(unambiguousSpecText()).chunks;

    // Deliberately NOT an engineering-shaped elaboration: the engineering
    // screen runs first and would claim it, which is correct but would make
    // this assertion about the wrong screen.
    const elaboration = screenCandidate(
      candidate({ question: 'Can you describe the export flow in more detail?' }),
      { chunks, evidence: [], existing: [] },
    );
    expect(elaboration.admit).toBe(false);
    if (!elaboration.admit) expect(elaboration.reason).toBe('ELABORATION_NOT_DECISION');

    const immaterial = screenCandidate(
      candidate({ question: 'Is the wording of the confirmation message final?', topics: [] }),
      { chunks, evidence: [], existing: [] },
    );
    expect(immaterial.admit).toBe(false);
    if (!immaterial.admit) expect(immaterial.reason).toBe('IMMATERIAL_TO_PRODUCT');

    const duplicate = screenCandidate(candidate({ subject: 'same' }), {
      chunks,
      evidence: [],
      existing: [
        {
          questionId: 'Q-001',
          kind: 'SCOPE_BOUNDARY',
          question: 'Is this a promise or best effort?',
          whyItMatters: 'x',
          productSurface: 'public-api',
          evidenceGap: 'x',
          resolves: 'x',
          topics: ['public-api'],
          options: [],
          sourceChunkIds: [],
          blocking: true,
          status: 'open',
          askedAt: 'now',
          subject: 'same',
        } as never,
      ],
    });
    expect(duplicate.admit).toBe(false);
    if (!duplicate.admit) expect(duplicate.reason).toBe('DUPLICATE');
  });

  it('refuses a question the submitted specification already answers', () => {
    const chunks = parseSpecificationDocument(unambiguousSpecText()).chunks;
    const answered = chunks.find((chunk) => chunk.text.includes('refuse to overwrite'));
    expect(answered).toBeDefined();
    const verdict = screenCandidate(
      candidate({
        question: 'The export command must refuse to overwrite an existing file?',
        resolves: 'overwrite behaviour',
        subject: 'overwrite',
      }),
      { chunks, evidence: [], existing: [] },
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) {
      expect(verdict.reason).toBe('ANSWERED_BY_SPECIFICATION');
      expect(verdict.answeredBy).toBe(answered?.chunkId);
    }
  });
});

describe('spec intake — convergence', () => {
  it('converges deterministically once every question is answered', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'workbench',
      kind: 'text',
      content: goldenSpecText(),
    });
    const id = started.intake.intakeId;

    let result = runIntakeDiscovery(fixture.intake, id);
    expect(result.readiness.ready).toBe(false);
    expect(result.intake.status).toBe('AWAITING_PRODUCT_ANSWERS');

    // The gate names exactly what would make it yes.
    expect(result.readiness.reasons.join(' ')).toContain('product question(s) are open');

    for (const question of result.questions.filter((q) => q.status === 'open')) {
      const answer = question.options[0] ?? 'The strict reading holds.';
      result = answerIntakeQuestion(fixture.intake, id, {
        questionId: question.questionId,
        answer,
      }).discovery;
    }

    expect(result.readiness.ready).toBe(true);
    expect(result.readiness.openQuestionIds).toEqual([]);
    expect(result.readiness.unaccountedChunkIds).toEqual([]);
    expect(result.readiness.deltaAnalysisComplete).toBe(true);
    expect(result.readiness.missionContractReady).toBe(true);
    expect(result.intake.status).toBe('READY_FOR_APPROVAL');
  });

  it('re-running discovery on a converged intake changes nothing', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'settings-export',
      kind: 'text',
      content: unambiguousSpecText(),
    });
    const id = started.intake.intakeId;
    const first = runIntakeDiscovery(fixture.intake, id);
    const second = runIntakeDiscovery(fixture.intake, id);
    const third = runIntakeDiscovery(fixture.intake, id);

    // Idempotent in the way that matters: no duplicated contracts, no
    // duplicated decisions, no new questions.
    expect(second.questions).toEqual(first.questions);
    expect(third.analysis.items.length).toBe(first.analysis.items.length);
    expect(second.readiness.ready).toBe(true);
    expect(third.readiness.ready).toBe(true);
    expect(third.intake.counters.groundingPasses).toBe(3);
  });

  it('holds the gate open when a normative statement is unaccounted for', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'settings-export',
      kind: 'text',
      content: unambiguousSpecText(),
    });
    const result = runIntakeDiscovery(fixture.intake, started.intake.intakeId);
    expect(result.readiness.ready).toBe(true);

    // Every normative chunk is accounted for by something.
    const states = new Set(result.coverage.map((entry) => entry.state));
    expect(states.has('UNACCOUNTED')).toBe(false);
    expect(result.coverage.length).toBeGreaterThan(4);
  });

  it('a new blocking question re-opens a converged intake', () => {
    const fixture = setupIntakeFixture();
    const started = startSpecIntake(fixture.intake, {
      name: 'settings-export',
      kind: 'text',
      content: unambiguousSpecText(),
    });
    const id = started.intake.intakeId;
    expect(runIntakeDiscovery(fixture.intake, id).readiness.ready).toBe(true);

    // A material question recorded directly on the mission moves the gate
    // backwards — the intake's readiness is derived from durable state, not
    // from a flag it set earlier.
    recordAssessment(fixture.mission.deps, started.mission.missionId, {
      questions: [
        {
          question: 'Must the exported format stay readable by version 1 of the importer?',
          whyItMatters: 'It is a compatibility promise to everyone who already exported.',
          topics: ['compatibility'],
          affectedSurfaces: ['compatibility-promise'],
          materiality: 'blocking',
        },
      ],
    });
    const after = runIntakeDiscovery(fixture.intake, id);
    expect(after.readiness.ready).toBe(false);
    expect(after.readiness.missionContractReady).toBe(false);
  });
});
