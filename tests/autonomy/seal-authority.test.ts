import { describe, expect, it } from 'vitest';
import { overnightAutonomyPreset, autonomyPolicyFingerprint, defaultAutonomyPolicy } from '@specbridge/core';
import { beginMission } from '@specbridge/mission';
import {
  NON_AUTHORITY_SIGNALS,
  bindSealToJob,
  assessSealCompleteness,
  assessSealExecutability,
  computeAuthorityDigest,
  createAuthorityResolver,
  draftSeal,
  evaluateAuthority,
  latestExecutableSeal,
  listSeals,
  readJobSeal,
  readSealBinding,
  refineIntentImpactUnderSeal,
  revokeSeal,
  screenTextForAuthoritySurfaces,
  sealMission,
  shouldDelegateAuthority,
  verifyNonAuthoritySignalsCannotGate,
} from '@specbridge/autonomy';
import { sealableMission, sealedMission, setupAutonomyFixture } from '../helpers-autonomy.js';

/**
 * Intent seal and Authority Firewall.
 *
 * The suite is organised around the one distinction vNext.10 rests on:
 * difficulty routes to stronger intelligence, authority routes to a human.
 * The negative tests matter as much as the positive ones, so both directions
 * are asserted explicitly rather than implied.
 */

describe('mission seal', () => {
  it('compiles a draft from durable mission state without mutating the mission', () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    const seal = draftSeal(fixture.deps, { missionId });

    expect(seal.status).toBe('DRAFT');
    expect(seal.missionId).toBe(missionId);
    expect(seal.goal).toContain('StepRelay');
    expect(seal.contracts.length).toBeGreaterThan(0);
    expect(seal.contracts[0]?.revision).toBe(1);
    expect(seal.acceptanceCriteria.length).toBe(3);
    expect(seal.presentAuthorityKinds).toContain('CONTRACTS');
    expect(seal.presentAuthorityKinds).toContain('REQUIREMENTS');
  });

  it('classifies which qualification surfaces each criterion implies', () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    const seal = draftSeal(fixture.deps, { missionId });

    const [compose, dashboard, rejection] = seal.acceptanceCriteria;
    expect(compose?.impliesSystemScenario).toBe(true);
    expect(dashboard?.impliesBrowserScenario).toBe(true);
    // A pure invariant implies neither: it closes on ordinary test evidence,
    // and inventing a browser scenario for it would be work nobody needs.
    expect(rejection?.impliesSystemScenario).toBe(false);
    expect(rejection?.impliesBrowserScenario).toBe(false);
  });

  it('is immutable: re-drafting the same id refuses rather than overwriting', () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    draftSeal(fixture.deps, { missionId, sealId: 'seal-fixed' });
    expect(() => draftSeal(fixture.deps, { missionId, sealId: 'seal-fixed' })).toThrowError(
      /immutable/i,
    );
  });

  it('produces a stable authority digest for identical authority', () => {
    const fixture = setupAutonomyFixture();
    const { missionId } = sealableMission(fixture);
    const first = draftSeal(fixture.deps, { missionId, sealId: 'seal-a' });
    const second = draftSeal(fixture.deps, { missionId, sealId: 'seal-b' });
    expect(second.authorityDigest).toBe(first.authorityDigest);
    expect(computeAuthorityDigest(first)).toBe(first.authorityDigest);
  });

  it('refuses to authorize a seal missing authority an unattended run needs', () => {
    const fixture = setupAutonomyFixture();
    // A mission with no contracts and no criteria: structurally incomplete.
    const mission = beginMission(fixture.mission.deps, {
      name: 'bare',
      goal: 'Build something unspecified.',
    });
    const draft = draftSeal(fixture.deps, { missionId: mission.missionId });

    const completeness = assessSealCompleteness(draft);
    expect(completeness.complete).toBe(false);
    expect(completeness.missing).toContain('CONTRACTS');
    expect(() => sealMission(fixture.deps, { sealId: draft.sealId })).toThrowError(/SBA005|missing/i);
  });

  it('authorizes a complete seal and records the channel', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    expect(seal.status).toBe('SEALED');
    expect(seal.sealedAt).toBeDefined();
    expect(seal.sealedVia).toBe('test');
    expect(latestExecutableSeal(fixture.workspace, seal.missionId)?.sealId).toBe(seal.sealId);
  });

  it('supersedes the predecessor when a re-seal names one', () => {
    const fixture = setupAutonomyFixture();
    const { seal, missionId } = sealedMission(fixture);
    const redraft = draftSeal(fixture.deps, { missionId, supersedes: seal.sealId });
    sealMission(fixture.deps, { sealId: redraft.sealId });

    const all = listSeals(fixture.workspace, missionId);
    const previous = all.find((entry) => entry.sealId === seal.sealId);
    expect(previous?.status).toBe('SUPERSEDED');
    expect(previous?.supersededBy).toBe(redraft.sealId);
    expect(latestExecutableSeal(fixture.workspace, missionId)?.sealId).toBe(redraft.sealId);
  });

  it('a revoked seal is not executable', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const revoked = revokeSeal(fixture.deps, seal.sealId, 'direction changed');
    const assessment = assessSealExecutability(revoked, fixture.config.autonomy);
    expect(assessment.executable).toBe(false);
    expect(assessment.reason).toBe('SEAL_NOT_EXECUTABLE');
  });

  it('detects autonomy policy drift since the seal was authorized', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    expect(assessSealExecutability(seal, fixture.config.autonomy).executable).toBe(true);

    // Someone widened delegation after the human authorized a narrower one.
    const widened = { ...fixture.config.autonomy, humanGate: 'ALL' as const };
    const drifted = assessSealExecutability(seal, widened);
    expect(drifted.executable).toBe(false);
    expect(drifted.reason).toBe('AUTONOMY_POLICY_DRIFT');
    expect(autonomyPolicyFingerprint(widened)).not.toBe(seal.delegatedAuthority.policyFingerprint);
  });
});

describe('authority firewall', () => {
  const overnight = overnightAutonomyPreset();

  it('delegates ordinary engineering surfaces under a seal', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    for (const surface of [
      'implementation-structure',
      'internal-architecture',
      'ui-framework',
      'styling-strategy',
      'state-management',
      'database-physical-layout',
      'container-topology',
      'broker-topology',
      'test-harness',
      'refactor',
      'work-decomposition',
    ] as const) {
      const decision = evaluateAuthority({ surface, seal, policy: fixture.config.autonomy });
      expect(decision.verdict, `${surface} should be autonomous`).toBe('AUTONOMOUS');
    }
  });

  it('answers difficulty with stronger intelligence, never with a human', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const decision = evaluateAuthority({
      surface: 'implementation-structure',
      seal,
      policy: fixture.config.autonomy,
      signals: [...NON_AUTHORITY_SIGNALS],
      strongerIntelligenceAvailable: true,
    });
    expect(decision.verdict).toBe('ESCALATE_INTELLIGENCE');
    expect(decision.reason).toBe('REQUIRES_STRONGER_INTELLIGENCE');
    expect(decision.observedSignals).toEqual([...NON_AUTHORITY_SIGNALS]);
  });

  it('no difficulty signal can produce a human gate', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const proof = verifyNonAuthoritySignalsCannotGate(fixture.config.autonomy, seal);
    expect(proof.violations).toEqual([]);
    expect(proof.holds).toBe(true);
  });

  it('stops for every hard authority surface, sealed or not', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    for (const surface of [
      'sealed-contract-change',
      'product-semantics-change',
      'wire-protocol-change',
      'persistence-compatibility-change',
      'security-boundary-expansion',
      'sealed-requirement-conflict',
      'contract-change-request',
      'human-only-credential',
      'external-irreversible-action',
      'scope-beyond-seal',
    ] as const) {
      const decision = evaluateAuthority({ surface, seal, policy: fixture.config.autonomy });
      expect(decision.verdict, `${surface} must need authority`).toBe('NEEDS_AUTHORITY');
      expect(decision.question.length).toBeGreaterThan(0);
      expect(decision.whyItMatters.length).toBeGreaterThan(0);
    }
  });

  it('treats spend inside the authorized ceiling as ordinary execution', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const inside = evaluateAuthority({
      surface: 'spend-beyond-ceiling',
      seal,
      policy: fixture.config.autonomy,
      spend: { requestedUsd: 1.5, ceilingUsd: 10 },
    });
    expect(inside.verdict).toBe('AUTONOMOUS');

    const outside = evaluateAuthority({
      surface: 'spend-beyond-ceiling',
      seal,
      policy: fixture.config.autonomy,
      spend: { requestedUsd: 25, ceilingUsd: 10 },
    });
    expect(outside.verdict).toBe('NEEDS_AUTHORITY');
    expect(outside.reason).toBe('EXCEEDS_AUTHORIZED_SPEND');
  });

  it('treats an unknown cost or unknown ceiling as outside the authorization', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    for (const spend of [
      { requestedUsd: null, ceilingUsd: 10 },
      { requestedUsd: 2, ceilingUsd: null },
    ]) {
      const decision = evaluateAuthority({
        surface: 'spend-beyond-ceiling',
        seal,
        policy: fixture.config.autonomy,
        spend,
      });
      expect(decision.verdict).toBe('NEEDS_AUTHORITY');
    }
  });

  it('grants no delegated authority without an executable seal', () => {
    const fixture = setupAutonomyFixture();
    const decision = evaluateAuthority({
      surface: 'implementation-structure',
      seal: undefined,
      policy: fixture.config.autonomy,
    });
    expect(decision.verdict).toBe('NEEDS_AUTHORITY');
    expect(decision.reason).toBe('NO_SEAL_BOUND');
  });

  it('respects a policy that reserves a surface to the human', () => {
    const fixture = setupAutonomyFixture({ autonomy: { decisions: { dependencySelection: 'HUMAN' } } });
    const { seal } = sealedMission(fixture);
    const decision = evaluateAuthority({
      surface: 'dependency-choice',
      seal,
      policy: fixture.config.autonomy,
    });
    expect(decision.verdict).toBe('NEEDS_AUTHORITY');
    expect(decision.reason).toBe('POLICY_RESERVES_TO_HUMAN');
  });

  it('screens proposal text for promises, not for difficulty', () => {
    // The words that SHOULD fire: they name promises to somebody outside.
    expect(screenTextForAuthoritySurfaces('change the wire format to protobuf').surfaces).toContain(
      'wire-protocol-change',
    );
    expect(
      screenTextForAuthoritySurfaces('disable authentication on the internal endpoint').surfaces,
    ).toContain('security-boundary-expansion');
    expect(screenTextForAuthoritySurfaces('a destructive migration drops the events table').surfaces)
      .toContain('persistence-compatibility-change');

    // The words that must NOT: they only describe hard engineering.
    for (const text of [
      'restructure the module layout for clarity',
      'redesign the internal scheduler architecture',
      'this is a large and architecturally heavy refactor',
      'add a new dependency for date parsing',
    ]) {
      expect(screenTextForAuthoritySurfaces(text).surfaces, text).toEqual([]);
    }
  });

  it('refines the v1.2 intent screen so internal architecture stops gating', () => {
    const delegated = refineIntentImpactUnderSeal(
      ['architecture-contract-change', 'new-dependency'],
      overnight,
    );
    expect(delegated).toEqual([]);

    const reserved = refineIntentImpactUnderSeal(
      ['architecture-contract-change', 'new-dependency'],
      defaultAutonomyPolicy(),
    );
    expect(reserved).toContain('sealed-contract-change');
    expect(reserved).toContain('scope-beyond-seal');

    // A public API change is a promise in every policy.
    expect(refineIntentImpactUnderSeal(['public-api-change'], overnight)).toEqual([
      'sealed-contract-change',
    ]);
  });
});

describe('delegated authority resolver', () => {
  it('pins a qualified runtime identity without granting additional authority', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const runtimeIdentity = {
      version: '1.1.0',
      commit: 'a'.repeat(40),
      digest: 'b'.repeat(64),
      qualificationRunId: 'qual-release-001',
    };
    bindSealToJob(fixture.deps, 'job-runtime-pinned', seal.sealId, { runtimeIdentity });

    expect(readSealBinding(fixture.workspace, 'job-runtime-pinned')?.runtimeIdentity).toEqual(runtimeIdentity);
    expect(readJobSeal(fixture.workspace, 'job-runtime-pinned')?.sealId).toBe(seal.sealId);
  });

  it('lets an architecture-flavoured replan proceed under a seal', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    const resolver = createAuthorityResolver({
      workspace: fixture.workspace,
      policy: fixture.config.autonomy,
    });
    // Bind the seal so the resolver can find it for this job.
    bindSealToJob(fixture.deps, 'job-1', seal.sealId);

    const verdict = resolver.resolve({
      jobId: 'job-1',
      decisionKinds: ['architecture-contract-change'],
      reasons: ['the replacement plan introduces "restructure"'],
      proposal: 'Restructure the scheduler into three modules and add a queue abstraction.',
    });
    expect(verdict.kind).toBe('AUTONOMOUS');
  });

  it('still stops a replan that would change a public contract', () => {
    const fixture = setupAutonomyFixture();
    const { seal } = sealedMission(fixture);
    bindSealToJob(fixture.deps, 'job-2', seal.sealId);
    const resolver = createAuthorityResolver({
      workspace: fixture.workspace,
      policy: fixture.config.autonomy,
    });

    const verdict = resolver.resolve({
      jobId: 'job-2',
      decisionKinds: ['public-api-change'],
      reasons: ['the replacement plan introduces "public api"'],
      proposal: 'Change the public API of the action SDK to take a context object.',
    });
    expect(verdict.kind).toBe('NEEDS_AUTHORITY');
    if (verdict.kind === 'NEEDS_AUTHORITY') {
      expect(verdict.surface).toBe('sealed-contract-change');
      expect(verdict.options?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('gives no delegated authority to a job with no seal binding', () => {
    const fixture = setupAutonomyFixture();
    const resolver = createAuthorityResolver({
      workspace: fixture.workspace,
      policy: fixture.config.autonomy,
    });
    const verdict = resolver.resolve({
      jobId: 'job-unbound',
      decisionKinds: [],
      reasons: [],
      proposal: 'Rename an internal helper.',
    });
    expect(verdict.kind).toBe('NEEDS_AUTHORITY');
    expect(readJobSeal(fixture.workspace, 'job-unbound')).toBeUndefined();
  });

  it('is only installed for an unattended workspace with an authority-only gate', () => {
    expect(shouldDelegateAuthority(overnightAutonomyPreset())).toBe(true);
    expect(shouldDelegateAuthority(defaultAutonomyPolicy())).toBe(false);
    expect(shouldDelegateAuthority({ ...overnightAutonomyPreset(), humanGate: 'ALL' })).toBe(false);
  });
});
