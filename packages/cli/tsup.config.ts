import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: false,
  sourcemap: true,
  clean: true,
  // The published npm package (specbridge-cli) must install outside this
  // monorepo. @specbridge/* workspace packages are not published to the
  // registry, so they are bundled into dist/index.js; external registry
  // dependencies (commander, zod, execa, ...) stay regular npm
  // dependencies declared in package.json.
  noExternal: [/^@specbridge\//],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
