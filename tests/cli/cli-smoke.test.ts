import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../packages/cli/src/cli';
import { emptyTempDir, fixturePath } from '../helpers.js';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

const standard = fixturePath('standard-feature');

describe('specbridge doctor', () => {
  it('reports a healthy standard workspace and exits 0', async () => {
    const result = await cli(standard, 'doctor');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('SpecBridge Doctor');
    expect(result.stdout).toContain('.kiro directory detected');
    expect(result.stdout).toContain('.kiro/steering detected');
    expect(result.stdout).toContain('.kiro/specs detected');
    expect(result.stdout).toContain('product.md');
    expect(result.stdout).toContain('user-authentication');
    expect(result.stdout).toContain('No migration required');
    expect(result.stdout).toContain('Round-trip safe');
    expect(result.stdout).toContain('Safe for read-only use');
    expect(result.stdout).toContain('Result:');
  });

  it('handles a workspace without .kiro: clear report, exit 1, no crash', async () => {
    const result = await cli(emptyTempDir(), 'doctor');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('No .kiro directory found');
  });

  it('emits machine-readable JSON with --json', async () => {
    const result = await cli(standard, 'doctor', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      data: { healthy: boolean; roundTripSafe: boolean; specs: { name: string }[] };
    };
    expect(report.schema).toBe('specbridge.doctor/1');
    expect(report.data.healthy).toBe(true);
    expect(report.data.roundTripSafe).toBe(true);
    expect(report.data.specs.map((s) => s.name)).toEqual(['user-authentication']);
  });

  it('tolerates hand-edited workspaces (warnings, but exit 0)', async () => {
    const result = await cli(fixturePath('manually-edited-feature'), 'doctor');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('search-filters');
  });

  it('reports partial specs without crashing', async () => {
    const result = await cli(fixturePath('partial-spec'), 'doctor');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('notification-settings');
    expect(result.stdout).toContain('partial');
  });

  it('reports CRLF workspaces as healthy and preserved', async () => {
    const result = await cli(fixturePath('crlf-files'), 'doctor');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('CRLF');
  });
});

describe('specbridge steering', () => {
  it('lists steering files', async () => {
    const result = await cli(standard, 'steering', 'list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('product');
    expect(result.stdout).toContain('tech');
    expect(result.stdout).toContain('structure');
  });

  it('shows a steering file raw', async () => {
    const result = await cli(standard, 'steering', 'show', 'product');
    expect(result.code).toBe(0);
    const original = readFileSync(
      path.join(standard, '.kiro', 'steering', 'product.md'),
      'utf8',
    );
    expect(result.stdout).toBe(original);
  });

  it('errors helpfully for unknown steering names', async () => {
    const result = await cli(standard, 'steering', 'show', 'nonexistent');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not found');
    expect(result.stderr).toContain('product');
  });
});

describe('specbridge spec list/show', () => {
  it('lists specs with type and progress', async () => {
    const result = await cli(standard, 'spec', 'list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('user-authentication');
    expect(result.stdout).toContain('feature');
    expect(result.stdout).toContain('3/9');
  });

  it('lists bugfix specs with their type', async () => {
    const result = await cli(fixturePath('bugfix-spec'), 'spec', 'list');
    expect(result.stdout).toContain('login-timeout-fix');
    expect(result.stdout).toContain('bugfix');
  });

  it('shows a spec summary', async () => {
    const result = await cli(standard, 'spec', 'show', 'user-authentication');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Spec: user-authentication');
    expect(result.stdout).toContain('Type: feature');
    expect(result.stdout).toContain('requirements.md');
    expect(result.stdout).toContain('Next open tasks');
    expect(result.stdout).toContain('Round-trip safe');
  });

  it('prints a single file byte-faithfully with --file', async () => {
    const result = await cli(standard, 'spec', 'show', 'user-authentication', '--file', 'tasks');
    expect(result.code).toBe(0);
    const original = readFileSync(
      path.join(standard, '.kiro', 'specs', 'user-authentication', 'tasks.md'),
      'utf8',
    );
    expect(result.stdout).toBe(original);
  });

  it('rejects unknown --file kinds with exit 2', async () => {
    const result = await cli(standard, 'spec', 'show', 'user-authentication', '--file', 'nope');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Valid kinds');
  });

  it('errors helpfully for unknown specs', async () => {
    const result = await cli(standard, 'spec', 'show', 'missing-spec');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Available specs: user-authentication');
  });

  it('exposes the full model as JSON', async () => {
    const result = await cli(standard, 'spec', 'show', 'user-authentication', '--json');
    const report = JSON.parse(result.stdout) as {
      data: {
        classification: { type: string; completeness: string };
        taskProgress: { total: number; completed: number };
        roundTrip: { identical: boolean }[];
      };
    };
    expect(report.data.classification.type).toBe('feature');
    expect(report.data.classification.completeness).toBe('complete');
    expect(report.data.taskProgress).toMatchObject({ total: 9, completed: 3 });
    expect(report.data.roundTrip.every((check) => check.identical)).toBe(true);
  });
});

describe('specbridge spec context', () => {
  it('assembles steering, spec documents, progress, and agreements', async () => {
    const result = await cli(standard, 'spec', 'context', 'user-authentication');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# SpecBridge Agent Context');
    expect(result.stdout).toContain('Working agreements');
    expect(result.stdout).toContain('Acme Portal'); // steering inlined
    expect(result.stdout).toContain('Requirement 1'); // requirements inlined
    expect(result.stdout).toContain('- [x] 1. Set up authentication module scaffolding');
    expect(result.stdout).toContain('Next open tasks');
    expect(result.stdout).toContain('no model was invoked');
  });

  it('adds compat-check guidance for --target claude-code', async () => {
    const result = await cli(
      standard,
      'spec',
      'context',
      'user-authentication',
      '--target',
      'claude-code',
    );
    expect(result.stdout).toContain('compat check user-authentication');
  });

  it('produces structured JSON with --format json', async () => {
    const result = await cli(
      standard,
      'spec',
      'context',
      'user-authentication',
      '--format',
      'json',
    );
    const context = JSON.parse(result.stdout) as {
      schema: string;
      spec: { name: string; type: string };
      steering: { name: string }[];
      documents: { tasks?: { content: string } };
      acceptanceCriterionIds: string[];
    };
    expect(context.schema).toBe('specbridge.agent-context/1');
    expect(context.spec.name).toBe('user-authentication');
    expect(context.steering.map((s) => s.name)).toEqual(['product', 'tech', 'structure']);
    expect(context.documents.tasks?.content).toContain('- [ ] 3. Session management');
    expect(context.acceptanceCriterionIds).toContain('2.3');
  });

  it('works for partial specs, reporting missing stages', async () => {
    const result = await cli(fixturePath('partial-spec'), 'spec', 'context', 'notification-settings');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Missing stages');
    expect(result.stdout).toContain('design.md is not present yet');
    expect(result.stdout).toContain('tasks.md is not present yet.');
  });

  it('rejects unknown formats and targets', async () => {
    expect((await cli(standard, 'spec', 'context', 'user-authentication', '--format', 'xml')).code).toBe(2);
    expect((await cli(standard, 'spec', 'context', 'user-authentication', '--target', 'cursor')).code).toBe(2);
  });
});

describe('specbridge compat check', () => {
  it('verifies byte-identical round trips for one spec', async () => {
    const result = await cli(standard, 'compat', 'check', 'user-authentication');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('byte-identical');
    expect(result.stdout).toContain('PASS');
  });

  it('verifies everything (specs + steering) without a name', async () => {
    const result = await cli(standard, 'compat', 'check');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('spec:user-authentication');
    expect(result.stdout).toContain('steering');
  });

  it('passes on the hardest fixtures: CRLF + BOM and UTF-8 content', async () => {
    expect((await cli(fixturePath('crlf-files'), 'compat', 'check')).code).toBe(0);
    expect((await cli(fixturePath('utf8-content'), 'compat', 'check')).code).toBe(0);
    expect((await cli(fixturePath('manually-edited-feature'), 'compat', 'check')).code).toBe(0);
  });

  it('reports per-file line-ending details in JSON', async () => {
    const result = await cli(fixturePath('crlf-files'), 'compat', 'check', '--json');
    const report = JSON.parse(result.stdout) as {
      data: { passed: boolean; groups: { checks: { eol: string; hasBom: boolean }[] }[] };
    };
    expect(report.data.passed).toBe(true);
    const checks = report.data.groups.flatMap((g) => g.checks);
    expect(checks.some((c) => c.eol === 'crlf')).toBe(true);
    expect(checks.some((c) => c.hasBom)).toBe(true);
  });
});

describe('planned commands are honest', () => {
  it.each([
    ['spec', 'run', 'x'],
    ['spec', 'sync', 'x'],
    ['spec', 'verify', 'x'],
    ['spec', 'export', 'x'],
  ])('%s %s exits 2 with a not-implemented message', async (...argv) => {
    const result = await cli(standard, ...argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not implemented yet');
    expect(result.stderr).toContain('planned');
  });
});

describe('general CLI behavior', () => {
  it('--help exits 0 and lists commands', async () => {
    const result = await cli(standard, '--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('spec');
    expect(result.stdout).toContain('steering');
  });

  it('--version exits 0', async () => {
    const result = await cli(standard, '--version');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0.2.0');
  });

  it('unknown commands exit 2', async () => {
    const result = await cli(standard, 'frobnicate');
    expect(result.code).toBe(2);
  });

  it('spec commands outside a workspace exit 2 with guidance', async () => {
    const result = await cli(emptyTempDir(), 'spec', 'list');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No .kiro directory found');
  });

  it('--cwd targets another directory', async () => {
    const result = await cli(emptyTempDir(), '--cwd', standard, 'spec', 'list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('user-authentication');
  });
});
