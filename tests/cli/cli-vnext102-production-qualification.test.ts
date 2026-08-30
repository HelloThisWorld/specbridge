import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_QUALIFICATION_ARTIFACTS,
  qualificationArtifactPath,
  startQualificationRun,
} from '@specbridge/orchestration';
import { runCli } from '../../packages/cli/src/cli';
import { git } from '../helpers-execution.js';
import { setupOrchestrationFixture } from '../helpers-orchestration.js';

async function cli(cwd: string, ...argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (line) => stdout.push(`${line}\n`),
    outRaw: (value) => stdout.push(value),
    err: (line) => stderr.push(`${line}\n`),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}

describe('Phase 10 production qualification CLI', () => {
  it('freezes a clean candidate and honestly previews every missing gate as NOT_READY', async () => {
    const fixture = setupOrchestrationFixture({ git: true });
    write(fixture.root, 'package.json', '{"name":"specbridge-monorepo","version":"1.1.0"}\n');
    write(fixture.root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    write(fixture.root, 'contracts/schema-versions.json', '{"dogfoodRun":"1.0.0"}\n');
    write(fixture.root, 'packages/core/package.json', '{"name":"@specbridge/core","version":"1.1.0"}\n');
    write(fixture.root, 'packages/core/src/index.ts', 'export const fixture = true;\n');
    write(
      fixture.root,
      'integrations/claude-code-plugin/specbridge/.claude-plugin/plugin.json',
      '{"name":"specbridge","version":"1.1.0"}\n',
    );
    write(
      fixture.root,
      'integrations/claude-code-plugin/specbridge/dist/checksums.json',
      '{"cli.cjs":"fixture"}\n',
    );
    write(
      fixture.root,
      'integrations/codex-plugin/specbridge/.codex-plugin/plugin.json',
      '{"name":"specbridge","version":"1.1.0"}\n',
    );
    write(fixture.root, 'integrations/codex-plugin/specbridge/dist/checksums.json', '{"cli.cjs":"fixture"}\n');
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-q', '-m', 'freeze candidate fixture');

    const run = startQualificationRun(
      {
        workspace: fixture.workspace,
        config: fixture.config,
        clock: fixture.clock,
        idFactory: () => 'production-cli-001',
      },
      {
        profile: 'offline',
        target: {
          kind: 'FIXTURE',
          name: 'production qualification fixture',
          repositoryPath: null,
          available: false,
          unavailableReason: 'Deterministic CLI contract fixture.',
          startingCommit: null,
          endingCommit: null,
          branch: null,
          worktreePath: null,
          missionSpec: null,
        },
      },
    );

    const frozen = await cli(fixture.root, 'orchestrate', 'qualify', 'freeze', run.runId, '--json');
    expect(frozen.code).toBe(0);
    expect(frozen.stderr).toBe('');
    const candidate = (JSON.parse(frozen.stdout) as { data: { candidate: Record<string, unknown> } }).data.candidate;
    expect(candidate['sourceTreeClean']).toBe(true);
    expect(String(candidate['runtimeDigest'])).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(candidate['runtimeFileCount'])).toBeGreaterThan(0);
    expect(existsSync(qualificationArtifactPath(
      fixture.workspace,
      run.runId,
      PRODUCTION_QUALIFICATION_ARTIFACTS.candidate,
    ))).toBe(true);

    const preview = await cli(
      fixture.root,
      'orchestrate',
      'qualify',
      'release',
      run.runId,
      '--json',
      '--no-write',
    );
    expect(preview.code).not.toBe(0);
    const decision = (JSON.parse(preview.stdout) as {
      data: { decision: { status: string; failedRequiredGateIds: string[] } };
    }).data.decision;
    expect(decision.status).toBe('NOT_READY');
    expect(decision.failedRequiredGateIds).toHaveLength(20);
    expect(decision.failedRequiredGateIds).toContain('real-local-model');
    expect(existsSync(qualificationArtifactPath(
      fixture.workspace,
      run.runId,
      PRODUCTION_QUALIFICATION_ARTIFACTS.manifest,
    ))).toBe(false);
  });
});
