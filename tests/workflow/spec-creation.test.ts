import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@specbridge/core';
import { SpecBridgeError, resolveWorkspace } from '@specbridge/core';
import {
  createSpec,
  executeSpecCreation,
  planSpecCreation,
  titleFromSpecName,
  validateSpecName,
} from '@specbridge/workflow';
import { copyFixtureToTemp, emptyTempDir, fixedClock } from '../helpers.js';

function freshWorkspace(): WorkspaceInfo {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro'), { recursive: true });
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('workspace setup failed');
  return workspace;
}

describe('spec name validation', () => {
  it.each(['notification-preferences', 'auth-v2', 'payment-retry', 'a', 'x1'])(
    'accepts %s',
    (name) => {
      expect(validateSpecName(name).valid).toBe(true);
    },
  );

  it.each([
    'NotificationPreferences',
    'notification_preferences',
    '../notification',
    'notification/',
    '-payment',
    'payment-',
    'payment--retry',
    'has space',
    '',
    '..',
    'C:\\absolute',
    '/absolute',
    'a'.repeat(101),
    'nul',
    'con',
  ])('rejects %j with an explanation', (name) => {
    const result = validateSpecName(name);
    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('derives a readable default title from the name', () => {
    expect(titleFromSpecName('notification-preferences')).toBe('Notification Preferences');
    expect(titleFromSpecName('auth-v2')).toBe('Auth V2');
  });
});

describe('spec creation', () => {
  it('creates a requirements-first feature spec (test 1)', () => {
    const workspace = freshWorkspace();
    const result = createSpec(
      workspace,
      { name: 'notification-preferences', mode: 'requirements-first' },
      fixedClock,
    );
    const dir = path.join(workspace.rootDir, '.kiro', 'specs', 'notification-preferences');
    expect(readdirSync(dir).sort()).toEqual(['design.md', 'requirements.md', 'tasks.md']);
    const requirements = readFileSync(path.join(dir, 'requirements.md'), 'utf8');
    expect(requirements).toContain('# Requirements Document');
    expect(requirements).toContain('**User Story:** As a <role>, I want <capability>, so that <benefit>.');
    expect(requirements).toContain('WHEN <condition or event>, THE SYSTEM SHALL <expected behavior>.');
    const design = readFileSync(path.join(dir, 'design.md'), 'utf8');
    expect(design).toContain('> Status: Pending requirements approval.');
    expect(result.plan.state.status).toBe('REQUIREMENTS_DRAFT');
    expect(result.plan.state.origin).toBe('created-by-specbridge');
    // No SpecBridge metadata inside .kiro files.
    for (const file of ['requirements.md', 'design.md', 'tasks.md']) {
      expect(readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/specbridge/i);
      expect(readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/^---/);
    }
  });

  it('creates a design-first feature spec (test 2)', () => {
    const workspace = freshWorkspace();
    const result = createSpec(workspace, { name: 'export-pipeline', mode: 'design-first' }, fixedClock);
    const dir = result.plan.dir;
    expect(readFileSync(path.join(dir, 'design.md'), 'utf8')).toContain('## Alternatives Considered');
    expect(readFileSync(path.join(dir, 'requirements.md'), 'utf8')).toContain(
      '> Status: Pending design review.',
    );
    expect(result.plan.state.status).toBe('DESIGN_DRAFT');
    expect(Object.keys(result.plan.state.stages)).toEqual(['design', 'requirements', 'tasks']);
  });

  it('creates a quick feature spec with all three documents active (test 3)', () => {
    const workspace = freshWorkspace();
    const result = createSpec(workspace, { name: 'healthcheck', mode: 'quick' }, fixedClock);
    expect(result.plan.state.status).toBe('READY_FOR_REVIEW');
    expect(result.plan.state.stages.requirements?.status).toBe('draft');
    expect(result.plan.state.stages.design?.status).toBe('draft');
    expect(result.plan.state.stages.tasks?.status).toBe('blocked');
    const tasks = readFileSync(path.join(result.plan.dir, 'tasks.md'), 'utf8');
    expect(tasks).toContain('Review and refine requirements.');
    expect(tasks).toContain('Add automated tests for acceptance criteria.');
  });

  it('creates a bugfix spec with bugfix.md instead of requirements.md (test 4)', () => {
    const workspace = freshWorkspace();
    const result = createSpec(
      workspace,
      { name: 'cache-fallback', specType: 'bugfix', description: 'Fix stale cache fallback after upstream timeout' },
      fixedClock,
    );
    expect(readdirSync(result.plan.dir).sort()).toEqual(['bugfix.md', 'design.md', 'tasks.md']);
    const bugfix = readFileSync(path.join(result.plan.dir, 'bugfix.md'), 'utf8');
    expect(bugfix).toContain('# Bugfix Document');
    expect(bugfix).toContain('Fix stale cache fallback after upstream timeout');
    expect(bugfix).toContain('## Unchanged Behavior');
    expect(result.plan.state.status).toBe('BUGFIX_DRAFT');
    expect(Object.keys(result.plan.state.stages)).toEqual(['bugfix', 'design', 'tasks']);
  });

  it('rejects invalid names with all reasons listed (test 5)', () => {
    const workspace = freshWorkspace();
    expect(() => planSpecCreation(workspace, { name: 'Payment_Retry' }, fixedClock)).toThrowError(
      /underscores[\s\S]*lowercase/i,
    );
  });

  it('rejects path traversal in names (test 6)', () => {
    const workspace = freshWorkspace();
    for (const name of ['../escape', 'a/../../b', '..', 'sub/dir']) {
      expect(() => planSpecCreation(workspace, { name }, fixedClock)).toThrowError(SpecBridgeError);
    }
    expect(existsSync(path.join(workspace.rootDir, 'escape'))).toBe(false);
  });

  it('refuses to overwrite an existing spec and lists its files (test 7)', () => {
    const root = copyFixtureToTemp('v02-existing-kiro-no-state');
    const workspace = resolveWorkspace(root);
    if (workspace === undefined) throw new Error('workspace setup failed');
    try {
      planSpecCreation(workspace, { name: 'user-authentication' }, fixedClock);
      expect.unreachable('should have thrown');
    } catch (error) {
      const specError = error as SpecBridgeError;
      expect(specError.code).toBe('SPEC_ALREADY_EXISTS');
      expect(specError.message).toContain('requirements.md');
      expect(specError.message).toContain('spec show user-authentication');
    }
    // Nothing was modified.
    expect(readdirSync(path.join(root, '.kiro', 'specs', 'user-authentication')).sort()).toEqual([
      'design.md',
      'requirements.md',
      'tasks.md',
    ]);
  });

  it('dry-run planning writes nothing (test 8)', () => {
    const workspace = freshWorkspace();
    const plan = planSpecCreation(workspace, { name: 'dry-run-spec', mode: 'quick' }, fixedClock);
    expect(plan.files).toHaveLength(3);
    expect(plan.state.createdAt).toBe('2026-07-12T10:00:00.000Z');
    expect(existsSync(plan.dir)).toBe(false);
    expect(existsSync(path.join(workspace.rootDir, '.specbridge'))).toBe(false);
    expect(existsSync(path.join(workspace.rootDir, '.kiro', 'specs'))).toBe(false);
  });

  it('inserts --description into the first document (test 9)', () => {
    const workspace = freshWorkspace();
    const description = 'Allow users to choose email and push notification preferences.';
    const result = createSpec(workspace, { name: 'notification-preferences', description }, fixedClock);
    const requirements = readFileSync(path.join(result.plan.dir, 'requirements.md'), 'utf8');
    expect(requirements).toContain(description);
    expect(requirements).toContain('**Notification Preferences**');
  });

  it('loads the description from --from-file (test 10)', () => {
    const workspace = freshWorkspace();
    writeFileSync(path.join(workspace.rootDir, 'description.md'), 'Retry failed payments with backoff.\n');
    const result = createSpec(
      workspace,
      { name: 'payment-retry', fromFile: 'description.md', cwd: workspace.rootDir },
      fixedClock,
    );
    expect(readFileSync(path.join(result.plan.dir, 'requirements.md'), 'utf8')).toContain(
      'Retry failed payments with backoff.',
    );
  });

  it('preserves UTF-8 description content byte-exactly (test 11)', () => {
    const workspace = freshWorkspace();
    const description = 'Préférences de notification — почтовые уведомления (δ-tests).';
    writeFileSync(path.join(workspace.rootDir, 'desc.md'), `${description}\n`, 'utf8');
    const result = createSpec(
      workspace,
      { name: 'localized-feature', fromFile: 'desc.md', cwd: workspace.rootDir },
      fixedClock,
    );
    expect(readFileSync(path.join(result.plan.dir, 'requirements.md'), 'utf8')).toContain(description);
  });

  it('rejects conflicting description inputs (test 12)', () => {
    const workspace = freshWorkspace();
    writeFileSync(path.join(workspace.rootDir, 'desc.md'), 'text');
    expect(() =>
      planSpecCreation(
        workspace,
        { name: 'x-spec', description: 'inline', fromFile: 'desc.md', cwd: workspace.rootDir },
        fixedClock,
      ),
    ).toThrowError(/either --description or --from-file/);
  });

  it('rejects description files outside the workspace, directories, and oversized files', () => {
    const workspace = freshWorkspace();
    const outside = emptyTempDir();
    writeFileSync(path.join(outside, 'desc.md'), 'outside');
    expect(() =>
      planSpecCreation(
        workspace,
        { name: 'a-spec', fromFile: path.join(outside, 'desc.md'), cwd: workspace.rootDir },
        fixedClock,
      ),
    ).toThrowError(/outside the workspace/);

    mkdirSync(path.join(workspace.rootDir, 'a-directory'));
    expect(() =>
      planSpecCreation(
        workspace,
        { name: 'a-spec', fromFile: 'a-directory', cwd: workspace.rootDir },
        fixedClock,
      ),
    ).toThrowError(/directory/);

    writeFileSync(path.join(workspace.rootDir, 'big.md'), 'x'.repeat(64));
    expect(() =>
      planSpecCreation(
        workspace,
        { name: 'a-spec', fromFile: 'big.md', cwd: workspace.rootDir, maxDescriptionBytes: 16 },
        fixedClock,
      ),
    ).toThrowError(/too large/);

    writeFileSync(path.join(workspace.rootDir, 'bad.md'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
    expect(() =>
      planSpecCreation(
        workspace,
        { name: 'a-spec', fromFile: 'bad.md', cwd: workspace.rootDir },
        fixedClock,
      ),
    ).toThrowError(/not valid UTF-8/);
  });

  it('a failed state write rolls the whole creation back (test 13)', () => {
    const workspace = freshWorkspace();
    const plan = planSpecCreation(workspace, { name: 'doomed-spec' }, fixedClock);
    // Occupy the sidecar state path with a directory so the state write fails.
    mkdirSync(plan.statePath, { recursive: true });
    expect(() => executeSpecCreation(workspace, plan)).toThrowError();
    expect(existsSync(plan.dir)).toBe(false);
    const tmpDir = path.join(workspace.sidecarDir, 'tmp');
    expect(!existsSync(tmpDir) || readdirSync(tmpDir).length === 0).toBe(true);
  });

  it('a rename collision leaves no partial directory or temp files', () => {
    const workspace = freshWorkspace();
    const plan = planSpecCreation(workspace, { name: 'raced-spec' }, fixedClock);
    // Another process creates the spec between planning and execution.
    mkdirSync(plan.dir, { recursive: true });
    writeFileSync(path.join(plan.dir, 'existing.md'), 'kept');
    expect(() => executeSpecCreation(workspace, plan)).toThrowError(/already exists/);
    expect(readdirSync(plan.dir)).toEqual(['existing.md']);
    const tmpDir = path.join(workspace.sidecarDir, 'tmp');
    expect(!existsSync(tmpDir) || readdirSync(tmpDir).length === 0).toBe(true);
  });
});
