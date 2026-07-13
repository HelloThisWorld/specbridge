import { defineConfig } from 'tsup';

/**
 * Self-contained plugin bundles.
 *
 * Everything — workspace packages and npm dependencies alike — is inlined
 * into two CommonJS files under specbridge/dist/, so the installed plugin
 * needs no node_modules, no workspace resolution, and no file outside its
 * own directory. Source maps are disabled: they would embed build-machine
 * paths. The build is reproducible for identical inputs and toolchain.
 */
export default defineConfig({
  entry: {
    cli: '../../packages/cli/src/index.ts',
    'mcp-server': '../../packages/mcp-server/src/standalone.ts',
  },
  outDir: 'specbridge/dist',
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  noExternal: [/.*/],
  sourcemap: false,
  minify: false,
  clean: false,
  outExtension: () => ({ js: '.cjs' }),
});
