import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/v2/index.ts'],
  format: ['cjs'],
  target: 'node20',
  dts: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@specbridge\//],
  outExtension: () => ({ js: '.cjs' }),
  banner: { js: '#!/usr/bin/env node' },
});
