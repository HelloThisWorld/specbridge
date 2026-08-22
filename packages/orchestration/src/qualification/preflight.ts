import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { OrchestrationError } from '../errors.js';
import type { DogfoodTarget } from './state.js';
import type { QualificationProfile } from './vocabulary.js';
import { PAID_CAPABLE_PROFILES } from './vocabulary.js';

/**
 * Real-dogfood preflight (vNext.9).
 *
 * Fails CLOSED. A dogfood run mutates a repository over hours or days while
 * nobody is watching, and the cost of starting one against the wrong tree,
 * the wrong branch, or an unbounded spend policy is not a failed test — it
 * is somebody's working copy or somebody's money. So every check below
 * refuses rather than warns when it cannot establish safety, and the
 * function returns findings rather than throwing so the operator sees ALL of
 * them at once instead of fixing them one error at a time.
 *
 * Two things preflight deliberately does NOT do:
 *
 *   It does not authorize spending. Displaying the economic configuration is
 *   not approval; vNext.5 spend mode, budget, and per-task approval remain
 *   the only authority, and a green preflight changes none of them.
 *
 *   It does not reveal credential values. It reports whether a runner is
 *   configured and bound, never what it was configured with.
 */

export type PreflightSeverity = 'ok' | 'warn' | 'refuse';

export interface PreflightFinding {
  /** Stable check id, e.g. `target.repository`. */
  id: string;
  severity: PreflightSeverity;
  message: string;
  remediation: string[];
}

/**
 * The economic configuration, surfaced before a potentially paid run.
 *
 * Every field is a policy value or a boolean presence flag. There is no
 * field here that could carry a key, a token, or an endpoint, which is why
 * the whole object is safe to print and safe to persist in a report.
 */
export interface EconomicConfigurationView {
  localEnabled: boolean;
  localModelConfigured: boolean;
  localHarnessProfile: string | null;
  localExecutionStrategy: string;
  subscriptionWorkerConfigured: boolean;
  quotaTelemetrySource: string;
  apiSpendMode: string;
  apiHarnessProfile: string | null;
  apiPricingConfigured: boolean;
  apiMaxBudgetUsd: number | null;
  apiPerTaskCeilingUsd: number | null;
  contextStrategy: string;
  adaptiveMode: string;
  protectedPaths: string[];
  verificationCommands: string[];
}

export interface PreflightInput {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  profile: QualificationProfile;
  target: DogfoodTarget;
  /**
   * Repository status of the DOGFOOD TARGET, supplied by the caller so this
   * module stays free of process execution. `null` means the caller could
   * not determine it, which is itself a refusal: an unknown working tree is
   * not a safe one.
   */
  targetRepository?:
    | {
        isGitRepository: boolean;
        /** Paths dirty outside `.specbridge/`. */
        dirtyPaths: readonly string[];
        branch: string | null;
        head: string | null;
        /** True when execution is confined to an isolated worktree. */
        isolatedWorktree: boolean;
      }
    | null
    | undefined;
}

export interface PreflightResult {
  profile: QualificationProfile;
  findings: PreflightFinding[];
  economics: EconomicConfigurationView;
  /** True when no finding refuses. A run may start only when this is true. */
  safe: boolean;
  /** True when this profile could, under policy, spend money. */
  paidCapable: boolean;
}

function ok(id: string, message: string): PreflightFinding {
  return { id, severity: 'ok', message, remediation: [] };
}

function warn(id: string, message: string, remediation: string[] = []): PreflightFinding {
  return { id, severity: 'warn', message, remediation };
}

function refuse(id: string, message: string, remediation: string[] = []): PreflightFinding {
  return { id, severity: 'refuse', message, remediation };
}

/** Read the economic configuration into a safe, printable view. */
export function economicConfiguration(config: AgentConfig): EconomicConfigurationView {
  const scheduler = config.orchestration.jobs.scheduler;
  const api = scheduler.api;
  const local = config.localInference;
  const workers = config.orchestration.jobs.routing;
  return {
    localEnabled: scheduler.allowLocalExecution,
    localModelConfigured: local?.enabled === true,
    localHarnessProfile: scheduler.localExecution.harnessProfile ?? null,
    localExecutionStrategy: scheduler.localExecution.strategy,
    // A subscription worker exists when at least one role routes to the
    // large agent. Reported as presence, never as identity or credentials.
    subscriptionWorkerConfigured: Object.values(workers).some((route) => route === 'large-agent'),
    quotaTelemetrySource: scheduler.telemetrySource,
    apiSpendMode: api.spendMode,
    apiHarnessProfile: api.harnessProfile,
    apiPricingConfigured: api.pricing !== null,
    apiMaxBudgetUsd: api.budget.maxCostPerJobUsd,
    apiPerTaskCeilingUsd: api.budget.maxCostPerTaskUsd,
    contextStrategy: config.orchestration.jobs.context.efficiency.strategy,
    adaptiveMode: scheduler.adaptive.mode,
    protectedPaths: [...config.execution.protectedPaths],
    verificationCommands: config.verification.commands.map((command) => command.name),
  };
}

/**
 * Run the preflight checks.
 *
 * The ordering mirrors how a run actually fails: an unreachable target
 * repository makes everything downstream moot, a dirty working tree is the
 * one failure that damages somebody else's work, and the economic checks
 * come last because they only matter once the run could actually start.
 */
export function runPreflight(input: PreflightInput): PreflightResult {
  const { config, profile, target } = input;
  const findings: PreflightFinding[] = [];
  const economics = economicConfiguration(config);
  const paidCapable = PAID_CAPABLE_PROFILES.includes(profile);

  // -- Target repository ----------------------------------------------------
  if (target.kind === 'FIXTURE') {
    findings.push(
      ok(
        'target.repository',
        `Target is the deterministic fixture "${target.name}". The real-product release gate is not satisfiable by this run.`,
      ),
    );
  } else if (target.repositoryPath === null) {
    findings.push(
      refuse('target.repository', 'No dogfood target repository is configured.', [
        'Configure the dogfood target repository path before starting a real dogfood run.',
        'Offline qualification does not need a target: run it with --profile offline.',
      ]),
    );
  } else if (!existsSync(target.repositoryPath) || !statSync(target.repositoryPath).isDirectory()) {
    findings.push(
      refuse(
        'target.repository',
        `The configured dogfood target "${target.repositoryPath}" does not exist or is not a directory.`,
        [
          'Clone or check out the dogfood target repository at the configured path.',
          'Correct the configured path if the repository lives elsewhere.',
        ],
      ),
    );
  } else {
    findings.push(ok('target.repository', `Dogfood target resolved at ${target.repositoryPath}.`));
  }

  // -- Working-tree safety --------------------------------------------------
  //
  // The one check whose failure damages work that is not ours. An unknown
  // repository state refuses for the same reason a dirty one does: "we could
  // not tell" is not evidence of safety.
  if (target.kind === 'REAL_REPOSITORY') {
    const repository = input.targetRepository;
    if (repository === null || repository === undefined) {
      findings.push(
        refuse(
          'target.working-tree',
          'The dogfood target repository status could not be determined.',
          ['Ensure the target path is a readable git repository.'],
        ),
      );
    } else if (!repository.isGitRepository) {
      findings.push(
        refuse('target.working-tree', 'The dogfood target is not a git repository.', [
          'Dogfood execution requires git for isolated worktrees and evidence.',
        ]),
      );
    } else if (!repository.isolatedWorktree && repository.dirtyPaths.length > 0) {
      findings.push(
        refuse(
          'target.working-tree',
          `The dogfood target has ${repository.dirtyPaths.length} uncommitted change(s) outside .specbridge/ and is not an isolated worktree.`,
          [
            'Commit or stash the changes in the target repository.',
            'Or point the dogfood run at a dedicated worktree and branch.',
          ],
        ),
      );
    } else if (!repository.isolatedWorktree) {
      findings.push(
        warn(
          'target.working-tree',
          `Dogfood will run directly in ${repository.branch ?? 'the current branch'} rather than an isolated worktree.`,
          ['Prefer a dedicated dogfood branch and worktree so an abort leaves the operator tree untouched.'],
        ),
      );
    } else {
      findings.push(
        ok(
          'target.working-tree',
          `Dogfood is confined to the isolated worktree ${target.worktreePath ?? '(configured)'} on ${repository.branch ?? 'a dedicated branch'}.`,
        ),
      );
    }
  }

  // -- Runners --------------------------------------------------------------
  if (profile !== 'offline') {
    if (!economics.localModelConfigured) {
      findings.push(
        refuse(
          'runners.local',
          `Profile "${profile}" exercises real local compute, but no local model is configured or enabled.`,
          [
            'Configure localInference in .specbridge/config.json, or run with --profile offline.',
          ],
        ),
      );
    } else {
      findings.push(ok('runners.local', 'Local inference is configured and enabled.'));
    }
  }
  if (profile === 'subscription' || profile === 'full') {
    if (!economics.subscriptionWorkerConfigured) {
      findings.push(
        refuse(
          'runners.subscription',
          `Profile "${profile}" requires a subscription-backed strong worker, and no role routes to one.`,
          ['Route at least one role to the large agent, or use a lower profile.'],
        ),
      );
    } else {
      findings.push(ok('runners.subscription', 'A subscription-backed strong worker is configured.'));
    }
    if (economics.quotaTelemetrySource === 'none') {
      findings.push(
        warn(
          'quota.telemetry',
          'No quota telemetry source is configured; quota-aware scheduling will operate without observations.',
          ['Record observations with `specbridge orchestrate quota-set` for real quota-window validation.'],
        ),
      );
    } else {
      findings.push(
        ok('quota.telemetry', `Quota telemetry source: ${economics.quotaTelemetrySource}.`),
      );
    }
  }

  // -- Economic configuration ----------------------------------------------
  //
  // Showing this is not approving it. The refusals below are about the
  // configuration being INCOHERENT — spending enabled with no budget, or
  // automatic spending with no way to price a call — not about the amount.
  findings.push(ok('economics.api-spend-mode', `API spend mode: ${economics.apiSpendMode}.`));
  if (economics.apiSpendMode !== 'DISABLED') {
    if (economics.apiMaxBudgetUsd === null) {
      findings.push(
        refuse(
          'economics.api-budget',
          `API spend mode is ${economics.apiSpendMode} with no maximum total budget configured.`,
          ['Set jobs.scheduler.api.budget.maxTotalUsd, or set spendMode to DISABLED.'],
        ),
      );
    } else {
      findings.push(
        ok(
          'economics.api-budget',
          `API budget ceiling: $${economics.apiMaxBudgetUsd.toFixed(2)} total` +
            (economics.apiPerTaskCeilingUsd === null
              ? ''
              : `, $${economics.apiPerTaskCeilingUsd.toFixed(2)} per task`) +
            '.',
        ),
      );
    }
    if (economics.apiSpendMode === 'AUTO_BOUNDED' && !economics.apiPricingConfigured) {
      findings.push(
        refuse(
          'economics.api-pricing',
          'AUTO_BOUNDED spending requires a pricing profile; without one, cost cannot be estimated before dispatch.',
          ['Configure jobs.scheduler.api.pricing, or use MANUAL spend mode.'],
        ),
      );
    }
    if (economics.apiHarnessProfile === null) {
      findings.push(
        refuse(
          'economics.api-binding',
          `API spend mode is ${economics.apiSpendMode} with no API harness profile bound.`,
          ['Bind jobs.scheduler.api.harnessProfile, or set spendMode to DISABLED.'],
        ),
      );
    }
  }
  if (paidCapable && economics.apiSpendMode === 'DISABLED') {
    findings.push(
      ok(
        'economics.api-spend',
        'The "full" profile is selected but API spending is DISABLED. This run will spend nothing, which is a valid result.',
      ),
    );
  }
  if (!paidCapable && economics.apiSpendMode !== 'DISABLED') {
    findings.push(
      ok(
        'economics.api-profile',
        `Profile "${profile}" will not use the API lane regardless of spend mode ${economics.apiSpendMode}.`,
      ),
    );
  }

  // -- Verification and protected paths -------------------------------------
  if (economics.verificationCommands.length === 0) {
    findings.push(
      refuse(
        'verification.commands',
        'No trusted verification commands are configured; nothing could verify a completion.',
        ['Configure verificationCommands in .specbridge/config.json.'],
      ),
    );
  } else {
    findings.push(
      ok(
        'verification.commands',
        `Trusted verification: ${economics.verificationCommands.join(', ')}.`,
      ),
    );
  }
  findings.push(
    economics.protectedPaths.length === 0
      ? warn(
          'governance.protected-paths',
          'No protected paths are configured for the target repository.',
          ['Protect the paths a dogfood agent must never modify.'],
        )
      : ok(
          'governance.protected-paths',
          `Protected paths: ${economics.protectedPaths.length} configured.`,
        ),
  );

  findings.push(
    ok(
      'runtime.strategies',
      `Context strategy: ${economics.contextStrategy}; adaptive scheduler mode: ${economics.adaptiveMode}.`,
    ),
  );

  return {
    profile,
    findings,
    economics,
    safe: !findings.some((finding) => finding.severity === 'refuse'),
    paidCapable,
  };
}

/**
 * Refuse to start when preflight is unsafe.
 *
 * Separated from `runPreflight` so the CLI can DISPLAY an unsafe preflight
 * without starting anything — inspecting a refusal must not itself be an
 * error, or operators learn to skip the check.
 */
export function assertPreflightSafe(result: PreflightResult): void {
  const refusals = result.findings.filter((finding) => finding.severity === 'refuse');
  if (refusals.length === 0) return;
  throw new OrchestrationError(
    'SBO054',
    `Dogfood preflight refused: ${refusals.map((finding) => finding.message).join(' ')}`,
    {
      remediation: refusals.flatMap((finding) => finding.remediation),
      details: { findings: refusals.map((finding) => finding.id) },
    },
  );
}

/** Normalize an operator-supplied target path without inventing a default. */
export function normalizeTargetPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return path.resolve(trimmed);
}
