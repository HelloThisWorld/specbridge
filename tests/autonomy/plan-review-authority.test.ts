import { describe, expect, it } from 'vitest';
import { overnightAutonomyPreset } from '@specbridge/core';
import { resolvePlanReviewRequirement } from '@specbridge/orchestration';
import type { DelegatedAuthorityResolver } from '@specbridge/orchestration';
import { bindSealToJob, createAuthorityResolver } from '@specbridge/autonomy';
import { sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * Regression: the plan-review gate is a COMPLEXITY gate.
 *
 * Found by the vNext.10 StepRelay dogfood, which is what a dogfood is for.
 * A real unattended run classified task 1, planned it successfully with a
 * real Claude dispatch, and then stopped:
 *
 *   AWAIT_HUMAN: Plan revision 1 for task 1 requires an explicit human
 *   review (high-risk policy).
 *
 * `planReview: 'high-risk'` fires when node complexity is HIGH. Nothing about
 * that plan touched a promise; the work was simply hard. Under
 * `humanGate: AUTHORITY_ONLY` a hard plan deserves a stronger reasoner and a
 * critic — not a person who is asleep.
 *
 * The fix routes the policy's conclusion through the authority firewall, so
 * these tests assert BOTH directions: difficulty stops gating, and a plan
 * that proposes a promise change still gates.
 */

function boundResolver(
  fixture: ReturnType<typeof setupAutonomyFixture>,
  jobId: string,
): DelegatedAuthorityResolver {
  const { seal } = sealedMission(fixture);
  bindSealToJob(fixture.deps, jobId, seal.sealId);
  return createAuthorityResolver({
    workspace: fixture.workspace,
    policy: fixture.config.autonomy,
  });
}

describe('plan review under delegated authority', () => {
  it('a HIGH-complexity plan no longer needs a human', () => {
    const fixture = setupAutonomyFixture();
    const resolver = boundResolver(fixture, 'job-1');

    const review = resolvePlanReviewRequirement(resolver, {
      jobId: 'job-1',
      nodeId: 'n-1',
      policyRequiresReview: true,
      policyReason: 'plan review by high-risk policy at complexity HIGH',
      planText:
        'Implement the workbench control surface.\n' +
        'Add a repository module for executions.\n' +
        'Wire the engine adapter behind an internal interface.\n' +
        'Restructure the module layout so the demo app depends only on the API.',
    });

    expect(review.humanReviewRequired).toBe(false);
    expect(review.relaxedBecause).toBeDefined();
  });

  it('a plan that would change a public contract still needs a human', () => {
    const fixture = setupAutonomyFixture();
    const resolver = boundResolver(fixture, 'job-2');

    const review = resolvePlanReviewRequirement(resolver, {
      jobId: 'job-2',
      nodeId: 'n-1',
      policyRequiresReview: true,
      policyReason: 'plan review by high-risk policy at complexity HIGH',
      planText:
        'Implement the control surface.\n' +
        'Change the wire format of the execution event so the dashboard can read it.',
    });

    expect(review.humanReviewRequired).toBe(true);
    expect(review.relaxedBecause).toBeUndefined();
  });

  it('a plan that would widen a security boundary still needs a human', () => {
    const fixture = setupAutonomyFixture();
    const resolver = boundResolver(fixture, 'job-3');

    const review = resolvePlanReviewRequirement(resolver, {
      jobId: 'job-3',
      nodeId: 'n-1',
      policyRequiresReview: true,
      policyReason: 'plan review by always policy at complexity LOW',
      planText: 'Disable authentication on the internal endpoint so the dashboard can poll it.',
    });

    expect(review.humanReviewRequired).toBe(true);
  });

  it('never invents a review the policy did not ask for', () => {
    const fixture = setupAutonomyFixture();
    const resolver = boundResolver(fixture, 'job-4');

    const review = resolvePlanReviewRequirement(resolver, {
      jobId: 'job-4',
      nodeId: 'n-1',
      policyRequiresReview: false,
      policyReason: 'not required',
      planText: 'Change the wire format of everything and disable authentication.',
    });

    // The seam only ever RELAXES. A resolver that could tighten would be a
    // way to introduce a gate the v1.2 rules never had.
    expect(review.humanReviewRequired).toBe(false);
  });

  it('an unsealed workspace keeps the v1.2 gate exactly', () => {
    const review = resolvePlanReviewRequirement(undefined, {
      jobId: 'job-5',
      nodeId: 'n-1',
      policyRequiresReview: true,
      policyReason: 'plan review by high-risk policy at complexity HIGH',
      planText: 'Anything at all.',
    });
    expect(review.humanReviewRequired).toBe(true);
  });

  it('a job with no seal binding keeps the gate', () => {
    const fixture = setupAutonomyFixture();
    // A resolver exists, but nothing bound a seal to THIS job.
    const resolver = createAuthorityResolver({
      workspace: fixture.workspace,
      policy: overnightAutonomyPreset(),
    });
    const review = resolvePlanReviewRequirement(resolver, {
      jobId: 'job-unbound',
      nodeId: 'n-1',
      policyRequiresReview: true,
      policyReason: 'plan review by high-risk policy at complexity HIGH',
      planText: 'Implement the thing.',
    });
    expect(review.humanReviewRequired).toBe(true);
  });

  it('a resolver that throws keeps the gate', () => {
    const broken: DelegatedAuthorityResolver = {
      resolve() {
        throw new Error('the autonomy layer is broken');
      },
    };
    const review = resolvePlanReviewRequirement(broken, {
      jobId: 'job-6',
      nodeId: 'n-1',
      policyRequiresReview: true,
      policyReason: 'plan review by always policy at complexity LOW',
      planText: 'Implement the thing.',
    });
    // The correct response to a bug in the thing that grants autonomy is to
    // grant none.
    expect(review.humanReviewRequired).toBe(true);
  });
});
