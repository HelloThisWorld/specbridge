import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string): string => path.resolve(rootDir, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@specbridge/core', replacement: pkg('core') },
      { find: '@specbridge/compat-kiro', replacement: pkg('compat-kiro') },
      { find: '@specbridge/drift', replacement: pkg('drift') },
      { find: '@specbridge/runners', replacement: pkg('runners') },
      { find: '@specbridge/reporting', replacement: pkg('reporting') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
