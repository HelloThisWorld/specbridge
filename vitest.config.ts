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
      { find: '@specbridge/evidence', replacement: pkg('evidence') },
      { find: '@specbridge/execution', replacement: pkg('execution') },
      { find: '@specbridge/reporting', replacement: pkg('reporting') },
      { find: '@specbridge/workflow', replacement: pkg('workflow') },
      { find: '@specbridge/mcp-server', replacement: pkg('mcp-server') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // CLI output assertions must see the exact text users see with NO_COLOR;
    // picocolors would otherwise force ANSI codes on Windows terminals.
    env: { NO_COLOR: '1' },
    // The v0.3 execution tests are process-level integration tests (git
    // snapshots, runner subprocesses, verification commands); slow CI
    // runners regularly exceed the 5s default.
    testTimeout: 30_000,
  },
});
