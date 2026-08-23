import { describe, expect, it } from 'vitest';
import type { BuildProjectionInput } from '@specbridge/orchestration';
import { buildContextProjection, readProjection, storeProjection } from '@specbridge/orchestration';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

/**
 * Regression: a resumed objective attempt must be able to re-derive its own
 * context projection.
 *
 * Found by the vNext.10 StepRelay dogfood. A driver that died between
 * writing a projection and completing the attempt is reconciled onto that
 * SAME attempt number by the survival runtime; the objective driver derives
 * the projection again from the same durable truth, and `storeProjection`
 * threw `Projection wu-1-a02.json already exists`. The supervisor restarted
 * the driver, which died at the same line, and the restart budget was the
 * only thing that stopped it.
 *
 * Immutability and idempotence are different properties. Re-deriving the
 * same content is not a mutation; writing DIFFERENT content under the same
 * key is, and still throws — that is the case the invariant exists for.
 *
 * Built through `buildContextProjection` rather than by hand so the test
 * exercises the real shape, including the `contentHash` that folds
 * `createdAt` in and therefore cannot itself be the identity.
 */

function input(overrides: Partial<BuildProjectionInput> = {}): BuildProjectionInput {
  return {
    jobId: 'job-1',
    objectiveNodeId: 'n-1',
    objective: {
      taskId: '1',
      title: 'Workbench Control Surface',
      acceptance: ['A workflow definition can be listed through the control surface.'],
    },
    workUnit: {
      workUnitId: 'wu-1',
      title: 'control surface',
      goal: 'expose the control surface',
      kind: 'build',
      status: 'READY',
      dependsOn: [],
      relevantContractIds: [],
      expectedArtifacts: [],
      expectedAreas: [],
      acceptance: [],
      attempts: [],
    } as unknown as BuildProjectionInput['workUnit'],
    attempt: 2,
    source: {
      missionId: 'm-1',
      constitutionVersion: 1,
      constitutionRules: [],
      contracts: [],
      adrs: [],
      decisions: [],
    },
    createdAt: '2026-08-24T00:00:00.000Z',
    maxProjectionChars: 20_000,
    ...overrides,
  };
}

describe('context projection immutability', () => {
  it('re-deriving the same projection for the same attempt is idempotent', () => {
    const fixture = setupOrchestrationFixture();
    const first = storeProjection(
      fixture.workspace,
      'job-1',
      'n-1',
      buildContextProjection(input()),
    );

    // The resume path: same attempt, same durable truth, a later clock.
    const second = storeProjection(
      fixture.workspace,
      'job-1',
      'n-1',
      buildContextProjection(input({ createdAt: '2026-08-24T00:07:31.000Z' })),
    );

    expect(second.ref).toBe(first.ref);
    // The STORED projection wins, so the recorded moment stays the one the
    // worker's context was first fixed at.
    expect(second.projection.createdAt).toBe('2026-08-24T00:00:00.000Z');
    expect(readProjection(fixture.workspace, 'job-1', 'n-1', 'wu-1', 2)?.createdAt).toBe(
      '2026-08-24T00:00:00.000Z',
    );
  });

  it('different content under the same key is still refused', () => {
    const fixture = setupOrchestrationFixture();
    storeProjection(fixture.workspace, 'job-1', 'n-1', buildContextProjection(input()));

    expect(() =>
      storeProjection(
        fixture.workspace,
        'job-1',
        'n-1',
        buildContextProjection(
          input({
            objective: {
              taskId: '1',
              title: 'Something else entirely',
              acceptance: ['a different promise'],
            },
          }),
        ),
      ),
    ).toThrowError(/DIFFERENT content/);
  });

  it('a new attempt gets its own projection', () => {
    const fixture = setupOrchestrationFixture();
    const second = storeProjection(
      fixture.workspace,
      'job-1',
      'n-1',
      buildContextProjection(input({ attempt: 2 })),
    );
    const third = storeProjection(
      fixture.workspace,
      'job-1',
      'n-1',
      buildContextProjection(input({ attempt: 3 })),
    );
    expect(third.ref).not.toBe(second.ref);
    expect(readProjection(fixture.workspace, 'job-1', 'n-1', 'wu-1', 3)?.attempt).toBe(3);
  });
});
