import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localInferenceConfigSchema,
  resolveWorkspace,
  sha256Hex,
} from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { MissionDeps } from '@specbridge/mission';
import {
  beginMission,
  markContractReady,
  observeSpecApproval,
  recordAssessment,
  recordTurn,
  readContractRegistry,
  storeContractRevision,
  synthesizeMissionSpec,
} from '@specbridge/mission';
import { LocalModelManager } from '@specbridge/runners';
import { approveStage } from '@specbridge/workflow';
import type {
  ContextProjection,
  DriverDeps,
  SecondaryBuilderPacket,
  SecondaryInferenceResult,
  SecondaryModelInference,
} from '@specbridge/orchestration';
import {
  CANDIDATE_ARTIFACT_SCHEMA_VERSION,
  SECONDARY_BUILDER_LIMITS,
  SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
  SECONDARY_BUILDER_SYSTEM_PROMPT,
  buildSecondaryBuilderPacket,
  candidateArtifactSchema,
  captureSecondarySourceContext,
  collectWorktreeChanges,
  contractSnapshotHashOf,
  contextProjectionSchema,
  createWorkerWorktree,
  createJob,
  driveJob,
  driveObjective,
  evaluateDeterministically,
  executeSecondaryObjectiveBuilder,
  managedLocalSecondaryModelInference,
  objectiveDir,
  readCandidate,
  readLatestWorkGraph,
  readSecondaryBuilderAttempt,
  readSecondaryBuilderAttempts,
  readWorkerRecord,
  requireGraphRevision,
  removeWorkerWorktree,
  resolveWorkers,
  runWorktreeVerification,
  secondaryBuilderResultSchema,
  storeSecondaryBuilderAttempt,
  storeWorkerRecord,
  storeWorkGraph,
} from '@specbridge/orchestration';
import { emptyTempDir } from '../helpers.js';
import { failingCommand, setupExecutionFixture } from '../helpers-execution.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function fixture(): {
  root: string;
  workspace: NonNullable<ReturnType<typeof resolveWorkspace>>;
} {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro', 'specs'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'mapper.ts'), 'export const map = (name: string) => ({ name });\n', 'utf8');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@specbridge.invalid');
  git(root, 'config', 'user.name', 'SpecBridge Tests');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('fixture has no workspace');
  return { root, workspace };
}

function projection(attempt = 1): ContextProjection {
  return contextProjectionSchema.parse({
    schemaVersion: '1.0.0',
    projectionId: `wu-1-a${String(attempt).padStart(2, '0')}`,
    jobId: 'job-1',
    objectiveNodeId: 'node-1',
    workUnitId: 'wu-1',
    attempt,
    createdAt: '2026-08-29T00:00:00.000Z',
    constitution: {
      version: 1,
      rules: [{ ruleId: 'RULE-1', version: 1, statement: 'Keep mapping deterministic.' }],
    },
    objective: {
      taskId: '1',
      title: 'Add an id field to the DTO mapper',
      acceptance: ['The mapper returns both id and name.'],
    },
    workUnit: {
      title: 'Update mapper',
      goal: 'Add an id argument and map it consistently.',
      kind: 'build',
      expectedArtifacts: ['src/mapper.ts'],
      expectedAreas: ['src'],
    },
    contracts: [],
    adrs: [],
    decisions: [],
    specExcerpts: [],
    workEvidence: [],
    contractSnapshotHash: contractSnapshotHashOf([], 1),
    contentHash: sha256Hex(`projection-${attempt}`),
  });
}

function inference(result: string | SecondaryInferenceResult): SecondaryModelInference {
  return {
    profile: 'fake-secondary',
    provider: 'deterministic-fake',
    model: 'fake-model',
    infer: async () =>
      typeof result === 'string'
        ? {
            ok: true,
            text: result,
            durationMs: 12,
            usage: { inputTokens: 20, outputTokens: 10 },
          }
        : result,
  };
}

function validProposal(edits: unknown[]): string {
  return JSON.stringify({
    schemaVersion: SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
    summary: 'Updated the mapper.',
    edits,
    notes: [],
  });
}

async function run(
  root: string,
  packet: SecondaryBuilderPacket,
  model: SecondaryModelInference,
  overrides: Partial<Parameters<typeof executeSecondaryObjectiveBuilder>[0]> = {},
) {
  return executeSecondaryObjectiveBuilder({
    worktreeRoot: root,
    packet,
    inference: model,
    maximumInputCharacters: 524_288,
    maxOutputBytes: 2_097_152,
    ...overrides,
  });
}

describe('SecondaryObjectiveBuilder structured edit boundary', () => {
  it('applies a valid proposal only in the isolated worktree and remains a normal candidate', async () => {
    const { root, workspace } = fixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    try {
      const packet = buildSecondaryBuilderPacket({
        projection: projection(),
        sourceContext: captureSecondarySourceContext(handle.dir, ['src/mapper.ts']),
        verificationHints: ['typecheck'],
      });
      const result = await run(
        handle.dir,
        packet,
        inference(
          validProposal([
            {
              path: 'src/mapper.ts',
              operation: 'REPLACE',
              content: 'export const map = (id: string, name: string) => ({ id, name });\n',
            },
            {
              path: 'src/mapper.test.ts',
              operation: 'CREATE',
              content: 'export const expected = { id: "1", name: "Ada" };\n',
            },
          ]),
        ),
      );
      expect(result.ok).toBe(true);
      expect(readFileSync(path.join(handle.dir, 'src', 'mapper.ts'), 'utf8')).toContain('id, name');
      expect(readFileSync(path.join(root, 'src', 'mapper.ts'), 'utf8')).not.toContain('id, name');
      expect(existsSync(path.join(root, 'src', 'mapper.test.ts'))).toBe(false);

      const collected = await collectWorktreeChanges(handle, { protectedPaths: [] });
      const verification = await runWorktreeVerification(handle, [
        { name: 'trusted', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60_000, required: true },
      ]);
      const candidate = candidateArtifactSchema.parse({
        schemaVersion: CANDIDATE_ARTIFACT_SCHEMA_VERSION,
        candidateId: 'wu-1-a01',
        jobId: 'job-1',
        objectiveNodeId: 'node-1',
        workUnitId: 'wu-1',
        attempt: 1,
        workerId: 'builder-wu-1-a1',
        createdAt: '2026-08-29T00:00:01.000Z',
        baselineCommit: handle.baselineCommit,
        contextProjectionHash: packet.projectionHash,
        contractSnapshotHash: packet.contractSnapshotHash,
        changedFiles: collected.changedFiles,
        patchRef: 'candidates/wu-1-a01.patch',
        localVerification: {
          ran: verification.ran,
          passed: verification.passed,
          commands: verification.commands.map((command) => ({
            name: command.name,
            status: command.status,
            exitCode: command.exitCode ?? null,
          })),
        },
        claims: {
          summary: 'Updated the mapper.',
          assumptionsDiscovered: [],
          contractChangeRequests: [],
          knownLimitations: [],
        },
        builderProvenance: {
          backend: 'SECONDARY_DIRECT_MODEL',
          inferenceProfile: 'fake-secondary',
          packetHash: packet.packetHash,
          sourceContextHash: packet.sourceContextHash,
        },
      });
      const evaluated = evaluateDeterministically({
        candidate,
        workUnit: {
          workUnitId: 'wu-1',
          objectiveNodeId: 'node-1',
          parentTaskId: '1',
          kind: 'build',
          title: 'Update mapper',
          goal: 'Add an id argument and map it consistently.',
          dependsOn: [],
          expectedArtifacts: ['src/mapper.ts'],
          relevantContractIds: [],
          relevantAdrIds: [],
          relevantConstitutionRuleIds: [],
          expectedAreas: ['src'],
          status: 'CANDIDATE_READY',
          attempt: 1,
          evaluationRefs: [],
        },
        projection: projection(),
        contracts: [],
        constitutionRules: [],
        constitutionVersion: 1,
        protectedViolations: collected.protectedViolations,
        patch: collected.patch,
        createdAt: '2026-08-29T00:00:02.000Z',
        evaluationId: 'eval-1',
      });
      expect(evaluated.verdict).toBe('PASS');
      expect(candidate.builderProvenance?.backend).toBe('SECONDARY_DIRECT_MODEL');
    } finally {
      await removeWorkerWorktree(workspace, 'job-1', handle);
    }
  });

  it.each([
    ['prose', 'Here is the code you requested.'],
    ['multiple documents', '{}\n{}'],
    ['fenced JSON', '```json\n{}\n```'],
    ['schema-invalid', JSON.stringify({ summary: 'missing edits' })],
    [
      'unknown operation',
      JSON.stringify({
        schemaVersion: SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
        summary: 'bad',
        edits: [{ path: 'src/x.ts', operation: 'DELETE', content: '' }],
      }),
    ],
    [
      'command field',
      JSON.stringify({
        schemaVersion: SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
        summary: 'bad',
        edits: [],
        command: 'git status',
      }),
    ],
  ])('rejects %s as INVALID_STRUCTURED_OUTPUT with no heuristic salvage', async (_name, output) => {
    const { workspace } = fixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    try {
      const packet = buildSecondaryBuilderPacket({ projection: projection(), sourceContext: [] });
      const result = await run(handle.dir, packet, inference(output));
      expect(result).toMatchObject({ ok: false, failure: { kind: 'INVALID_STRUCTURED_OUTPUT' } });
    } finally {
      await removeWorkerWorktree(workspace, 'job-1', handle);
    }
  });

  it.each([
    ['.specbridge/config.json', 'CREATE'],
    ['.SPECBRIDGE/config.json', 'CREATE'],
    ['.kiro/specs/mission/contracts.json', 'CREATE'],
    ['.codex/settings.json', 'CREATE'],
    ['.env', 'CREATE'],
    ['../../outside.txt', 'CREATE'],
  ])('refuses authority, credential, and traversal target %s', async (target, operation) => {
    const { root, workspace } = fixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    try {
      const packet = buildSecondaryBuilderPacket({ projection: projection(), sourceContext: [] });
      const result = await run(
        handle.dir,
        packet,
        inference(validProposal([{ path: target, operation, content: 'forbidden\n' }])),
      );
      expect(result).toMatchObject({ ok: false, failure: { kind: 'FORBIDDEN_EDIT' } });
      expect(existsSync(path.resolve(root, '..', 'outside.txt'))).toBe(false);
    } finally {
      await removeWorkerWorktree(workspace, 'job-1', handle);
    }
  });

  it('rejects a symlink escape and never writes through it', async () => {
    const { root, workspace } = fixture();
    const outside = emptyTempDir();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    try {
      symlinkSync(outside, path.join(handle.dir, 'linked'), 'junction');
      const packet = buildSecondaryBuilderPacket({ projection: projection(), sourceContext: [] });
      const result = await run(
        handle.dir,
        packet,
        inference(validProposal([{ path: 'linked/escape.ts', operation: 'CREATE', content: 'no\n' }])),
      );
      expect(result).toMatchObject({ ok: false, failure: { kind: 'FORBIDDEN_EDIT' } });
      expect(existsSync(path.join(outside, 'escape.ts'))).toBe(false);
      expect(readFileSync(path.join(root, 'src', 'mapper.ts'), 'utf8')).toContain('name');
    } finally {
      await removeWorkerWorktree(workspace, 'job-1', handle);
    }
  });

  it('refuses stale source before inference', async () => {
    const { workspace } = fixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    try {
      const packet = buildSecondaryBuilderPacket({
        projection: projection(),
        sourceContext: captureSecondarySourceContext(handle.dir, ['src/mapper.ts']),
      });
      writeFileSync(path.join(handle.dir, 'src', 'mapper.ts'), 'changed after packet\n', 'utf8');
      let calls = 0;
      const model = inference(validProposal([]));
      const result = await run(handle.dir, packet, { ...model, infer: async (request) => { calls += 1; return model.infer(request); } });
      expect(result).toMatchObject({ ok: false, failure: { kind: 'STALE_SOURCE_CONTEXT' } });
      expect(calls).toBe(0);
    } finally {
      await removeWorkerWorktree(workspace, 'job-1', handle);
    }
  });

  it('refuses an escaping source-context path without reading or invoking inference', async () => {
    const { workspace } = fixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    try {
      const packet = buildSecondaryBuilderPacket({
        projection: projection(),
        sourceContext: [
          { path: '../../outside.txt', contentHash: sha256Hex('outside'), content: 'outside' },
        ],
      });
      let calls = 0;
      const model = inference(validProposal([]));
      const result = await run(handle.dir, packet, {
        ...model,
        infer: async (request) => {
          calls += 1;
          return model.infer(request);
        },
      });
      expect(result).toMatchObject({ ok: false, failure: { kind: 'STALE_SOURCE_CONTEXT' } });
      expect(calls).toBe(0);
    } finally {
      await removeWorkerWorktree(workspace, 'job-1', handle);
    }
  });

  it('distinguishes empty, oversized, unavailable, timeout, and context failures', async () => {
    const { workspace } = fixture();
    const handle = await createWorkerWorktree({ workspace, jobId: 'job-1', workUnitId: 'wu-1', attempt: 1 });
    try {
      const packet = buildSecondaryBuilderPacket({ projection: projection(), sourceContext: [] });
      expect(await run(handle.dir, packet, inference(validProposal([]))))
        .toMatchObject({ ok: false, failure: { kind: 'EMPTY_EDIT_SET' } });
      expect(await run(
        handle.dir,
        packet,
        inference(validProposal([{ path: 'src/huge.ts', operation: 'CREATE', content: '界'.repeat(SECONDARY_BUILDER_LIMITS.maxFileBytes) }])),
      )).toMatchObject({ ok: false, failure: { kind: 'INVALID_STRUCTURED_OUTPUT' } });
      expect(await run(handle.dir, packet, inference({ ok: false, kind: 'unavailable', problem: 'disabled', durationMs: 1 })))
        .toMatchObject({ ok: false, failure: { kind: 'INFERENCE_UNAVAILABLE' } });
      expect(await run(handle.dir, packet, inference({ ok: false, kind: 'timeout', problem: 'timed out', durationMs: 1 })))
        .toMatchObject({ ok: false, failure: { kind: 'TIMEOUT' } });
      expect(await run(handle.dir, packet, inference(validProposal([])), { maximumInputCharacters: 1 }))
        .toMatchObject({ ok: false, failure: { kind: 'CONTEXT_TOO_LARGE' } });
    } finally {
      await removeWorkerWorktree(workspace, 'job-1', handle);
    }
  });

  it('has no output field capable of representing a shell or tool invocation', () => {
    expect(SECONDARY_BUILDER_SYSTEM_PROMPT).toContain('no shell');
    const parsed = secondaryBuilderResultSchema.safeParse({
      schemaVersion: SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
      summary: 'attempted command',
      edits: [],
      shell: 'npm test',
    });
    expect(parsed.success).toBe(false);
  });
});

const GOAL = 'Build StepRelay: a lightweight, config-driven, distributed workflow engine.';

function secondaryMissionFixture(
  options: {
    verificationFails?: boolean;
    staleProjection?: boolean;
    semanticEvaluationAlways?: boolean;
  } = {},
): {
  root: string;
  workspace: ReturnType<typeof setupExecutionFixture>['workspace'];
  driverDeps: DriverDeps;
  inferenceCalls: () => number;
  mission: ReturnType<typeof beginMission>;
} {
  const base = setupExecutionFixture({
    git: true,
    useFakeClaude: true,
    defaultRunner: 'claude-code',
    ...(options.verificationFails === true ? { verificationCommands: [failingCommand()] } : {}),
    extraConfig: {
      orchestration: {
        jobs: {
          routing: { classifier: 'disabled', critic: 'disabled' },
          planReview: 'auto',
          ...(options.semanticEvaluationAlways === true
            ? { objectives: { semanticEvaluation: 'always' } }
            : {}),
        },
      },
    },
  });
  const missionDeps: MissionDeps = {
    workspace: base.workspace,
    clock: base.clock,
    idFactory: base.idFactory,
    host: 'test',
  };
  const mission = beginMission(missionDeps, { name: 'steprelay-secondary', goal: GOAL });
  const turn = recordTurn(missionDeps, mission.missionId, {
    speaker: 'user',
    kind: 'confirmation',
    text: GOAL,
  });
  const decided = recordAssessment(missionDeps, mission.missionId, {
    decisions: (
      [
        ['goal', 'A lightweight config-driven workflow engine.'],
        ['use-cases', 'Event-driven workflow orchestration.'],
        ['system-boundaries', 'Engine owns orchestration; actions own logic.'],
        ['canonical-model', 'A deterministic definition-interpreting kernel.'],
        ['public-api', 'The definition format and the action SDK.'],
        ['failure-semantics', 'At-least-once with idempotent completions.'],
        ['compatibility', 'Additive-only public evolution.'],
      ] as const
    ).map(([topic, decision]) => ({
      decision,
      provenance: 'known-from-user' as const,
      sourceTurnId: turn.turn.turnId,
      topics: [topic],
    })),
  });
  recordAssessment(missionDeps, mission.missionId, {
    contracts: [
      {
        title: 'Event-driven execution',
        summary: 'The canonical envelope and result protocol.',
        classification: 'public',
        compatibilityPolicy: 'additive-only',
        requirements: [
          { statement: 'An action request dispatch is supported.' },
          { statement: 'An action result resumes execution.' },
        ],
        decisionIds: [decided.decisionIds[3]!],
      },
    ],
  });
  markContractReady(missionDeps, mission.missionId);
  synthesizeMissionSpec(missionDeps, mission.missionId);
  for (const stage of ['requirements', 'design', 'tasks'] as const) {
    const spec = analyzeSpec(base.workspace, requireSpec(base.workspace, 'steprelay-secondary'));
    const approved = approveStage(base.workspace, spec, { stage }, { clock: base.clock });
    if (!approved.ok) throw new Error(`approval of ${stage} failed`);
  }
  observeSpecApproval(missionDeps, mission.missionId);
  git(base.root, 'add', '.kiro');
  git(base.root, 'commit', '-q', '-m', 'approved secondary mission spec');

  let inferenceCalls = 0;
  const directInference: SecondaryModelInference = {
    profile: 'fake-secondary-objective',
    provider: 'deterministic-fake',
    model: 'fixture-model',
    async infer(request) {
      inferenceCalls += 1;
      const envelope = request.userPrompt.includes('"workUnitId":"wu-1"');
      const target = envelope
        ? 'src/envelope/implementation.js'
        : 'src/transport/implementation.js';
      // No candidate has reached integration while either direct-model call
      // is running: the canonical checkout remains byte-identical.
      expect(existsSync(path.join(base.root, target))).toBe(false);
      return {
        ok: true,
        text: validProposal([
          {
            path: target,
            operation: 'CREATE',
            content: `module.exports = { source: "secondary", unit: "${envelope ? 'envelope' : 'transport'}" };\n`,
          },
        ]),
        durationMs: 8,
        usage: { inputTokens: 120, outputTokens: 40 },
      };
    },
  };
  let contractMutated = false;
  return {
    root: base.root,
    workspace: base.workspace,
    inferenceCalls: () => inferenceCalls,
    mission,
    driverDeps: {
      workspace: base.workspace,
      config: base.config,
      registry: base.registry,
      clock: base.clock,
      idFactory: base.idFactory,
      host: 'test',
      secondaryObjectiveBuilder: {
        selectionReason: 'Phase 4 deterministic qualification explicitly selected this backend.',
        sourceContext: () => {
          if (options.staleProjection === true && !contractMutated) {
            const current = readContractRegistry(base.workspace, mission.missionId)[0]!;
            storeContractRevision(base.workspace, mission.missionId, {
              ...current,
              revision: current.revision + 1,
              supersedesRevision: current.revision,
              recordedAt: base.clock().toISOString(),
            });
            contractMutated = true;
          }
          return [];
        },
        inference: directInference,
      },
    },
  };
}

describe('Secondary Objective Builder governed lifecycle', () => {
  it('flows through normal candidate evaluation, aggregation, integration, and trusted verification', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture();
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Implement StepRelay using the explicitly selected secondary builder.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      expect(result.stop.kind).toBe('completed');
      expect(readFileSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'), 'utf8'))
        .toContain('secondary');
      expect(readFileSync(path.join(fixture.root, 'src', 'transport', 'implementation.js'), 'utf8'))
        .toContain('secondary');

      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const node = jobGraph.nodes[0]!;
      const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, node.nodeId)!;
      const buildUnits = workGraph.units.filter((unit) => unit.kind === 'build');
      expect(buildUnits.every((unit) => unit.status === 'INTEGRATED')).toBe(true);
      for (const unit of buildUnits) {
        const candidate = readCandidate(
          fixture.workspace,
          job.jobId,
          node.nodeId,
          unit.workUnitId,
          unit.attempt,
        );
        expect(candidate?.builderProvenance).toMatchObject({
          backend: 'SECONDARY_DIRECT_MODEL',
          inferenceProfile: 'fake-secondary-objective',
          provider: 'deterministic-fake',
        });
      }
      const attempts = readSecondaryBuilderAttempts(fixture.workspace, job.jobId, node.nodeId);
      expect(attempts).toHaveLength(2);
      expect(attempts.every((attempt) => attempt.status === 'CANDIDATE_READY')).toBe(true);
      expect(attempts.every((attempt) => attempt.verification?.passed === true)).toBe(true);
      expect(attempts.every((attempt) => attempt.proposal?.edits.length === 1)).toBe(true);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('preserves packet, proposal, applied files, and trusted failure evidence without integration', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({ verificationFails: true });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise the secondary verification-failure path.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      expect(result.stop.kind).not.toBe('completed');
      expect(existsSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'))).toBe(false);
      expect(existsSync(path.join(fixture.root, 'src', 'transport', 'implementation.js'))).toBe(false);

      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const attempts = readSecondaryBuilderAttempts(fixture.workspace, job.jobId, jobGraph.nodes[0]!.nodeId);
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((attempt) => attempt.status === 'VERIFICATION_FAILED')).toBe(true);
      expect(attempts.every((attempt) => attempt.failure?.kind === 'VERIFICATION_FAILURE')).toBe(true);
      expect(attempts.every((attempt) => attempt.packet.sourceContext.length === 0)).toBe(true);
      expect(attempts.every((attempt) => (attempt.proposal?.edits.length ?? 0) > 0)).toBe(true);
      expect(attempts.every((attempt) => attempt.appliedFiles.length > 0)).toBe(true);
      expect(attempts.every((attempt) => attempt.verification?.commands[0]?.status === 'nonzero-exit')).toBe(true);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('refuses a projection whose approved contract revision changes before inference', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({ staleProjection: true });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise stale approved projection refusal.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      expect(result.stop.kind).not.toBe('completed');
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const attempts = readSecondaryBuilderAttempts(fixture.workspace, job.jobId, jobGraph.nodes[0]!.nodeId);
      const stale = attempts.find((attempt) => attempt.failure?.kind === 'STALE_APPROVED_PROJECTION');
      expect(stale).toMatchObject({
        status: 'FAILED',
        failure: { kind: 'STALE_APPROVED_PROJECTION' },
      });
      expect(stale?.rawOutput).toBeUndefined();
      expect(existsSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'))).toBe(false);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('resumes an identity-bound persisted secondary candidate without rebuilding it', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const controller = new AbortController();
      const fixture = secondaryMissionFixture({ semanticEvaluationAlways: true });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise secondary candidate crash recovery.',
      });
      const interrupted = await driveJob(fixture.driverDeps, job.jobId, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.message.includes('EVALUATOR on')) controller.abort();
        },
      });
      expect(interrupted.stop.kind).toBe('interrupted');

      const jobGraph = requireGraphRevision(
        fixture.workspace,
        job.jobId,
        interrupted.job.graphRevision,
      );
      const nodeId = jobGraph.nodes[0]!.nodeId;
      const midGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId)!;
      const unit = midGraph.units.find(
        (entry) =>
          entry.attempt > 0 &&
          readCandidate(
            fixture.workspace,
            job.jobId,
            nodeId,
            entry.workUnitId,
            entry.attempt,
          ) !== undefined,
      )!;
      const candidate = readCandidate(
        fixture.workspace,
        job.jobId,
        nodeId,
        unit.workUnitId,
        unit.attempt,
      )!;
      const worker = readWorkerRecord(
        fixture.workspace,
        job.jobId,
        nodeId,
        unit.workUnitId,
        unit.attempt,
        'BUILDER',
      )!;

      // Recreate the exact durable shape of a process that died after the
      // candidate and finished-worker markers, but before the graph status.
      expect(worker.status).toBe('FINISHED');
      storeWorkGraph(fixture.workspace, job.jobId, {
        ...midGraph,
        units: midGraph.units.map((entry) => {
          if (entry.workUnitId !== unit.workUnitId) return entry;
          const { candidateRef: _candidateRef, ...building } = entry;
          return { ...building, status: 'BUILDING' as const };
        }),
      });
      expect(existsSync(path.join(fixture.root, candidate.changedFiles[0]!.path))).toBe(false);

      const resumed = await driveObjective({
        workspace: fixture.workspace,
        config: fixture.driverDeps.config,
        jobId: job.jobId,
        specName: 'steprelay-secondary',
        node: jobGraph.nodes[0]!,
        mission: fixture.mission,
        policy: fixture.driverDeps.config.orchestration.jobs,
        workers: resolveWorkers(fixture.driverDeps.config),
        allowDirty: false,
        runnerProfile: fixture.driverDeps.config.defaultRunner,
        probeCache: { probe: undefined },
        clock: fixture.driverDeps.clock,
        idFactory: fixture.driverDeps.idFactory,
        secondaryBuilder: fixture.driverDeps.secondaryObjectiveBuilder,
        countWorkerRun: () => undefined,
        recordEvent: () => undefined,
      });
      expect(resumed.failure).toBeUndefined();
      // One original call plus the other independent build unit. Rebuilding
      // the persisted first candidate would make this three.
      expect(fixture.inferenceCalls()).toBe(2);
      const attempts = readSecondaryBuilderAttempts(fixture.workspace, job.jobId, nodeId);
      expect(attempts.filter((attempt) => attempt.workUnitId === unit.workUnitId)).toHaveLength(1);
      expect(attempts.find((attempt) => attempt.workUnitId === unit.workUnitId)?.status)
        .toBe('CANDIDATE_READY');
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('reconciles an interrupted secondary attempt with no candidate and never claims completion', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    let dangling: Awaited<ReturnType<typeof createWorkerWorktree>> | undefined;
    let cleanupWorkspace: ReturnType<typeof setupExecutionFixture>['workspace'] | undefined;
    let cleanupJobId: string | undefined;
    try {
      const controller = new AbortController();
      const fixture = secondaryMissionFixture({ semanticEvaluationAlways: true });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise interrupted secondary attempt reconciliation.',
      });
      cleanupWorkspace = fixture.workspace;
      cleanupJobId = job.jobId;
      const interrupted = await driveJob(fixture.driverDeps, job.jobId, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.message.includes('EVALUATOR on')) controller.abort();
        },
      });
      expect(interrupted.stop.kind).toBe('interrupted');

      const jobGraph = requireGraphRevision(
        fixture.workspace,
        job.jobId,
        interrupted.job.graphRevision,
      );
      const nodeId = jobGraph.nodes[0]!.nodeId;
      const midGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId)!;
      const unit = midGraph.units.find(
        (entry) =>
          entry.attempt > 0 &&
          readCandidate(
            fixture.workspace,
            job.jobId,
            nodeId,
            entry.workUnitId,
            entry.attempt,
          ) !== undefined,
      )!;
      const candidate = readCandidate(
        fixture.workspace,
        job.jobId,
        nodeId,
        unit.workUnitId,
        unit.attempt,
      )!;
      const worker = readWorkerRecord(
        fixture.workspace,
        job.jobId,
        nodeId,
        unit.workUnitId,
        unit.attempt,
        'BUILDER',
      )!;
      const attempt = readSecondaryBuilderAttempt(
        fixture.workspace,
        job.jobId,
        nodeId,
        unit.workUnitId,
        unit.attempt,
      )!;

      // Remove the candidate record to model death before persistence while
      // retaining the already-durable proposal/applied-files attempt record.
      const candidateDir = path.join(objectiveDir(fixture.workspace, job.jobId, nodeId), 'candidates');
      rmSync(path.join(candidateDir, `${candidate.candidateId}.json`));
      rmSync(path.join(candidateDir, `${candidate.candidateId}.patch`), { force: true });
      storeSecondaryBuilderAttempt(fixture.workspace, job.jobId, nodeId, {
        ...attempt,
        status: 'EDITS_APPLIED',
      });
      const { finishedAt: _finishedAt, ...unfinishedWorker } = worker;
      storeWorkerRecord(fixture.workspace, job.jobId, nodeId, {
        ...unfinishedWorker,
        status: 'RUNNING',
      });
      storeWorkGraph(fixture.workspace, job.jobId, {
        ...midGraph,
        units: midGraph.units.map((entry) => {
          if (entry.workUnitId !== unit.workUnitId) return entry;
          const { candidateRef: _candidateRef, ...building } = entry;
          return { ...building, status: 'BUILDING' as const };
        }),
      });
      dangling = await createWorkerWorktree({
        workspace: fixture.workspace,
        jobId: job.jobId,
        workUnitId: unit.workUnitId,
        attempt: unit.attempt,
      });
      const proposedPath = path.join(dangling.dir, candidate.changedFiles[0]!.path);
      mkdirSync(path.dirname(proposedPath), { recursive: true });
      writeFileSync(proposedPath, 'interrupted secondary proposal\n', 'utf8');

      expect(existsSync(path.join(fixture.root, candidate.changedFiles[0]!.path))).toBe(false);
      expect(readSecondaryBuilderAttempt(
        fixture.workspace,
        job.jobId,
        nodeId,
        unit.workUnitId,
        unit.attempt,
      )?.status).toBe('EDITS_APPLIED');

      const resumed = await driveObjective({
        workspace: fixture.workspace,
        config: fixture.driverDeps.config,
        jobId: job.jobId,
        specName: 'steprelay-secondary',
        node: jobGraph.nodes[0]!,
        mission: fixture.mission,
        policy: fixture.driverDeps.config.orchestration.jobs,
        workers: resolveWorkers(fixture.driverDeps.config),
        allowDirty: false,
        runnerProfile: fixture.driverDeps.config.defaultRunner,
        probeCache: { probe: undefined },
        clock: fixture.driverDeps.clock,
        idFactory: fixture.driverDeps.idFactory,
        secondaryBuilder: fixture.driverDeps.secondaryObjectiveBuilder,
        countWorkerRun: () => undefined,
        recordEvent: () => undefined,
      });
      expect(resumed.failure).toBeUndefined();
      expect(existsSync(dangling.dir)).toBe(false);
      // The incomplete first attempt is preserved, and only that unit is
      // rebuilt before the remaining independent unit runs.
      expect(fixture.inferenceCalls()).toBe(3);
      const attempts = readSecondaryBuilderAttempts(fixture.workspace, job.jobId, nodeId)
        .filter((entry) => entry.workUnitId === unit.workUnitId);
      expect(attempts.map((entry) => [entry.attempt, entry.status])).toEqual([
        [1, 'EDITS_APPLIED'],
        [2, 'CANDIDATE_READY'],
      ]);
    } finally {
      if (
        dangling !== undefined &&
        existsSync(dangling.dir) &&
        cleanupWorkspace !== undefined &&
        cleanupJobId !== undefined
      ) {
        await removeWorkerWorktree(cleanupWorkspace, cleanupJobId, dangling).catch(() => undefined);
      }
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);
});

const realLocal = process.env['SPECBRIDGE_TEST_LOCAL_BUILDER'] === '1' ? it : it.skip;
const realManagers: LocalModelManager[] = [];
afterEach(async () => {
  await Promise.all(realManagers.splice(0).map((manager) => manager.stop('qualification cleanup')));
});

describe('real managed-local Secondary Objective Builder qualification', () => {
  it('maps a disabled managed local model to a structured inference failure', async () => {
    const base = setupExecutionFixture({ git: true });
    const handle = await createWorkerWorktree({
      workspace: base.workspace,
      jobId: 'job-disabled-secondary',
      workUnitId: 'wu-1',
      attempt: 1,
    });
    const manager = new LocalModelManager({ config: base.config.localInference });
    realManagers.push(manager);
    try {
      const packet = buildSecondaryBuilderPacket({ projection: projection(), sourceContext: [] });
      const result = await executeSecondaryObjectiveBuilder({
        worktreeRoot: handle.dir,
        packet,
        inference: managedLocalSecondaryModelInference(manager, base.config),
        maximumInputCharacters: 100_000,
        maxOutputBytes: base.config.localInference.maxOutputBytes,
      });
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'INFERENCE_UNAVAILABLE' },
      });
    } finally {
      await removeWorkerWorktree(base.workspace, 'job-disabled-secondary', handle);
    }
  });

  realLocal('uses configured llama.cpp/Qwen to perform a small governed coding task', async () => {
    const executable = process.env['SPECBRIDGE_TEST_LLAMA_SERVER'];
    const modelPath = process.env['SPECBRIDGE_TEST_QWEN_GGUF'];
    if (executable === undefined || modelPath === undefined) {
      throw new Error('set SPECBRIDGE_TEST_LLAMA_SERVER and SPECBRIDGE_TEST_QWEN_GGUF');
    }
    const base = setupExecutionFixture({ git: true });
    const handle = await createWorkerWorktree({
      workspace: base.workspace,
      jobId: 'job-real-secondary',
      workUnitId: 'wu-1',
      attempt: 1,
    });
    const localInference = localInferenceConfigSchema.parse({
      enabled: true,
      executable,
      model: modelPath,
      contextSize: 16_384,
      maximumInputCharacters: 32_000,
      requestTimeoutMs: 600_000,
    });
    const config = { ...base.config, localInference };
    const manager = new LocalModelManager({ config: localInference });
    realManagers.push(manager);
    try {
      mkdirSync(path.join(handle.dir, 'src'), { recursive: true });
      writeFileSync(
        path.join(handle.dir, 'src', 'mapper.ts'),
        'export interface UserDto { name: string }\nexport const mapUser = (name: string): UserDto => ({ name });\n',
        'utf8',
      );
      const packet = buildSecondaryBuilderPacket({
        projection: projection(),
        sourceContext: captureSecondarySourceContext(handle.dir, ['src/mapper.ts']),
      });
      const result = await executeSecondaryObjectiveBuilder({
        worktreeRoot: handle.dir,
        packet,
        inference: managedLocalSecondaryModelInference(manager, config),
        maximumInputCharacters: 32_000,
        maxOutputBytes: localInference.maxOutputBytes,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.appliedFiles).toContain('src/mapper.ts');
        expect(readFileSync(path.join(handle.dir, 'src', 'mapper.ts'), 'utf8')).toMatch(/id/);
      }
    } finally {
      await removeWorkerWorktree(base.workspace, 'job-real-secondary', handle);
    }
  }, 900_000);
});
