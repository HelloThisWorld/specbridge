import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emptyTempDir } from './helpers';

/**
 * Programmatic template-pack fixtures. Building packs in temp directories
 * (instead of static fixture files) lets tests mutate manifests, inject
 * traversal paths, create symlinks, and produce oversized files without
 * checking hostile content into the repository.
 */

export interface PackFileMap {
  [relativePath: string]: string;
}

export function featureManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: 'sample-feature',
    version: '1.0.0',
    displayName: 'Sample Feature',
    description: 'A sample feature template used by tests.',
    kind: 'feature',
    supportedModes: ['requirements-first', 'quick'],
    defaultMode: 'requirements-first',
    tags: ['sample', 'testing'],
    files: [
      { source: 'files/requirements.md.template', target: 'requirements.md', stage: 'requirements', required: true },
      { source: 'files/design.md.template', target: 'design.md', stage: 'design', required: true },
      { source: 'files/tasks.md.template', target: 'tasks.md', stage: 'tasks', required: true },
    ],
    variables: [
      { name: 'actor', description: 'Primary actor.', type: 'string', required: false, default: 'user' },
    ],
    compatibility: { specbridge: '>=0.7.0 <1.0.0', kiroLayout: '1' },
    license: 'MIT',
    ...overrides,
  };
}

export function bugfixManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return featureManifest({
    id: 'sample-bugfix',
    displayName: 'Sample Bugfix',
    description: 'A sample bugfix template used by tests.',
    kind: 'bugfix',
    tags: ['sample', 'bugfix'],
    files: [
      { source: 'files/bugfix.md.template', target: 'bugfix.md', stage: 'bugfix', required: true },
      { source: 'files/design.md.template', target: 'design.md', stage: 'design', required: true },
      { source: 'files/tasks.md.template', target: 'tasks.md', stage: 'tasks', required: true },
    ],
    ...overrides,
  });
}

export function featurePackFiles(manifest: Record<string, unknown> = featureManifest()): PackFileMap {
  return {
    'specbridge-template.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'README.md': '# Sample Feature template\n\nUsage: specbridge template apply sample-feature --name my-spec\n',
    'files/requirements.md.template':
      '# Requirements Document\n\n## Introduction\n\n**{{title}}**\n\n{{description}}\n\n' +
      '## Requirements\n\n### Requirement 1: <initial requirement title>\n\n' +
      '**User Story:** As a {{actor}}, I want <capability>, so that <benefit>.\n\n' +
      '#### Acceptance Criteria\n\n1. WHEN <condition>, THE SYSTEM SHALL <behavior>.\n',
    'files/design.md.template':
      '# Design Document\n\n## Overview\n\n**{{title}}**\n\n{{description}}\n\n## Architecture\n\nDescribe the approach here.\n',
    'files/tasks.md.template': '# Implementation Plan\n\n- [ ] 1. Implement {{title}}.\n- [ ] 2. Add tests.\n',
  };
}

export function bugfixPackFiles(manifest: Record<string, unknown> = bugfixManifest()): PackFileMap {
  return {
    'specbridge-template.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'README.md': '# Sample Bugfix template\n\nUsage: specbridge template apply sample-bugfix --name my-fix\n',
    'files/bugfix.md.template':
      '# Bugfix Document\n\n## Summary\n\n**{{title}}**\n\n{{description}}\n\n' +
      '## Current Behavior\n\nDescribe the incorrect behavior here.\n\n## Expected Behavior\n\nDescribe the correct behavior here.\n',
    'files/design.md.template': '# Fix Design\n\n## Root Cause\n\nDocument the root cause here.\n',
    'files/tasks.md.template': '# Bugfix Implementation Plan\n\n- [ ] 1. Reproduce the bug.\n- [ ] 2. Fix it.\n',
  };
}

/** Write a pack file map into a directory, creating parents as needed. */
export function writePack(dir: string, files: PackFileMap): string {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/** A fresh temp directory containing the given pack. */
export function tempPack(files: PackFileMap): string {
  const dir = path.join(emptyTempDir(), 'pack');
  mkdirSync(dir, { recursive: true });
  return writePack(dir, files);
}

/**
 * Try to create a symlink; returns false when the platform forbids it
 * (Windows without developer mode). Tests should skip in that case.
 */
export function tryCreateSymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

/** A workspace root containing an empty `.kiro` directory. */
export function freshKiroWorkspace(): string {
  const root = emptyTempDir();
  mkdirSync(path.join(root, '.kiro'), { recursive: true });
  return root;
}
