import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { readAgentConfig, resolveWorkspace } from '@specbridge/core';
import type {
  ConformanceCheckResult,
  ConformanceGroupRunner,
  RegisteredRunnerProfile,
  RunnerConformanceContext,
} from '@specbridge/runners';
import { RunnerRegistry, checkOperationSupport, validStageMarkdown } from '@specbridge/runners';
import { approveStage } from '@specbridge/workflow';
import { runApprovedTask } from './execute-task.js';
import { resumeRun } from './resume-run.js';
import {
  RUN_RECORD_SCHEMA_VERSION,
  createRun,
  writeRunArtifact,
} from './run-store.js';

/**
 * Execution-layer conformance groups (v0.6): task-execution and resume.
 *
 * These exercise the SHARED orchestration — approvals, clean-tree policy,
 * Git snapshots, trusted verification, evidence evaluation, verified-only
 * checkbox completion — against the profile under test, inside a scaffolded
 * throwaway workspace (never the user's repository).
 *
 * Provider-forced misbehavior scenarios (protected-path writes, false
 * claims) cannot be commanded from a real provider on demand; they are
 * exercised continuously by the fake-provider and mock-runner test suites,
 * and the orchestration protections they verify are provider-independent.
 */

export const CONFORMANCE_SPEC_NAME = 'conformance-fixture';

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function gitAvailable(root: string): boolean {
  try {
    execFileSync('git', ['--version'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scaffold a minimal approved-and-ready workspace for conformance runs:
 * steering, one spec with requirements/design/tasks approved through the
 * REAL approval flow, a git baseline commit, and a runner configuration.
 */
export function createConformanceWorkspace(
  root: string,
  profile: RegisteredRunnerProfile,
  options?: { verificationExit?: number },
): { workspace: WorkspaceInfo; config: AgentConfig; registry: RunnerRegistry } | { error: string } {
  const specDir = path.join(root, '.kiro', 'specs', CONFORMANCE_SPEC_NAME);
  mkdirSync(path.join(root, '.kiro', 'steering'), { recursive: true });
  mkdirSync(specDir, { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, '.kiro', 'steering', 'product.md'),
    '# Product\n\nConformance fixture workspace (throwaway).\n',
    'utf8',
  );
  writeFileSync(
    path.join(specDir, 'requirements.md'),
    validStageMarkdown('requirements', CONFORMANCE_SPEC_NAME, 'conformance'),
    'utf8',
  );
  writeFileSync(
    path.join(specDir, 'design.md'),
    validStageMarkdown('design', CONFORMANCE_SPEC_NAME, 'conformance'),
    'utf8',
  );
  writeFileSync(
    path.join(specDir, 'tasks.md'),
    validStageMarkdown('tasks', CONFORMANCE_SPEC_NAME, 'conformance'),
    'utf8',
  );
  writeFileSync(path.join(root, 'src', 'placeholder.txt'), 'conformance fixture\n', 'utf8');

  const verificationExit = options?.verificationExit ?? 0;
  const configFile = {
    schemaVersion: '2.0.0',
    defaultRunner: profile.name,
    runnerProfiles: { [profile.name]: { ...profile.config, enabled: true } },
    verification: {
      commands: [
        {
          name: 'conformance-verify',
          argv: [process.execPath, '-e', `process.exit(${verificationExit})`],
          timeoutMs: 60_000,
          required: true,
        },
      ],
    },
  };
  mkdirSync(path.join(root, '.specbridge'), { recursive: true });
  writeFileSync(
    path.join(root, '.specbridge', 'config.json'),
    `${JSON.stringify(configFile, null, 2)}\n`,
    'utf8',
  );

  if (!gitAvailable(root)) {
    return { error: 'git is unavailable; task-execution conformance needs a git repository' };
  }
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'conformance@specbridge.invalid');
  git(root, 'config', 'user.name', 'SpecBridge Conformance');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');

  const workspace = resolveWorkspace(root);
  if (workspace === undefined) {
    return { error: 'the scaffolded conformance workspace could not be resolved' };
  }
  const clock = (() => {
    let tick = 0;
    const start = new Date('2026-01-01T00:00:00.000Z').getTime();
    return () => new Date(start + 1000 * tick++);
  })();
  for (const stage of ['requirements', 'design', 'tasks'] as const) {
    const spec = analyzeSpec(workspace, requireSpec(workspace, CONFORMANCE_SPEC_NAME));
    const approval = approveStage(workspace, spec, { stage }, { clock });
    if (!approval.ok) {
      return { error: `conformance fixture approval of ${stage} failed: ${approval.message}` };
    }
  }
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'conformance baseline');

  const read = readAgentConfig(workspace);
  if (read.config === undefined) {
    return { error: 'the scaffolded conformance configuration is invalid' };
  }
  const registry = new RunnerRegistry();
  registry.registerProfile({
    name: profile.name,
    config: read.config.runnerProfiles[profile.name] ?? profile.config,
    runner: profile.runner,
  });
  return { workspace, config: read.config, registry };
}

const check = (
  group: ConformanceCheckResult['group'],
  id: string,
  title: string,
  status: ConformanceCheckResult['status'],
  detail?: string,
): ConformanceCheckResult => ({ id, group, title, status, ...(detail !== undefined ? { detail } : {}) });

/** Task-execution conformance: end-to-end shared orchestration. */
export const taskExecutionConformanceGroup: ConformanceGroupRunner = {
  group: 'task-execution',
  applicable: (context: RunnerConformanceContext) => {
    const support = checkOperationSupport(
      'task-execution',
      context.profile.runner.declaredCapabilities,
    );
    return support.supported
      ? { applicable: true }
      : {
          applicable: false,
          reason: `missing capabilities: ${[...support.missingCapabilities, ...support.unsatisfiedBoundaries.flat()].join(', ')}`,
        };
  },
  async run(context: RunnerConformanceContext) {
    if (!context.invocationsAllowed) {
      return [
        check(
          'task-execution',
          'task-execution.verified-flow',
          'verified evidence updates exactly one checkbox',
          'skipped',
          'requires provider invocation — rerun with --network (or a fake provider in CI)',
        ),
        check(
          'task-execution',
          'task-execution.failed-verifier',
          'a failed verifier leaves the checkbox unchanged',
          'skipped',
          'requires provider invocation — rerun with --network (or a fake provider in CI)',
        ),
      ];
    }
    const results: ConformanceCheckResult[] = [];

    // Scenario 1: passing verifier → verified evidence → one checkbox.
    {
      const root = path.join(context.workspaceRoot, 'task-verified');
      mkdirSync(root, { recursive: true });
      const fixture = createConformanceWorkspace(root, context.profile);
      if ('error' in fixture) {
        results.push(check('task-execution', 'task-execution.verified-flow', 'verified evidence updates exactly one checkbox', 'skipped', fixture.error));
      } else {
        const outcome = await runApprovedTask(
          { workspace: fixture.workspace, config: fixture.config, registry: fixture.registry },
          { specName: CONFORMANCE_SPEC_NAME, next: true },
        );
        const report = outcome.kind === 'executed' ? outcome.report : undefined;
        results.push(
          check(
            'task-execution',
            'task-execution.verified-flow',
            'verified evidence updates exactly one checkbox',
            report !== undefined && report.evidenceStatus === 'verified' && report.checkboxUpdated
              ? 'passed'
              : 'failed',
            report !== undefined
              ? `evidenceStatus=${report.evidenceStatus} checkboxUpdated=${report.checkboxUpdated}`
              : `outcome=${outcome.kind}${outcome.kind === 'preflight-failed' ? `: ${outcome.preflight.failure?.message ?? ''}` : ''}`,
          ),
        );
        results.push(
          check(
            'task-execution',
            'task-execution.claims-not-authority',
            'evidence comes from Git state and trusted verification, not provider claims',
            report !== undefined && report.verification.ran && report.changedFiles.length > 0
              ? 'passed'
              : 'failed',
            report !== undefined
              ? `verificationRan=${report.verification.ran} actualChangedFiles=${report.changedFiles.length}`
              : undefined,
          ),
        );
      }
    }

    // Scenario 2: failing verifier → checkbox unchanged, evidence retained.
    {
      const root = path.join(context.workspaceRoot, 'task-failing');
      mkdirSync(root, { recursive: true });
      const fixture = createConformanceWorkspace(root, context.profile, { verificationExit: 1 });
      if ('error' in fixture) {
        results.push(check('task-execution', 'task-execution.failed-verifier', 'a failed verifier leaves the checkbox unchanged', 'skipped', fixture.error));
      } else {
        const outcome = await runApprovedTask(
          { workspace: fixture.workspace, config: fixture.config, registry: fixture.registry },
          { specName: CONFORMANCE_SPEC_NAME, next: true },
        );
        const report = outcome.kind === 'executed' ? outcome.report : undefined;
        results.push(
          check(
            'task-execution',
            'task-execution.failed-verifier',
            'a failed verifier leaves the checkbox unchanged',
            report !== undefined && report.evidenceStatus !== 'verified' && !report.checkboxUpdated
              ? 'passed'
              : 'failed',
            report !== undefined
              ? `evidenceStatus=${report.evidenceStatus} checkboxUpdated=${report.checkboxUpdated}`
              : `outcome=${outcome.kind}`,
          ),
        );
      }
    }
    return results;
  },
};

/** Resume conformance: refusal paths are provider-independent and free. */
export const resumeConformanceGroup: ConformanceGroupRunner = {
  group: 'resume',
  applicable: (context: RunnerConformanceContext) => {
    const capabilities = context.profile.runner.declaredCapabilities;
    return capabilities.taskResume
      ? { applicable: true }
      : { applicable: false, reason: 'the runner declares no taskResume capability' };
  },
  async run(context: RunnerConformanceContext) {
    const results: ConformanceCheckResult[] = [];
    const root = path.join(context.workspaceRoot, 'resume-fixture');
    mkdirSync(root, { recursive: true });
    const fixture = createConformanceWorkspace(root, context.profile);
    if ('error' in fixture) {
      return [
        check('resume', 'resume.refusals', 'unsafe resumes are refused', 'skipped', fixture.error),
      ];
    }
    const deps = { workspace: fixture.workspace, config: fixture.config, registry: fixture.registry };

    // A verified run is never resumed.
    createRun(fixture.workspace, {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: 'conf-resume-verified',
      kind: 'task-execution',
      specName: CONFORMANCE_SPEC_NAME,
      taskId: '1',
      runner: context.profile.name,
      sessionId: 'conf-session-1',
      createdAt: new Date().toISOString(),
      resumeSupported: true,
      evidenceStatus: 'verified',
      outcome: 'completed',
      warnings: [],
    });
    const verifiedResume = await resumeRun(deps, { runId: 'conf-resume-verified' });
    results.push(
      check(
        'resume',
        'resume.refuses-verified',
        'a verified run is never resumed',
        verifiedResume.kind === 'refused' ? 'passed' : 'failed',
        `kind=${verifiedResume.kind}`,
      ),
    );

    // A run without an explicit provider session id is never resumed
    // ("latest session" guessing is not a thing).
    createRun(fixture.workspace, {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: 'conf-resume-no-session',
      kind: 'task-execution',
      specName: CONFORMANCE_SPEC_NAME,
      taskId: '1',
      runner: context.profile.name,
      createdAt: new Date().toISOString(),
      resumeSupported: false,
      evidenceStatus: 'failed',
      outcome: 'failed',
      warnings: [],
    });
    const sessionlessResume = await resumeRun(deps, { runId: 'conf-resume-no-session' });
    results.push(
      check(
        'resume',
        'resume.requires-explicit-session',
        'resume requires an explicit provider session id (no "latest" guessing)',
        sessionlessResume.kind === 'refused' ? 'passed' : 'failed',
        `kind=${sessionlessResume.kind}`,
      ),
    );

    // Divergence from the recorded post-run state blocks the resume.
    createRun(fixture.workspace, {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: 'conf-resume-diverged',
      kind: 'task-execution',
      specName: CONFORMANCE_SPEC_NAME,
      taskId: '1',
      runner: context.profile.name,
      sessionId: 'conf-session-2',
      createdAt: new Date().toISOString(),
      resumeSupported: true,
      evidenceStatus: 'failed',
      outcome: 'failed',
      warnings: [],
    });
    const fakeSnapshot = (entries: { path: string; status: string; contentHash?: string }[]) =>
      `${JSON.stringify({
        schemaVersion: '1.0.0',
        capturedAt: new Date().toISOString(),
        gitAvailable: true,
        head: 'recorded-head',
        detached: false,
        clean: entries.length === 0,
        entries,
        excludedPrefixes: [],
        protectedHashes: {},
        diagnostics: [],
      })}\n`;
    writeRunArtifact(fixture.workspace, 'conf-resume-diverged', 'git-before.json', fakeSnapshot([]));
    writeRunArtifact(
      fixture.workspace,
      'conf-resume-diverged',
      'git-after.json',
      fakeSnapshot([{ path: 'src/from-previous-session.txt', status: ' M', contentHash: 'deadbeef' }]),
    );
    const divergedResume = await resumeRun(deps, { runId: 'conf-resume-diverged' });
    results.push(
      check(
        'resume',
        'resume.blocks-divergence',
        'repository divergence blocks an unsafe resume',
        divergedResume.kind === 'refused' ? 'passed' : 'failed',
        `kind=${divergedResume.kind}`,
      ),
    );
    return results;
  },
};

export const EXECUTION_CONFORMANCE_GROUPS: ConformanceGroupRunner[] = [
  taskExecutionConformanceGroup,
  resumeConformanceGroup,
];
