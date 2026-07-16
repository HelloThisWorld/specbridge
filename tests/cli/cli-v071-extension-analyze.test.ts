import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { FIXED_NOW } from '../helpers';
import { freshKiroWorkspace } from '../helpers-templates';
import { analyzerManifest, installAndEnableTestExtension } from '../helpers-extensions';

async function cli(cwd: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line = '') => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line = '') => stderr.push(`${line}\n`),
    now: () => FIXED_NOW,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function writeSpec(root: string, name: string, requirements: string): void {
  const dir = path.join(root, '.kiro', 'specs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'requirements.md'), requirements, 'utf8');
}

describe('specbridge spec analyze --extension', () => {
  it('runs an enabled analyzer extension and namespaces its diagnostics', async () => {
    const root = freshKiroWorkspace();
    writeSpec(
      root,
      'demo-spec',
      '# Requirements\n\n## 1. First requirement\n\nWHEN a user saves THEN the system SHALL persist. Retry policy is TBD.\n',
    );
    await installAndEnableTestExtension(root, analyzerManifest());

    const result = await cli(root, 'spec', 'analyze', 'demo-spec', '--extension', 'demo-analyzer', '--json');
    expect(result.code).toBe(1); // extension reports a warning-level finding; TBD content is also flagged built-in
    const report = JSON.parse(result.stdout) as {
      data: {
        extensions: Array<{ extensionId: string; diagnostics: Array<{ ruleId: string; confidence: string }> }>;
        extensionFailures: unknown[];
      };
    };
    const run = report.data.extensions.find((entry) => entry.diagnostics.length > 0);
    expect(run?.extensionId).toBe('demo-analyzer');
    expect(run?.diagnostics[0]?.ruleId).toBe('demo-analyzer/RULE001');
    expect(report.data.extensionFailures).toEqual([]);

    // The extension never modified the spec.
    const requirements = readFileSync(path.join(root, '.kiro', 'specs', 'demo-spec', 'requirements.md'), 'utf8');
    expect(requirements).toContain('Retry policy is TBD.');
  });

  it('fails clearly when the extension is installed but disabled (SBE015)', async () => {
    const root = freshKiroWorkspace();
    writeSpec(root, 'demo-spec', '# Requirements\n\n## 1. Requirement\n\nThe system SHALL work.\n');
    const { workspace } = await installAndEnableTestExtension(root, analyzerManifest());
    await cli(root, 'spec', 'analyze', 'demo-spec'); // warm-up sanity, no extension
    const { disableExtension } = await import('@specbridge/extensions');
    disableExtension({ workspace, id: 'demo-analyzer' });

    const result = await cli(root, 'spec', 'analyze', 'demo-spec', '--extension', 'demo-analyzer', '--json');
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      data: { extensionFailures: Array<{ extensionId: string; message: string }> };
    };
    expect(report.data.extensionFailures[0]?.message).toContain('SBE015');
  });

  it('reports unknown extensions without crashing (SBE001)', async () => {
    const root = freshKiroWorkspace();
    writeSpec(root, 'demo-spec', '# Requirements\n\n## 1. Requirement\n\nThe system SHALL work.\n');
    const result = await cli(root, 'spec', 'analyze', 'demo-spec', '--extension', 'ghost-analyzer', '--json');
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      data: { extensionFailures: Array<{ message: string }> };
    };
    expect(report.data.extensionFailures[0]?.message).toContain('SBE001');
  });
});
