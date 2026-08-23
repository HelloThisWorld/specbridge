import { describe, expect, it } from 'vitest';
import {
  blockJob,
  createJob,
  escalateAuthority,
  requireJobState,
} from '@specbridge/orchestration';
import { computeAutonomyTelemetry, formatMeasurement } from '@specbridge/autonomy';
import { setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * The primary metric must be falsifiable in BOTH directions.
 *
 * Found by the vNext.10 dogfood, and it is the sharpest kind of defect: the
 * measurement itself was wrong, so nothing downstream could have noticed.
 * The run ended in BLOCKED — "all 4 execution attempts for this task are
 * spent", a job that plainly needs a person — and the report said
 * `humanInterventionsAfterSeal: 0`.
 *
 * The cause was mundane: `blockJob` records `budget_exhausted` rather than
 * `job_blocked` when the blocker is a budget, and the intervention event map
 * listed only the latter. A LIST of known causes can be incomplete. The
 * job's current STATUS cannot be.
 */

describe('humanInterventionsAfterSeal', () => {
  it('counts a job blocked on an exhausted budget', () => {
    const fixture = setupAutonomyFixture();
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement the sealed product intent.',
    });
    blockJob(fixture.deps, job.jobId, {
      category: 'BUDGET_EXHAUSTED',
      code: 'maxTaskAttempts',
      message: 'Recovery stopped: all 4 execution attempts for this task are spent.',
      remediation: ['Raise the attempt budget, or decide the task differently.'],
    });

    const telemetry = computeAutonomyTelemetry(fixture.deps, { jobId: job.jobId });
    expect(telemetry.jobStatus).toBe('BLOCKED');
    expect(telemetry.humanInterventionsAfterSeal).toBe(1);
    expect(telemetry.interventions[0]?.detail).toMatch(/budget|attempts/i);
  });

  it('counts a job blocked for any other reason, whatever event carried it', () => {
    const fixture = setupAutonomyFixture();
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement the sealed product intent.',
    });
    blockJob(fixture.deps, job.jobId, {
      category: 'BLOCKED_DEPENDENCY',
      code: 'MISSING_PREREQUISITE',
      message: 'The database is not reachable and only a person can start it.',
      remediation: ['Start the database.'],
    });
    expect(computeAutonomyTelemetry(fixture.deps, { jobId: job.jobId }).humanInterventionsAfterSeal)
      .toBe(1);
  });

  it('does NOT count an authority stop as an intervention', () => {
    const fixture = setupAutonomyFixture();
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement the sealed product intent.',
    });
    escalateAuthority(fixture.deps, job.jobId, {
      surface: 'sealed-contract-change',
      reason: 'MODIFIES_SEALED_CONTRACT',
      question: 'Completing this work requires changing sealed contract CTR-002.',
      whyItMatters: 'A sealed contract is a promise a human made.',
    });

    const telemetry = computeAutonomyTelemetry(fixture.deps, { jobId: job.jobId });
    expect(requireJobState(fixture.workspace, job.jobId).status).toBe('NEEDS_AUTHORITY');
    // Governance working is not the runtime failing. Counting it here would
    // make the metric unfalsifiable in the other direction: a run could
    // report zero by escalating everything.
    expect(telemetry.humanInterventionsAfterSeal).toBe(0);
    expect(telemetry.humanAuthorityEscalations).toBe(1);
  });

  it('a healthy job reports zero', () => {
    const fixture = setupAutonomyFixture();
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement the sealed product intent.',
    });
    expect(computeAutonomyTelemetry(fixture.deps, { jobId: job.jobId }).humanInterventionsAfterSeal)
      .toBe(0);
  });

  it('renders an unknown measurement as n/a, never as zero', () => {
    const fixture = setupAutonomyFixture();
    const job = createJob(fixture.deps, {
      specName: fixture.specName,
      goal: 'Implement the sealed product intent.',
    });
    const telemetry = computeAutonomyTelemetry(fixture.deps, { jobId: job.jobId });
    // No provider reported anything, so nothing is claimed.
    expect(telemetry.reportedCostUsd).toBeNull();
    expect(telemetry.reportedTokens).toBeNull();
    expect(formatMeasurement(telemetry.reportedCostUsd, 'usd')).toBe('n/a');
    expect(formatMeasurement(telemetry.reportedTokens, 'tokens')).toBe('n/a');
    // And an absent ledger is n/a rather than 100%.
    expect(telemetry.contractClosureRatio).toBeNull();
    expect(formatMeasurement(telemetry.contractClosureRatio, 'ratio')).toBe('n/a');
  });
});
