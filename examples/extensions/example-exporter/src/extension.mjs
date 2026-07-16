import { createExporterExtension } from '@specbridge/extension-sdk';
import manifest from '../specbridge-extension.json' with { type: 'json' };

createExporterExtension({
  manifest,
  export(input) {
    return {
      files: [{
        path: input.specName + '-summary.md',
        mediaType: 'text/markdown',
        content: '# ' + input.specName + '\n',
      }],
    };
  },
}).run();
