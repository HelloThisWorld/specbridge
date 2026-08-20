import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import {
  analyzeRequirementsStage,
  analyzeTasksStage,
  approveStage,
  analyzeDesignStage,
} from '@specbridge/workflow';
import {
  markContractReady,
  observeSpecApproval,
  readSpecCandidate,
  requireMissionState,
  synthesizeMissionSpec,
} from '@specbridge/mission';
import { coveredMission, setupMissionFixture, startedMission } from '../helpers-mission.js';

describe('mission → spec synthesis', () => {
  it('is refused before CONTRACT_READY', () => {
    const fixture = setupMissionFixture();
    const { missionId } = startedMission(fixture);
    expect(() => synthesizeMissionSpec(fixture.deps, missionId)).toThrow(/CONTRACT_READY/);
  });

  it('compiles contracts into a valid Kiro spec with objective tasks', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    markContractReady(fixture.deps, covered.missionId);

    const result = synthesizeMissionSpec(fixture.deps, covered.missionId);
    expect(result.specName).toBe('steprelay');
    expect(result.objectiveCount).toBe(1);
    expect(result.mission.status).toBe('SPEC_REVIEW');
    expect(result.mission.specName).toBe('steprelay');

    // The spec exists on disk with all three stages plus sidecar state.
    const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, 'steprelay'));
    expect(spec.state).toBeDefined();

    // The existing stage analyzers find no error-severity findings.
    const options = { placeholderSeverity: 'error' as const, missingFileSeverity: 'error' as const };
    for (const analysis of [
      analyzeRequirementsStage(spec, options),
      analyzeDesignStage(spec, options),
      analyzeTasksStage(spec, options),
    ]) {
      const errors = analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      expect(errors, `${analysis.stage}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
    }

    // Objectives are leaf checkbox tasks with acceptance criteria as notes.
    const tasksMarkdown = readFileSync(
      path.join(fixture.workspace.kiroDir, 'specs', 'steprelay', 'tasks.md'),
      'utf8',
    );
    expect(tasksMarkdown).toMatch(/- \[ \] 1\. Canonical Workflow Model/);
    expect(tasksMarkdown).toMatch(/ {2}- Acceptance: Sequential execution is deterministic/);
    expect(tasksMarkdown).toMatch(/ {2}- Contract: CTR-001 r1/);
    expect(tasksMarkdown).toMatch(/_Requirements: 1\.1, 1\.2, 1\.3_/);
    expect(spec.tasks?.allTasks.every((task) => task.children.length === 0)).toBe(true);

    // Candidates and the provenance map were archived for audit.
    expect(readSpecCandidate(fixture.workspace, covered.missionId, 'requirements.md')).toBeDefined();
    const provenance = JSON.parse(
      readSpecCandidate(fixture.workspace, covered.missionId, 'provenance.json') ?? '{}',
    ) as { requirements: { contractId: string; criteria: { source: string }[] }[] };
    expect(provenance.requirements[0]?.contractId).toBe('CTR-001');
    expect(provenance.requirements[0]?.criteria[0]?.source).toMatch(/^CTR-001\/r1\/R1$/);
  });

  it('a name collision fails closed: the mission returns to CONTRACT_READY', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    markContractReady(fixture.deps, covered.missionId);
    synthesizeMissionSpec(fixture.deps, covered.missionId);

    // A second mission tries to synthesize into the same name.
    const second = coveredMission(fixture);
    markContractReady(fixture.deps, second.missionId);
    expect(() => synthesizeMissionSpec(fixture.deps, second.missionId)).toThrow(/already exists|creation failed/i);
    expect(requireMissionState(fixture.workspace, second.missionId).status).toBe('CONTRACT_READY');
  });

  it('observeSpecApproval promotes SPEC_REVIEW to APPROVED only after every human approval', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    markContractReady(fixture.deps, covered.missionId);
    synthesizeMissionSpec(fixture.deps, covered.missionId);

    // Unapproved: observation changes nothing.
    expect(observeSpecApproval(fixture.deps, covered.missionId).status).toBe('SPEC_REVIEW');

    // The HUMAN approval path (approveStage is the CLI's underlying call).
    for (const stage of ['requirements', 'design', 'tasks'] as const) {
      const spec = analyzeSpec(fixture.workspace, requireSpec(fixture.workspace, 'steprelay'));
      const result = approveStage(fixture.workspace, spec, { stage }, { clock: fixture.clock });
      expect(result.ok, `approve ${stage}`).toBe(true);
    }
    const approved = observeSpecApproval(fixture.deps, covered.missionId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAt).toBeDefined();
  });

  it('touches nothing under .kiro except the created spec directory', () => {
    const fixture = setupMissionFixture();
    const covered = coveredMission(fixture);
    markContractReady(fixture.deps, covered.missionId);
    const before = readdirSync(path.join(fixture.root, '.kiro'));
    synthesizeMissionSpec(fixture.deps, covered.missionId);
    const after = readdirSync(path.join(fixture.root, '.kiro'));
    expect(after.sort()).toEqual([...new Set([...before, 'specs'])].sort());
    expect(readdirSync(path.join(fixture.root, '.kiro', 'specs'))).toEqual(['steprelay']);
  });
});
