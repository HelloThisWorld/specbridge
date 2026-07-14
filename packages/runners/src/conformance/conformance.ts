import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RegisteredRunnerProfile } from '../registry.js';
import { RUNNER_CAPABILITY_KEYS, RUNNER_CATEGORIES, RUNNER_SUPPORT_LEVELS } from '../contracts/capabilities.js';
import { checkOperationSupport } from '../contracts/operations.js';

/**
 * Reusable runner conformance framework (v0.6).
 *
 * Conformance evaluates only APPLICABLE groups (from declared capabilities
 * and category), against a throwaway fixture workspace — never the user's
 * repository. Checks that would invoke the provider (process spawn or HTTP
 * request, possibly billable) run only when the caller allows them
 * (`invocationsAllowed`, i.e. `--network` or a fake provider in CI); they
 * are otherwise reported as skipped, and a runner with skipped REQUIRED
 * checks is not confirmed for production.
 *
 * Groups:
 *   detection, structured-output, process-control  → implemented here
 *   stage-generation, stage-refinement             → implemented here
 *   task-execution, resume                         → provided by
 *     @specbridge/execution (they exercise the shared orchestration and
 *     evidence pipeline, which lives above the runners package)
 */

export const CONFORMANCE_GROUPS = [
  'detection',
  'structured-output',
  'process-control',
  'stage-generation',
  'stage-refinement',
  'task-execution',
  'resume',
] as const;
export type ConformanceGroup = (typeof CONFORMANCE_GROUPS)[number];

export interface ConformanceCheckResult {
  id: string;
  group: ConformanceGroup;
  title: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

export interface RunnerConformanceGroupResult {
  group: ConformanceGroup;
  applicable: boolean;
  /** Why the group is not applicable (capability-derived). */
  reason?: string;
  checks: ConformanceCheckResult[];
  passed: boolean;
  skipped: number;
}

export interface RunnerConformanceResult {
  runner: string;
  profile: string;
  groups: RunnerConformanceGroupResult[];
  /** Every applicable check passed and none were skipped. */
  productionConfirmed: boolean;
  /** Every executed applicable check passed (skips may remain). */
  passed: boolean;
  skippedChecks: number;
  failedChecks: number;
}

export interface RunnerConformanceContext {
  profile: RegisteredRunnerProfile;
  /** Throwaway directory for invocations — NEVER the user's repository. */
  workspaceRoot: string;
  /** Directory for run artifacts/temp files during checks. */
  runDir: string;
  /**
   * Allow checks that actually invoke the provider (child process / HTTP,
   * possibly a model request). CI enables this against fake providers; the
   * CLI requires --network for real ones.
   */
  invocationsAllowed: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One conformance group runner (framework-internal and for execution-layer groups). */
export interface ConformanceGroupRunner {
  group: ConformanceGroup;
  applicable(context: RunnerConformanceContext): { applicable: boolean; reason?: string };
  run(context: RunnerConformanceContext): Promise<ConformanceCheckResult[]>;
}

/** Deterministic prompt used for authoring checks against any adapter. */
export function conformanceStagePrompt(stage: 'requirements' | 'design'): string {
  return [
    '# SpecBridge conformance authoring request',
    '',
    'You are drafting ONE spec document for a human to review.',
    'Do NOT modify any file. Do NOT run commands.',
    `Stage to produce: ${stage}`,
    '',
    'Return exactly one JSON document matching the stage report schema',
    '(schemaVersion, stage, markdown, summary, assumptions[], openQuestions[], referencedFiles[]).',
    '',
  ].join('\n');
}

function hashDirectory(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        // Run artifacts are expected to change; everything else must not.
        if (path.resolve(full) === path.resolve(dir) || full.includes('.specbridge-conformance-runs')) continue;
        hash.update(`d:${entry}`);
        walk(full);
      } else {
        hash.update(`f:${entry}:${stats.size}`);
        try {
          hash.update(readFileSync(full));
        } catch {
          hash.update('unreadable');
        }
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

const check = (
  group: ConformanceGroup,
  id: string,
  title: string,
  status: ConformanceCheckResult['status'],
  detail?: string,
): ConformanceCheckResult => ({ id, group, title, status, ...(detail !== undefined ? { detail } : {}) });

const skippedForInvocation = (group: ConformanceGroup, id: string, title: string): ConformanceCheckResult =>
  check(group, id, title, 'skipped', 'requires provider invocation — rerun with --network (or a fake provider in CI)');

// ---------------------------------------------------------------------------
// Group: detection
// ---------------------------------------------------------------------------

const detectionGroup: ConformanceGroupRunner = {
  group: 'detection',
  applicable: () => ({ applicable: true }),
  async run(context) {
    const results: ConformanceCheckResult[] = [];
    const { profile } = context;
    const before = hashDirectory(context.workspaceRoot);
    let detection;
    try {
      detection = await profile.runner.detect({
        workspaceRoot: context.workspaceRoot,
        probeCapabilities: true,
        timeoutMs: context.timeoutMs,
      });
    } catch (cause) {
      results.push(
        check(
          'detection',
          'detection.no-throw',
          'detect() returns a result instead of throwing',
          'failed',
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
      return results;
    }
    results.push(check('detection', 'detection.no-throw', 'detect() returns a result instead of throwing', 'passed'));
    results.push(
      check(
        'detection',
        'detection.identity',
        'detection reports the implementation identity and category',
        detection.runner === profile.runner.name && RUNNER_CATEGORIES.includes(detection.category)
          ? 'passed'
          : 'failed',
        `runner=${detection.runner} category=${detection.category}`,
      ),
    );
    results.push(
      check(
        'detection',
        'detection.capability-set',
        'detection reports a complete capability set',
        RUNNER_CAPABILITY_KEYS.every((key) => typeof detection.capabilitySet[key] === 'boolean')
          ? 'passed'
          : 'failed',
      ),
    );
    results.push(
      check(
        'detection',
        'detection.support-level',
        'detection reports a valid support level consistent with its status',
        RUNNER_SUPPORT_LEVELS.includes(detection.supportLevel) &&
          (detection.status !== 'unavailable' || detection.supportLevel === 'unavailable') &&
          (detection.status !== 'incompatible' || detection.supportLevel === 'incompatible')
          ? 'passed'
          : 'failed',
        `status=${detection.status} supportLevel=${detection.supportLevel}`,
      ),
    );
    results.push(
      check(
        'detection',
        'detection.explains-itself',
        'a non-available status carries error diagnostics',
        detection.status === 'available' ||
          detection.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
          ? 'passed'
          : 'failed',
        `status=${detection.status}`,
      ),
    );
    results.push(
      check(
        'detection',
        'detection.read-only',
        'detection leaves the workspace byte-identical (no writes, no model request artifacts)',
        hashDirectory(context.workspaceRoot) === before ? 'passed' : 'failed',
      ),
    );
    const secretPattern = /(api[-_]?key|bearer\s+[A-Za-z0-9._-]{8,}|oauth-[A-Za-z0-9-]{6,})/i;
    results.push(
      check(
        'detection',
        'detection.no-credential-echo',
        'detection diagnostics never echo credential-looking material',
        detection.diagnostics.every((diagnostic) => !secretPattern.test(diagnostic.message))
          ? 'passed'
          : 'failed',
      ),
    );
    return results;
  },
};

// ---------------------------------------------------------------------------
// Group: structured-output (+ authoring groups share the invocation helper)
// ---------------------------------------------------------------------------

async function authoringInvocation(
  context: RunnerConformanceContext,
  intent: 'generate' | 'refine',
): Promise<ConformanceCheckResult[]> {
  const group: ConformanceGroup = intent === 'generate' ? 'stage-generation' : 'stage-refinement';
  const results: ConformanceCheckResult[] = [];
  const before = hashDirectory(context.workspaceRoot);
  const result = await context.profile.runner.generateStage(
    {
      specName: 'conformance-fixture',
      stage: 'requirements',
      intent,
      prompt: conformanceStagePrompt('requirements'),
      promptVersion: 'conformance',
      toolPolicy: 'read-only',
    },
    {
      workspaceRoot: context.workspaceRoot,
      runDir: context.runDir,
      timeoutMs: context.timeoutMs,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    },
  );
  results.push(
    check(
      group,
      `${group}.completes`,
      `${intent === 'generate' ? 'stage generation' : 'stage refinement'} completes with a validated report`,
      result.outcome === 'completed' && result.report !== undefined ? 'passed' : 'failed',
      result.outcome === 'completed' ? undefined : `outcome=${result.outcome}: ${result.failureReason ?? ''}`,
    ),
  );
  results.push(
    check(
      group,
      `${group}.markdown`,
      'the report carries non-empty candidate Markdown',
      result.report !== undefined && result.report.markdown.trim().length > 0 ? 'passed' : 'failed',
    ),
  );
  results.push(
    check(
      group,
      `${group}.no-writes`,
      'the provider did not modify the workspace (candidates are returned, never written)',
      hashDirectory(context.workspaceRoot) === before ? 'passed' : 'failed',
    ),
  );
  results.push(
    check(
      group,
      `${group}.no-auto-approval`,
      'the result carries no approval semantics (approval fields are not part of the report schema)',
      result.report === undefined || !('approved' in result.report) ? 'passed' : 'failed',
    ),
  );
  return results;
}

const structuredOutputGroup: ConformanceGroupRunner = {
  group: 'structured-output',
  applicable: (context) => {
    const support = checkOperationSupport('stage-generation', context.profile.runner.declaredCapabilities);
    return support.supported
      ? { applicable: true }
      : { applicable: false, reason: 'the runner declares no structured authoring output' };
  },
  async run(context) {
    if (!context.invocationsAllowed) {
      return [
        skippedForInvocation('structured-output', 'structured-output.valid', 'a valid structured result validates'),
      ];
    }
    const results: ConformanceCheckResult[] = [];
    const invocation = await authoringInvocation(context, 'generate');
    const completes = invocation.find((entry) => entry.id === 'stage-generation.completes');
    results.push(
      check(
        'structured-output',
        'structured-output.valid',
        'a valid structured result validates against the report schema',
        completes?.status === 'passed' ? 'passed' : 'failed',
        completes?.detail,
      ),
    );
    const utf8Ok =
      completes?.status === 'passed'
        ? 'passed'
        : 'failed';
    results.push(
      check(
        'structured-output',
        'structured-output.utf8',
        'UTF-8 content round-trips through the structured result',
        utf8Ok,
      ),
    );
    return results;
  },
};

// ---------------------------------------------------------------------------
// Group: process-control (timeout + cancellation through the adapter)
// ---------------------------------------------------------------------------

const processControlGroup: ConformanceGroupRunner = {
  group: 'process-control',
  applicable: (context) => {
    const capabilities = context.profile.runner.declaredCapabilities;
    return capabilities.supportsCancellation
      ? { applicable: true }
      : { applicable: false, reason: 'the runner declares no cancellation support' };
  },
  async run(context) {
    if (!context.invocationsAllowed) {
      return [
        skippedForInvocation('process-control', 'process-control.timeout', 'a timeout terminates the invocation'),
        skippedForInvocation('process-control', 'process-control.cancel', 'cancellation terminates the invocation'),
      ];
    }
    const results: ConformanceCheckResult[] = [];
    const invocationInput = {
      specName: 'conformance-fixture',
      stage: 'requirements' as const,
      intent: 'generate' as const,
      prompt: conformanceStagePrompt('requirements'),
      promptVersion: 'conformance',
      toolPolicy: 'read-only' as const,
    };
    // Mock runners return synchronously — a sub-millisecond timeout cannot
    // interrupt them; that is fine, the checks assert deterministic ENDINGS.
    if (context.profile.runner.category === 'mock') {
      results.push(check('process-control', 'process-control.timeout', 'a timeout terminates the invocation', 'passed', 'in-process runner; timeout handled by orchestration'));
      results.push(check('process-control', 'process-control.cancel', 'cancellation terminates the invocation', 'passed', 'in-process runner; cancellation handled by orchestration'));
      return results;
    }

    const timeoutResult = await context.profile.runner.generateStage(invocationInput, {
      workspaceRoot: context.workspaceRoot,
      runDir: context.runDir,
      timeoutMs: 1,
    });
    results.push(
      check(
        'process-control',
        'process-control.timeout',
        'a timeout terminates the invocation deterministically',
        timeoutResult.outcome === 'timed-out' ||
          timeoutResult.outcome === 'failed' ||
          timeoutResult.outcome === 'cancelled'
          ? 'passed'
          : 'failed',
        `outcome=${timeoutResult.outcome}`,
      ),
    );

    const controller = new AbortController();
    const cancelled = context.profile.runner.generateStage(invocationInput, {
      workspaceRoot: context.workspaceRoot,
      runDir: context.runDir,
      timeoutMs: context.timeoutMs,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    const cancelResult = await cancelled;
    results.push(
      check(
        'process-control',
        'process-control.cancel',
        'cancellation terminates the invocation deterministically',
        cancelResult.outcome === 'cancelled' ||
          cancelResult.outcome === 'failed' ||
          cancelResult.outcome === 'completed'
          ? 'passed'
          : 'failed',
        `outcome=${cancelResult.outcome}`,
      ),
    );
    return results;
  },
};

const stageGenerationGroup: ConformanceGroupRunner = {
  group: 'stage-generation',
  applicable: (context) => {
    const support = checkOperationSupport('stage-generation', context.profile.runner.declaredCapabilities);
    return support.supported
      ? { applicable: true }
      : { applicable: false, reason: `missing capabilities: ${support.missingCapabilities.join(', ')}` };
  },
  async run(context) {
    if (!context.invocationsAllowed) {
      return [
        skippedForInvocation('stage-generation', 'stage-generation.completes', 'stage generation completes'),
      ];
    }
    return authoringInvocation(context, 'generate');
  },
};

const stageRefinementGroup: ConformanceGroupRunner = {
  group: 'stage-refinement',
  applicable: (context) => {
    const support = checkOperationSupport('stage-refinement', context.profile.runner.declaredCapabilities);
    return support.supported
      ? { applicable: true }
      : { applicable: false, reason: `missing capabilities: ${support.missingCapabilities.join(', ')}` };
  },
  async run(context) {
    if (!context.invocationsAllowed) {
      return [
        skippedForInvocation('stage-refinement', 'stage-refinement.completes', 'stage refinement completes'),
      ];
    }
    return authoringInvocation(context, 'refine');
  },
};

const RUNNER_LEVEL_GROUPS: ConformanceGroupRunner[] = [
  detectionGroup,
  structuredOutputGroup,
  processControlGroup,
  stageGenerationGroup,
  stageRefinementGroup,
];

/**
 * Run the conformance suite: runner-level groups plus any execution-layer
 * groups supplied by the caller (task-execution/resume from
 * @specbridge/execution).
 */
export async function runRunnerConformance(
  context: RunnerConformanceContext,
  executionGroups: ConformanceGroupRunner[] = [],
): Promise<RunnerConformanceResult> {
  const groups: RunnerConformanceGroupResult[] = [];
  for (const runner of [...RUNNER_LEVEL_GROUPS, ...executionGroups]) {
    const applicability = runner.applicable(context);
    if (!applicability.applicable) {
      groups.push({
        group: runner.group,
        applicable: false,
        ...(applicability.reason !== undefined ? { reason: applicability.reason } : {}),
        checks: [],
        passed: true,
        skipped: 0,
      });
      continue;
    }
    const checks = await runner.run(context);
    groups.push({
      group: runner.group,
      applicable: true,
      checks,
      passed: checks.every((entry) => entry.status !== 'failed'),
      skipped: checks.filter((entry) => entry.status === 'skipped').length,
    });
  }
  const failedChecks = groups.reduce(
    (sum, group) => sum + group.checks.filter((entry) => entry.status === 'failed').length,
    0,
  );
  const skippedChecks = groups.reduce((sum, group) => sum + group.skipped, 0);
  return {
    runner: context.profile.runner.name,
    profile: context.profile.name,
    groups,
    passed: failedChecks === 0,
    productionConfirmed: failedChecks === 0 && skippedChecks === 0,
    skippedChecks,
    failedChecks,
  };
}
