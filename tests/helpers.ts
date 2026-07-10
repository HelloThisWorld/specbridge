import { cpSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to a fixture workspace (tests/fixtures/<name>). */
export function fixturePath(...segments: string[]): string {
  return path.join(testsDir, 'fixtures', ...segments);
}

/** Absolute path to an example workspace (examples/<name>). */
export function examplePath(...segments: string[]): string {
  return path.join(testsDir, '..', 'examples', ...segments);
}

/**
 * Copy a fixture into a fresh temp directory so tests can write safely.
 * Returns the temp workspace root. Vitest workers clean tmp dirs lazily;
 * the OS temp dir handles the rest.
 */
export function copyFixtureToTemp(fixtureName: string): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'specbridge-test-'));
  cpSync(fixturePath(fixtureName), tempRoot, { recursive: true });
  return tempRoot;
}

/** A temp directory guaranteed to contain no `.kiro` anywhere upward. */
export function emptyTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'specbridge-empty-'));
}
