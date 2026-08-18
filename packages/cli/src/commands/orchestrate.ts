import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, readAgentConfig } from '@specbridge/core';
import type { OrchestrationState } from '@specbridge/orchestration';
import {
  ORCHESTRATION_PHASES,
  budgetUsage,
  describeOrchestration,
  explainOrchestration,
  listOrchestrationRuns,
  orchestrationStorageBytes,
  readOrchestrationEvents,
  readPlanRevision,
  requireOrchestrationState,
} from '@specbridge/orchestration';
import {
  blockedLine,
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge orchestrate …` — deterministic, read-only inspection of
 * governed orchestration runs.
 *
 * Everything here reads persisted structured state. No command invokes a
 * model, interprets natural language, starts or advances a run, runs a
 * command, or writes anything: a CLI that claims to be deterministic must
 * actually be. Driving a run is the job of the MCP surface and the
 * `/specbridge:develop` skill.
 */

function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

/** Phases that mean the run is waiting on the user rather than on work. */
const WAITING_PHASES = new Set(['NEEDS_CLARIFICATION', 'AWAITING_PLAN_REVIEW', 'BLOCKED']);

function phaseLine(state: OrchestrationState): string {
  if (state.phase === 'COMPLETED') return okLine(`${state.orchestrationId}  ${state.phase}`);
  if (state.phase === 'REJECTED') return failLine(`${state.orchestrationId}  ${state.phase}`);
  if (WAITING_PHASES.has(state.phase)) return blockedLine(`${state.orchestrationId}  ${state.phase}`);
  return infoLine(`${state.orchestrationId}  ${state.phase}`);
}

export function registerOrchestrateCommands(program: Command, runtime: CliRuntime): void {
  const orchestrate = program
    .command('orchestrate')
    .description('Inspect governed agent orchestration runs (read-only, deterministic)');

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------
  orchestrate
    .command('status')
    .description('List orchestration runs with phase, plan revision, and blockers')
    .option('--spec <name>', 'only runs for one spec')
    .option('--active', 'only runs that are not finished')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { spec?: string; active?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const listed = listOrchestrationRuns(workspace);
      const runs = listed.runs.filter((run) => {
        if (options.spec !== undefined && run.specName !== options.spec) return false;
        if (options.active === true && run.finalizedAt !== undefined) return false;
        return true;
      });

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-status', {
          runs: runs.map((run) => {
            const explanation = explainOrchestration(run);
            return {
              orchestrationId: run.orchestrationId,
              specName: run.specName,
              taskId: run.taskId ?? null,
              phase: run.phase,
              final: explanation.final,
              planRevision: run.planRevision,
              planReviewed: explanation.planReviewed,
              openQuestions: run.openQuestions.length,
              exhaustedBudgets: explanation.exhaustedBudgets,
              summary: explanation.summary,
              nextAction: explanation.nextAction,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
            };
          }),
          diagnostics: listed.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
          })),
        });
        runtime.exitCode = listed.diagnostics.length > 0 ? EXIT_CODES.gateFailure : EXIT_CODES.ok;
        return;
      }

      runtime.out(reportTitle('Orchestration runs'));
      if (runs.length === 0) {
        runtime.out(dim('  No orchestration runs recorded in this workspace.'));
        runtime.out(dim('  Governed runs are started from an agent host (e.g. /specbridge:develop).'));
      }
      for (const run of runs) {
        const explanation = explainOrchestration(run);
        runtime.out(phaseLine(run));
        runtime.out(
          dim(
            `    spec ${run.specName}${run.taskId !== undefined ? `, task ${run.taskId}` : ''}` +
              `, plan revision ${run.planRevision}`,
          ),
        );
        runtime.out(dim(`    ${explanation.summary}`));
        if (explanation.exhaustedBudgets.length > 0) {
          runtime.out(warnLine(`    budget exhausted: ${explanation.exhaustedBudgets.join(', ')}`));
        }
      }
      for (const diagnostic of listed.diagnostics) {
        runtime.out(warnLine(`  ${diagnostic.code}: ${diagnostic.message}`));
      }
      runtime.exitCode = listed.diagnostics.length > 0 ? EXIT_CODES.gateFailure : EXIT_CODES.ok;
    });

  // -------------------------------------------------------------------------
  // show
  // -------------------------------------------------------------------------
  orchestrate
    .command('show <orchestration-id>')
    .description('One orchestration run in depth: plan, decisions, counters, recent events')
    .option('--events <count>', 'recent events to show (default 20, max 200)', '20')
    .option('--json', 'output a machine-readable JSON report')
    .action((orchestrationId: string, options: { events?: string; json?: boolean }) => {
      const workspace = runtime.workspace();
      const state = requireOrchestrationState(workspace, orchestrationId);
      const requested = Number.parseInt(options.events ?? '20', 10);
      const eventLimit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 20;
      const detail = describeOrchestration(workspace, state, { eventLimit });
      const plan =
        state.planRevision > 0
          ? readPlanRevision(workspace, orchestrationId, state.planRevision)
          : undefined;

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-show', {
          ...detail,
          storageBytes: orchestrationStorageBytes(workspace, orchestrationId),
          decisions: detail.decisions,
          plan:
            plan === undefined
              ? null
              : {
                  planId: plan.planId,
                  revision: plan.revision,
                  goal: plan.goal,
                  nonGoals: plan.nonGoals,
                  constraints: plan.constraints,
                  assumptions: plan.assumptions,
                  steps: plan.steps.map((step) => ({
                    id: step.id,
                    description: step.description,
                    status: step.status,
                  })),
                  testStrategy: plan.testStrategy,
                  verificationStrategy: plan.verificationStrategy,
                  binding: plan.binding,
                },
        });
        return;
      }

      runtime.out(reportTitle(`Orchestration ${state.orchestrationId}`));
      runtime.out(phaseLine(state));
      runtime.out(dim(`  ${detail.summary}`));
      runtime.out(dim(`  Next action: ${detail.nextAction}`));

      if (detail.openQuestions.length > 0) {
        runtime.out(sectionTitle('Open questions'));
        for (const question of detail.openQuestions) {
          runtime.out(`  - ${question.question}`);
          runtime.out(dim(`    why: ${question.whyItMatters}`));
        }
      }
      if (detail.decisions.length > 0) {
        runtime.out(sectionTitle('Decisions in force'));
        for (const decision of detail.decisions) {
          runtime.out(`  - ${decision.question}`);
          runtime.out(dim(`    ${decision.answer}  [${decision.source}]`));
        }
      }
      if (plan !== undefined) {
        runtime.out(sectionTitle(`Execution plan (revision ${plan.revision})`));
        runtime.out(`  Goal: ${plan.goal}`);
        for (const [index, step] of plan.steps.entries()) {
          runtime.out(`  ${index + 1}. ${step.description} ${dim(`[${step.status}]`)}`);
        }
        runtime.out(dim(`  Test strategy: ${plan.testStrategy}`));
        runtime.out(dim(`  Verification: ${plan.verificationStrategy}`));
        if (detail.planStale) {
          runtime.out(warnLine(`  Plan is STALE: ${detail.planStaleReasons.join(', ')}`));
        }
        runtime.out(
          detail.planReviewed
            ? okLine('  Plan review: approved')
            : warnLine('  Plan review: not approved'),
        );
      }

      runtime.out(sectionTitle('Budgets'));
      for (const budget of budgetUsage(state)) {
        const line = `  ${budget.name}: ${budget.used}/${budget.limit}`;
        runtime.out(budget.exhausted ? warnLine(`${line}  exhausted`) : dim(line));
      }

      if (detail.blocker !== undefined) {
        runtime.out(sectionTitle('Blocker'));
        runtime.out(blockedLine(`  ${detail.blocker.category}: ${detail.blocker.message}`));
        for (const step of detail.blocker.remediation) runtime.out(dim(`    - ${step}`));
      }

      runtime.out(sectionTitle(`Recent events (${detail.recentEvents.length} of ${detail.totalEvents})`));
      for (const event of detail.recentEvents) runtime.out(dim(`  ${event.at}  ${event.type}`));
      if (detail.interactiveRunIds.length > 0) {
        runtime.out(sectionTitle('Interactive execution runs'));
        for (const runId of detail.interactiveRunIds) runtime.out(dim(`  ${runId}`));
      }
    });

  // -------------------------------------------------------------------------
  // explain
  // -------------------------------------------------------------------------
  orchestrate
    .command('explain <orchestration-id>')
    .description('Why the run is where it is: blockers, staleness, budgets, next safe action')
    .option('--json', 'output a machine-readable JSON report')
    .action((orchestrationId: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const explanation = explainOrchestration(requireOrchestrationState(workspace, orchestrationId));

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-explain', { ...explanation });
        return;
      }

      runtime.out(reportTitle(`Why orchestration ${explanation.orchestrationId} is ${explanation.phase}`));
      runtime.out(`  ${explanation.summary}`);
      if (explanation.executionBlockedBecause !== undefined) {
        runtime.out(blockedLine(`  Execution has not started: ${explanation.executionBlockedBecause}`));
      }
      if (explanation.planStale) {
        runtime.out(warnLine(`  The active plan is stale: ${explanation.planStaleReasons.join(', ')}`));
      }
      if (explanation.exhaustedBudgets.length > 0) {
        runtime.out(warnLine(`  Exhausted budgets: ${explanation.exhaustedBudgets.join(', ')}`));
      }
      runtime.out(sectionTitle('Counters'));
      for (const budget of explanation.budgets) {
        runtime.out(dim(`  ${budget.name}: ${budget.used}/${budget.limit}`));
      }
      runtime.out(sectionTitle('Next action'));
      runtime.out(`  ${explanation.nextAction}`);
      runtime.out(dim(`  Allowed actions here: ${explanation.allowedActions.join(', ') || '(none)'}`));
    });

  // -------------------------------------------------------------------------
  // policy
  // -------------------------------------------------------------------------
  const policy = orchestrate
    .command('policy')
    .description('Inspect and validate the orchestration policy in .specbridge/config.json');

  policy
    .command('show')
    .description('Show the resolved orchestration policy and its source')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const read = readAgentConfig(workspace);
      if (read.config === undefined) {
        runtime.out(failLine('.specbridge/config.json is invalid; no policy could be resolved.'));
        for (const diagnostic of read.diagnostics) runtime.out(dim(`  ${diagnostic.message}`));
        runtime.exitCode = EXIT_CODES.usageError;
        return;
      }
      const orchestration = read.config.orchestration;

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-policy', {
          source: read.exists ? read.path : 'defaults (no configuration file)',
          sourceSchemaVersion: read.sourceSchemaVersion ?? null,
          orchestration,
        });
        return;
      }

      runtime.out(reportTitle('Orchestration policy'));
      runtime.out(dim(`  Source: ${read.exists ? read.path : 'built-in defaults (no config file)'}`));
      runtime.out(orchestration.enabled ? okLine('  enabled') : warnLine('  disabled'));
      runtime.out(sectionTitle('Planning'));
      runtime.out(dim(`  mode: ${orchestration.planning.mode}`));
      runtime.out(dim(`  maxReplans: ${orchestration.planning.maxReplans}`));
      runtime.out(sectionTitle('Execution budgets'));
      runtime.out(dim(`  maxIterations: ${orchestration.execution.maxIterations}`));
      runtime.out(dim(`  maxRepairCycles: ${orchestration.execution.maxRepairCycles}`));
      runtime.out(dim(`  maxNoProgressCycles: ${orchestration.execution.maxNoProgressCycles}`));
      runtime.out(dim(`  maxElapsedMs: ${orchestration.execution.maxElapsedMs}`));
      runtime.out(sectionTitle('Retry and clarification'));
      runtime.out(dim(`  maxTransientRetries: ${orchestration.retry.maxTransientRetries}`));
      runtime.out(dim(`  maxRounds: ${orchestration.clarification.maxRounds}`));
    });

  policy
    .command('validate')
    .description('Validate the orchestration policy without changing anything')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      const read = readAgentConfig(workspace);
      const problems = read.config === undefined ? read.diagnostics.map((d) => d.message) : [];
      const warnings: string[] = [];

      if (read.config !== undefined) {
        const orchestration = read.config.orchestration;
        if (!orchestration.enabled) {
          warnings.push('Orchestration is disabled; the governed workflow will refuse to start runs.');
        }
        if (orchestration.planning.mode === 'disabled') {
          warnings.push(
            'Planning mode is "disabled": no execution plan is required. Every other gate ' +
              '(approvals, evidence, verification, protected paths, budgets) still applies.',
          );
        }
        if (orchestration.planning.mode === 'auto') {
          warnings.push(
            'Planning mode is "auto": plans are recorded but not reviewed before the first edit.',
          );
        }
      }

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-policy-validate', {
          valid: problems.length === 0,
          problems,
          warnings,
        });
        runtime.exitCode = problems.length > 0 ? EXIT_CODES.usageError : EXIT_CODES.ok;
        return;
      }

      runtime.out(reportTitle('Orchestration policy validation'));
      if (problems.length === 0) {
        runtime.out(okLine('  Policy is valid.'));
      }
      for (const problem of problems) runtime.out(failLine(`  ${problem}`));
      for (const warning of warnings) runtime.out(warnLine(`  ${warning}`));
      runtime.exitCode = problems.length > 0 ? EXIT_CODES.usageError : EXIT_CODES.ok;
    });

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------
  orchestrate
    .command('events <orchestration-id>')
    .description('Bounded page of the append-only orchestration event history')
    .option('--limit <count>', 'events to return (default 50, max 500)', '50')
    .option('--offset <count>', 'events to skip from the newest (default 0)', '0')
    .option('--json', 'output a machine-readable JSON report')
    .action((orchestrationId: string, options: { limit?: string; offset?: string; json?: boolean }) => {
      const workspace = runtime.workspace();
      // Existence check first, so a bad id fails the same way everywhere.
      requireOrchestrationState(workspace, orchestrationId);
      const limit = Number.parseInt(options.limit ?? '50', 10);
      const offset = Number.parseInt(options.offset ?? '0', 10);
      const page = readOrchestrationEvents(workspace, orchestrationId, {
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      });

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-events', {
          orchestrationId,
          events: page.events,
          total: page.total,
          truncated: page.truncated,
        });
        return;
      }

      runtime.out(reportTitle(`Orchestration events (${page.events.length} of ${page.total})`));
      for (const event of page.events) {
        runtime.out(`  ${String(event['at'])}  ${String(event['type'])}`);
      }
      if (page.truncated) {
        runtime.out(dim('  History is persisted in full; use --limit/--offset to page through it.'));
      }
    });

  // -------------------------------------------------------------------------
  // phases (contract reference)
  // -------------------------------------------------------------------------
  orchestrate
    .command('phases')
    .description('List the orchestration phase vocabulary')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-phases', { phases: [...ORCHESTRATION_PHASES] });
        return;
      }
      runtime.out(reportTitle('Orchestration phases'));
      for (const phase of ORCHESTRATION_PHASES) runtime.out(`  ${phase}`);
    });
}
