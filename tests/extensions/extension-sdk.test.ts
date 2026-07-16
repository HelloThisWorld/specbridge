import { describe, expect, it } from 'vitest';
import {
  computePermissionHash,
  connectLoopback,
  EXTENSION_PROTOCOL_ERRORS,
  initializeParamsFor,
  invokeExtensionOnce,
  noPermissions,
  parseExtensionManifest,
  permissionEscalations,
  semverSatisfies,
  validateExtensionId,
  validateSemverRange,
} from '@specbridge/extension-sdk';
import {
  analyzerManifest,
  exporterManifest,
  runnerManifest,
  templateProviderManifest,
  verifierManifest,
} from '../helpers-extensions';

describe('extension manifest validation', () => {
  it('accepts a valid manifest for every extension kind', () => {
    for (const manifest of [
      analyzerManifest(),
      verifierManifest(),
      exporterManifest(),
      runnerManifest(),
      templateProviderManifest(),
    ]) {
      const parsed = parseExtensionManifest(JSON.stringify(manifest));
      expect(parsed.manifest?.id).toBe(manifest.id);
      expect(parsed.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });

  it('validates extension IDs against the documented grammar', () => {
    for (const valid of ['security-analyzer', 'playwright-verifier', 'jira-exporter', 'custom-agent-runner', 'a1']) {
      expect(validateExtensionId(valid).valid, valid).toBe(true);
    }
    for (const invalid of [
      'SecurityAnalyzer',
      'security_analyzer',
      '../security',
      'security/analyzer',
      '-security',
      'security-',
      'security--analyzer',
      '',
      'a'.repeat(65),
    ]) {
      expect(validateExtensionId(invalid).valid, invalid || '(empty)').toBe(false);
    }
  });

  it('rejects unknown manifest fields, bad versions, and bad ranges', () => {
    const withUnknown = { ...analyzerManifest(), surprise: true } as unknown as Record<string, unknown>;
    expect(parseExtensionManifest(JSON.stringify(withUnknown)).manifest).toBeUndefined();

    const badVersion = analyzerManifest({ version: '1.0' as never });
    expect(parseExtensionManifest(JSON.stringify(badVersion)).manifest).toBeUndefined();

    const badRange = analyzerManifest({ compatibility: { specbridge: '^0.7.0' } });
    const parsed = parseExtensionManifest(JSON.stringify(badRange));
    expect(parsed.issues.some((issue) => issue.code === 'SBE004' && issue.category === 'compatibility')).toBe(true);
  });

  it('rejects an unsupported schema major version with SBE005', () => {
    const manifest = analyzerManifest({ schemaVersion: '2.0.0' });
    const parsed = parseExtensionManifest(JSON.stringify(manifest));
    expect(parsed.manifest).toBeUndefined();
    expect(parsed.issues[0]?.code).toBe('SBE005');
  });

  it('rejects an incompatible protocol major version with SBE007', () => {
    const manifest = analyzerManifest({ protocolVersion: '2.0.0' });
    const parsed = parseExtensionManifest(JSON.stringify(manifest));
    expect(parsed.issues.some((issue) => issue.code === 'SBE007')).toBe(true);
  });

  it('requires an entrypoint for executable kinds and forbids it for template providers', () => {
    const { entrypoint: _e, ...noEntrypoint } = analyzerManifest();
    const missing = parseExtensionManifest(JSON.stringify(noEntrypoint));
    expect(missing.issues.some((issue) => issue.code === 'SBE012')).toBe(true);

    const provider = { ...templateProviderManifest(), entrypoint: 'dist/extension.cjs' };
    const withEntrypoint = parseExtensionManifest(JSON.stringify(provider));
    expect(withEntrypoint.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('rejects traversal, absolute, and backslash entrypoints with SBE012', () => {
    for (const entrypoint of ['../evil.cjs', '/abs/evil.cjs', 'C:/evil.cjs', 'dist\\extension.cjs', 'dist/extension.exe']) {
      const parsed = parseExtensionManifest(JSON.stringify(analyzerManifest({ entrypoint })));
      expect(
        parsed.issues.some((issue) => issue.code === 'SBE012'),
        entrypoint,
      ).toBe(true);
    }
  });

  it('rejects operations that do not belong to the declared kind', () => {
    const manifest = analyzerManifest({ capabilities: { operations: ['verifier.verify'] } });
    const parsed = parseExtensionManifest(JSON.stringify(manifest));
    expect(parsed.issues.some((issue) => issue.code === 'SBE021')).toBe(true);
  });

  it('forces template providers to be permissionless and operationless', () => {
    const grabby = templateProviderManifest({
      permissions: {
        specRead: false,
        repositoryRead: false,
        repositoryWrite: false,
        network: true,
        childProcess: false,
        environmentVariables: [],
      },
    });
    const parsed = parseExtensionManifest(JSON.stringify(grabby));
    expect(parsed.issues.some((issue) => issue.category === 'permissions')).toBe(true);
  });

  it('rejects wildcard-style environment variable names', () => {
    const manifest = analyzerManifest({
      permissions: {
        specRead: true,
        repositoryRead: false,
        repositoryWrite: false,
        network: false,
        childProcess: false,
        environmentVariables: ['PATH*'],
      },
    });
    expect(parseExtensionManifest(JSON.stringify(manifest)).manifest).toBeUndefined();
  });

  it('rejects oversized manifests with SBE008', () => {
    const manifest = JSON.stringify({ padding: 'x'.repeat(300 * 1024) });
    const parsed = parseExtensionManifest(manifest);
    expect(parsed.issues[0]?.code).toBe('SBE008');
  });
});

describe('permission hash', () => {
  const input = {
    extensionId: 'demo-analyzer',
    extensionVersion: '1.0.0',
    manifestSha256: 'a'.repeat(64),
    permissions: analyzerManifest().permissions,
  };

  it('is deterministic and order-insensitive for environment variables', () => {
    const a = computePermissionHash(input);
    const b = computePermissionHash({
      ...input,
      permissions: { ...input.permissions, environmentVariables: [] },
    });
    expect(a).toBe(b);
    const withVariables = computePermissionHash({
      ...input,
      permissions: { ...input.permissions, environmentVariables: ['B_VAR', 'A_VAR'] },
    });
    const withVariablesSorted = computePermissionHash({
      ...input,
      permissions: { ...input.permissions, environmentVariables: ['A_VAR', 'B_VAR'] },
    });
    expect(withVariables).toBe(withVariablesSorted);
    expect(withVariables).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the manifest hash, version, or permissions change', () => {
    const base = computePermissionHash(input);
    expect(computePermissionHash({ ...input, manifestSha256: 'b'.repeat(64) })).not.toBe(base);
    expect(computePermissionHash({ ...input, extensionVersion: '1.0.1' })).not.toBe(base);
    expect(
      computePermissionHash({
        ...input,
        permissions: { ...input.permissions, network: true },
      }),
    ).not.toBe(base);
  });

  it('detects permission escalations', () => {
    const before = noPermissions();
    const after = { ...noPermissions(), network: true, environmentVariables: ['MY_TOKEN'] };
    expect(permissionEscalations(before, after)).toEqual(['network', 'environmentVariables:MY_TOKEN']);
    expect(permissionEscalations(after, before)).toEqual([]);
  });
});

describe('sdk semver', () => {
  it('supports AND-composed comparator ranges', () => {
    expect(validateSemverRange('>=0.7.1 <1.0.0').valid).toBe(true);
    expect(validateSemverRange('^1.0.0').valid).toBe(false);
    expect(semverSatisfies('0.7.1', '>=0.7.1 <1.0.0')).toBe(true);
    expect(semverSatisfies('1.0.0', '>=0.7.1 <1.0.0')).toBe(false);
    expect(semverSatisfies('0.7.0', '>=0.7.1 <1.0.0')).toBe(false);
  });
});

describe('extension server over loopback', () => {
  const manifest = analyzerManifest();
  const okHandler = {
    'analyzer.analyze': () => ({ diagnostics: [] }),
  };

  it('initializes, invokes, and shuts down cleanly', async () => {
    const output = await invokeExtensionOnce({
      manifest,
      handlers: {
        'analyzer.analyze': (payload) => {
          const input = payload as { stageContent: string };
          return {
            diagnostics: input.stageContent.includes('TBD')
              ? [
                  {
                    ruleId: 'RULE001',
                    severity: 'warning' as const,
                    message: 'unresolved TBD found',
                    confidence: 'deterministic' as const,
                  },
                ]
              : [],
          };
        },
      },
      operation: 'analyzer.analyze',
      payload: {
        specName: 'demo',
        specType: 'feature',
        workflowMode: 'requirements-first',
        stage: 'requirements',
        stageContent: 'This is TBD.',
      },
    });
    expect((output as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
  });

  it('rejects identity mismatches during initialize with SBE020', async () => {
    const connection = connectLoopback({ manifest, handlers: okHandler });
    const response = await connection.request(
      'initialize',
      initializeParamsFor(manifest, { extensionId: 'someone-else' }),
    );
    expect(response.error?.data?.['extensionCode']).toBe('SBE020');
    await connection.close();
  });

  it('rejects an incompatible protocol major version with SBE007', async () => {
    const connection = connectLoopback({ manifest, handlers: okHandler });
    const response = await connection.request(
      'initialize',
      initializeParamsFor(manifest, { protocolVersion: '9.0.0' }),
    );
    expect(response.error?.data?.['extensionCode']).toBe('SBE007');
    await connection.close();
  });

  it('rejects invoke before initialize', async () => {
    const connection = connectLoopback({ manifest, handlers: okHandler });
    const response = await connection.request('extension.invoke', {
      operation: 'analyzer.analyze',
      payload: {},
    });
    expect(response.error?.code).toBe(EXTENSION_PROTOCOL_ERRORS.notInitialized);
    await connection.close();
  });

  it('rejects undeclared operations with SBE021', async () => {
    const connection = connectLoopback({ manifest, handlers: okHandler });
    await connection.requestResult('initialize', initializeParamsFor(manifest));
    const response = await connection.request('extension.invoke', {
      operation: 'verifier.verify',
      payload: {},
    });
    expect(response.error?.data?.['extensionCode']).toBe('SBE021');
    await connection.close();
  });

  it('validates handler output and hides stack traces by default', async () => {
    const connection = connectLoopback({
      manifest,
      handlers: {
        'analyzer.analyze': () => ({ nonsense: true }),
      },
    });
    await connection.requestResult('initialize', initializeParamsFor(manifest));
    const invalidOutput = await connection.request('extension.invoke', {
      operation: 'analyzer.analyze',
      payload: {
        specName: 'demo',
        specType: 'feature',
        workflowMode: 'quick',
        stage: 'requirements',
        stageContent: 'content',
      },
    });
    expect(invalidOutput.error?.code).toBe(EXTENSION_PROTOCOL_ERRORS.invalidOutput);
    await connection.close();

    const throwing = connectLoopback({
      manifest,
      handlers: {
        'analyzer.analyze': () => {
          throw new Error('boom');
        },
      },
    });
    await throwing.requestResult('initialize', initializeParamsFor(manifest));
    const failed = await throwing.request('extension.invoke', {
      operation: 'analyzer.analyze',
      payload: {
        specName: 'demo',
        specType: 'feature',
        workflowMode: 'quick',
        stage: 'requirements',
        stageContent: 'content',
      },
    });
    expect(failed.error?.message).toContain('boom');
    expect(failed.error?.data?.['stack']).toBeUndefined();
    await throwing.close();
  });

  it('supports cancellation via extension.cancel', async () => {
    const connection = connectLoopback({
      manifest,
      handlers: {
        'analyzer.analyze': (_payload, context) =>
          new Promise((resolve) => {
            context.signal.addEventListener('abort', () => resolve({ diagnostics: [] }));
          }),
      },
    });
    await connection.requestResult('initialize', initializeParamsFor(manifest));
    const invokePromise = connection.request('extension.invoke', {
      operation: 'analyzer.analyze',
      payload: {
        specName: 'demo',
        specType: 'feature',
        workflowMode: 'quick',
        stage: 'requirements',
        stageContent: 'content',
      },
    });
    // The invoke id is allocated before cancel, so cancel targets it.
    const cancelResponse = await connection.request('extension.cancel', { targetId: 'loopback-2' });
    expect((cancelResponse.result as { cancelled: boolean }).cancelled).toBe(true);
    const cancelled = await invokePromise;
    expect(cancelled.error?.data?.['extensionCode']).toBe('SBE024');
    await connection.close();
  });

  it('keeps handler logging off the protocol stream', async () => {
    const connection = connectLoopback({
      manifest,
      handlers: {
        'analyzer.analyze': (_payload, context) => {
          context.log('working...');
          return { diagnostics: [] };
        },
      },
    });
    await connection.requestResult('initialize', initializeParamsFor(manifest));
    await connection.requestResult('extension.invoke', {
      operation: 'analyzer.analyze',
      payload: {
        specName: 'demo',
        specType: 'feature',
        workflowMode: 'quick',
        stage: 'requirements',
        stageContent: 'content',
      },
    });
    expect(connection.logLines).toContain('working...');
    await connection.close();
  });
});
