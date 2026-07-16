import type { ExtensionManifest } from '@specbridge/extension-sdk';
import { sha256HexOf } from './checksums.js';
import type { EnabledExtension } from './enablement.js';
import { isExtensionError } from './errors.js';
import { loadExtensionPackage, readExtensionPackageDirectory } from './manifest-loader.js';
import { invokeExtensionOperation, probeExtensionHandshake } from './protocol-client.js';

/**
 * Extension conformance: controlled, kind-specific checks that an extension
 * package behaves correctly over the real protocol. Conformance never uses
 * the network itself and never mutates the package under test — installed
 * files are hashed before and after every run.
 *
 * An extension cannot be marked conformant when any applicable check fails.
 */
export interface ExtensionConformanceCheck {
  readonly id: string;
  readonly title: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly detail?: string;
}

export interface ExtensionConformanceResult {
  readonly extensionId: string;
  readonly version: string;
  readonly kind: string;
  readonly checks: readonly ExtensionConformanceCheck[];
  readonly passed: boolean;
}

function check(
  id: string,
  title: string,
  status: 'passed' | 'failed' | 'skipped',
  detail?: string,
): ExtensionConformanceCheck {
  return detail === undefined ? { id, title, status } : { id, title, status, detail };
}

function directoryFingerprint(dir: string): string {
  const files = readExtensionPackageDirectory(dir);
  const parts: Buffer[] = [];
  for (const name of [...files.keys()].sort()) {
    parts.push(Buffer.from(name, 'utf8'), files.get(name) ?? Buffer.alloc(0));
  }
  return sha256HexOf(Buffer.concat(parts));
}

/** A minimal valid payload for each kind's primary operation. */
export function conformanceFixturePayload(kind: ExtensionManifest['kind']): unknown {
  switch (kind) {
    case 'analyzer':
      return {
        specName: 'conformance-fixture',
        specType: 'feature',
        workflowMode: 'requirements-first',
        stage: 'requirements',
        stageContent: '# Requirements\n\nThe system SHALL respond within 200 ms. TBD: retries.\n',
      };
    case 'verifier':
      return {
        specName: 'conformance-fixture',
        taskId: '1.1',
        changedFiles: [
          { path: 'src/example.ts', changeType: 'modified' },
          { path: 'tests/example.test.ts', changeType: 'modified' },
        ],
      };
    case 'exporter':
      return {
        specName: 'conformance-fixture',
        specType: 'feature',
        workflowMode: 'requirements-first',
        stages: { requirements: '# Requirements\n\nOne requirement.\n' },
      };
    case 'runner':
      return {};
    case 'template-provider':
      return undefined;
  }
}

const PRIMARY_OPERATION: Record<string, string> = {
  analyzer: 'analyzer.analyze',
  verifier: 'verifier.verify',
  exporter: 'exporter.export',
  runner: 'runner.detect',
};

/**
 * Run conformance against an enabled (or temporarily staged) extension.
 * The caller decides where the package lives; nothing here installs,
 * enables, or persists anything.
 */
export async function runExtensionConformance(
  enabled: EnabledExtension,
  options: {
    operationTimeoutMs?: number;
    /** `verify-if-present` for source directories under development. */
    checksums?: 'require' | 'verify-if-present';
  } = {},
): Promise<ExtensionConformanceResult> {
  const manifest = enabled.manifest;
  const checks: ExtensionConformanceCheck[] = [];
  const timeoutMs = options.operationTimeoutMs ?? 30_000;

  // 1. The package must validate (manifest, checksums, layout).
  const validation = loadExtensionPackage(readExtensionPackageDirectory(enabled.installedDir), {
    checksums: options.checksums ?? 'require',
  });
  const validationErrors = validation.issues.filter((issue) => issue.severity === 'error');
  checks.push(
    check(
      'package-valid',
      'package validates (manifest, checksums, layout)',
      validationErrors.length === 0 ? 'passed' : 'failed',
      validationErrors[0]?.message,
    ),
  );

  if (manifest.kind === 'template-provider') {
    // Data-only: package validation already validated and rendered every
    // template pack through the v0.7.0 template system; no process exists.
    checks.push(
      check('data-only', 'no entrypoint and no process is ever started', 'passed'),
      check(
        'templates-validate',
        'every contributed template pack validates and renders',
        validationErrors.length === 0 ? 'passed' : 'failed',
      ),
    );
    return finish(enabled, checks);
  }

  const before = directoryFingerprint(enabled.installedDir);

  // 2. Protocol handshake: initialize with identity + capability validation.
  const probe = await probeExtensionHandshake(enabled);
  checks.push(
    check(
      'protocol-initialize',
      'initialize handshake succeeds with matching identity and declared capabilities',
      probe.ok ? 'passed' : 'failed',
      probe.ok ? undefined : probe.detail,
    ),
  );

  if (probe.ok) {
    // 3. Primary operation with a fixture payload.
    const operation = PRIMARY_OPERATION[manifest.kind];
    if (operation !== undefined && manifest.capabilities.operations.includes(operation)) {
      try {
        await invokeExtensionOperation(enabled, {
          operation,
          payload: conformanceFixturePayload(manifest.kind),
          timeoutMs,
        });
        checks.push(
          check('primary-operation', `${operation} succeeds on a fixture payload and validates`, 'passed'),
        );
      } catch (error) {
        checks.push(
          check(
            'primary-operation',
            `${operation} succeeds on a fixture payload and validates`,
            'failed',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }

      // 4. Malformed input must fail safely (structured error, no hang).
      try {
        await invokeExtensionOperation(enabled, {
          operation,
          payload: { garbage: true },
          timeoutMs,
        });
        // Some hosts normalize garbage into a valid empty result; a
        // structured completion is safe behavior too.
        checks.push(check('malformed-input', 'malformed input fails safely', 'passed'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unsafeCodes = ['SBE022', 'SBE023', 'SBE025', 'SBE026'];
        const code = isExtensionError(error) ? error.extensionCode : undefined;
        const safe = code === undefined || !unsafeCodes.includes(code);
        checks.push(
          check(
            'malformed-input',
            'malformed input fails safely',
            safe ? 'passed' : 'failed',
            safe ? undefined : message,
          ),
        );
      }

      // 5. Determinism for analyzers: identical input, identical output.
      if (manifest.kind === 'analyzer') {
        try {
          const payload = conformanceFixturePayload('analyzer');
          const first = await invokeExtensionOperation(enabled, { operation, payload, timeoutMs });
          const second = await invokeExtensionOperation(enabled, { operation, payload, timeoutMs });
          const same = JSON.stringify(first.output) === JSON.stringify(second.output);
          checks.push(
            check(
              'analyzer-deterministic',
              'identical input produces identical diagnostics',
              same ? 'passed' : 'failed',
            ),
          );
        } catch (error) {
          checks.push(
            check(
              'analyzer-deterministic',
              'identical input produces identical diagnostics',
              'failed',
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
    } else {
      checks.push(
        check('primary-operation', 'primary operation declared', 'failed', 'primary operation missing'),
      );
    }
  }

  // 6. The extension must not have mutated its own package (or anything the
  //    fingerprint covers) during conformance.
  const after = directoryFingerprint(enabled.installedDir);
  checks.push(
    check(
      'no-package-mutation',
      'conformance run did not modify the installed package',
      before === after ? 'passed' : 'failed',
    ),
  );

  return finish(enabled, checks);
}

function finish(enabled: EnabledExtension, checks: ExtensionConformanceCheck[]): ExtensionConformanceResult {
  return {
    extensionId: enabled.manifest.id,
    version: enabled.manifest.version,
    kind: enabled.manifest.kind,
    checks,
    passed: checks.every((item) => item.status !== 'failed'),
  };
}
