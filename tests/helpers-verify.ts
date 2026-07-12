import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SpecWorkflowState, WorkspaceInfo } from '@specbridge/core';
import { readSpecState, resolveWorkspace, stateStage } from '@specbridge/core';
import { MarkdownDocument, parseTasks, taskFingerprint, taskPlanHash } from '@specbridge/compat-kiro';
import type { EvidenceSpecContext, TaskEvidenceRecord } from '@specbridge/evidence';
import { EVIDENCE_SCHEMA_VERSION, writeTaskEvidence } from '@specbridge/evidence';
import type { VerificationPolicy, VerifySpecsRequest, VerifySpecsResult } from '@specbridge/drift';
import { verifySpecs } from '@specbridge/drift';
import { copyFixtureToTemp } from './helpers.js';
import {
  EXECUTION_SPEC,
  approveAllStages,
  git,
  initGitRepo,
  tickingClock,
  writeFixtureConfig,
} from './helpers-execution.js';

/**
 * Shared setup for v0.4 verification tests: a git-committed copy of the
 * `v03-ready-feature` fixture with optional approvals, evidence records,
 * verification policies, and file edits. Fully offline and deterministic.
 */

export const VERIFY_SPEC = EXECUTION_SPEC;

export interface VerifyFixtureOptions {
  /** Approve all stages through the real flow (default true). */
  approve?: boolean;
  /** Write a `.specbridge/config.json` (default: none — defaults apply). */
  config?: {
    verificationCommands?: Record<string, unknown>[];
    execution?: Record<string, unknown>;
  };
  /** Commit everything (including approvals/config) as the baseline. */
  commitBaseline?: boolean;
}

export interface VerifyFixture {
  root: string;
  workspace: WorkspaceInfo;
  specName: string;
  clock: () => Date;
  /** Write a workspace-relative file (creates directories). */
  write: (relative: string, content: string) => void;
  /** Read a workspace-relative file. */
  read: (relative: string) => string;
  /** Stage and commit everything. */
  commit: (message: string) => void;
  /** Current HEAD SHA. */
  head: () => string;
  /** Flip one task checkbox from `[ ]` to `[x]` by editing the raw line. */
  checkTask: (taskId: string) => void;
  /** Write a verification policy for the spec. */
  writePolicy: (policy: Partial<VerificationPolicy> & Record<string, unknown>) => string;
  /** Persist a verified evidence record with a current specContext. */
  writeVerifiedEvidence: (
    taskId: string,
    overrides?: Partial<TaskEvidenceRecord> & Record<string, unknown>,
  ) => TaskEvidenceRecord;
  /** Run verifySpecs with fixture defaults. */
  verify: (
    overrides?: Partial<Omit<VerifySpecsRequest, 'workspace'>>,
  ) => Promise<VerifySpecsResult>;
}

let evidenceCounter = 0;

export function currentSpecContext(
  workspace: WorkspaceInfo,
  specName: string,
  taskId: string,
): EvidenceSpecContext {
  const state: SpecWorkflowState | undefined = readSpecState(workspace, specName).state;
  const tasksPath = path.join(workspace.rootDir, '.kiro', 'specs', specName, 'tasks.md');
  const document = MarkdownDocument.load(tasksPath);
  const model = parseTasks(document);
  const task = model.allTasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error(`fixture: task ${taskId} not found in tasks.md`);

  const specContext: EvidenceSpecContext = {
    taskFingerprint: taskFingerprint(task),
    taskText: document.lineAt(task.line).text,
  };
  if (state !== undefined) {
    const documentStage = stateStage(state, state.specType === 'bugfix' ? 'bugfix' : 'requirements');
    if (documentStage?.approvedHash != null) specContext.documentHash = documentStage.approvedHash;
    const designStage = stateStage(state, 'design');
    if (designStage?.approvedHash != null) specContext.designHash = designStage.approvedHash;
    const tasksStage = stateStage(state, 'tasks');
    if (tasksStage?.status === 'approved') {
      specContext.tasksPlanHash =
        typeof tasksStage.approvedPlanHash === 'string'
          ? tasksStage.approvedPlanHash
          : taskPlanHash(document);
    }
  }
  return specContext;
}

export function setupVerifyFixture(options: VerifyFixtureOptions = {}): VerifyFixture {
  const root = copyFixtureToTemp('v03-ready-feature');
  initGitRepo(root);
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('fixture has no .kiro workspace');
  const clock = tickingClock();

  if (options.approve !== false) {
    approveAllStages(workspace, VERIFY_SPEC, clock);
  }
  if (options.config !== undefined) {
    writeFixtureConfig(root, {
      verificationCommands: options.config.verificationCommands ?? [],
      ...(options.config.execution !== undefined ? { execution: options.config.execution } : {}),
    });
  }

  const write = (relative: string, content: string): void => {
    const absolute = path.join(root, relative.split('/').join(path.sep));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };
  const read = (relative: string): string =>
    readFileSync(path.join(root, relative.split('/').join(path.sep)), 'utf8');
  const commit = (message: string): void => {
    git(root, 'add', '-A');
    // Tolerate a clean tree so scenario builders can commit unconditionally.
    if (git(root, 'status', '--porcelain').trim() !== '') {
      git(root, 'commit', '-q', '-m', message);
    }
  };
  const head = (): string => git(root, 'rev-parse', 'HEAD').trim();

  if (options.commitBaseline !== false) {
    commit('verification baseline');
  }

  const checkTask = (taskId: string): void => {
    const relative = `.kiro/specs/${VERIFY_SPEC}/tasks.md`;
    const document = MarkdownDocument.load(path.join(root, relative.split('/').join(path.sep)));
    const model = parseTasks(document);
    const task = model.allTasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) throw new Error(`fixture: task ${taskId} not found`);
    const line = document.lineAt(task.line).text;
    document.setLineText(task.line, line.replace('- [ ]', '- [x]'));
    write(relative, document.serialize());
  };

  const writePolicy = (
    policy: Partial<VerificationPolicy> & Record<string, unknown>,
  ): string => {
    const relative = `.specbridge/policies/${VERIFY_SPEC}.json`;
    write(
      relative,
      `${JSON.stringify(
        { schemaVersion: '1.0.0', specName: VERIFY_SPEC, ...policy },
        null,
        2,
      )}\n`,
    );
    return relative;
  };

  const writeVerifiedEvidence = (
    taskId: string,
    overrides: Partial<TaskEvidenceRecord> & Record<string, unknown> = {},
  ): TaskEvidenceRecord => {
    evidenceCounter += 1;
    const headSha = head();
    const record: TaskEvidenceRecord = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId: `verify-fixture-${String(evidenceCounter).padStart(4, '0')}`,
      specName: VERIFY_SPEC,
      taskId,
      status: 'verified',
      runner: 'mock',
      repository: {
        headBefore: headSha,
        headAfter: headSha,
        branch: 'main',
        dirtyBefore: false,
        dirtyAfter: true,
      },
      changedFiles: [
        { path: 'src/settings.txt', changeType: 'modified', preExisting: true, modifiedDuringRun: true },
      ],
      verificationCommands: [
        { name: 'test', argv: [process.execPath, '-e', '0'], required: true, exitCode: 0, durationMs: 10, passed: true },
      ],
      verificationSkipped: false,
      runnerClaims: { changedFiles: [], commandsReported: [], testsReported: [] },
      violations: [],
      warnings: [],
      evaluatedAt: clock().toISOString(),
      specContext: currentSpecContext(workspace, VERIFY_SPEC, taskId),
      ...overrides,
    };
    writeTaskEvidence(workspace, record);
    return record;
  };

  const verify = async (
    overrides: Partial<Omit<VerifySpecsRequest, 'workspace'>> = {},
  ): Promise<VerifySpecsResult> =>
    verifySpecs({
      workspace,
      selection: { mode: 'single', spec: VERIFY_SPEC },
      comparison: { mode: 'working-tree' },
      failOn: 'error',
      toolVersion: '0.4.0-test',
      clock,
      idFactory: () => `verification-${VERIFY_SPEC}`,
      ...overrides,
    });

  return {
    root,
    workspace,
    specName: VERIFY_SPEC,
    clock,
    write,
    read,
    commit,
    head,
    checkTask,
    writePolicy,
    writeVerifiedEvidence,
    verify,
  };
}

/** Every diagnostic (global + per spec) of a verification result. */
export function allDiagnostics(
  result: VerifySpecsResult,
): VerifySpecsResult['report']['globalDiagnostics'] {
  return [
    ...result.report.globalDiagnostics,
    ...result.report.specResults.flatMap((spec) => spec.diagnostics),
  ];
}

export function ruleIds(result: VerifySpecsResult): string[] {
  return allDiagnostics(result).map((diagnostic) => diagnostic.ruleId);
}
