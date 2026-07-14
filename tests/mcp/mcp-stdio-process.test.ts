import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFixtureToTemp } from '../helpers.js';
import { EXECUTION_SPEC, setupExecutionFixture } from '../helpers-execution.js';

/**
 * Process-level stdio tests against the REAL built server: every stdout
 * byte is protocol framing, stderr logging never corrupts the protocol, and
 * SIGINT/SIGTERM shut down cleanly.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'standalone.js');

beforeAll(() => {
  if (!existsSync(serverEntry)) {
    // Local runs may predate a build; CI builds before testing. The
    // standalone entry imports the BUILT workspace packages, so the whole
    // workspace is built, not just this package.
    execFileSync('pnpm', ['build'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  }
}, 300_000);

function spawnServer(projectRoot: string, extraArgs: string[] = []): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [serverEntry, '--stdio', '--project-root', projectRoot, '--log-level', 'info', '--json-logs', ...extraArgs],
    { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 15_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('server did not exit in time'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('process-level stdio server', () => {
  let session:
    | { client: Client; transport: StdioClientTransport; projectRoot: string }
    | undefined;

  afterAll(async () => {
    await session?.client.close();
  });

  it('full lifecycle: handshake, tools, resources, prompts, invocation, clean shutdown', async () => {
    const fixture = setupExecutionFixture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry, '--stdio', '--project-root', fixture.root],
      cwd: fixture.root,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    session = { client, transport, projectRoot: fixture.root };

    // Identity through initialization.
    expect(client.getServerVersion()?.name).toBe('specbridge');
    expect(client.getServerVersion()?.version).toBe('0.6.0');

    // Capability listings.
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('workspace_detect');
    const resources = await client.listResources();
    expect(resources.resources.some((resource) => resource.uri === 'specbridge://workspace')).toBe(true);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.length).toBe(4);

    // Tool invocations.
    const detect = await client.callTool({ name: 'workspace_detect', arguments: {} });
    expect(detect.isError).not.toBe(true);
    expect((detect.structuredContent as { found: boolean }).found).toBe(true);
    const list = await client.callTool({ name: 'spec_list', arguments: {} });
    expect(
      ((list.structuredContent as { specs: { name: string }[] }).specs).map((spec) => spec.name),
    ).toContain(EXECUTION_SPEC);

    // A resource read over the wire.
    const resource = await client.readResource({
      uri: `specbridge://specs/${EXECUTION_SPEC}/tasks`,
    });
    const contents = resource.contents[0] as { text?: string } | undefined;
    expect(contents?.text).toContain('Implementation Plan');

    // Drift check over the wire.
    const drift = await client.callTool({
      name: 'spec_check_drift',
      arguments: { scope: 'all' },
    });
    expect(drift.isError).not.toBe(true);

    // Clean shutdown: closing the transport ends the process.
    await client.close();
    session = undefined;
  }, 60_000);

  it('emits only protocol JSON on stdout; logs go to stderr', async () => {
    const root = copyFixtureToTemp('standard-feature');
    const child = spawnServer(root);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Drive one raw initialize round trip, then close stdin.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw-test', version: '0.0.0' },
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    child.stdin.end();
    await waitForExit(child);

    // Every stdout line is a complete JSON-RPC message.
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe('2.0');
    }
    // Startup logging went to stderr, as structured JSON.
    expect(stderr).toContain('server_started');
    const firstLog = stderr.split('\n').find((line) => line.trim().length > 0);
    expect(() => JSON.parse(firstLog as string)).not.toThrow();
  }, 30_000);

  const signals: NodeJS.Signals[] = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    it(`${signal} shuts the server down cleanly`, async () => {
      const root = copyFixtureToTemp('standard-feature');
      const child = spawnServer(root);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      child.kill(signal);
      const code = await waitForExit(child);
      expect(code).toBe(0);
      expect(stderr).toContain('server_stopped');
    }, 30_000);
  }

  it('handles an unsupported protocol version cleanly (SDK negotiation, no crash)', async () => {
    const root = copyFixtureToTemp('standard-feature');
    const child = spawnServer(root);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '1999-01-01',
          capabilities: {},
          clientInfo: { name: 'ancient-client', version: '0.0.0' },
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    child.stdin.end();
    await waitForExit(child);
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const response = JSON.parse(lines[0] as string) as {
      jsonrpc: string;
      result?: { protocolVersion?: string };
      error?: unknown;
    };
    // The SDK either counter-offers a supported version or returns a clean
    // JSON-RPC error — never garbage, never a crash.
    expect(response.jsonrpc).toBe('2.0');
    expect(response.result !== undefined || response.error !== undefined).toBe(true);
    if (response.result?.protocolVersion !== undefined) {
      expect(response.result.protocolVersion).not.toBe('1999-01-01');
    }
  }, 30_000);

  it('an invalid project root fails fast with an actionable stderr message', async () => {
    const child = spawn(
      process.execPath,
      [serverEntry, '--stdio', '--project-root', path.join('Z:', 'no', 'such', 'dir-xyz')],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const code = await waitForExit(child);
    expect(code).toBe(1);
    expect(stderr).toContain('does not exist');
    expect(stdout).toBe('');
  }, 30_000);

  it('--version prints the version and exits without starting a server', async () => {
    const child = spawn(process.execPath, [serverEntry, '--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const code = await waitForExit(child);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('0.6.0');
  }, 30_000);
});
