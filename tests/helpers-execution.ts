import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, MockScenario, WorkspaceInfo } from '@specbridge/core';
import { readAgentConfig, resolveWorkspace } from '@specbridge/core';
import { analyzeSpec, requireSpec } from '@specbridge/compat-kiro';
import { approveStage } from '@specbridge/workflow';
import type { RunnerRegistry } from '@specbridge/runners';
import { createDefaultRunnerRegistry } from '@specbridge/runners';
import { copyFixtureToTemp, fixturePath } from './helpers.js';

/**
 * Shared setup for v0.3 execution tests: a git-committed copy of the
 * `v03-ready-feature` fixture with all three stages approved through the
 * real approval flow (so hashes are exact) and a validated runner config.
 * Fully offline; the fake Claude CLI is a local node script.
 */

export const EXECUTION_SPEC = 'settings-persistence';

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

export function initGitRepo(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@specbridge.invalid');
  git(root, 'config', 'user.name', 'SpecBridge Tests');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'fixture baseline');
}

/** node one-liners so verification needs no shell and no project deps. */
export function passingCommand(name = 'test', required = true): Record<string, unknown> {
  return { name, argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60_000, required };
}

export function failingCommand(name = 'test', required = true): Record<string, unknown> {
  return { name, argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 60_000, required };
}

/** Monotonic test clock: +1s per call, deterministic ISO timestamps. */
export function tickingClock(startIso = '2026-07-12T10:00:00.000Z'): () => Date {
  let tick = 0;
  const start = new Date(startIso).getTime();
  return () => new Date(start + 1000 * tick++);
}

/** Deterministic id factory: run-000001, run-000002, … */
export function idCounter(prefix = 'id'): () => string {
  let counter = 0;
  return () => `${prefix}-${String(++counter).padStart(6, '0')}`;
}

export const FAKE_CLAUDE_PATH = fixturePath('fake-claude', 'fake-claude.mjs');

export interface ExecutionFixtureOptions {
  scenario?: MockScenario;
  /** Verification command objects for config.json (default: one passing). */
  verificationCommands?: Record<string, unknown>[];
  execution?: Record<string, unknown>;
  /** Approve all stages through the real flow (default true). */
  approve?: boolean;
  /** Use the fake Claude CLI as the claude-code runner executable. */
  useFakeClaude?: boolean;
  defaultRunner?: string;
  extraConfig?: Record<string, unknown>;
}

export interface ExecutionFixture {
  root: string;
  workspace: WorkspaceInfo;
  config: AgentConfig;
  registry: RunnerRegistry;
  specName: string;
  clock: () => Date;
  idFactory: () => string;
  deps: {
    workspace: WorkspaceInfo;
    config: AgentConfig;
    registry: RunnerRegistry;
    clock: () => Date;
    idFactory: () => string;
  };
}

export function approveAllStages(workspace: WorkspaceInfo, specName: string, clock: () => Date): void {
  for (const stage of ['requirements', 'design', 'tasks'] as const) {
    const spec = analyzeSpec(workspace, requireSpec(workspace, specName));
    const result = approveStage(workspace, spec, { stage }, { clock });
    if (!result.ok) {
      throw new Error(`fixture approval of ${stage} failed: ${result.message}`);
    }
  }
}

export function writeFixtureConfig(root: string, options: ExecutionFixtureOptions): void {
  const config = {
    schemaVersion: '1.0.0',
    defaultRunner: options.defaultRunner ?? 'mock',
    runners: {
      mock: {
        enabled: true,
        scenario: options.scenario ?? 'success',
        changeFile: 'src/mock-change.txt',
      },
      ...(options.useFakeClaude === true
        ? {
            'claude-code': {
              enabled: true,
              command: process.execPath,
              commandArgs: [FAKE_CLAUDE_PATH],
              timeoutMs: 60_000,
              maxTurns: 5,
            },
          }
        : {}),
    },
    verification: {
      commands: options.verificationCommands ?? [passingCommand()],
    },
    execution: options.execution ?? {},
    ...(options.extraConfig ?? {}),
  };
  mkdirSync(path.join(root, '.specbridge'), { recursive: true });
  writeFileSync(path.join(root, '.specbridge', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function setupExecutionFixture(options: ExecutionFixtureOptions = {}): ExecutionFixture {
  const root = copyFixtureToTemp('v03-ready-feature');
  initGitRepo(root);
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('fixture has no .kiro workspace');
  const clock = tickingClock();
  if (options.approve !== false) {
    approveAllStages(workspace, EXECUTION_SPEC, clock);
  }
  writeFixtureConfig(root, options);
  const read = readAgentConfig(workspace);
  if (read.config === undefined) {
    throw new Error(`fixture config invalid: ${read.diagnostics.map((d) => d.message).join('; ')}`);
  }
  const registry = createDefaultRunnerRegistry(read.config);
  const idFactory = idCounter('run');
  return {
    root,
    workspace,
    config: read.config,
    registry,
    specName: EXECUTION_SPEC,
    clock,
    idFactory,
    deps: { workspace, config: read.config, registry, clock, idFactory },
  };
}
