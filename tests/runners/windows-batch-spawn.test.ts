import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSafeProcess } from '@specbridge/runners';

/**
 * Regression: Windows batch wrappers must be runnable.
 *
 * Found by the vNext.10 StepRelay dogfood. Since Node 20.12 / 22
 * (CVE-2024-27980) `spawn` without a shell rejects `.bat` and `.cmd` with
 * EINVAL — a correct security fix that silently made the obvious Windows
 * verification command impossible:
 *
 *   "argv": ["./gradlew.bat", "test"]     spawn-failed
 *   "argv": ["./mvnw.cmd", "verify"]      spawn-failed
 *
 * The dogfood's builder recorded `spawn-failed` for BOTH trusted verification
 * commands on every attempt, the objective evaluation read that as a failing
 * build, and the runtime spent three repair/replan cycles rewriting code that
 * had never been tested.
 *
 * The fix routes a resolved `.bat`/`.cmd` through cmd.exe with a command line
 * SpecBridge builds itself — every element a discrete quoted token, so no
 * argument can become an operator, and never Node's `shell: true`, which
 * would interpret the arguments as a shell string.
 *
 * Windows-only by nature; the suite skips elsewhere rather than pretending.
 */

const windows = process.platform === 'win32';

function batchFixture(body: string, extension = '.bat'): { dir: string; name: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'specbridge-batch-'));
  const name = `runner${extension}`;
  writeFileSync(path.join(dir, name), `@echo off\r\n${body}\r\n`, 'utf8');
  chmodSync(path.join(dir, name), 0o755);
  return { dir, name };
}

describe.skipIf(!windows)('windows batch wrappers', () => {
  it('runs a .bat wrapper and reports ok', async () => {
    const { dir, name } = batchFixture('echo hello-from-batch');
    const result = await runSafeProcess({
      executable: `./${name}`,
      argv: [],
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe('ok');
    expect(result.stdout).toContain('hello-from-batch');
  });

  it('runs a .cmd wrapper too', async () => {
    const { dir, name } = batchFixture('echo hello-from-cmd', '.cmd');
    const result = await runSafeProcess({
      executable: `./${name}`,
      argv: [],
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe('ok');
    expect(result.stdout).toContain('hello-from-cmd');
  });

  it('passes arguments through as discrete tokens', async () => {
    const { dir, name } = batchFixture('echo [%1] [%2]');
    const result = await runSafeProcess({
      executable: `./${name}`,
      argv: ['first arg', 'second'],
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe('ok');
    expect(result.stdout).toContain('first arg');
    expect(result.stdout).toContain('second');
  });

  it('an argument containing shell metacharacters stays an ARGUMENT', async () => {
    const { dir, name } = batchFixture('echo [%1]');
    const marker = path.join(dir, 'INJECTED.txt');
    const result = await runSafeProcess({
      executable: `./${name}`,
      // If this were interpolated into a shell string, cmd would run `echo`
      // twice and create the marker file. It is a single argument.
      argv: [`a & echo pwned > "${marker}"`],
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe('ok');
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
  });

  it('a non-zero batch exit is reported as nonzero-exit, not as a spawn failure', async () => {
    const { dir, name } = batchFixture('exit /b 3');
    const result = await runSafeProcess({
      executable: `./${name}`,
      argv: [],
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe('nonzero-exit');
    expect(result.observation.exitCode).toBe(3);
  });

  it('a missing wrapper is still a clean spawn-failed', async () => {
    const { dir } = batchFixture('echo x');
    const result = await runSafeProcess({
      executable: './does-not-exist.bat',
      argv: [],
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe('spawn-failed');
    expect(result.failureReason).toMatch(/not found/);
  });
});
