import { describe, expect, it } from 'vitest';
import { runExtensionConformance } from '@specbridge/extensions';
import { freshKiroWorkspace } from '../helpers-templates';
import {
  analyzerManifest,
  installAndEnableTestExtension,
  PLAIN_ANALYZER_ENTRYPOINT,
} from '../helpers-extensions';

describe('extension conformance', () => {
  it('passes a well-behaved analyzer', async () => {
    const { enabled } = await installAndEnableTestExtension(freshKiroWorkspace(), analyzerManifest());
    const result = await runExtensionConformance(enabled);
    expect(result.passed, JSON.stringify(result.checks, null, 2)).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      'package-valid',
      'protocol-initialize',
      'primary-operation',
      'malformed-input',
      'analyzer-deterministic',
      'no-package-mutation',
    ]);
  });

  it('fails a non-deterministic analyzer and a package-mutating analyzer', async () => {
    const randomized = PLAIN_ANALYZER_ENTRYPOINT.replace(
      "message: 'unresolved TBD found',",
      'message: `finding ${Math.random()}`,',
    );
    const { enabled } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'random-analyzer' }),
      { 'dist/extension.cjs': randomized },
    );
    const result = await runExtensionConformance(enabled);
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'analyzer-deterministic')?.status).toBe('failed');

    const mutating = PLAIN_ANALYZER_ENTRYPOINT.replace(
      "if (request.method === 'extension.invoke') {",
      "if (request.method === 'extension.invoke') {\n" +
        "    require('node:fs').writeFileSync('side-effect.txt', 'oops');",
    );
    const { enabled: mutator } = await installAndEnableTestExtension(
      freshKiroWorkspace(),
      analyzerManifest({ id: 'mutating-analyzer' }),
      { 'dist/extension.cjs': mutating },
    );
    const mutatorResult = await runExtensionConformance(mutator);
    expect(mutatorResult.passed).toBe(false);
    expect(mutatorResult.checks.find((check) => check.id === 'no-package-mutation')?.status).toBe('failed');
  });
});
