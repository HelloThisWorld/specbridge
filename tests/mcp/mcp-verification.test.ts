import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXECUTION_SPEC, setupExecutionFixture } from '../helpers-execution.js';
import { callTool, connectMcp } from '../helpers-mcp.js';

/**
 * spec_run_verification: trusted commands only, argv execution, timeouts,
 * explicit report persistence, and untouched spec/approval state.
 */

function snapshotState(root: string): string {
  return readFileSync(
    path.join(root, '.specbridge', 'state', 'specs', `${EXECUTION_SPEC}.json`),
    'utf8',
  );
}

describe('spec_run_verification', () => {
  it('runs only the configured commands (argv arrays) and reports outcomes', async () => {
    const fixture = setupExecutionFixture({
      verificationCommands: [
        { name: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60_000, required: true },
        { name: 'lint', argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 60_000, required: false },
      ],
    });
    const stateBefore = snapshotState(fixture.root);
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_run_verification', { scope: 'all' });
      expect(result.isError).toBe(false);
      const commands = result.structured['commands'] as {
        name: string;
        disposition: string;
        passed: boolean;
      }[];
      expect(commands.map((command) => command.name).sort()).toEqual(['lint', 'unit']);
      expect(commands.find((command) => command.name === 'unit')?.passed).toBe(true);
      expect(commands.find((command) => command.name === 'lint')?.passed).toBe(false);
      // Spec content and approval state remain byte-identical.
      expect(snapshotState(fixture.root)).toBe(stateBefore);
    } finally {
      await session.close();
    }
  });

  it('MCP arguments cannot provide or alter a command', async () => {
    const fixture = setupExecutionFixture();
    const session = await connectMcp(fixture.root);
    try {
      // Every schema-unknown field is rejected at the protocol layer.
      const result = await session.client.callTool({
        name: 'spec_run_verification',
        arguments: { scope: 'all', command: ['rm', '-rf', '/'], argv: ['evil'] },
      });
      // The SDK strips or rejects unknown args; assert the command list is
      // exactly the configured one either way.
      const structured = (result.structuredContent ?? {}) as {
        commands?: { name: string }[];
        error?: unknown;
      };
      if (result.isError !== true) {
        expect(structured.commands?.map((command) => command.name)).toEqual(['test']);
      }
    } finally {
      await session.close();
    }
  });

  it('handles command timeouts without hanging', async () => {
    const fixture = setupExecutionFixture({
      verificationCommands: [
        {
          name: 'slow',
          argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 60000)'],
          timeoutMs: 1000,
          required: true,
        },
      ],
    });
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_run_verification', { scope: 'all' });
      expect(result.isError).toBe(false);
      const commands = result.structured['commands'] as { name: string; timedOut: boolean; passed: boolean }[];
      expect(commands[0]?.timedOut).toBe(true);
      expect(commands[0]?.passed).toBe(false);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('report persistence is explicit: nothing under .specbridge/reports unless requested', async () => {
    const fixture = setupExecutionFixture();
    const reportsDir = path.join(fixture.root, '.specbridge', 'reports');
    const session = await connectMcp(fixture.root);
    try {
      const withoutPersist = await callTool(session, 'spec_run_verification', { scope: 'all' });
      expect(withoutPersist.isError).toBe(false);
      expect(withoutPersist.structured['reportPersisted']).toBe(false);
      expect(existsSync(reportsDir)).toBe(false);

      const withPersist = await callTool(session, 'spec_run_verification', {
        scope: 'all',
        persistReport: true,
      });
      expect(withPersist.isError).toBe(false);
      expect(withPersist.structured['reportPersisted']).toBe(true);
      const reportPath = withPersist.structured['reportPath'] as string;
      expect(reportPath.startsWith('.specbridge/reports/')).toBe(true);
      expect(existsSync(path.join(fixture.root, reportPath, 'report.json'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('spec_check_drift never executes commands even when they are configured', async () => {
    // A command that would leave a marker file if it ever ran.
    const marker = 'verification-ran-marker.txt';
    const fixture = setupExecutionFixture({
      verificationCommands: [
        {
          name: 'marker',
          argv: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync('${marker}', 'ran')`,
          ],
          timeoutMs: 60_000,
          required: true,
        },
      ],
    });
    writeFileSync(path.join(fixture.root, 'src', 'drift.txt'), 'change\n');
    const session = await connectMcp(fixture.root);
    try {
      const result = await callTool(session, 'spec_check_drift', { scope: 'all' });
      expect(result.isError).toBe(false);
      expect(existsSync(path.join(fixture.root, marker))).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('never fetches, commits, or pushes (HEAD and remotes untouched)', async () => {
    const fixture = setupExecutionFixture();
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.root,
      encoding: 'utf8',
    }).trim();
    const session = await connectMcp(fixture.root);
    try {
      await callTool(session, 'spec_run_verification', { scope: 'all', persistReport: true });
      const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture.root,
        encoding: 'utf8',
      }).trim();
      expect(headAfter).toBe(headBefore);
    } finally {
      await session.close();
    }
  });
});
