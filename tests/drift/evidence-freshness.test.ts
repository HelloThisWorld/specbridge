import { describe, expect, it } from 'vitest';
import type { EvidenceFreshnessContext, TaskEvidenceRecord } from '@specbridge/evidence';
import {
  assessEvidenceRecord,
  assessTaskEvidence,
  evidencePathEscapesRepository,
  reusableCommandPass,
} from '@specbridge/evidence';

/**
 * Deterministic evidence freshness: hashes, task identity, timestamps, and
 * repository paths — never model claims.
 */

const NOW = new Date('2026-07-12T12:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FINGERPRINT = 'c'.repeat(64);

function record(overrides: Partial<TaskEvidenceRecord> = {}): TaskEvidenceRecord {
  return {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    specName: 'settings-persistence',
    taskId: '1',
    status: 'verified',
    runner: 'mock',
    repository: { headBefore: 'abc123', headAfter: 'abc123', dirtyBefore: false, dirtyAfter: true },
    changedFiles: [
      { path: 'src/store.ts', changeType: 'modified', preExisting: false, modifiedDuringRun: true },
    ],
    verificationCommands: [
      { name: 'test', argv: ['node', '-e', '0'], required: true, exitCode: 0, durationMs: 5, passed: true },
    ],
    verificationSkipped: false,
    runnerClaims: { changedFiles: [], commandsReported: [], testsReported: [] },
    violations: [],
    warnings: [],
    evaluatedAt: '2026-07-12T10:00:00.000Z',
    specContext: {
      documentHash: HASH_A,
      designHash: HASH_A,
      tasksPlanHash: HASH_A,
      taskFingerprint: FINGERPRINT,
      taskText: '- [ ] 1. Build the store',
    },
    ...overrides,
  };
}

function context(overrides: Partial<EvidenceFreshnessContext> = {}): EvidenceFreshnessContext {
  return {
    specName: 'settings-persistence',
    approved: { documentHash: HASH_A, designHash: HASH_A, tasksPlanHash: HASH_A },
    approvedAt: {
      document: '2026-07-12T09:00:00.000Z',
      design: '2026-07-12T09:00:01.000Z',
      tasks: '2026-07-12T09:00:02.000Z',
    },
    tasks: new Map([
      [
        '1',
        {
          fingerprint: FINGERPRINT,
          title: 'Build the store',
          rawLineText: '- [x] 1. Build the store',
          state: 'done',
        },
      ],
    ]),
    now: NOW,
    ...overrides,
  };
}

describe('assessEvidenceRecord', () => {
  it('accepts fresh verified evidence (checkbox progress does not matter)', () => {
    const assessment = assessEvidenceRecord(record(), context());
    expect(assessment.validity).toBe('valid');
    expect(assessment.accepted).toBe(true);
    expect(assessment.reasons).toHaveLength(0);
  });

  it('flags spec-name mismatches as invalid', () => {
    const assessment = assessEvidenceRecord(record({ specName: 'other-spec' }), context());
    expect(assessment.validity).toBe('invalid');
    expect(assessment.reasons[0]?.code).toBe('spec-name-mismatch');
  });

  it('flags evidence paths escaping the repository (SBV024 source)', () => {
    for (const bad of ['../outside.ts', '/etc/passwd', 'C:/Windows/system32.dll', 'a/../../b']) {
      expect(evidencePathEscapesRepository(bad)).toBe(true);
      const assessment = assessEvidenceRecord(
        record({
          changedFiles: [
            { path: bad, changeType: 'modified', preExisting: false, modifiedDuringRun: true },
          ],
        }),
        context(),
      );
      expect(assessment.validity).toBe('invalid');
      expect(assessment.pathViolations).toContain(bad);
    }
    expect(evidencePathEscapesRepository('src/inside.ts')).toBe(false);
  });

  it('detects changed approved hashes as stale with precise codes', () => {
    const cases: [Partial<EvidenceFreshnessContext['approved']>, string][] = [
      [{ documentHash: HASH_B, designHash: HASH_A, tasksPlanHash: HASH_A }, 'document-hash-changed'],
      [{ documentHash: HASH_A, designHash: HASH_B, tasksPlanHash: HASH_A }, 'design-hash-changed'],
      [{ documentHash: HASH_A, designHash: HASH_A, tasksPlanHash: HASH_B }, 'plan-hash-changed'],
    ];
    for (const [approved, code] of cases) {
      const assessment = assessEvidenceRecord(record(), context({ approved: approved as never }));
      expect(assessment.validity).toBe('stale');
      expect(assessment.reasons.map((reason) => reason.code)).toContain(code);
    }
  });

  it('treats a no-longer-approved stage as stale', () => {
    const assessment = assessEvidenceRecord(
      record(),
      context({ approved: { designHash: HASH_A, tasksPlanHash: HASH_A } }),
    );
    expect(assessment.validity).toBe('stale');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('stage-not-approved');
  });

  it('detects changed task fingerprints as stale', () => {
    const changed = context();
    changed.tasks.set('1', {
      fingerprint: 'd'.repeat(64),
      title: 'Build the RENAMED store',
      rawLineText: '- [x] 1. Build the RENAMED store',
      state: 'done',
    });
    const assessment = assessEvidenceRecord(record(), changed);
    expect(assessment.validity).toBe('stale');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('task-identity-changed');
  });

  it('falls back to approval timestamps for legacy v0.3 records', () => {
    const legacy = record();
    delete (legacy as Record<string, unknown>)['specContext'];
    // Approved before the evidence: fine.
    expect(assessEvidenceRecord(legacy, context()).validity).toBe('valid');
    // Re-approved after the evidence: stale.
    const reapproved = context({
      approvedAt: { document: '2026-07-12T11:00:00.000Z' },
    });
    const assessment = assessEvidenceRecord(legacy, reapproved);
    expect(assessment.validity).toBe('stale');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('approved-after-evidence');
  });

  it('flags diverged commit lineage and notes unknown lineage', () => {
    const diverged = assessEvidenceRecord(
      record(),
      context({ ancestry: new Map([['abc123', 'not-ancestor']]) }),
    );
    expect(diverged.validity).toBe('stale');
    expect(diverged.reasons.map((reason) => reason.code)).toContain('history-diverged');

    const unknown = assessEvidenceRecord(
      record(),
      context({ ancestry: new Map([['abc123', 'unknown']]) }),
    );
    expect(unknown.validity).toBe('valid');
    expect(unknown.notes.some((note) => note.includes('shallow'))).toBe(true);
  });

  it('validates manual acceptance structurally and labels it', () => {
    const manual = assessEvidenceRecord(
      record({
        status: 'manually-accepted',
        manualAcceptance: {
          actor: 'local-user',
          reason: 'verified by hand',
          acceptedAt: '2026-07-12T10:30:00.000Z',
        },
      }),
      context(),
    );
    expect(manual.validity).toBe('valid');
    expect(manual.manual).toBe(true);

    const malformed = assessEvidenceRecord(record({ status: 'manually-accepted' }), context());
    expect(malformed.validity).toBe('invalid');
    expect(malformed.reasons.map((reason) => reason.code)).toContain('manual-record-malformed');
  });

  it('never counts model claims: non-accepted statuses are not evidence of completion', () => {
    const claimed = record({
      status: 'implemented-unverified',
      runnerClaims: {
        outcome: 'completed',
        summary: 'the model says everything works',
        changedFiles: ['src/store.ts'],
        commandsReported: ['pnpm test'],
        testsReported: [{ name: 'all', status: 'passed' }],
      },
    });
    const assessment = assessEvidenceRecord(claimed, context());
    expect(assessment.accepted).toBe(false);
    expect(assessment.validity).toBe('not-accepted');
  });
});

describe('assessTaskEvidence buckets', () => {
  it('the newest accepted record decides the bucket', () => {
    const older = record({ runId: 'run-1', evaluatedAt: '2026-07-12T09:30:00.000Z' });
    const newerStale = record({
      runId: 'run-2',
      evaluatedAt: '2026-07-12T10:30:00.000Z',
      specContext: { ...record().specContext, tasksPlanHash: HASH_B },
    });
    const assessment = assessTaskEvidence('1', [older, newerStale], context());
    expect(assessment.bucket).toBe('stale');
    expect(assessment.best?.record.runId).toBe('run-2');
  });

  it('reports missing when no accepted record exists', () => {
    const failed = record({ status: 'failed' });
    expect(assessTaskEvidence('1', [failed], context()).bucket).toBe('missing');
    expect(assessTaskEvidence('1', [], context()).bucket).toBe('missing');
  });
});

describe('reusableCommandPass', () => {
  it('reuses a passing command only from valid evidence at the exact current HEAD', () => {
    const assessment = assessEvidenceRecord(record(), context());
    expect(reusableCommandPass([assessment], 'test', 'abc123')?.runId).toBe('run-1');
    expect(reusableCommandPass([assessment], 'test', 'other')).toBeUndefined();
    expect(reusableCommandPass([assessment], 'lint', 'abc123')).toBeUndefined();
    expect(reusableCommandPass([assessment], 'test', undefined)).toBeUndefined();

    const stale = assessEvidenceRecord(
      record({ specContext: { ...record().specContext, tasksPlanHash: HASH_B } }),
      context(),
    );
    expect(reusableCommandPass([stale], 'test', 'abc123')).toBeUndefined();
  });
});
