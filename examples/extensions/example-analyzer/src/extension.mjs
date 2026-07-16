import { createAnalyzerExtension } from '@specbridge/extension-sdk';
import manifest from '../specbridge-extension.json' with { type: 'json' };

createAnalyzerExtension({
  manifest,
  analyze(input) {
    const diagnostics = [];
    input.stageContent.split('\n').forEach((line, index) => {
      if (line.includes('TBD')) {
        diagnostics.push({
          ruleId: 'RULE001',
          severity: 'warning',
          message: 'Unresolved TBD found; replace it with a concrete decision.',
          line: index + 1,
          confidence: 'deterministic',
        });
      }
    });
    return { diagnostics };
  },
}).run();
