import { defineConfig } from 'tsup';

/**
 * Reproducible single-file bundle for the node20 GitHub Action runtime.
 *
 * Everything — workspace packages and npm dependencies alike — is inlined
 * into dist/index.js (CommonJS), so consumers of `uses:` need no package
 * manager, no pnpm, and no install step. The committed bundle is rebuilt in
 * CI and diffed against the source to keep it honest.
 */
export default defineConfig({
  entry: { index: 'src/main.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  noExternal: [/.*/],
  sourcemap: false,
  minify: false,
  clean: true,
});
