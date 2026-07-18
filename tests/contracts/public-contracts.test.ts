import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract freeze: the committed snapshots under contracts/ must match the
 * built public surface. Drift without an intentional snapshot update (and a
 * CHANGELOG entry) fails CI. These tests also pin a handful of load-bearing
 * literals directly, so a snapshot regeneration cannot silently launder an
 * unintended breaking change through a single command.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractsDir = path.join(repoRoot, 'contracts');

function readContract(name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractsDir, name), 'utf8'));
}

describe('public contract snapshots', () => {
  it('checker passes against the current build (requires pnpm build)', { timeout: 120_000 }, () => {
    const cliDist = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
    if (!existsSync(cliDist)) {
      throw new Error('packages/cli/dist is missing — run "pnpm build" before the contract tests.');
    }
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'check-public-contracts.mjs'), '--check'],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
    );
    expect(output).toContain('all snapshots match');
  });

  it('snapshot files exist for every frozen area', () => {
    const expected = [
      'cli-commands.json',
      'exit-codes.json',
      'report-ids.json',
      'schema-versions.json',
      'verification-rules.json',
      'runner-contract.json',
      'template-contract.json',
      'extension-contract.json',
      'mcp-contract.json',
      'plugin-skills.json',
      'github-action.json',
    ];
    const present = readdirSync(contractsDir).filter((name) => name.endsWith('.json'));
    for (const name of expected) expect(present, name).toContain(name);
  });

  it('exit codes stay pinned to their documented numbers', () => {
    expect(readContract('exit-codes.json')).toEqual({
      ok: 0,
      gateFailure: 1,
      usageError: 2,
      runnerUnavailable: 3,
      runnerFailure: 4,
      timeout: 5,
      safetyFailure: 6,
    });
  });

  it('verification rule IDs stay contiguous SBV001–SBV026', () => {
    const { ruleIds } = readContract('verification-rules.json') as { ruleIds: string[] };
    expect(ruleIds).toEqual(
      Array.from({ length: 26 }, (_, index) => `SBV${String(index + 1).padStart(3, '0')}`),
    );
  });

  it('MCP tool names include the frozen v0.5–v0.7 surface', () => {
    const { tools, prompts, serverName } = readContract('mcp-contract.json') as {
      tools: string[];
      prompts: string[];
      serverName: string;
    };
    expect(serverName).toBe('specbridge');
    expect(tools).toHaveLength(37);
    for (const name of ['workspace_detect', 'spec_list', 'task_begin', 'task_complete', 'registry_search']) {
      expect(tools).toContain(name);
    }
    expect(prompts).toEqual([
      'specbridge-author-stage',
      'specbridge-implement-task',
      'specbridge-status',
      'specbridge-verify',
    ]);
  });

  it('the v1.0.0 CLI tree keeps every pre-1.0 command and the new migrate/state groups', () => {
    const { tree } = readContract('cli-commands.json') as {
      tree: { subcommands: Record<string, { subcommands?: Record<string, unknown> }> };
    };
    const top = Object.keys(tree.subcommands);
    for (const name of [
      'doctor', 'steering', 'spec', 'runner', 'config', 'run', 'compat', 'mcp',
      'template', 'extension', 'registry', 'migrate', 'state',
    ]) {
      expect(top, name).toContain(name);
    }
    expect(Object.keys(tree.subcommands['migrate']?.subcommands ?? {})).toEqual(
      expect.arrayContaining(['status', 'plan', 'apply', 'verify']),
    );
    expect(Object.keys(tree.subcommands['state']?.subcommands ?? {})).toEqual(
      expect.arrayContaining(['validate', 'recover']),
    );
  });

  it('GitHub Action inputs/outputs stay pinned', () => {
    expect(readContract('github-action.json')).toEqual({
      inputs: [
        'annotation-limit', 'annotations', 'base-ref', 'fail-on', 'head-ref', 'mode',
        'report-directory', 'run-verification', 'spec', 'strict', 'write-step-summary',
      ],
      outputs: [
        'affected-specs', 'error-count', 'html-report', 'info-count', 'json-report',
        'markdown-report', 'result', 'spec-count', 'verification-id', 'warning-count',
      ],
    });
  });

  it('Claude Code Skill names stay pinned', () => {
    expect(readContract('plugin-skills.json')).toEqual({
      skills: [
        'approve', 'author', 'continue', 'doctor', 'extensions', 'implement',
        'new', 'runners', 'status', 'templates', 'verify',
      ],
    });
  });
});
