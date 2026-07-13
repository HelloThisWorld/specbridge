import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/standalone.ts'],
  format: ['esm'],
  target: 'node20',
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
});
