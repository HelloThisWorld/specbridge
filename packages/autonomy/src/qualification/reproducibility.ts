import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import { runSafeProcess } from '@specbridge/runners';
import { recordJobEvent } from '@specbridge/orchestration';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, jobDepsOf, newRecordId, now, nowIso } from '../deps.js';
import { assertAutonomyId, autonomyPath, listJsonRecords, readJsonRecord, writeJsonRecord } from '../store.js';
import { advanceClosurePhase, registerClosureEvidence } from '../closure/service.js';

/**
 * Reproducibility qualification.
 *
 * An autonomous mission must not declare completion on the strength of the
 * dirty developer environment that produced the feature. The build that
 * passes with a warm cache, a running database, and eleven hours of
 * accumulated state is not the build a person clones tomorrow.
 *
 * The honesty constraint runs through the whole module: a step that cannot
 * run HERE is recorded as UNAVAILABLE, and an UNAVAILABLE step makes the run
 * INCONCLUSIVE rather than passing. Fabricating reproducibility an
 * environment cannot provide would be worse than not claiming it — a report
 * that says "reproducible" on a machine that could not do a clean build is
 * a claim about somebody else's machine.
 */

export const REPRODUCIBILITY_SCHEMA_VERSION = '1.0.0';

const shortText = z.string().max(200);
const text = z.string().max(4_000);

/**
 * The dimensions a reproducibility run may exercise.
 *
 * Named rather than free-form so a report can say which ones were actually
 * proven. "We ran a clean build" and "we also provisioned a fresh
 * environment and re-ran the acceptance scenarios" are different claims.
 */
export const REPRODUCIBILITY_DIMENSIONS = [
  'CLEAN_CHECKOUT',
  'NO_BUILD_CACHE',
  'FRESH_DEPENDENCY_RESOLUTION',
  'FRESH_ENVIRONMENT',
  'FRESH_APPLICATION_START',
  'REPEATED_QUALIFICATION',
] as const;
export type ReproducibilityDimension = (typeof REPRODUCIBILITY_DIMENSIONS)[number];

export const reproducibilityStepSchema = z
  .object({
    stepId: shortText,
    dimension: z.enum(REPRODUCIBILITY_DIMENSIONS),
    name: shortText,
    argv: z.array(z.string().min(1).max(500)).min(1).max(30),
    timeoutMs: z.number().int().min(1_000).max(24 * 3_600_000).default(1_800_000),
    /** Working directory relative to the clean checkout. */
    cwd: shortText.optional(),
  })
  .passthrough();
export type ReproducibilityStep = z.infer<typeof reproducibilityStepSchema>;

export const reproducibilityResultSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    runId: shortText,
    jobId: shortText.optional(),
    /**
     * PASSED requires every declared step to have RUN and passed.
     * INCONCLUSIVE means something could not be attempted here, which is an
     * honest outcome and explicitly not a pass.
     */
    status: z.enum(['PASSED', 'FAILED', 'INCONCLUSIVE', 'NOT_RUN']),
    startedAt: shortText,
    finishedAt: shortText.optional(),
    /** Where the clean checkout lived, when one was made. */
    checkoutPath: shortText.optional(),
    gitHead: shortText.optional(),
    dimensions: z.array(z.enum(REPRODUCIBILITY_DIMENSIONS)).max(10).default([]),
    steps: z
      .array(
        z
          .object({
            stepId: shortText,
            dimension: z.enum(REPRODUCIBILITY_DIMENSIONS),
            name: shortText,
            outcome: z.enum(['PASSED', 'FAILED', 'UNAVAILABLE', 'NOT_RUN']),
            detail: text,
            durationMs: z.number().int().min(0).nullable().default(null),
          })
          .passthrough(),
      )
      .max(30)
      .default([]),
    /** Why the run could not conclude, when it could not. */
    inconclusiveReason: text.optional(),
    failureDetail: text.optional(),
  })
  .passthrough();
export type ReproducibilityResult = z.infer<typeof reproducibilityResultSchema>;

function resultFile(workspace: WorkspaceInfo, runId: string): string {
  assertAutonomyId('reproducibility run', runId);
  return autonomyPath(workspace, 'reproducibility', `${runId}.json`);
}

export function readReproducibilityResult(
  workspace: WorkspaceInfo,
  runId: string,
): ReproducibilityResult | undefined {
  return readJsonRecord(resultFile(workspace, runId), (raw) =>
    reproducibilityResultSchema.parse(raw),
  );
}

export function listReproducibilityResults(workspace: WorkspaceInfo): ReproducibilityResult[] {
  return listJsonRecords(autonomyPath(workspace, 'reproducibility'), (raw) =>
    reproducibilityResultSchema.parse(raw),
  ).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export interface RunReproducibilityOptions {
  jobId?: string | undefined;
  steps: readonly ReproducibilityStep[];
  /** Absolute path of the clean checkout the steps run in. */
  checkoutPath: string;
  gitHead?: string | undefined;
  /** Sealed items this run is evidence for. */
  itemIds?: readonly string[] | undefined;
  runId?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Injected command runner (tests). */
  commandRunner?:
    | ((input: {
        argv: readonly string[];
        cwd: string;
        timeoutMs: number;
      }) => Promise<{ outcome: 'PASSED' | 'FAILED' | 'UNAVAILABLE'; detail: string }>)
    | undefined;
}

export async function runReproducibilityQualification(
  deps: AutonomyDeps,
  options: RunReproducibilityOptions,
): Promise<ReproducibilityResult> {
  const policy = autonomyPolicyOf(deps).closure;
  const runId = options.runId ?? newRecordId(deps, 'rp');
  const startedAt = nowIso(deps);
  const deadline = now(deps).getTime() + policy.reproducibilityTimeoutMs;

  const run =
    options.commandRunner ??
    (async (input) => {
      const [executable, ...argv] = input.argv;
      if (executable === undefined) return { outcome: 'UNAVAILABLE' as const, detail: 'empty command' };
      const result = await runSafeProcess({
        executable,
        argv,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 512 * 1024,
      });
      if (result.status === 'ok') return { outcome: 'PASSED' as const, detail: 'exited 0' };
      // A tool that is not installed on this machine is UNAVAILABLE, not a
      // failed build. Reporting it as a failure would send the gap-closure
      // loop off to repair code that compiles fine everywhere else.
      if (result.status === 'spawn-failed') {
        return {
          outcome: 'UNAVAILABLE' as const,
          detail: `${executable} could not be started in the clean checkout`,
        };
      }
      return {
        outcome: 'FAILED' as const,
        detail: `${result.status}: ${(result.stderr || result.stdout).split('\n')[0] ?? ''}`.slice(0, 400),
      };
    });

  const steps: ReproducibilityResult['steps'] = [];
  let failureDetail: string | undefined;
  let unavailable: string | undefined;

  for (const step of options.steps) {
    if (options.signal?.aborted === true || now(deps).getTime() > deadline) {
      steps.push({
        stepId: step.stepId,
        dimension: step.dimension,
        name: step.name,
        outcome: 'NOT_RUN',
        detail: 'the reproducibility window elapsed before this step ran',
        durationMs: null,
      });
      unavailable = unavailable ?? 'the reproducibility window elapsed';
      continue;
    }
    const before = now(deps).getTime();
    const outcome = await run({
      argv: step.argv,
      cwd: step.cwd !== undefined ? `${options.checkoutPath}/${step.cwd}` : options.checkoutPath,
      timeoutMs: step.timeoutMs,
    });
    steps.push({
      stepId: step.stepId,
      dimension: step.dimension,
      name: step.name,
      outcome: outcome.outcome,
      detail: outcome.detail.slice(0, 4_000),
      durationMs: Math.max(0, now(deps).getTime() - before),
    });
    if (outcome.outcome === 'FAILED') {
      failureDetail = `${step.name}: ${outcome.detail}`;
      break;
    }
    if (outcome.outcome === 'UNAVAILABLE') {
      unavailable = unavailable ?? `${step.name}: ${outcome.detail}`;
    }
  }

  const status: ReproducibilityResult['status'] =
    failureDetail !== undefined
      ? 'FAILED'
      : unavailable !== undefined
        ? 'INCONCLUSIVE'
        : steps.length > 0
          ? 'PASSED'
          : 'NOT_RUN';

  const result = reproducibilityResultSchema.parse({
    schemaVersion: REPRODUCIBILITY_SCHEMA_VERSION,
    runId,
    ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
    status,
    startedAt,
    finishedAt: nowIso(deps),
    checkoutPath: options.checkoutPath.slice(0, 200),
    ...(options.gitHead !== undefined ? { gitHead: options.gitHead } : {}),
    dimensions: [...new Set(options.steps.map((step) => step.dimension))],
    steps,
    ...(failureDetail !== undefined ? { failureDetail } : {}),
    ...(unavailable !== undefined ? { inconclusiveReason: unavailable } : {}),
  });
  writeJsonRecord(resultFile(deps.workspace, runId), result);

  if (options.jobId !== undefined) {
    // Only a PASS advances the closure phase. An INCONCLUSIVE run leaves
    // `reproducibilityPassed` false, so the oracle keeps asking — which is
    // the correct outcome for a machine that could not do a clean build.
    if (status === 'PASSED') {
      advanceClosurePhase(deps, {
        jobId: options.jobId,
        phase: 'FINAL_CONTRACT_AUDIT',
        reproducibilityPassed: true,
      });
    }
    if (options.itemIds !== undefined && options.itemIds.length > 0 && status !== 'INCONCLUSIVE') {
      registerClosureEvidence(deps, {
        jobId: options.jobId,
        itemIds: options.itemIds,
        kind: 'REPRODUCIBILITY_RUN',
        ref: runId,
        passed: status === 'PASSED',
        ...(options.gitHead !== undefined ? { gitHead: options.gitHead } : {}),
        ...(failureDetail !== undefined ? { detail: failureDetail } : {}),
      });
    }
    try {
      recordJobEvent(jobDepsOf(deps), options.jobId, 'reproducibility_completed', {
        runId,
        status,
        dimensions: result.dimensions.length,
      });
    } catch {
      // Certification fixtures run this with no job record.
    }
  }
  return result;
}

/**
 * The default step set for a Node/pnpm project.
 *
 * A starting point rather than a policy: a project that builds differently
 * declares its own steps. What matters is that whatever runs, runs in a
 * clean checkout with no build cache, and that anything that could not run
 * is reported as such.
 */
export function defaultNodeReproducibilitySteps(packageManager: string): ReproducibilityStep[] {
  return [
    {
      stepId: 'install',
      dimension: 'FRESH_DEPENDENCY_RESOLUTION',
      name: `${packageManager} install (frozen lockfile)`,
      argv: [packageManager, 'install', '--frozen-lockfile'],
      timeoutMs: 1_800_000,
    },
    {
      stepId: 'build',
      dimension: 'NO_BUILD_CACHE',
      name: `${packageManager} build`,
      argv: [packageManager, 'build'],
      timeoutMs: 1_800_000,
    },
    {
      stepId: 'test',
      dimension: 'REPEATED_QUALIFICATION',
      name: `${packageManager} test`,
      argv: [packageManager, 'test'],
      timeoutMs: 3_600_000,
    },
  ];
}
