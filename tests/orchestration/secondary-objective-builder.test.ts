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
  clearOperationalState,
  collectWorktreeChanges,
  compileSecondaryBuilderPacket,
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
  readBuilderRoutingStates,
  readBuilderRoutingTelemetry,
  readLatestWorkGraph,
  readObjectiveCooldownState,
  readJobEvents,
  readJobCheckpoint,
  readSecondaryBuilderAttempt,
  readSecondaryBuilderAttempts,
  readWorkReadinessRecord,
  readWorkReadinessTelemetry,
  readWorkerRecord,
  requireGraphRevision,
  removeWorkerWorktree,
  resolveWorkers,
  runWorktreeVerification,
  secondaryBuilderResultSchema,
  storeSecondaryBuilderAttempt,
  storeWorkerRecord,
  storeWorkGraph,
  workUnitSchema,
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
    automaticContext?: boolean;
    noVerification?: boolean;
    secondaryVerificationFails?: boolean;
    secondaryNeedsMoreContextOnce?: boolean;
    secondaryStrategy?: 'OFF' | 'AUTO' | 'PREFER';
    omitSecondarySelection?: boolean;
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
    ...(options.secondaryVerificationFails === true
      ? {
          verificationCommands: [{
            name: 'reject-secondary-fixture',
            argv: [
              process.execPath,
              '-e',
              "const fs=require('fs');const p=['src/envelope/implementation.js','src/transport/implementation.js'];const bad=p.some(f=>fs.existsSync(f)&&fs.readFileSync(f,'utf8').includes('secondary'));process.exit(bad?1:0)",
            ],
            timeoutMs: 60_000,
            required: true,
          }],
        }
      : {}),
    ...(options.noVerification === true ? { verificationCommands: [] } : {}),
    extraConfig: {
      orchestration: {
        jobs: {
          routing: { classifier: 'disabled', critic: 'disabled' },
          planReview: 'auto',
          ...(options.semanticEvaluationAlways === true
            ? {
                objectives: {
                  semanticEvaluation: 'always',
                  ...(options.secondaryStrategy !== undefined
                    ? { secondaryBuilder: { strategy: options.secondaryStrategy } }
                    : {}),
                },
              }
            : options.secondaryStrategy !== undefined
              ? { objectives: { secondaryBuilder: { strategy: options.secondaryStrategy } } }
              : {}),
        },
      },
    },
  });
  mkdirSync(path.join(base.root, 'src', 'envelope'), { recursive: true });
  mkdirSync(path.join(base.root, 'src', 'transport'), { recursive: true });
  writeFileSync(path.join(base.root, 'src', 'envelope', 'implementation.js'), 'module.exports = { source: "baseline" };\n', 'utf8');
  writeFileSync(path.join(base.root, 'src', 'transport', 'implementation.js'), 'module.exports = { source: "baseline" };\n', 'utf8');
  writeFileSync(path.join(base.root, 'src', 'envelope', 'implementation.test.js'), "require('./implementation.js');\n", 'utf8');
  writeFileSync(path.join(base.root, 'src', 'transport', 'implementation.test.js'), "require('./implementation.js');\n", 'utf8');
  git(base.root, 'add', 'src');
  git(base.root, 'commit', '-q', '-m', 'secondary packet fixture source');
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
  const inferenceCallsByTarget = new Map<string, number>();
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
      const targetCalls = (inferenceCallsByTarget.get(target) ?? 0) + 1;
      inferenceCallsByTarget.set(target, targetCalls);
      // No candidate has reached integration while either direct-model call
      // is running: the canonical checkout remains byte-identical.
      expect(readFileSync(path.join(base.root, target), 'utf8')).toContain('baseline');
      if (options.secondaryNeedsMoreContextOnce === true && targetCalls === 1) {
        return {
          ok: true,
          text: JSON.stringify({
            schemaVersion: SECONDARY_BUILDER_RESULT_SCHEMA_VERSION,
            status: 'NEEDS_MORE_CONTEXT',
            summary: 'The adjacent dependency packet is insufficient.',
            edits: [],
            needsMoreContextReasons: ['The surrounding module contract is required.'],
          }),
          durationMs: 5,
          usage: { inputTokens: 80, outputTokens: 20 },
        };
      }
      return {
        ok: true,
        text: validProposal([
          {
            path: target,
            operation: 'REPLACE',
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
      ...(options.omitSecondarySelection === true
        ? {}
        : {
            secondaryObjectiveBuilder: {
              selectionReason: 'Phase 4 deterministic qualification explicitly selected this backend.',
              ...(options.automaticContext === true
                ? {}
                : {
                    sourceContext: ({ worktreeRoot }: { worktreeRoot: string }) => {
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
                      return captureSecondarySourceContext(worktreeRoot, [
                        'src/envelope/implementation.js',
                        'src/transport/implementation.js',
                        'src/envelope/implementation.test.js',
                        'src/transport/implementation.test.js',
                      ]);
                    },
                  }),
              inference: directInference,
            },
          }),
    },
  };
}

describe('Secondary Objective Builder governed lifecycle', () => {
  it('continues an entire eligible Objective through a five-hour Strong cooldown', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({ secondaryStrategy: 'PREFER' });
      const observedAt = fixture.driverDeps.clock!().toISOString();
      const resetAt = new Date(Date.parse(observedAt) + 5 * 3_600_000).toISOString();
      let cooling = false;
      const quota = {
        source: 'phase8-five-hour-fixture',
        getFiveHourQuota: () => {
          return Promise.resolve({
            window: 'five-hour' as const,
            remainingRatio: cooling ? 0 : 1,
            usedRatio: cooling ? 1 : 0,
            resetAt,
            observedAt: fixture.driverDeps.clock!().toISOString(),
            source: 'phase8-five-hour-fixture',
          });
        },
        getWeeklyQuota: () => Promise.resolve({
          window: 'weekly' as const,
          remainingRatio: 0.8,
          usedRatio: 0.2,
          resetAt: null,
          observedAt: fixture.driverDeps.clock!().toISOString(),
          source: 'phase8-five-hour-fixture',
        }),
      };
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Continue permitted Secondary work while Strong is cooling down.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {
        quotaTelemetryProvider: quota,
        onEvent: (event) => {
          if (event.kind === 'decision' && event.message.includes('no execution plan')) cooling = true;
        },
      });
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const nodeId = jobGraph.nodes[0]!.nodeId;
      const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId)!;
      const cooldown = readObjectiveCooldownState(fixture.workspace, job.jobId, nodeId);
      const events = readJobEvents(fixture.workspace, job.jobId, { limit: 2_000 }).events;

      expect(result.stop.kind).toBe('completed');
      expect(result.job.status).toBe('COMPLETED');
      expect(fixture.inferenceCalls()).toBe(2);
      expect(workGraph.units.filter((unit) => unit.kind === 'build').every(
        (unit) => unit.status === 'INTEGRATED' && unit.attempt === 1,
      )).toBe(true);
      expect(cooldown).toMatchObject({
        status: 'ACTIVE',
        completedDuringCooldown: ['wu-1', 'wu-2'],
        strongAttemptsAvoided: 0,
      });
      expect(events.some((event) => event.type === 'resource_cooldown_started')).toBe(true);
      expect(events.some((event) => event.type === 'useful_work_during_cooldown')).toBe(true);
      expect(events.some((event) => event.type === 'resource_wait_started')).toBe(false);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('enters durable resource wait under OFF only after every Strong-only candidate is removed', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({
        omitSecondarySelection: true,
        secondaryStrategy: 'OFF',
      });
      const observedAt = fixture.driverDeps.clock!().toISOString();
      const resetAt = new Date(Date.parse(observedAt) + 5 * 3_600_000).toISOString();
      let cooling = false;
      let recovered = false;
      const quota = {
        source: 'phase8-off-fixture',
        getFiveHourQuota: () => {
          const available = recovered || !cooling;
          return Promise.resolve({
            window: 'five-hour' as const,
            remainingRatio: available ? 1 : 0,
            usedRatio: available ? 0 : 1,
            resetAt: available ? null : resetAt,
            observedAt: fixture.driverDeps.clock!().toISOString(),
            source: 'phase8-off-fixture',
          });
        },
        getWeeklyQuota: () => Promise.resolve(null),
      };
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Respect OFF while Strong subscription is cooling down.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {
        quotaTelemetryProvider: quota,
        onEvent: (event) => {
          if (event.kind === 'decision' && event.message.includes('no execution plan')) cooling = true;
        },
      });
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const node = jobGraph.nodes[0]!;
      const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, node.nodeId)!;
      const cooldown = readObjectiveCooldownState(fixture.workspace, job.jobId, node.nodeId);

      expect(result.stop.kind).toBe('deferred');
      expect(result.job.status).toBe('WAITING_RESOURCE');
      expect(result.job.blocker).toBeUndefined();
      expect(result.job.operationalWait).toMatchObject({
        kind: 'SUBSCRIPTION_QUOTA_RESET',
        wakeAt: resetAt,
      });
      expect(readJobCheckpoint(fixture.workspace, job.jobId)?.operationalWait).toMatchObject({
        kind: 'SUBSCRIPTION_QUOTA_RESET',
        wakeAt: resetAt,
      });
      expect(fixture.inferenceCalls()).toBe(0);
      expect(workGraph.units.filter((unit) => unit.kind !== 'integration').every(
        (unit) => unit.status === 'READY' && unit.attempt === 0
          && unit.resourceWait?.resourceClass === 'STRONG_SUBSCRIPTION',
      )).toBe(true);
      expect(node.attempts.filter((attempt) => attempt.role === 'EXECUTOR')).toHaveLength(0);
      expect(readBuilderRoutingStates(fixture.workspace, job.jobId, node.nodeId)).toHaveLength(0);
      expect(cooldown?.strongAttemptsAvoided).toBeGreaterThan(0);

      recovered = true;
      clearOperationalState(fixture.driverDeps, job.jobId, {
        resolution: 'the supervisor observed the subscription reset',
      });
      const resumed = await driveJob(fixture.driverDeps, job.jobId, {
        quotaTelemetryProvider: quota,
      });
      const recoveredGraph = readLatestWorkGraph(fixture.workspace, job.jobId, node.nodeId)!;
      const recoveredState = readObjectiveCooldownState(fixture.workspace, job.jobId, node.nodeId);
      expect(resumed.stop.kind).toBe('completed');
      expect(recoveredGraph.units.filter((unit) => unit.kind !== 'integration').every(
        (unit) => unit.status === 'INTEGRATED' && unit.attempt === 1 && unit.resourceWait === undefined,
      )).toBe(true);
      expect(recoveredState).toMatchObject({ status: 'RECOVERED' });
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('preserves sticky Strong fallback and Secondary evidence across cooldown recovery', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({
        secondaryStrategy: 'PREFER',
        secondaryVerificationFails: true,
      });
      const observedAt = fixture.driverDeps.clock!().toISOString();
      const resetAt = new Date(Date.parse(observedAt) + 5 * 3_600_000).toISOString();
      let cooling = false;
      let recovered = false;
      const quota = {
        source: 'phase8-fallback-fixture',
        getFiveHourQuota: () => {
          const available = recovered || !cooling;
          return Promise.resolve({
            window: 'five-hour' as const,
            remainingRatio: available ? 1 : 0,
            usedRatio: available ? 0 : 1,
            resetAt: available ? null : resetAt,
            observedAt: fixture.driverDeps.clock!().toISOString(),
            source: 'phase8-fallback-fixture',
          });
        },
        getWeeklyQuota: () => Promise.resolve(null),
      };
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Preserve a bounded Secondary to Strong handoff through cooldown.',
      });
      const waiting = await driveJob(fixture.driverDeps, job.jobId, {
        quotaTelemetryProvider: quota,
        onEvent: (event) => {
          if (event.kind === 'decision' && event.message.includes('no execution plan')) cooling = true;
        },
      });
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, waiting.job.graphRevision);
      const nodeId = jobGraph.nodes[0]!.nodeId;
      const waitingGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId)!;
      const beforeRecovery = readBuilderRoutingStates(fixture.workspace, job.jobId, nodeId);

      expect(waiting.stop.kind).toBe('deferred');
      expect(waiting.job.status).toBe('WAITING_RESOURCE');
      expect(waitingGraph.units.filter((unit) => unit.kind === 'build').every(
        (unit) => unit.status === 'READY' && unit.attempt === 2
          && unit.resourceWait?.fallbackPending === true,
      )).toBe(true);
      expect(beforeRecovery).toHaveLength(2);
      expect(beforeRecovery.every((state) =>
        state.escalationStatus === 'STRONG_FALLBACK_REQUIRED'
        && state.repairAttemptsUsed === 1
        && state.attempts.map((attempt) => attempt.kind).join(',') === 'SECONDARY,SECONDARY_REPAIR',
      )).toBe(true);

      // Fresh process/supervisor cycle: only durable WorkGraph/routing files
      // survive. Recovery must not reopen the Secondary chain.
      recovered = true;
      clearOperationalState(fixture.driverDeps, job.jobId, {
        resolution: 'the supervisor observed the subscription reset',
      });
      const resumed = await driveJob(fixture.driverDeps, job.jobId, {
        quotaTelemetryProvider: quota,
      });
      const afterRecovery = readBuilderRoutingStates(fixture.workspace, job.jobId, nodeId);
      const completedGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId)!;

      expect(resumed.stop.kind).toBe('completed');
      expect(completedGraph.units.filter((unit) => unit.kind === 'build').every(
        (unit) => unit.status === 'INTEGRATED' && unit.attempt === 3
          && unit.resourceWait === undefined,
      )).toBe(true);
      expect(afterRecovery.every((state) =>
        state.repairAttemptsUsed === 1
        && state.attempts.at(-1)?.kind === 'STRONG_FALLBACK'
        && state.finalBackend === 'STRONG',
      )).toBe(true);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('turns an active Strong quota refusal into resource state without consuming implementation budget', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi-builder-quota';
    try {
      const fixture = secondaryMissionFixture({
        omitSecondarySelection: true,
        secondaryStrategy: 'OFF',
      });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Classify an active subscription refusal as resource availability.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const node = jobGraph.nodes[0]!;
      const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, node.nodeId)!;
      const cooldown = readObjectiveCooldownState(fixture.workspace, job.jobId, node.nodeId);

      expect(result.stop.kind).toBe('deferred');
      expect(result.job.status).toBe('WAITING_RESOURCE');
      expect(result.job.operationalWait).toMatchObject({ kind: 'PROVIDER_COOLDOWN' });
      expect(result.job.blocker).toBeUndefined();
      expect(node.attempts.filter((attempt) => attempt.role === 'EXECUTOR')).toHaveLength(0);
      expect(workGraph.units.filter((unit) => unit.kind !== 'integration').every(
        (unit) => unit.status === 'READY' && unit.attempt === 0
          && unit.latestFailure === undefined && unit.resourceWait !== undefined,
      )).toBe(true);
      expect(cooldown).toMatchObject({
        status: 'ACTIVE',
        lastAvailability: 'QUOTA_EXHAUSTED',
        // First call established cooldown; the later sibling was gated.
        strongAttemptsAvoided: 1,
      });
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('keeps OFF on the legacy Strong-only runtime without automatic Secondary work', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({
        omitSecondarySelection: true,
        secondaryStrategy: 'OFF',
      });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Qualify the Phase 7 OFF compatibility path.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      expect(result.stop.kind).toBe('completed');
      expect(fixture.inferenceCalls()).toBe(0);
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      expect(readBuilderRoutingStates(
        fixture.workspace,
        job.jobId,
        jobGraph.nodes[0]!.nodeId,
      )).toHaveLength(0);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('falls through from PREFER to Strong when automatic Secondary is unavailable', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({
        automaticContext: true,
        omitSecondarySelection: true,
        secondaryStrategy: 'PREFER',
      });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Qualify immediate Strong fallback when optional Secondary is unavailable.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      expect(result.stop.kind).toBe('completed');
      expect(fixture.inferenceCalls()).toBe(0);
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const states = readBuilderRoutingStates(
        fixture.workspace,
        job.jobId,
        jobGraph.nodes[0]!.nodeId,
      );
      expect(states).toHaveLength(2);
      expect(states.every((state) =>
        state.decisions[0]?.selectedBackend === 'STRONG'
        && state.decisions[0]?.reasons.some((reason) => reason.code === 'SECONDARY_UNAVAILABLE')
        && state.finalBackend === 'STRONG')).toBe(true);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('automatically compiles a fresh packet before the governed candidate lifecycle', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({ automaticContext: true });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise automatic Secondary Builder packet compilation.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      const graph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const attempts = readSecondaryBuilderAttempts(
        fixture.workspace,
        job.jobId,
        graph.nodes[0]!.nodeId,
      );
      expect(result.stop.kind).toBe('completed');
      expect(attempts).toHaveLength(2);
      expect(attempts.every((attempt) => attempt.packet.sourceContext.length > 0)).toBe(true);
      expect(attempts.every((attempt) => attempt.packet.targets.length === 1)).toBe(true);
      expect(attempts.every((attempt) => attempt.packet.retrievalPlanRefs.length > 0)).toBe(true);
      expect(attempts.every((attempt) => attempt.packet.quality.contextSufficient)).toBe(true);
      expect(attempts.every((attempt) => attempt.status === 'CANDIDATE_READY')).toBe(true);
      const workGraph = readLatestWorkGraph(
        fixture.workspace,
        job.jobId,
        graph.nodes[0]!.nodeId,
      )!;
      for (const unit of workGraph.units.filter((entry) => entry.kind === 'build')) {
        expect(readWorkReadinessRecord(
          fixture.workspace,
          job.jobId,
          graph.nodes[0]!.nodeId,
          unit.workUnitId,
          unit.attempt,
        )?.decision.status).toBe('ELIGIBLE');
      }
      expect(readWorkReadinessTelemetry(
        fixture.workspace,
        job.jobId,
        graph.nodes[0]!.nodeId,
      )).toMatchObject({
        assessmentCount: 2,
        statusCounts: { ELIGIBLE: 2 },
      });
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('records a non-eligible explicit attempt before inference without changing routing', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({ noVerification: true });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise Secondary readiness admission without trusted verification.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      const graph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const workGraph = readLatestWorkGraph(
        fixture.workspace,
        job.jobId,
        graph.nodes[0]!.nodeId,
      )!;
      const first = workGraph.units.find((unit) => unit.kind === 'build')!;
      const readiness = readWorkReadinessRecord(
        fixture.workspace,
        job.jobId,
        graph.nodes[0]!.nodeId,
        first.workUnitId,
        first.attempt,
      );
      expect(result.stop.kind).toBe('blocked');
      expect(fixture.inferenceCalls()).toBe(0);
      expect(readiness?.assessment.verificationStrength).toBe('NONE');
      expect(readiness?.decision.status).toBe('STRONG_REQUIRED');
      expect(readSecondaryBuilderAttempts(
        fixture.workspace,
        job.jobId,
        graph.nodes[0]!.nodeId,
      )).toHaveLength(0);
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

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
      const routing = readBuilderRoutingStates(fixture.workspace, job.jobId, node.nodeId);
      expect(routing).toHaveLength(2);
      expect(routing.every((state) => state.finalBackend === 'SECONDARY')).toBe(true);
      expect(readBuilderRoutingTelemetry(fixture.workspace, job.jobId, node.nodeId))
        .toMatchObject({
          eligibleCompletedUnits: 2,
          eligibleCompletedWithoutStrong: 2,
          strongBuilderAvoidanceRatio: 1,
        });
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('repairs once, detects repeated Secondary failure, and lets Strong continue the preserved candidate', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({
        secondaryStrategy: 'PREFER',
        secondaryVerificationFails: true,
      });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise bounded Secondary repair and Strong continuation.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const nodeId = jobGraph.nodes[0]!.nodeId;
      const workGraph = readLatestWorkGraph(fixture.workspace, job.jobId, nodeId)!;
      const diagnosticStates = readBuilderRoutingStates(fixture.workspace, job.jobId, nodeId);
      expect(
        result.stop.kind,
        JSON.stringify({
          stop: result.stop,
          jobStatus: result.job.status,
          units: workGraph.units.map((unit) => ({
            id: unit.workUnitId,
            status: unit.status,
            attempt: unit.attempt,
            failure: unit.latestFailure,
          })),
          routing: diagnosticStates.map((state) => ({
            workUnitId: state.workUnitId,
            identity: state.workIdentity.slice(0, 12),
            escalation: state.escalationStatus,
            decisions: state.decisions.map((decision) => ({
              attempt: decision.workUnitAttempt,
              backend: decision.selectedBackend,
              reasons: decision.reasons.map((reason) => reason.code),
            })),
            attempts: state.attempts.map((attempt) => ({
              attempt: attempt.workUnitAttempt,
              kind: attempt.kind,
              outcome: attempt.outcome,
              noProgress: attempt.noProgress,
            })),
          })),
        }, null, 2),
      ).toBe('completed');

      const buildUnits = workGraph.units.filter((unit) => unit.kind === 'build');
      expect(buildUnits.every((unit) => unit.attempt === 3 && unit.status === 'INTEGRATED')).toBe(true);
      expect(fixture.inferenceCalls()).toBe(4);

      const states = readBuilderRoutingStates(fixture.workspace, job.jobId, nodeId);
      expect(states).toHaveLength(2);
      for (const state of states) {
        expect(state.attempts.map((attempt) => [attempt.kind, attempt.outcome])).toEqual([
          ['SECONDARY', 'FAILED_VERIFICATION'],
          ['SECONDARY_REPAIR', 'FAILED_VERIFICATION'],
          ['STRONG_FALLBACK', 'SUCCEEDED'],
        ]);
        expect(state.attempts[1]?.noProgress).toBe(true);
        expect(state.repairAttemptsUsed).toBe(1);
        expect(state.finalBackend).toBe('STRONG');
      }
      expect(readBuilderRoutingTelemetry(fixture.workspace, job.jobId, nodeId)).toMatchObject({
        eligibleCompletedUnits: 2,
        eligibleCompletedWithoutStrong: 0,
        strongBuilderAvoidanceRatio: 0,
        repairAttempts: 2,
      });
      for (const unit of buildUnits) {
        expect(readCandidate(
          fixture.workspace,
          job.jobId,
          nodeId,
          unit.workUnitId,
          unit.attempt,
        )?.builderProvenance).toMatchObject({
          backend: 'LARGE_AGENT',
          routingAttemptKind: 'STRONG_FALLBACK',
        });
      }
      expect(readFileSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'), 'utf8'))
        .not.toContain('secondary');
      expect(readFileSync(path.join(fixture.root, 'src', 'transport', 'implementation.js'), 'utf8'))
        .not.toContain('secondary');
    } finally {
      if (priorScenario === undefined) delete process.env['FAKE_CLAUDE_SCENARIO'];
      else process.env['FAKE_CLAUDE_SCENARIO'] = priorScenario;
    }
  }, 300_000);

  it('widens Phase 5 context exactly once when Secondary requests more context', async () => {
    const priorScenario = process.env['FAKE_CLAUDE_SCENARIO'];
    process.env['FAKE_CLAUDE_SCENARIO'] = 'objective-multi';
    try {
      const fixture = secondaryMissionFixture({
        automaticContext: true,
        secondaryNeedsMoreContextOnce: true,
        secondaryStrategy: 'PREFER',
      });
      const job = createJob(fixture.driverDeps, {
        specName: 'steprelay-secondary',
        goal: 'Exercise one bounded Phase 7 context widening.',
      });
      const result = await driveJob(fixture.driverDeps, job.jobId, {});
      expect(result.stop.kind).toBe('completed');
      expect(fixture.inferenceCalls()).toBe(4);

      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const nodeId = jobGraph.nodes[0]!.nodeId;
      const attempts = readSecondaryBuilderAttempts(fixture.workspace, job.jobId, nodeId);
      expect(attempts).toHaveLength(4);
      for (const unitId of ['wu-1', 'wu-2']) {
        const chain = attempts
          .filter((attempt) => attempt.workUnitId === unitId)
          .sort((left, right) => left.attempt - right.attempt);
        expect(chain.map((attempt) => attempt.packet.expansion.level)).toEqual([
          'ADJACENT_DEPENDENCIES',
          'MODULE_CONTEXT',
        ]);
        expect(chain.map((attempt) => attempt.status)).toEqual(['CONTEXT_INSUFFICIENT', 'CANDIDATE_READY']);
      }
      const states = readBuilderRoutingStates(fixture.workspace, job.jobId, nodeId);
      expect(states).toHaveLength(2);
      expect(states.every((state) =>
        state.attempts.map((attempt) => attempt.kind).join(',') === 'SECONDARY,SECONDARY_REPAIR'
        && state.finalBackend === 'SECONDARY')).toBe(true);
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
      expect(readFileSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'), 'utf8'))
        .toContain('baseline');
      expect(readFileSync(path.join(fixture.root, 'src', 'transport', 'implementation.js'), 'utf8'))
        .toContain('baseline');

      const jobGraph = requireGraphRevision(fixture.workspace, job.jobId, result.job.graphRevision);
      const attempts = readSecondaryBuilderAttempts(fixture.workspace, job.jobId, jobGraph.nodes[0]!.nodeId);
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((attempt) => attempt.status === 'VERIFICATION_FAILED')).toBe(true);
      expect(attempts.every((attempt) => attempt.failure?.kind === 'VERIFICATION_FAILURE')).toBe(true);
      expect(attempts.every((attempt) => attempt.packet.sourceContext.length > 0)).toBe(true);
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
      expect(readFileSync(path.join(fixture.root, 'src', 'envelope', 'implementation.js'), 'utf8'))
        .toContain('baseline');
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
      expect(readFileSync(path.join(fixture.root, candidate.changedFiles[0]!.path), 'utf8'))
        .toContain('baseline');

      const resumed = await driveObjective({
        workspace: fixture.workspace,
        config: fixture.driverDeps.config,
        registry: fixture.driverDeps.registry,
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

      expect(readFileSync(path.join(fixture.root, candidate.changedFiles[0]!.path), 'utf8'))
        .toContain('baseline');
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
        registry: fixture.driverDeps.registry,
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
    mkdirSync(path.join(base.root, 'src'), { recursive: true });
    writeFileSync(
      path.join(base.root, 'src', 'mapper.ts'),
      'export interface UserDto { name: string }\nexport const mapUser = (name: string): UserDto => ({ name });\n',
      'utf8',
    );
    git(base.root, 'add', 'src/mapper.ts');
    git(base.root, 'commit', '-q', '-m', 'real packet qualification fixture');
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
      const compiled = await compileSecondaryBuilderPacket({
        workspace: base.workspace,
        config,
        jobId: 'job-real-secondary',
        objectiveNodeId: 'node-1',
        workUnit: workUnitSchema.parse({
          workUnitId: 'wu-1',
          objectiveNodeId: 'node-1',
          parentTaskId: '1',
          kind: 'build',
          title: 'Add id to UserDto mapper',
          goal: 'Update mapUser in src/mapper.ts to return id and name.',
          expectedArtifacts: ['src/mapper.ts'],
          expectedAreas: ['src'],
          status: 'READY',
        }),
        projection: projection(),
        attempt: 1,
        worktreeRoot: handle.dir,
        baselineRef: handle.baselineCommit,
        verificationHints: base.config.verification.commands.map((command) => command.name),
        maximumInputCharacters: 32_000,
        createdAt: '2026-08-30T00:00:00.000Z',
        persist: false,
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error(compiled.failure.reasons.join('; '));
      expect(compiled.metrics.selectedFiles).toBeGreaterThan(0);
      expect(compiled.packet.sourceContext.map((entry) => entry.path)).toContain('src/mapper.ts');
      const result = await executeSecondaryObjectiveBuilder({
        worktreeRoot: handle.dir,
        packet: compiled.packet,
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
