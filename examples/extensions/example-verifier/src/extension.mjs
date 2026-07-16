import { createVerifierExtension } from '@specbridge/extension-sdk';
import manifest from '../specbridge-extension.json' with { type: 'json' };

createVerifierExtension({
  manifest,
  verify(input) {
    const source = input.changedFiles.filter((f) => !/test/i.test(f.path));
    const tests = input.changedFiles.filter((f) => /test/i.test(f.path));
    const missing = source.length > 0 && tests.length === 0;
    return {
      status: missing ? 'warning' : source.length === 0 ? 'not-applicable' : 'passed',
      diagnostics: missing
        ? [{ ruleId: 'TESTS_MISSING', severity: 'warning', message: 'Changed source files have no matching test changes (heuristic).', confidence: 'heuristic' }]
        : [],
    };
  },
}).run();
