import { describe, expect, it } from 'vitest';
import {
  invokeExtensionOperation,
  isExtensionError,
  probeExtensionHandshake,
} from '@specbridge/extensions';
import { freshKiroWorkspace } from '../helpers-templates';
import {
  analyzerManifest,
  installAndEnableTestExtension,
  PLAIN_ANALYZER_ENTRYPOINT,
} from '../helpers-extensions';

const ANALYZER_PAYLOAD = {
  specName: 'demo',
  specType: 'feature',
  workflowMode: 'requirements-first',
  stage: 'requirements',
  stageContent: 'The retry limit is TBD.',
};

async function expectInvokeCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(isExtensionError(error), String(error)).toBe(true);
    if (isExtensionError(error)) {
      expect(error.extensionCode).toBe(code);
    }
    return;
  }
  throw new Error(`expected ${code} but the invocation succeeded`);
}

describe('extension process host and protocol client', () => {
  it('runs a real analyzer extension out of process', async () => {
    const { enabled } = await installAndEnableTestExtension(freshKiroWorkspace(), analyzerManifest());
    const outcome = await invokeExtensionOperation(enabled, {
      operation: 'analyzer.analyze',
      payload: ANALYZER_PAYLOAD,
    });
    const output = outcome.output as { diagnostics: Array<{ ruleId: string }> };
    expect(output.diagnostics).toHaveLength(1);
    expect(output.diagnostics[0]?.ruleId).toBe('RULE001');
    expect(outcome.protocolLog.length).toBeGreaterThan(0);
  });

  it('fails safely when stdout is corrupted by logging (SBE022)', async () => {
    const entrypoint =
      `process.stdout.write('extension is starting up...\\n');\n` + PLAIN_ANALYZER_ENTRYPOINT;
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'corrupt-analyzer' }),
      { 'dist/extension.cjs': entrypoint },
    );
    await expectInvokeCode(
      invokeExtensionOperation(enabled, { operation: 'analyzer.analyze', payload: ANALYZER_PAYLOAD }),
      'SBE022',
    );
  });

  it('stderr logging does not corrupt the protocol and is captured', async () => {
    const entrypoint =
      `process.stderr.write('demo-analyzer booting\\n');\n` + PLAIN_ANALYZER_ENTRYPOINT;
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'noisy-analyzer' }),
      { 'dist/extension.cjs': entrypoint },
    );
    const outcome = await invokeExtensionOperation(enabled, {
      operation: 'analyzer.analyze',
      payload: ANALYZER_PAYLOAD,
    });
    expect((outcome.output as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
    expect(outcome.stderr).toContain('demo-analyzer booting');
  });

  it('terminates an unresponsive extension at the startup timeout (SBE019)', async () => {
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'silent-analyzer' }),
      { 'dist/extension.cjs': 'setInterval(() => {}, 1000);\n' },
    );
    await expectInvokeCode(
      invokeExtensionOperation(enabled, {
        operation: 'analyzer.analyze',
        payload: ANALYZER_PAYLOAD,
        startupTimeoutMs: 500,
      }),
      'SBE019',
    );
  });

  it('terminates a hanging operation at the operation timeout (SBE023)', async () => {
    const hangingInvoke = PLAIN_ANALYZER_ENTRYPOINT.replace(
      "if (request.method === 'extension.invoke') {",
      "if (request.method === 'extension.invoke') { return; } if (false) {",
    );
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'hanging-analyzer' }),
      { 'dist/extension.cjs': hangingInvoke },
    );
    await expectInvokeCode(
      invokeExtensionOperation(enabled, {
        operation: 'analyzer.analyze',
        payload: ANALYZER_PAYLOAD,
        timeoutMs: 500,
      }),
      'SBE023',
    );
  });

  it('rejects identity mismatches from the running process (SBE020)', async () => {
    const lying = PLAIN_ANALYZER_ENTRYPOINT.replace(
      'extensionId: manifest.id,',
      "extensionId: 'someone-else',",
    );
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'lying-analyzer' }),
      { 'dist/extension.cjs': lying },
    );
    await expectInvokeCode(
      invokeExtensionOperation(enabled, { operation: 'analyzer.analyze', payload: ANALYZER_PAYLOAD }),
      'SBE020',
    );
  });

  it('rejects oversized protocol output (SBE025)', async () => {
    const oversized = PLAIN_ANALYZER_ENTRYPOINT.replace(
      "message: 'unresolved TBD found',",
      "message: 'x'.repeat(3 * 1024 * 1024),",
    );
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'oversized-analyzer' }),
      { 'dist/extension.cjs': oversized },
    );
    await expectInvokeCode(
      invokeExtensionOperation(enabled, { operation: 'analyzer.analyze', payload: ANALYZER_PAYLOAD }),
      'SBE025',
    );
  });

  it('passes only granted environment variables and redacts their values', async () => {
    const envProbe = PLAIN_ANALYZER_ENTRYPOINT.replace(
      "message: 'unresolved TBD found',",
      'message: `granted=${process.env.DEMO_TOKEN !== undefined} ` +\n' +
        '  `leaked=${process.env.SB_TEST_LEAK !== undefined}`,',
    ).replace(
      "rl.on('line', (line) => {",
      "process.stderr.write('token is ' + process.env.DEMO_TOKEN + '\\n');\nrl.on('line', (line) => {",
    );
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({
        id: 'env-analyzer',
        permissions: {
          specRead: true,
          repositoryRead: false,
          repositoryWrite: false,
          network: false,
          childProcess: false,
          environmentVariables: ['DEMO_TOKEN'],
        },
      }),
      { 'dist/extension.cjs': envProbe },
    );
    const outcome = await invokeExtensionOperation(enabled, {
      operation: 'analyzer.analyze',
      payload: ANALYZER_PAYLOAD,
      environment: {
        ...process.env,
        DEMO_TOKEN: 'super-secret-value',
        SB_TEST_LEAK: 'must-not-cross',
      },
    });
    const output = outcome.output as { diagnostics: Array<{ message: string }> };
    expect(output.diagnostics[0]?.message).toBe('granted=true leaked=false');
    expect(outcome.stderr).toContain('[redacted]');
    expect(outcome.stderr).not.toContain('super-secret-value');
  });

  it('normalizes an immediately exiting process into a handshake failure (SBE019)', async () => {
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'exiting-analyzer' }),
      { 'dist/extension.cjs': 'process.exit(3);\n' },
    );
    await expectInvokeCode(
      invokeExtensionOperation(enabled, { operation: 'analyzer.analyze', payload: ANALYZER_PAYLOAD }),
      'SBE019',
    );
  });

  it('doctor-style handshake probe succeeds without invoking operations', async () => {
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'probe-analyzer' }),
    );
    const probe = await probeExtensionHandshake(enabled);
    expect(probe.ok, probe.detail).toBe(true);
  });
});
