import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string): string => path.join(root, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@specbridge/core', replacement: pkg('core') },
      { find: '@specbridge/repository', replacement: pkg('repository') },
      { find: '@specbridge/design', replacement: pkg('design') },
      { find: '@specbridge/mcp-server', replacement: pkg('mcp-server') },
    ],
  },
  test: {
    include: ['tests/v2/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: process.platform === 'win32' ? 'threads' : 'forks',
  },
});
