import { configDefaults, defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

/**
 * Large-repository performance suite, run separately from `pnpm test`.
 *
 * The fixtures build ~9,000 files and real git history, which is far heavier
 * than any unit or integration test. Sharing the main worker pool with them
 * starves the vitest worker RPC on loaded CI runners (the run reports every
 * test as passing but still fails with a "Timeout calling onTaskUpdate"
 * unhandled error). Isolating the suite keeps both halves reliable, and
 * matches the repository policy of treating performance measurements as
 * informational benchmarks with generous budgets rather than tight gates.
 *
 * `include`/`exclude` are set explicitly rather than merged: vitest's
 * mergeConfig concatenates arrays, which would keep the base exclusion of
 * tests/performance and run the main suite instead.
 *
 * Run with: pnpm test:perf
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['tests/performance/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    // Fixture construction alone takes ~40s on a developer machine.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // The measurements assume no competing load inside this run.
    fileParallelism: false,
  },
});
