import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string): string => path.resolve(rootDir, 'packages', name, 'src', 'index.ts');

/**
 * Worker ceiling that always leaves the vitest coordinator room to run.
 *
 * This suite is process-heavy: most integration tests spawn real `git`,
 * runner, and verification subprocesses, so each worker is really a worker
 * plus its children. Vitest's default pool sizes itself to the core count,
 * which on a 4-core GitHub-hosted runner leaves the coordinator competing
 * with every worker for scheduling.
 *
 * When that happens the worker->main `onTaskUpdate` RPC can exceed birpc's
 * 60s default (not configurable through vitest), and the run fails with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` — every test passing and
 * the process still exiting 1. Reserving headroom keeps the RPC responsive.
 *
 * A developer machine with many cores is capped too: past a handful of
 * workers this suite is bound by subprocess spawn cost, not by CPU. The cap
 * of 6 is empirical: at 8, the v1.2 driver tests (which add fake llama.cpp
 * servers and multi-role worker subprocesses on top of the usual git/runner
 * children) still starved the coordinator RPC on a 24-core machine.
 */
const workerCeiling = (): number => {
  const cores = availableParallelism();
  if (cores <= 4) return 2;
  return Math.min(cores - 2, 6);
};

/**
 * WINDOWS runs on the threads pool instead of the default forks pool.
 *
 * The `onTaskUpdate` timeout persisted on the 4-vCPU Windows runner even
 * with a SINGLE worker — every test passing and the run still exiting 1 —
 * which rules out coordinator CPU starvation and points at the fork IPC
 * channel itself (a known failure class of process-IPC RPC on Windows).
 * Threads exchange RPC over MessagePorts and sidestep that channel; the
 * full suite passes under threads on Windows with identical wall time.
 * The suite is thread-safe by construction: no test worker calls
 * process.chdir or process.exit (those only appear inside spawned fixture
 * processes), and Linux/macOS stay on forks, which is green there.
 */
const poolForPlatform = (): 'threads' | 'forks' =>
  process.platform === 'win32' ? 'threads' : 'forks';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@specbridge/core', replacement: pkg('core') },
      { find: '@specbridge/compat-kiro', replacement: pkg('compat-kiro') },
      { find: '@specbridge/drift', replacement: pkg('drift') },
      { find: '@specbridge/runners', replacement: pkg('runners') },
      { find: '@specbridge/evidence', replacement: pkg('evidence') },
      { find: '@specbridge/execution', replacement: pkg('execution') },
      { find: '@specbridge/orchestration', replacement: pkg('orchestration') },
      { find: '@specbridge/reporting', replacement: pkg('reporting') },
      { find: '@specbridge/workflow', replacement: pkg('workflow') },
      { find: '@specbridge/templates', replacement: pkg('templates') },
      { find: '@specbridge/mcp-server', replacement: pkg('mcp-server') },
      { find: '@specbridge/extension-sdk', replacement: pkg('extension-sdk') },
      { find: '@specbridge/extensions', replacement: pkg('extensions') },
      { find: '@specbridge/registry', replacement: pkg('registry') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // The large-repository performance suite builds ~9,000-file fixtures and
    // real git history. Running it inside the main worker pool starves the
    // vitest worker RPC on loaded CI runners, so it runs separately via
    // `pnpm test:perf` (vitest.perf.config.ts).
    exclude: [...configDefaults.exclude, 'tests/performance/**'],
    environment: 'node',
    // CLI output assertions must see the exact text users see with NO_COLOR;
    // picocolors would otherwise force ANSI codes on Windows terminals.
    env: { NO_COLOR: '1' },
    // The v0.3 execution tests are process-level integration tests (git
    // snapshots, runner subprocesses, verification commands); slow CI
    // runners regularly exceed the 5s default.
    //
    // Windows CI gets double the budget: process spawn costs several times
    // more there, and with a second worker running the subprocess-heavy
    // v1.2 driver suites, the git-heaviest single test (resume.test.ts
    // "recovers each intermediate phase" — five git-initialized fixtures,
    // ~50 blocking git spawns) ran out of its 30s on the 4-vCPU runner
    // while 1,647 of 1,648 tests passed. A timeout is a slowness budget,
    // not a correctness assertion; local runs and Linux/macOS stay tight.
    testTimeout: process.env['CI'] !== undefined && process.platform === 'win32' ? 60_000 : 30_000,
    maxWorkers: workerCeiling(),
    pool: poolForPlatform(),
    // On CI the default reporter writes a line per test to a non-TTY stream
    // from the coordinator — 1,479 synchronous writes competing with the RPC
    // it also has to service. `dot` keeps failure output in full while
    // removing that load, and `github-actions` annotates failures inline on
    // the pull request, which is more useful than the passing-test lines it
    // replaces.
    ...(process.env['CI'] !== undefined ? { reporters: ['dot', 'github-actions'] } : {}),
  },
});
