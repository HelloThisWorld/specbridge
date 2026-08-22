import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import {
  answerClarification,
  buildQuotaForecast,
  cancelJob,
  decideApiSpendApproval,
  listApiSpendApprovals,
  readApiBudgetState,
  readApiSpendApproval,
  resolveApiHarnessBinding,
  summarizeApiBudget,
  computeDynamicReserve,
  classifyLocalExecutionShape,
  classifyLocalSuitability,
  createLocalManager,
  createJob,
  driveJob,
  evaluateLocalRuntime,
  managedLocalInference,
  executionPlanSchema,
  listJobs,
  readCandidate,
  readConflicts,
  readEvaluations,
  readExecutionLedger,
  listContextSelectionPlans,
  readContextExpansionState,
  readContextMetrics,
  listEvaluationResults,
  listFailureAssessments,
  listRecoveryDecisions,
  readTaskReliabilityState,
  summarizeExecutionLedger,
  readJobCheckpoint,
  readJobEvents,
  readLatestWorkGraph,
  readNodePlan,
  readProjection as readObjectiveProjection,
  readQuotaTelemetryFile,
  readSchedulingDecisions,
  readAdaptiveDecisions,
  readAdaptiveCalibration,
  loadAdaptiveProfiles,
  rebuildAdaptiveProfiles,
  summarizeCalibration,
  readWorkerRecords,
  recordQuotaObservation,
  recordJobEvent,
  requireGraphRevision,
  requireJobState,
  resolveLocalExecutionMode,
  resolveLocalHarnessBinding,
  resolveWorkers,
  reviewNodePlan,
  summarizeLocalRuntime,
} from '@specbridge/orchestration';
import { explainContextSelection, renderContextExplanation } from '@specbridge/context';
import { localModelDoctor } from '@specbridge/runners';
import { validateLocalInferenceConfig } from '@specbridge/core';
import type { DriverEvent, JobState } from '@specbridge/orchestration';
import {
  blockedLine,
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { loadExecutionContext } from '../execution-context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge orchestrate run/jobs/job/…` — the long-running job surface.
 *
 * `run` is the ONE command in the orchestrate group that drives work: a
 * foreground persistent loop over durable job state (Ctrl+C interrupts
 * safely; the job resumes with `run` again). Everything else here stays
 * deterministic and read-only or a thin recorded human decision (answer,
 * review-plan, cancel-job) — no command interprets natural language or
 * invents policy.
 */

function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

/**
 * Formatters for the adaptive diagnostic. Every one renders an absent
 * measurement as "n/a" rather than as a zero: a profile that never observed
 * a cost must not print "$0.0000", which reads as free.
 */
function formatMs(value: number | null): string {
  if (value === null) return 'n/a';
  return value >= 60_000 ? `${Math.round(value / 60_000)}m` : `${Math.round(value / 1_000)}s`;
}

function formatCount(value: number | null): string {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}

function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function formatUsd(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(4)}`;
}

function formatScore(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

function statusLine(job: JobState): string {
  const label = `${job.jobId}  ${job.status}  spec ${job.specName}`;
  if (job.status === 'COMPLETED') return okLine(label);
  if (job.status === 'FAILED' || job.status === 'CANCELLED') return failLine(label);
  if (job.status === 'BLOCKED' || job.status === 'NEEDS_CLARIFICATION') return blockedLine(label);
  return infoLine(label);
}

function jobSummary(job: JobState): Record<string, unknown> {
  return {
    jobId: job.jobId,
    specName: job.specName,
    status: job.status,
    graphRevision: job.graphRevision,
    currentNodeId: job.currentNodeId ?? null,
    counters: job.counters,
    budgets: job.budgets,
    openQuestions: job.openQuestions.map((question) => ({
      id: question.id,
      question: question.question,
      whyItMatters: question.whyItMatters,
    })),
    escalations: job.escalations.length,
    blocker: job.blocker ?? null,
    latestEvidence: job.latestEvidence ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finalOutcome: job.finalOutcome ?? null,
  };
}

export function registerOrchestrateJobCommands(orchestrate: Command, runtime: CliRuntime): void {
  // -------------------------------------------------------------------------
  // run — the long-running foreground orchestrator
  // -------------------------------------------------------------------------
  orchestrate
    .command('run')
    .description('Run the long-running job orchestrator for one approved spec (foreground, resumable)')
    .argument('<spec>', 'spec name under .kiro/specs/')
    .option('--goal <text>', 'stated goal recorded on the job (default: implement the approved plan)')
    .option('--resume <jobId>', 'resume an existing job instead of creating one')
    .option('--dry-run', 'validate and show what would run, without creating or advancing anything')
    .option('--json', 'output a machine-readable JSON report of the final state')
    .action(
      async (
        specName: string,
        options: { goal?: string; resume?: string; dryRun?: boolean; json?: boolean },
      ) => {
        const context = loadExecutionContext(runtime);
        const deps = {
          workspace: context.workspace,
          config: context.config,
          registry: context.registry,
          host: 'cli',
        };

        if (options.dryRun === true) {
          const workers = resolveWorkers(context.config);
          const jobsPolicy = context.config.orchestration.jobs;
          const doctor = await localModelDoctor(context.config.localInference);
          if (options.json === true) {
            jsonOut(runtime, 'orchestrate-run-dry-run', {
              specName,
              jobsEnabled: jobsPolicy.enabled,
              workers: workers.map((worker) => ({
                workerId: worker.workerId,
                roles: worker.roles,
                reasoningTier: worker.reasoningTier,
                costTier: worker.costTier,
                repositoryWrite: worker.repositoryWrite,
              })),
              routing: jobsPolicy.routing,
              planReview: jobsPolicy.planReview,
              escalation: jobsPolicy.escalation,
              budgets: jobsPolicy.budgets,
              localModel: {
                startable: doctor.startable,
                problems: doctor.configProblems,
              },
            });
            return;
          }
          runtime.out(reportTitle('Orchestrate dry run'));
          runtime.out(infoLine(`spec: ${specName}`));
          runtime.out(infoLine(`plan review: ${jobsPolicy.planReview}; escalation: ${jobsPolicy.escalation}`));
          runtime.out(infoLine(`workers:`));
          for (const worker of workers) {
            runtime.out(
              dim(
                `  ${worker.workerId} (${worker.reasoningTier}, ${worker.costTier}) roles ${worker.roles.join('/')}` +
                  `${worker.repositoryWrite ? ' [writes repository]' : ' [read-only]'}`,
              ),
            );
          }
          runtime.out(
            doctor.startable
              ? okLine('local model: configured and startable')
              : warnLine(`local model: not startable (${doctor.configProblems.join('; ') || 'not configured'})`),
          );
          runtime.out(dim('  No job was created. Run without --dry-run to start.'));
          return;
        }

        let jobId: string;
        if (options.resume !== undefined) {
          const existing = requireJobState(context.workspace, options.resume);
          if (existing.specName !== specName) {
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `Job ${options.resume} belongs to spec "${existing.specName}", not "${specName}".`,
            );
          }
          jobId = existing.jobId;
        } else {
          // One active job per spec: resuming is explicit, never accidental.
          const active = listJobs(context.workspace).jobs.find(
            (job) => job.specName === specName && job.finalizedAt === undefined,
          );
          if (active !== undefined) {
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `Job ${active.jobId} is already active (${active.status}) for "${specName}". ` +
                `Resume it with --resume ${active.jobId}, or cancel it with \`${CLI_BIN} orchestrate cancel-job ${active.jobId}\`.`,
            );
          }
          const job = createJob(deps, {
            specName,
            goal: options.goal ?? `Implement the approved task plan of "${specName}".`,
          });
          jobId = job.jobId;
          runtime.out(okLine(`Created job ${jobId} for spec ${specName}.`));
        }

        const controller = new AbortController();
        const onSigint = (): void => {
          runtime.err('Interrupt received; checkpointing and stopping (the job stays resumable)…');
          controller.abort();
        };
        process.once('SIGINT', onSigint);

        try {
          const result = await driveJob(deps, jobId, {
            signal: controller.signal,
            onEvent: (event: DriverEvent) => {
              if (event.kind === 'decision') runtime.out(dim(`  → ${event.message}`));
              else runtime.out(infoLine(`${event.kind}: ${event.message}`));
            },
          });

          if (options.json === true) {
            jsonOut(runtime, 'orchestrate-run', {
              jobId,
              stop: result.stop,
              job: jobSummary(result.job),
            });
          } else {
            runtime.out('');
            switch (result.stop.kind) {
              case 'completed':
                runtime.out(okLine(`Job ${jobId} COMPLETED: every task verified through the evidence pipeline.`));
                break;
              case 'needs-human':
                runtime.out(blockedLine(`Job ${jobId} needs you: ${result.stop.detail}`));
                runtime.out(
                  dim(
                    result.stop.what === 'plan-review'
                      ? `  Review with \`${CLI_BIN} orchestrate node-plan ${jobId} <nodeId>\` then \`${CLI_BIN} orchestrate review-plan ${jobId} <nodeId> --approve\`.`
                      : `  Answer with \`${CLI_BIN} orchestrate answer ${jobId} <questionId> <answer…>\`, then resume.`,
                  ),
                );
                break;
              case 'blocked':
                runtime.out(blockedLine(`Job ${jobId} BLOCKED: ${result.stop.reason}`));
                break;
              case 'interrupted':
                runtime.out(warnLine(`Job ${jobId} interrupted; resume with \`${CLI_BIN} orchestrate run ${specName} --resume ${jobId}\`.`));
                break;
              case 'final':
                runtime.out(infoLine(`Job ${jobId} is already ${result.stop.status}.`));
                break;
            }
          }
          runtime.exitCode = result.stop.kind === 'completed' ? EXIT_CODES.ok : EXIT_CODES.gateFailure;
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
      },
    );

  // -------------------------------------------------------------------------
  // jobs / job — read-only inspection
  // -------------------------------------------------------------------------
  orchestrate
    .command('jobs')
    .description('List orchestration jobs (read-only)')
    .option('--spec <name>', 'only jobs for one spec')
    .option('--active', 'only jobs that are not finished')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { spec?: string; active?: boolean; json?: boolean }) => {
      const workspace = runtime.workspace();
      const listed = listJobs(workspace);
      const jobs = listed.jobs.filter((job) => {
        if (options.spec !== undefined && job.specName !== options.spec) return false;
        if (options.active === true && job.finalizedAt !== undefined) return false;
        return true;
      });
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-jobs', {
          jobs: jobs.map(jobSummary),
          diagnostics: listed.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
          })),
        });
        return;
      }
      runtime.out(reportTitle('Orchestration jobs'));
      if (jobs.length === 0) {
        runtime.out(dim('  No jobs in this workspace. Start one with `specbridge orchestrate run <spec>`.'));
      }
      for (const job of jobs) {
        runtime.out(statusLine(job));
        runtime.out(
          dim(
            `    graph revision ${job.graphRevision}, agent runs ${job.counters.agentRuns}/${job.budgets.maxAgentRuns}` +
              `, replans ${job.counters.jobReplans}/${job.budgets.maxJobReplans}, escalations ${job.counters.escalations}`,
          ),
        );
      }
      for (const diagnostic of listed.diagnostics) runtime.out(warnLine(diagnostic.message));
    });

  orchestrate
    .command('job')
    .description('Show one job: status, graph nodes, questions, blocker (read-only)')
    .argument('<jobId>')
    .option('--events <n>', 'also show the last N events')
    .option('--json', 'output a machine-readable JSON report')
    .action((jobId: string, options: { events?: string; json?: boolean }) => {
      const workspace = runtime.workspace();
      const job = requireJobState(workspace, jobId);
      const graph = job.graphRevision > 0 ? requireGraphRevision(workspace, jobId, job.graphRevision) : undefined;
      const checkpoint = readJobCheckpoint(workspace, jobId);
      const eventLimit = options.events !== undefined ? Math.max(1, Number(options.events) || 20) : 0;
      const events = eventLimit > 0 ? readJobEvents(workspace, jobId, { limit: eventLimit }) : undefined;

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-job', {
          job: jobSummary(job),
          graph:
            graph !== undefined
              ? {
                  revision: graph.revision,
                  nodes: graph.nodes.map((node) => ({
                    nodeId: node.nodeId,
                    taskId: node.parentTaskId,
                    title: node.title,
                    status: node.status,
                    complexity: node.complexity ?? null,
                    planRevision: node.planRevision,
                    planApproved: node.planApproved,
                    humanReviewRequired: node.humanReviewRequired,
                    attempts: node.attempts.length,
                    repairCycles: node.repairCycles,
                    replans: node.replans,
                    latestFailure: node.latestFailure ?? null,
                    latestDiagnosis: node.latestDiagnosis ?? null,
                  })),
                }
              : null,
          checkpoint: checkpoint ?? null,
          ...(events !== undefined ? { events: events.events } : {}),
        });
        return;
      }

      runtime.out(reportTitle(`Job ${jobId}`));
      runtime.out(statusLine(job));
      runtime.out(dim(`    goal: ${job.goal.slice(0, 120)}`));
      if (job.blocker !== undefined) {
        runtime.out(blockedLine(`  blocker [${job.blocker.code}]: ${job.blocker.message}`));
        for (const line of job.blocker.remediation) runtime.out(dim(`    ${line}`));
      }
      for (const question of job.openQuestions) {
        runtime.out(warnLine(`  question ${question.id}: ${question.question}`));
      }
      if (graph !== undefined) {
        runtime.out('');
        runtime.out(reportTitle('Runtime graph'));
        for (const node of graph.nodes) {
          const marks = [
            node.complexity ?? '?',
            `plan r${node.planRevision}${node.planApproved ? '✓' : node.humanReviewRequired ? ' needs review' : ''}`,
            `${node.attempts.length} attempt(s)`,
          ].join(', ');
          const line = `${node.nodeId}  ${node.status}  task ${node.parentTaskId} (${marks})`;
          runtime.out(
            node.status === 'COMPLETED'
              ? okLine(line)
              : node.status === 'FAILED'
                ? failLine(line)
                : node.status === 'BLOCKED'
                  ? blockedLine(line)
                  : infoLine(line),
          );
        }
      }
      if (checkpoint !== undefined) {
        runtime.out('');
        runtime.out(dim(`  next action: ${checkpoint.nextAction}`));
      }
      if (events !== undefined) {
        runtime.out('');
        runtime.out(reportTitle(`Last ${events.events.length} events`));
        for (const event of events.events) {
          runtime.out(dim(`  ${String(event['at'])}  ${String(event['type'])}`));
        }
      }
    });

  // -------------------------------------------------------------------------
  // node-plan — read a node's plan for human review
  // -------------------------------------------------------------------------
  orchestrate
    .command('node-plan')
    .description("Show a node's execution plan (read-only)")
    .argument('<jobId>')
    .argument('<nodeId>')
    .option('--revision <n>', 'plan revision (default: the active one)')
    .option('--json', 'output the raw plan document')
    .action((jobId: string, nodeId: string, options: { revision?: string; json?: boolean }) => {
      const workspace = runtime.workspace();
      const job = requireJobState(workspace, jobId);
      const graph = requireGraphRevision(workspace, jobId, job.graphRevision);
      const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node === undefined) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `Node ${nodeId} does not exist in job ${jobId}.`);
      }
      const revision = options.revision !== undefined ? Number(options.revision) : node.planRevision;
      const raw = readNodePlan(workspace, jobId, nodeId, revision);
      if (raw === undefined) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `No plan revision ${revision} exists for node ${nodeId}.`);
      }
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-node-plan', { jobId, nodeId, revision, plan: raw });
        return;
      }
      const parsed = executionPlanSchema.safeParse(raw);
      if (!parsed.success) {
        runtime.out(warnLine('The stored plan does not parse; showing raw JSON.'));
        runtime.out(JSON.stringify(raw, null, 2));
        return;
      }
      const plan = parsed.data;
      runtime.out(reportTitle(`Plan for ${nodeId} (task ${node.parentTaskId}), revision ${plan.revision}`));
      runtime.out(infoLine(`goal: ${plan.goal}`));
      for (const step of plan.steps) runtime.out(dim(`  ${step.id}. ${step.description}`));
      runtime.out(infoLine(`test strategy: ${plan.testStrategy}`));
      runtime.out(infoLine(`verification: ${plan.verificationStrategy}`));
      if (plan.assumptions.length > 0) {
        runtime.out(warnLine(`assumptions: ${plan.assumptions.join('; ')}`));
      }
      if (node.humanReviewRequired) {
        runtime.out('');
        runtime.out(
          blockedLine(
            `This plan awaits your review: \`${CLI_BIN} orchestrate review-plan ${jobId} ${nodeId} --approve\` or --reject.`,
          ),
        );
      }
    });

  // -------------------------------------------------------------------------
  // Human decisions: review-plan, answer, cancel-job
  // -------------------------------------------------------------------------
  orchestrate
    .command('review-plan')
    .description("Record YOUR review of a node's pending plan (human decision)")
    .argument('<jobId>')
    .argument('<nodeId>')
    .option('--approve', 'approve the plan for execution')
    .option('--reject', 'reject the plan (a replacement will be planned)')
    .option('--note <text>', 'optional note recorded with the decision')
    .action((jobId: string, nodeId: string, options: { approve?: boolean; reject?: boolean; note?: string }) => {
      if (options.approve === options.reject) {
        throw new SpecBridgeError('INVALID_ARGUMENT', 'Pass exactly one of --approve or --reject.');
      }
      const context = loadExecutionContext(runtime);
      const deps = { workspace: context.workspace, config: context.config, host: 'cli' };
      reviewNodePlan(deps, jobId, {
        nodeId,
        decision: options.approve === true ? 'approved' : 'rejected',
        note: options.note,
      });
      runtime.out(
        okLine(
          `Recorded: plan ${options.approve === true ? 'approved' : 'rejected'} for ${nodeId}. ` +
            `Resume with \`${CLI_BIN} orchestrate run <spec> --resume ${jobId}\`.`,
        ),
      );
    });

  orchestrate
    .command('answer')
    .description('Answer an open clarification question (human decision)')
    .argument('<jobId>')
    .argument('<questionId>')
    .argument('<answer...>')
    .action((jobId: string, questionId: string, answerWords: string[]) => {
      const context = loadExecutionContext(runtime);
      const deps = { workspace: context.workspace, config: context.config, host: 'cli' };
      const job = answerClarification(deps, jobId, [
        { questionId, answer: answerWords.join(' ') },
      ]);
      runtime.out(okLine(`Recorded the decision. ${job.openQuestions.length} question(s) remain open.`));
      if (job.openQuestions.length === 0) {
        runtime.out(dim(`  Resume with \`${CLI_BIN} orchestrate run ${job.specName} --resume ${jobId}\`.`));
      }
    });

  orchestrate
    .command('cancel-job')
    .description('Cancel a job (final; never auto-restarted)')
    .argument('<jobId>')
    .option('--reason <text>', 'reason recorded on the cancellation', 'cancelled from the CLI')
    .action((jobId: string, options: { reason: string }) => {
      const context = loadExecutionContext(runtime);
      const deps = { workspace: context.workspace, config: context.config, host: 'cli' };
      const job = cancelJob(deps, jobId, options.reason);
      runtime.out(okLine(`Job ${jobId} is ${job.status}.`));
    });

  // ---------------------------------------------------------------------------
  // Objective-runtime inspection (read-only)
  // ---------------------------------------------------------------------------
  orchestrate
    .command('objective')
    .description('One objective in depth: work graph, unit statuses, workers, conflicts, evaluations')
    .argument('<jobId>')
    .argument('<nodeId>')
    .option('--json', 'output a machine-readable JSON report')
    .action((jobId: string, nodeId: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      requireJobState(workspace, jobId);
      const graph = readLatestWorkGraph(workspace, jobId, nodeId);
      const conflicts = readConflicts(workspace, jobId, nodeId);
      const workers = readWorkerRecords(workspace, jobId, nodeId);
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-objective', {
          workGraph: graph ?? null,
          conflicts,
          workers,
          evaluations: readEvaluations(workspace, jobId, nodeId),
        });
        return;
      }
      if (graph === undefined) {
        runtime.out(dim('  no work graph exists for this objective yet'));
        return;
      }
      runtime.out(reportTitle(`Objective ${nodeId} (task ${graph.parentTaskId}) — work graph r${graph.revision}`));
      runtime.out(dim(`  proposed by ${graph.proposedBy}`));
      for (const unit of graph.units) {
        const label = `${unit.workUnitId} [${unit.status}] (${unit.kind}) ${unit.title}`;
        const line =
          unit.status === 'INTEGRATED' || unit.status === 'VERIFIED_CANDIDATE'
            ? okLine(label)
            : unit.status === 'FAILED' || unit.status === 'BLOCKED'
              ? blockedLine(label)
              : infoLine(label);
        runtime.out(`  ${line}`);
        if (unit.dependsOn.length > 0) runtime.out(dim(`      depends on ${unit.dependsOn.join(', ')}`));
        if (unit.latestFailure !== undefined) {
          runtime.out(warnLine(`      ${unit.latestFailure.category}: ${unit.latestFailure.message}`));
        }
      }
      if (conflicts.length > 0) {
        runtime.out(dim('  Contract conflicts:'));
        for (const conflict of conflicts) {
          runtime.out(blockedLine(`    ${conflict.conflictId} [${conflict.status}] ${conflict.contractId}: ${conflict.claims[0]?.claim ?? ''}`));
        }
      }
      if (workers.length > 0) {
        runtime.out(dim('  Workers:'));
        for (const worker of workers) {
          runtime.out(dim(`    ${worker.workerId} [${worker.status}] ${worker.agentRole} on ${worker.workspaceIdentity} (projection ${worker.contextProjectionHash.slice(0, 12)}…)`));
        }
      }
    });

  orchestrate
    .command('workunit')
    .description('One work unit in depth: projection identity, candidate, evaluations')
    .argument('<jobId>')
    .argument('<nodeId>')
    .argument('<workUnitId>')
    .option('--json', 'output a machine-readable JSON report')
    .action((jobId: string, nodeId: string, workUnitId: string, options: { json?: boolean }) => {
      const workspace = runtime.workspace();
      requireJobState(workspace, jobId);
      const graph = readLatestWorkGraph(workspace, jobId, nodeId);
      const unit = graph?.units.find((candidate) => candidate.workUnitId === workUnitId);
      if (unit === undefined) {
        runtime.out(failLine(`Work unit ${workUnitId} does not exist for objective ${nodeId}.`));
        runtime.exitCode = 2;
        return;
      }
      const attempt = Math.max(1, unit.attempt);
      const candidate = readCandidate(workspace, jobId, nodeId, workUnitId, attempt);
      const projection = readObjectiveProjection(workspace, jobId, nodeId, workUnitId, attempt);
      const evaluations = readEvaluations(workspace, jobId, nodeId, workUnitId);
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-workunit', {
          unit,
          candidate: candidate ?? null,
          projection: projection ?? null,
          evaluations,
        });
        return;
      }
      runtime.out(reportTitle(`Work unit ${workUnitId} [${unit.status}] — ${unit.title}`));
      runtime.out(`  Goal: ${unit.goal}`);
      runtime.out(dim(`  attempt ${unit.attempt}, kind ${unit.kind}`));
      if (projection !== undefined) {
        runtime.out(dim(`  projection ${projection.contentHash.slice(0, 16)}… over ${projection.contracts.length} contract(s), constitution v${projection.constitution.version}`));
      }
      if (candidate !== undefined) {
        runtime.out(
          candidate.localVerification.passed
            ? okLine(`  candidate: ${candidate.changedFiles.length} file(s), local verification ${candidate.localVerification.ran ? 'passed' : 'not run'}`)
            : warnLine(`  candidate: ${candidate.changedFiles.length} file(s), local verification FAILED`),
        );
        runtime.out(dim(`    claims: ${candidate.claims.summary}`));
      }
      for (const evaluation of evaluations) {
        const line = `  evaluation ${evaluation.evaluationId} [${evaluation.layer}] ${evaluation.verdict}`;
        runtime.out(evaluation.verdict === 'PASS' ? okLine(line) : blockedLine(line));
        for (const reason of evaluation.reasons.slice(0, 5)) runtime.out(dim(`      ${reason}`));
      }
    });

  // -------------------------------------------------------------------------
  // quota / quota-set / scheduler — vNext.2 quota-aware scheduling surface
  // -------------------------------------------------------------------------
  orchestrate
    .command('quota')
    .description('Show subscription quota telemetry and the derived scheduler forecast (read-only)')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      const context = loadExecutionContext(runtime);
      const policy = context.config.orchestration.jobs.scheduler;
      const file = readQuotaTelemetryFile(context.workspace);
      const forecast = buildQuotaForecast({
        fiveHour: file.fiveHour,
        weekly: file.weekly,
        now: new Date(),
        policy,
      });
      const reserve = computeDynamicReserve({
        forecast,
        policy: policy.reserve,
        weeklyPressureRatio: policy.weeklyPressureRatio,
      });
      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-quota', {
          telemetry: { fiveHour: file.fiveHour, weekly: file.weekly },
          forecast,
          reserveRatio: reserve.ratio,
          reserveBasis: reserve.basis,
        });
        return;
      }
      runtime.out(reportTitle('Subscription quota'));
      const percent = (ratio: number | null): string =>
        ratio === null ? 'unknown' : `${(ratio * 100).toFixed(1)}%`;
      const untilText = (ms: number | null): string =>
        ms === null ? 'unknown' : `${Math.round(ms / 60_000)}m`;
      runtime.out(
        infoLine(
          `  five-hour: ${percent(forecast.fiveHourRemainingRatio)} remaining, reset in ${untilText(forecast.timeToFiveHourResetMs)}`,
        ),
      );
      runtime.out(
        infoLine(
          `  weekly:    ${percent(forecast.weeklyRemainingRatio)} remaining, reset in ${untilText(forecast.timeToWeeklyResetMs)}`,
        ),
      );
      runtime.out(infoLine(`  scheduler mode: ${forecast.schedulerMode} (telemetry ${forecast.telemetryFreshness})`));
      runtime.out(infoLine(`  dynamic reserve: ${(reserve.ratio * 100).toFixed(1)}%`));
      if (forecast.telemetryFreshness !== 'FRESH') {
        runtime.out(
          warnLine(
            '  telemetry is not fresh; record an observation with `specbridge orchestrate quota-set`.',
          ),
        );
      }
    });

  orchestrate
    .command('quota-set')
    .description('Record one subscription quota observation into the manual telemetry file')
    .requiredOption('--window <window>', 'quota window: five-hour or weekly')
    .requiredOption('--remaining <percent>', 'remaining capacity as a percentage (0-100)')
    .option('--resets-in-minutes <minutes>', 'minutes until this window resets')
    .option('--reset-at <iso>', 'exact reset time (ISO 8601)')
    .action(
      (options: {
        window: string;
        remaining: string;
        resetsInMinutes?: string;
        resetAt?: string;
      }) => {
        const workspace = runtime.workspace();
        if (options.window !== 'five-hour' && options.window !== 'weekly') {
          runtime.out(failLine('--window must be "five-hour" or "weekly".'));
          runtime.exitCode = 2;
          return;
        }
        const remainingPercent = Number(options.remaining);
        if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
          runtime.out(failLine('--remaining must be a percentage between 0 and 100.'));
          runtime.exitCode = 2;
          return;
        }
        const now = new Date();
        let resetAt: string | undefined = options.resetAt;
        if (resetAt === undefined && options.resetsInMinutes !== undefined) {
          const minutes = Number(options.resetsInMinutes);
          if (!Number.isFinite(minutes) || minutes < 0) {
            runtime.out(failLine('--resets-in-minutes must be a non-negative number.'));
            runtime.exitCode = 2;
            return;
          }
          resetAt = new Date(now.getTime() + minutes * 60_000).toISOString();
        }
        recordQuotaObservation(workspace, {
          window: options.window,
          remainingRatio: remainingPercent / 100,
          ...(resetAt !== undefined ? { resetAt } : {}),
          observedAt: now.toISOString(),
        });
        runtime.out(
          okLine(
            `Recorded: ${options.window} at ${remainingPercent.toFixed(1)}% remaining` +
              `${resetAt !== undefined ? `, reset ${resetAt}` : ''}.`,
          ),
        );
      },
    );

  orchestrate
    .command('scheduler')
    .description('Show quota-scheduler state for one job: mode, reserve, ready tasks, recent decisions (read-only)')
    .argument('<jobId>')
    .option('--decisions <n>', 'number of recent scheduling decisions to show (default 10)')
    .option('--json', 'output a machine-readable JSON report')
    .action((jobId: string, options: { decisions?: string; json?: boolean }) => {
      const context = loadExecutionContext(runtime);
      const policy = context.config.orchestration.jobs.scheduler;
      const job = requireJobState(context.workspace, jobId);
      const graph =
        job.graphRevision > 0
          ? requireGraphRevision(context.workspace, jobId, job.graphRevision)
          : undefined;
      const file = readQuotaTelemetryFile(context.workspace);
      const forecast = buildQuotaForecast({
        fiveHour: file.fiveHour,
        weekly: file.weekly,
        now: new Date(),
        policy,
      });
      const reserve = computeDynamicReserve({
        forecast,
        policy: policy.reserve,
        weeklyPressureRatio: policy.weeklyPressureRatio,
      });
      const decisionLimit = Math.max(1, Number(options.decisions ?? '10') || 10);
      const decisions = readSchedulingDecisions(context.workspace, jobId, { limit: decisionLimit });
      const ledger = readExecutionLedger(context.workspace, jobId);
      const readyNodes = (graph?.nodes ?? []).filter((node) => node.status === 'READY');
      const laneCounts: Record<string, number> = {};
      for (const entry of ledger) {
        if (entry.role !== 'EXECUTOR') continue;
        const key = entry.lane ?? 'unassigned';
        laneCounts[key] = (laneCounts[key] ?? 0) + 1;
      }

      // vNext.4: how the LOCAL lane would spend its compute, and why. The
      // preview recomputes the same deterministic classifiers the driver
      // uses, so "which mode will this task use?" is answerable BEFORE a run.
      const binding = resolveLocalHarnessBinding(context.config);
      const localExecutionPolicy = policy.localExecution;
      const directAvailable =
        context.config.localInference.enabled &&
        validateLocalInferenceConfig(context.config.localInference).ok &&
        policy.allowLocalExecution;
      const verificationAvailable = context.config.verification.commands.length > 0;
      const modePreview = readyNodes.map((node) => {
        const suitability = classifyLocalSuitability({
          taskId: node.parentTaskId,
          title: node.title,
          complexity: node.complexity,
          deterministicVerificationAvailable: verificationAvailable,
          localWorkerAvailable: directAvailable,
          maxLocalAttempts: policy.maxLocalAttempts,
        });
        if (suitability.class === 'STRONG_REQUIRED') {
          return {
            nodeId: node.nodeId,
            taskId: node.parentTaskId,
            suitability: suitability.class,
            shape: null,
            executionMode: null,
            reasonCode: null,
            detail: 'Routed to the subscription lane; local execution modes do not apply.',
          };
        }
        const shape = classifyLocalExecutionShape({
          taskId: node.parentTaskId,
          title: node.title,
          taskCategory: suitability.category,
          complexity: node.complexity,
          priorDirectFailureNeedsRepository: job.escalations.some(
            (entry) => entry.nodeId === node.nodeId && entry.reason === 'LOCAL_DIRECT_TO_HARNESS',
          ),
        });
        const resolution = resolveLocalExecutionMode({
          strategy: localExecutionPolicy.strategy,
          suitability: suitability.class,
          shape,
          directAvailable,
          binding,
          localAttemptsUsed: 0,
          maxLocalAttempts: policy.maxLocalAttempts,
        });
        return {
          nodeId: node.nodeId,
          taskId: node.parentTaskId,
          suitability: suitability.class,
          shape: shape.shape,
          executionMode: resolution.mode,
          reasonCode: resolution.reasonCode,
          detail: resolution.detail,
        };
      });
      const localRuntime = summarizeLocalRuntime(ledger);

      // vNext.5: the paid continuity bridge, from the perspective a user
      // actually needs — "is this able to spend my money, has it, and if a
      // task is waiting instead of bridging, why?".
      const apiBinding = resolveApiHarnessBinding(context.config);
      const apiPolicy = policy.api;
      const budgetState = readApiBudgetState(context.workspace, jobId);
      const apiBudget = summarizeApiBudget(budgetState, apiPolicy.budget);
      const approvals = listApiSpendApprovals(context.workspace, jobId);
      const pendingApprovals = approvals.filter((entry) => entry.status === 'REQUESTED');
      const apiAttempts = ledger.filter((entry) => entry.lane === 'API');
      // The most recent gap-bridge conclusion per ready task: this is the
      // answer to "why is this task waiting instead of using the API?".
      const apiWaitReasons = readyNodes.flatMap((node) => {
        const latest = [...decisions]
          .reverse()
          .find((entry) => entry.nodeId === node.nodeId && entry.apiBridge !== null);
        return latest?.apiBridge == null
          ? []
          : [
              {
                nodeId: node.nodeId,
                taskId: node.parentTaskId,
                decision: latest.apiBridge.decision,
                reasonCode: latest.reasonCode,
                gapReason: latest.apiBridge.gapReason,
                estimatedGapDurationMs: latest.apiBridge.estimatedGapDurationMs,
                delaySensitivity: latest.apiBridge.delaySensitivity,
                estimatedCostUsd: latest.apiBridge.estimatedCostUsd,
                detail: latest.apiBridge.detail,
              },
            ];
      });

      // vNext.8: a COMPACT adaptive summary here; the full candidate
      // comparison, score breakdown, and calibration live in
      // `orchestrate adaptive`. Reading the profile store is deliberately
      // non-persisting: a read-only diagnostic must not rewrite a cache.
      const adaptivePolicy = policy.adaptive;
      const adaptiveDecisions = readAdaptiveDecisions(context.workspace, jobId, { limit: decisionLimit });
      const adaptiveProfiles =
        adaptivePolicy.mode === 'HEURISTIC'
          ? undefined
          : loadAdaptiveProfiles({
              workspace: context.workspace,
              policy: adaptivePolicy,
              now: new Date(),
              persist: false,
            });
      const adaptiveSummary = {
        mode: adaptivePolicy.mode,
        profileCount: adaptiveProfiles?.profiles.profiles.size ?? 0,
        observations: adaptiveProfiles?.profiles.observationCount ?? 0,
        profilesBuiltAt: adaptiveProfiles?.profiles.builtAt ?? null,
        decisions: adaptiveDecisions.length,
        applied: adaptiveDecisions.filter((entry) => entry.adaptiveApplied).length,
        disagreements: adaptiveDecisions.filter((entry) => entry.disagreement).length,
        fallbackReasons: adaptiveDecisions.reduce<Record<string, number>>((counts, entry) => {
          if (entry.fallbackReason === null) return counts;
          counts[entry.fallbackReason] = (counts[entry.fallbackReason] ?? 0) + 1;
          return counts;
        }, {}),
      };

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-scheduler', {
          schedulerEnabled: policy.enabled,
          forecast,
          reserveRatio: reserve.ratio,
          reserveBasis: reserve.basis,
          readyTasks: readyNodes.map((node) => ({
            nodeId: node.nodeId,
            taskId: node.parentTaskId,
            title: node.title,
            complexity: node.complexity ?? null,
          })),
          attemptLanes: laneCounts,
          adaptive: adaptiveSummary,
          localExecution: {
            strategy: localExecutionPolicy.strategy,
            directAvailable,
            binding: {
              status: binding.status,
              available: binding.available,
              profile: binding.profileName,
              runner: binding.runner,
              model: binding.model,
              computeLocality: binding.locality,
              localityEvidence: binding.localityEvidence,
              localityOverridden: binding.localityOverridden,
              credentialRisks: binding.credentialRisks,
              problems: binding.problems,
            },
            readyTaskModes: modePreview,
            observations: localRuntime,
          },
          api: {
            enabled: apiBinding.available && apiPolicy.spendMode !== 'DISABLED',
            spendMode: apiPolicy.spendMode,
            pricingConfigured: apiPolicy.pricing !== null,
            pricingSource: apiPolicy.pricing?.source ?? null,
            binding: {
              status: apiBinding.status,
              available: apiBinding.available,
              profile: apiBinding.profileName,
              runner: apiBinding.runner,
              provider: apiBinding.provider,
              model: apiBinding.model,
              computeLocality: apiBinding.locality,
              localityEvidence: apiBinding.localityEvidence,
              localityOverridden: apiBinding.localityOverridden,
              credentialSources: apiBinding.credentialSources,
              problems: apiBinding.problems,
            },
            budget: {
              ...apiBudget,
              maxCostPerJobUsd: apiPolicy.budget.maxCostPerJobUsd,
              maxCostPerTaskUsd: apiPolicy.budget.maxCostPerTaskUsd,
              maxCostPerAttemptUsd: apiPolicy.budget.maxCostPerAttemptUsd,
              reservations: budgetState.reservations,
            },
            attempts: apiAttempts.map((entry) => ({
              attemptId: entry.attemptId,
              taskId: entry.taskId,
              status: entry.status,
              provider: entry.provider,
              model: entry.model,
              gapReason: entry.gapReason,
              estimatedCostUsd: entry.metrics.estimatedCostUsd ?? null,
              reconciledCostUsd: entry.metrics.reconciledCostUsd ?? null,
              costSource: entry.costSource,
            })),
            approvals: approvals.map((entry) => ({
              approvalId: entry.approvalId,
              taskId: entry.taskId,
              status: entry.status,
              maxAuthorizedCostUsd: entry.maxAuthorizedCostUsd,
              expiresAt: entry.expiresAt,
            })),
            waitReasons: apiWaitReasons,
          },
          decisions,
        });
        return;
      }

      runtime.out(reportTitle(`Scheduler — job ${jobId}`));
      runtime.out(
        infoLine(
          `  mode ${forecast.schedulerMode} (telemetry ${forecast.telemetryFreshness}), reserve ${(reserve.ratio * 100).toFixed(1)}%`,
        ),
      );
      if (!policy.enabled) runtime.out(warnLine('  lane scheduling is disabled by configuration.'));
      runtime.out(
        infoLine(
          `  attempt lanes: ${Object.entries(laneCounts)
            .map(([laneName, count]) => `${laneName}=${count}`)
            .join(', ') || '(none yet)'}`,
        ),
      );
      runtime.out(reportTitle('Local execution (vNext.4)'));
      runtime.out(
        infoLine(
          `  strategy ${localExecutionPolicy.strategy}; direct ${directAvailable ? 'available' : 'unavailable'}; harness binding ${binding.status}`,
        ),
      );
      runtime.out(
        (binding.available ? okLine : warnLine)(
          `  harness: ${binding.profileName ?? '(none)'} [${binding.runner ?? 'n/a'}] model ${binding.model ?? 'unknown'} — compute ${binding.locality}`,
        ),
      );
      runtime.out(dim(`    ${binding.localityEvidence}`));
      for (const problem of binding.problems) runtime.out(warnLine(`    ${problem}`));
      if (binding.credentialRisks.length > 0) {
        runtime.out(
          warnLine(
            `    credential-shaped passthrough names: ${binding.credentialRisks.join(', ')} (names only)`,
          ),
        );
      }
      for (const [mode, stats] of Object.entries(localRuntime.byMode)) {
        const pass = stats.verificationPassRate;
        runtime.out(
          infoLine(
            `  ${mode}: ${stats.attempts} attempt(s), ${stats.completed} verified` +
              `${pass !== null ? `, pass rate ${(pass * 100).toFixed(0)}%` : ''}` +
              `${stats.medianWallTimeMs !== null ? `, median ${(stats.medianWallTimeMs / 1000).toFixed(1)}s` : ''}`,
          ),
        );
      }
      if (localRuntime.localToStrongEscalations > 0) {
        runtime.out(
          dim(`  ${localRuntime.localToStrongEscalations} local task(s) later escalated to the subscription lane.`),
        );
      }

      runtime.out(reportTitle('API gap bridge (vNext.5)'));
      const apiEnabled = apiBinding.available && apiPolicy.spendMode !== 'DISABLED';
      runtime.out(
        (apiEnabled ? okLine : dim)(
          `  spend mode ${apiPolicy.spendMode}; binding ${apiBinding.status}; ` +
            `${apiEnabled ? 'paid bridging is available' : 'no paid execution is possible'}`,
        ),
      );
      runtime.out(
        infoLine(
          `  profile: ${apiBinding.profileName ?? '(none)'} [${apiBinding.runner ?? 'n/a'}] ` +
            `provider ${apiBinding.provider ?? 'unknown'} model ${apiBinding.model ?? 'unknown'} — ` +
            `compute ${apiBinding.locality}`,
        ),
      );
      runtime.out(dim(`    ${apiBinding.localityEvidence}`));
      for (const problem of apiBinding.problems) runtime.out(warnLine(`    ${problem}`));
      if (apiBinding.credentialSources.length > 0) {
        runtime.out(
          dim(`    credential source names (values never read): ${apiBinding.credentialSources.join(', ')}`),
        );
      }
      runtime.out(
        infoLine(
          `  pricing: ${apiPolicy.pricing === null ? 'NOT CONFIGURED — automatic spend is refused' : apiPolicy.pricing.source}`,
        ),
      );
      runtime.out(
        infoLine(
          `  budget: reserved $${apiBudget.reservedUsd.toFixed(4)}, committed $${apiBudget.committedUsd.toFixed(4)}` +
            `${apiBudget.unknownUsd > 0 ? `, UNKNOWN $${apiBudget.unknownUsd.toFixed(4)}` : ''}` +
            `, remaining ${apiBudget.remainingUsd === null ? 'unbounded' : `$${apiBudget.remainingUsd.toFixed(4)}`}` +
            ` over ${apiBudget.attempts} attempt(s)`,
        ),
      );
      if (apiBudget.hasUnknownCost) {
        runtime.out(
          warnLine(
            '    at least one paid attempt could not report its cost; committed spend is a floor, not an exact figure.',
          ),
        );
      }
      for (const approval of pendingApprovals) {
        runtime.out(
          warnLine(
            `  approval pending: ${approval.approvalId} — task ${approval.taskId}, up to ` +
              `$${approval.maxAuthorizedCostUsd.toFixed(4)}, expires ${approval.expiresAt}`,
          ),
        );
        runtime.out(dim(`    approve: specbridge orchestrate api-approve ${jobId} ${approval.approvalId}`));
      }
      if (apiWaitReasons.length > 0) {
        runtime.out(infoLine('  why ready tasks are not bridging:'));
        for (const entry of apiWaitReasons) {
          runtime.out(
            dim(
              `    task ${entry.taskId}: ${entry.decision} [${entry.reasonCode}] — gap ${entry.gapReason}` +
                `${entry.estimatedGapDurationMs !== null ? ` (~${Math.round(entry.estimatedGapDurationMs / 60_000)}m)` : ' (unknown)'}` +
                `, delay ${entry.delaySensitivity}` +
                `${entry.estimatedCostUsd !== null ? `, est $${entry.estimatedCostUsd.toFixed(4)}` : ', cost unknown'}`,
            ),
          );
        }
      }

      runtime.out(reportTitle('Adaptive scheduler'));
      runtime.out(
        (adaptiveSummary.mode === 'ADAPTIVE' ? okLine : dim)(
          `  mode ${adaptiveSummary.mode}; ${adaptiveSummary.profileCount} profile(s) from ` +
            `${adaptiveSummary.observations} observation(s); ${adaptiveSummary.decisions} recent decision(s), ` +
            `${adaptiveSummary.applied} applied, ${adaptiveSummary.disagreements} disagreement(s)`,
        ),
      );
      for (const [reason, count] of Object.entries(adaptiveSummary.fallbackReasons)) {
        runtime.out(dim(`    fell back ${count}x: ${reason}`));
      }
      runtime.out(dim(`    detail: ${CLI_BIN} orchestrate adaptive ${jobId}`));

      runtime.out(reportTitle('Ready tasks'));
      if (readyNodes.length === 0) runtime.out(dim('  (none)'));
      for (const node of readyNodes) {
        runtime.out(infoLine(`  ${node.nodeId}  task ${node.parentTaskId}  ${node.title.slice(0, 80)}`));
        const preview = modePreview.find((entry) => entry.nodeId === node.nodeId);
        if (preview !== undefined) {
          runtime.out(
            dim(
              `    ${preview.suitability}${preview.shape !== null ? ` + ${preview.shape}` : ''} → ` +
                `${preview.executionMode ?? 'SUBSCRIPTION'}${preview.reasonCode !== null ? ` [${preview.reasonCode}]` : ''}`,
            ),
          );
        }
      }
      runtime.out(reportTitle(`Recent scheduling decisions (${decisions.length})`));
      for (const decision of decisions) {
        const line = `  ${decision.createdAt}  task ${decision.taskId} → ${decision.selectedLane} [${decision.reasonCode}] mode ${decision.schedulerMode}`;
        runtime.out(decision.selectedLane === 'DEFER' ? warnLine(line) : okLine(line));
        runtime.out(dim(`    ${decision.detail.slice(0, 140)}`));
      }
    });

  // vNext.8 adaptive compute scheduler. Read-only by construction, with one
  // exception that is still not a policy change: `--rebuild` discards a
  // DERIVED cache and recomputes it from canonical history. Nothing here can
  // alter a weight, a budget, a quota bound, or a placement — those are
  // control-plane policy, and a diagnostic that could edit them would be a
  // second way to configure the scheduler.
  orchestrate
    .command('adaptive')
    .description(
      'Show adaptive-scheduler state: mode, profiles, predictions, vetoes, fallbacks, calibration (read-only)',
    )
    .argument('[jobId]', 'job to explain adaptive decisions for (optional)')
    .option('--node <nodeId>', 'explain one node in detail')
    .option('--profiles', 'list derived performance profiles')
    .option('--level <level>', 'profile level filter (EXACT|TARGET_CATEGORY|LANE_CATEGORY|LANE_GLOBAL)')
    .option('--limit <n>', 'rows to show (default 20)')
    .option('--rebuild', 'discard and rebuild the derived profile cache from the ExecutionLedger')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (
        jobId: string | undefined,
        options: {
          node?: string;
          profiles?: boolean;
          level?: string;
          limit?: string;
          rebuild?: boolean;
          json?: boolean;
        },
      ) => {
        const context = loadExecutionContext(runtime);
        const policy = context.config.orchestration.jobs.scheduler.adaptive;
        const limit = Math.max(1, Number(options.limit ?? '20') || 20);
        const now = new Date();

        const loaded =
          options.rebuild === true
            ? rebuildAdaptiveProfiles({ workspace: context.workspace, policy, now })
            : loadAdaptiveProfiles({ workspace: context.workspace, policy, now, persist: false });

        const allProfiles = [...loaded.profiles.profiles.values()]
          .filter((profile) => options.level === undefined || profile.level === options.level)
          .sort((left, right) =>
            right.weightedSamples !== left.weightedSamples
              ? right.weightedSamples - left.weightedSamples
              : left.profileKey < right.profileKey
                ? -1
                : 1,
          );

        const decisions =
          jobId === undefined
            ? []
            : readAdaptiveDecisions(context.workspace, jobId, {
                limit,
                ...(options.node !== undefined ? { nodeId: options.node } : {}),
              });
        const calibration =
          jobId === undefined ? [] : readAdaptiveCalibration(context.workspace, jobId, { limit: 200 });
        const calibrationSummary = summarizeCalibration(calibration);

        const profileRows = allProfiles.slice(0, limit).map((profile) => ({
          level: profile.level,
          profileKey: profile.profileKey,
          lane: profile.lane,
          executionMode: profile.executionMode,
          samples: profile.samples,
          weightedSamples: Math.round(profile.weightedSamples * 100) / 100,
          verifiedSuccesses: profile.verifiedSuccesses,
          unverifiedSuccesses: profile.unverifiedSuccesses,
          implementationFailures: profile.implementationFailures,
          infrastructureFailures: profile.infrastructureFailures,
          inconclusive: profile.inconclusive,
          censored: profile.censored,
          attemptsPerSuccess: profile.attemptsPerSuccess,
          firstAttemptSuccesses: profile.firstAttemptSuccesses,
          firstAttempts: profile.firstAttempts,
          wallTimeMs: profile.wallTimeMs,
          inputTokens: profile.inputTokens,
          contextTokens: profile.contextTokens,
          fiveHourBurnRatio: profile.fiveHourBurnRatio,
          apiCostUsd: profile.apiCostUsd,
          stagnationRate: profile.stagnationRate,
          oscillationRate: profile.oscillationRate,
          runawayRate: profile.runawayRate,
          contextMissRate: profile.contextMissRate,
          contextExpansionRate: profile.contextExpansionRate,
          infrastructureFailureRate: profile.infrastructureFailureRate,
          safetyEvents: profile.safetyEvents,
          latestRuntimeIdentity: profile.latestRuntimeIdentity,
          lastObservedAt: profile.lastObservedAt,
          drift: profile.drift,
        }));

        if (options.json === true) {
          jsonOut(runtime, 'orchestrate-adaptive', {
            mode: policy.mode,
            enabled: policy.mode !== 'HEURISTIC',
            weights: policy.weights,
            thresholds: {
              minimumSamplesForAdaptiveDecision: policy.minimumSamplesForAdaptiveDecision,
              minimumComparableSamples: policy.minimumComparableSamples,
              minimumConfidence: policy.minimumConfidence,
              minimumUtilityImprovement: policy.minimumUtilityImprovement,
              priorStrength: policy.priorStrength,
              recencyHalfLifeMs: policy.recencyHalfLifeMs,
            },
            profileStore: {
              source: loaded.source,
              invalidatedReason: loaded.invalidatedReason,
              builtAt: loaded.profiles.builtAt,
              fingerprint: loaded.fingerprint,
              jobsScanned: loaded.jobsScanned,
              observations: loaded.profiles.observationCount,
              droppedByAge: loaded.profiles.droppedByAge,
              profileCount: loaded.profiles.profiles.size,
            },
            profiles: profileRows,
            decisions: decisions.map((decision) => ({
              decisionId: decision.decisionId,
              createdAt: decision.createdAt,
              nodeId: decision.nodeId,
              taskId: decision.taskId,
              mode: decision.mode,
              taskSignature: decision.taskSignature,
              heuristicLane: decision.heuristicLane,
              heuristicCandidateId: decision.heuristicCandidateId,
              recommendedCandidateId: decision.recommendedCandidateId,
              selectedCandidateId: decision.selectedCandidateId,
              adaptiveApplied: decision.adaptiveApplied,
              disagreement: decision.disagreement,
              wouldApplyInAdaptiveMode: decision.wouldApplyInAdaptiveMode,
              confidence: decision.confidence,
              utilityMargin: decision.utilityMargin,
              fallbackReason: decision.fallbackReason,
              rejectedCandidates: decision.rejectedCandidates,
              explanation: decision.explanation,
              ...(options.node !== undefined ? { predictions: decision.predictions } : {}),
            })),
            calibration: calibrationSummary,
          });
          return;
        }

        runtime.out(reportTitle('Adaptive compute scheduler (vNext.8)'));
        const modeLine =
          `  mode ${policy.mode}` +
          (policy.mode === 'HEURISTIC'
            ? ' — history is recorded but never ranks or places work'
            : policy.mode === 'SHADOW'
              ? ' — recommendations are computed and recorded; the heuristic still executes'
              : ' — history may select among policy-eligible candidates');
        runtime.out(policy.mode === 'ADAPTIVE' ? okLine(modeLine) : infoLine(modeLine));
        runtime.out(
          dim(
            `    floors: ${policy.minimumSamplesForAdaptiveDecision} weighted samples, ` +
              `${policy.minimumComparableSamples} comparable, confidence >= ${policy.minimumConfidence}, ` +
              `utility margin >= ${policy.minimumUtilityImprovement}`,
          ),
        );

        runtime.out(reportTitle('Derived profile store'));
        runtime.out(
          infoLine(
            `  ${loaded.profiles.profiles.size} profile(s) from ${loaded.profiles.observationCount} observation(s) ` +
              `across ${loaded.jobsScanned} job(s) — ${loaded.source}` +
              (loaded.invalidatedReason !== null ? ` (cache ${loaded.invalidatedReason})` : ''),
          ),
        );
        runtime.out(
          dim(
            `    built ${loaded.profiles.builtAt}; ${loaded.profiles.droppedByAge} observation(s) aged out; ` +
              'derived state — deleting it costs a rebuild and nothing else',
          ),
        );

        runtime.out(reportTitle(`Performance profiles (${allProfiles.length})`));
        if (profileRows.length === 0) {
          runtime.out(dim('  (none — cold start; the deterministic heuristics decide)'));
        }
        for (const profile of profileRows) {
          const resolving = profile.verifiedSuccesses + profile.implementationFailures;
          const rate =
            resolving > 0 ? `${Math.round((profile.verifiedSuccesses / resolving) * 100)}%` : 'n/a';
          runtime.out(
            okLine(
              `  [${profile.level}] ${profile.profileKey}  ` +
                `verified ${rate} (${profile.verifiedSuccesses}/${resolving})  ` +
                `samples ${profile.samples} (weighted ${profile.weightedSamples})`,
            ),
          );
          runtime.out(
            dim(
              `    P50/P90 wall ${formatMs(profile.wallTimeMs.p50)}/${formatMs(profile.wallTimeMs.p90)}  ` +
                `context ${formatCount(profile.contextTokens.p50)}/${formatCount(profile.contextTokens.p90)} tok  ` +
                `burn ${formatRatio(profile.fiveHourBurnRatio.p50)}/${formatRatio(profile.fiveHourBurnRatio.p90)}  ` +
                `cost ${formatUsd(profile.apiCostUsd.p50)}/${formatUsd(profile.apiCostUsd.p90)}`,
            ),
          );
          runtime.out(
            dim(
              `    infra-fail ${formatRate(profile.infrastructureFailureRate)}  ` +
                `inconclusive ${profile.inconclusive}  censored ${profile.censored}  ` +
                `unverified ${profile.unverifiedSuccesses}  ` +
                `stalled ${formatRate(profile.stagnationRate)}  oscillating ${formatRate(profile.oscillationRate)}  ` +
                `runaway ${formatRate(profile.runawayRate)}  context-miss ${formatRate(profile.contextMissRate)}`,
            ),
          );
          if (profile.safetyEvents > 0) {
            runtime.out(
              warnLine(`    ${profile.safetyEvents} safety-class failure(s) on record (these do not decay)`),
            );
          }
          if (profile.drift.detected) {
            runtime.out(warnLine(`    drift: ${profile.drift.detail}`));
          }
        }

        if (jobId === undefined) {
          runtime.out(dim('\n  Pass a job id to see its adaptive decisions and prediction accuracy.'));
          return;
        }

        runtime.out(reportTitle(`Adaptive decisions (${decisions.length})`));
        if (decisions.length === 0) {
          runtime.out(
            dim(
              policy.mode === 'HEURISTIC'
                ? '  (none — adaptive mode is HEURISTIC, so nothing is computed)'
                : '  (none recorded yet)',
            ),
          );
        }
        for (const decision of decisions) {
          const headline =
            `  ${decision.createdAt}  task ${decision.taskId} [${decision.mode}]  ` +
            `${decision.selectedCandidateId ?? 'no candidate'}`;
          runtime.out(decision.adaptiveApplied ? okLine(headline) : infoLine(headline));
          runtime.out(dim(`    signature ${decision.taskSignature}`));
          if (decision.disagreement) {
            runtime.out(
              warnLine(
                `    recommended ${decision.recommendedCandidateId ?? 'n/a'} but executed ` +
                  `${decision.heuristicCandidateId ?? 'n/a'}` +
                  (decision.mode === 'SHADOW'
                    ? ' — the alternative was NOT run, so no outcome is claimed for it'
                    : ''),
              ),
            );
          }
          runtime.out(
            dim(
              `    confidence ${decision.confidence}` +
                (decision.utilityMargin !== null
                  ? `, margin ${decision.utilityMargin.toFixed(4)}`
                  : '') +
                (decision.fallbackReason !== null
                  ? `, fell back: ${decision.fallbackReason}`
                  : ', adaptive decided'),
            ),
          );
          for (const line of decision.explanation) runtime.out(dim(`      ${line}`));
          for (const veto of decision.rejectedCandidates) {
            if (veto.code === 'LANE_NOT_ELIGIBLE') continue;
            runtime.out(warnLine(`    vetoed ${veto.candidateId}: ${veto.code} — ${veto.detail}`));
          }
          if (options.node !== undefined) {
            for (const prediction of decision.predictions) {
              runtime.out(
                infoLine(
                  `    ${prediction.candidateId}  score ${prediction.score.toFixed(4)}  ` +
                    `P(verified) ${(prediction.verifiedSuccessProbability * 100).toFixed(0)}%  ` +
                    `[${prediction.level}/${prediction.confidence}/${prediction.identityMatch}]  ` +
                    `${prediction.sampleCount} sample(s)`,
                ),
              );
              for (const component of prediction.scoreComponents) {
                runtime.out(
                  dim(
                    `        ${component.name.padEnd(22)} ${component.contribution >= 0 ? '+' : ''}` +
                      `${component.contribution.toFixed(4)}  ${component.detail}`,
                  ),
                );
              }
            }
          }
        }

        runtime.out(reportTitle('Prediction calibration'));
        if (calibrationSummary.records === 0) {
          runtime.out(dim('  (no calibration records yet)'));
        } else {
          runtime.out(
            infoLine(
              `  ${calibrationSummary.records} record(s), ${calibrationSummary.scoredRecords} with a ` +
                'resolvable success outcome',
            ),
          );
          runtime.out(
            dim(
              `    mean Brier ${formatScore(calibrationSummary.meanBrierScore)} (lower is better)  ` +
                `wall-time error ${formatRate(calibrationSummary.meanAbsoluteWallTimeError)}  ` +
                `context error ${formatRate(calibrationSummary.meanAbsoluteContextTokenError)}  ` +
                `cost error ${formatRate(calibrationSummary.meanAbsoluteCostError)}`,
            ),
          );
          runtime.out(
            dim(
              '    Calibration is derived metadata: a wrong forecast never edits the attempt, ' +
                'the evaluation, or the ledger.',
            ),
          );
        }
      },
    );

  // vNext.5 spend authorization. Deciding is a HUMAN action and lives only
  // here: no MCP tool, no agent-reachable API, and no model output can
  // approve spending. An agent can cause a request to exist by doing work
  // that stalls; it can never cause an authorization to exist.
  orchestrate
    .command('api-approve')
    .description('Approve one bounded API spend request for a task (human decision; CLI only)')
    .argument('<jobId>')
    .argument('<approvalId>')
    .option('--max-cost <usd>', 'authorize LESS than requested (never more)')
    .option('--note <text>', 'note recorded with the decision')
    .option('--by <name>', 'who is approving (recorded for audit)')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (
        jobId: string,
        approvalId: string,
        options: { maxCost?: string; note?: string; by?: string; json?: boolean },
      ) => {
        const context = loadExecutionContext(runtime);
        const existing = readApiSpendApproval(context.workspace, jobId, approvalId);
        if (existing === undefined) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            `No API spend approval "${approvalId}" exists for job ${jobId}.`,
          );
        }
        let maxAuthorizedCostUsd: number | undefined;
        if (options.maxCost !== undefined) {
          const parsed = Number(options.maxCost);
          if (!Number.isFinite(parsed) || parsed < 0) {
            throw new SpecBridgeError('INVALID_ARGUMENT', '--max-cost must be a non-negative number.');
          }
          if (parsed > existing.maxAuthorizedCostUsd) {
            // Raising the ceiling silently would turn "approve this" into
            // "approve more than was explained to me".
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `--max-cost ${parsed} exceeds the requested maximum ${existing.maxAuthorizedCostUsd}. ` +
                'An approval may authorize less than was requested, never more.',
            );
          }
          maxAuthorizedCostUsd = parsed;
        }
        const decided = decideApiSpendApproval({
          workspace: context.workspace,
          jobId,
          approvalId,
          decision: 'APPROVED',
          decidedBy: options.by ?? 'cli-user',
          ...(maxAuthorizedCostUsd !== undefined ? { maxAuthorizedCostUsd } : {}),
          ...(options.note !== undefined ? { note: options.note } : {}),
          now: new Date(),
        });
        recordJobEvent(
          { workspace: context.workspace, config: context.config },
          jobId,
          'api_approval_granted',
          {
            approvalId: decided.approvalId,
            nodeId: decided.nodeId,
            taskId: decided.taskId,
            maxAuthorizedCostUsd: decided.maxAuthorizedCostUsd,
            decidedBy: decided.decidedBy ?? 'cli-user',
            expiresAt: decided.expiresAt,
          },
        );
        if (options.json === true) {
          jsonOut(runtime, 'orchestrate-api-approve', { approval: decided });
          return;
        }
        runtime.out(
          okLine(
            `Approved up to $${decided.maxAuthorizedCostUsd.toFixed(4)} of API spend for task ` +
              `${decided.taskId} on profile "${decided.profileName}" (expires ${decided.expiresAt}).`,
          ),
        );
        runtime.out(
          dim(
            '  The authorization covers this exact task version only; materially changed work needs a fresh one.',
          ),
        );
      },
    );

  orchestrate
    .command('api-deny')
    .description('Deny one API spend request (human decision; CLI only)')
    .argument('<jobId>')
    .argument('<approvalId>')
    .option('--note <text>', 'note recorded with the decision')
    .option('--by <name>', 'who is denying (recorded for audit)')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (jobId: string, approvalId: string, options: { note?: string; by?: string; json?: boolean }) => {
        const context = loadExecutionContext(runtime);
        const decided = decideApiSpendApproval({
          workspace: context.workspace,
          jobId,
          approvalId,
          decision: 'DENIED',
          decidedBy: options.by ?? 'cli-user',
          ...(options.note !== undefined ? { note: options.note } : {}),
          now: new Date(),
        });
        recordJobEvent(
          { workspace: context.workspace, config: context.config },
          jobId,
          'api_approval_denied',
          {
            approvalId: decided.approvalId,
            nodeId: decided.nodeId,
            taskId: decided.taskId,
            decidedBy: decided.decidedBy ?? 'cli-user',
          },
        );
        if (options.json === true) {
          jsonOut(runtime, 'orchestrate-api-deny', { approval: decided });
          return;
        }
        runtime.out(okLine(`Denied API spend for task ${decided.taskId}. No paid execution will run.`));
      },
    );

  orchestrate
    .command('local-benchmark')
    .description(
      'Compare LOCAL execution modes (direct model vs harness) on approved tasks in isolated worktrees (opt-in; never touches your working tree)',
    )
    .requiredOption('--spec <name>', 'spec whose approved tasks are benchmarked')
    .requiredOption('--task <id...>', 'approved task id(s) to run through both modes')
    .option('--job <id>', 'record the evaluation on this job\'s timeline')
    .option('--mode <mode...>', 'modes to run (DIRECT_MODEL, HARNESS); default both')
    .option('--harness-profile <name>', 'harness profile override (default: the bound LOCAL harness)')
    .option('--keep-worktrees', 'keep the isolated checkouts for inspection')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      async (options: {
        spec: string;
        task: string[];
        job?: string;
        mode?: string[];
        harnessProfile?: string;
        keepWorktrees?: boolean;
        json?: boolean;
      }) => {
        const context = loadExecutionContext(runtime);
        const modes = (options.mode ?? ['DIRECT_MODEL', 'HARNESS']).map((mode) => mode.toUpperCase());
        for (const mode of modes) {
          if (mode !== 'DIRECT_MODEL' && mode !== 'HARNESS') {
            throw new SpecBridgeError(
              'INVALID_ARGUMENT',
              `Unknown local execution mode "${mode}". Valid modes: DIRECT_MODEL, HARNESS.`,
            );
          }
        }
        // The direct arm needs a real local model. It is started here and
        // stopped in the finally below — the benchmark owns it for exactly
        // as long as it runs.
        const localManager = createLocalManager(context.config, () => {});
        const inference =
          localManager !== undefined && validateLocalInferenceConfig(context.config.localInference).ok
            ? managedLocalInference(localManager, context.config)
            : undefined;
        if (modes.includes('DIRECT_MODEL') && inference === undefined) {
          runtime.out(
            warnLine(
              '  local inference is not enabled/configured; the DIRECT_MODEL arm will report UNAVAILABLE.',
            ),
          );
        }
        const tasks = context.workspace;
        try {
          const report = await evaluateLocalRuntime({
            workspace: tasks,
            config: context.config,
            cases: options.task.map((taskId) => ({
              caseId: `${options.spec}-${taskId}`,
              specName: options.spec,
              taskId,
              title: `task ${taskId}`,
            })),
            modes: modes as ('DIRECT_MODEL' | 'HARNESS')[],
            ...(inference !== undefined ? { inference } : {}),
            ...(options.harnessProfile !== undefined ? { harnessProfile: options.harnessProfile } : {}),
            maxHarnessWallTimeMs:
              context.config.orchestration.jobs.scheduler.localExecution.maxHarnessWallTimeMs,
            ...(options.keepWorktrees === true ? { keepWorktrees: true } : {}),
            onProgress: (message) => {
              if (options.json !== true) runtime.out(dim(`  ${message}`));
            },
          });
          if (options.job !== undefined) {
            // Evidence collection is only useful if it lands somewhere a
            // human will look later: the job's own timeline.
            requireJobState(context.workspace, options.job);
            recordJobEvent(
              { workspace: context.workspace, config: context.config },
              options.job,
              'local_runtime_evaluation_recorded',
              {
                spec: options.spec,
                cases: report.cases.length,
                harnessProfile: report.harnessProfile ?? 'none',
                harnessLocality: report.harnessLocality ?? 'UNKNOWN',
                summary: report.summary
                  .map((entry) => `${entry.mode}:${entry.verified}/${entry.arms}`)
                  .join(' '),
              },
            );
          }
          if (options.json === true) {
            jsonOut(runtime, 'orchestrate-local-benchmark', { report });
            return;
          }
          runtime.out(reportTitle(`Local runtime benchmark — ${options.spec}`));
          runtime.out(
            infoLine(
              `  harness ${report.harnessProfile ?? '(none)'} (compute ${report.harnessLocality ?? 'UNKNOWN'})`,
            ),
          );
          for (const entry of report.cases) {
            runtime.out(reportTitle(`Task ${entry.taskId}`));
            for (const arm of entry.arms) {
              const line =
                `  ${arm.mode}: ${arm.outcome} (${arm.evidenceStatus ?? 'no evidence'}) ` +
                `in ${(arm.wallTimeMs / 1000).toFixed(1)}s, ${arm.changedFiles.length} file(s) changed`;
              runtime.out(arm.outcome === 'VERIFIED' ? okLine(line) : warnLine(line));
              if (arm.unexpectedFiles.length > 0) {
                runtime.out(failLine(`    unexpected control-plane changes: ${arm.unexpectedFiles.join(', ')}`));
              }
              runtime.out(
                dim(
                  `    tokens in/out ${arm.inputTokens ?? 'unknown'}/${arm.outputTokens ?? 'unknown'}; ` +
                    `tool calls ${arm.toolCalls ?? 'unknown'}; commands ${arm.commandRuns ?? 'unknown'}; ` +
                    `compactions ${arm.compactions ?? 'unknown'}`,
                ),
              );
              runtime.out(dim(`    ${arm.detail.slice(0, 160)}`));
            }
          }
          runtime.out(reportTitle('Summary'));
          for (const entry of report.summary) {
            runtime.out(
              infoLine(
                `  ${entry.mode}: ${entry.verified}/${entry.arms} verified` +
                  `${entry.medianWallTimeMs !== null ? `, median ${(entry.medianWallTimeMs / 1000).toFixed(1)}s` : ''}` +
                  `${entry.unavailable > 0 ? `, ${entry.unavailable} unavailable` : ''}`,
              ),
            );
          }
          runtime.out(
            dim(
              '  Trusted evidence is the metric: an arm counts only when SpecBridge verification accepts its result.',
            ),
          );
        } finally {
          await localManager?.stop('benchmark finished');
        }
      },
    );
  // -------------------------------------------------------------------------
  // explain-node — why is this task not complete, and what would unblock it
  // -------------------------------------------------------------------------
  orchestrate
    .command('explain-node')
    .description(
      'Explain one task: evaluation verdicts, execution health, the repeating failure, ' +
        'remaining budget, the current recovery decision, and what would unblock it (read-only)',
    )
    .argument('<jobId>')
    .argument('<nodeId>')
    .option('--json', 'output a machine-readable JSON report')
    .action((jobId: string, nodeId: string, options: { json?: boolean }) => {
      const context = loadExecutionContext(runtime);
      const workspace = context.workspace;
      const job = requireJobState(workspace, jobId);
      const graph =
        job.graphRevision > 0 ? requireGraphRevision(workspace, jobId, job.graphRevision) : undefined;
      const node = graph?.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node === undefined) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Node ${nodeId} does not exist in the active graph of job ${jobId}.`,
          {
            exitCode: EXIT_CODES.usageError,
            remediation: [`List the graph with \`${CLI_BIN} orchestrate job ${jobId}\`.`],
          },
        );
      }

      const reliability = readTaskReliabilityState(workspace, jobId, nodeId);
      const evaluations = listEvaluationResults(workspace, jobId, { nodeId });
      const assessments = listFailureAssessments(workspace, jobId, { nodeId });
      const decisions = listRecoveryDecisions(workspace, jobId, { nodeId });
      const latestEvaluation = evaluations.at(-1);
      const latestAssessment = assessments.at(-1);
      const latestDecision = decisions.at(-1);
      const ledger = summarizeExecutionLedger(readExecutionLedger(workspace, jobId, { nodeId }));

      const budgets = job.budgets;
      const remaining = {
        attempts: Math.max(
          0,
          budgets.maxTaskAttempts -
            node.attempts.filter((attempt) => attempt.role === 'EXECUTOR').length,
        ),
        repairs: Math.max(0, budgets.maxRepairCyclesPerTask - node.repairCycles),
        replans: Math.max(0, budgets.maxReplansPerTask - node.replans),
        transientRetries: Math.max(0, budgets.maxTransientRetries - job.counters.transientRetries),
      };

      // Failure fingerprints seen more than once, most repeated first: the
      // direct answer to "what keeps happening?".
      const fingerprintCounts = new Map<string, number>();
      for (const entry of reliability?.observations ?? []) {
        if (entry.failureFingerprint === null) continue;
        fingerprintCounts.set(
          entry.failureFingerprint,
          (fingerprintCounts.get(entry.failureFingerprint) ?? 0) + 1,
        );
      }
      const repeating = [...fingerprintCounts.entries()]
        .filter(([, count]) => count > 1)
        .sort((left, right) => right[1] - left[1]);

      const failedChecks = (latestEvaluation?.deterministicChecks ?? []).filter(
        (check) => check.required && check.outcome !== 'PASSED',
      );

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-explain-node', {
          job: { jobId, status: job.status },
          node: {
            nodeId,
            taskId: node.parentTaskId,
            title: node.title,
            status: node.status,
            planRevision: node.planRevision,
          },
          health: reliability?.health ?? 'HEALTHY',
          evaluation: latestEvaluation ?? null,
          failedChecks,
          assessment: latestAssessment ?? null,
          recovery: latestDecision ?? null,
          repeatingFingerprints: repeating.map(([fingerprint, count]) => ({ fingerprint, count })),
          remaining,
          counters: {
            stagnationEvents: reliability?.stagnationEvents ?? 0,
            oscillationEvents: reliability?.oscillationEvents ?? 0,
            runawayEvents: reliability?.runawayEvents ?? 0,
            freshContextRestarts: reliability?.freshContextRestarts ?? 0,
          },
          costOfFailure: ledger.reliability,
        });
        return;
      }

      runtime.out(reportTitle(`Task ${node.parentTaskId} (${nodeId})`));
      runtime.out(infoLine(`  status: ${node.status}   health: ${reliability?.health ?? 'HEALTHY'}`));
      runtime.out(dim(`    ${node.title.slice(0, 140)}`));

      runtime.out('');
      runtime.out(reportTitle('Why is it not complete?'));
      if (node.status === 'COMPLETED') {
        runtime.out(okLine('  The task completed through verified evidence and a passing evaluation.'));
      } else if (latestEvaluation === undefined) {
        runtime.out(dim('  No attempt has been evaluated yet.'));
      } else {
        const line = `  latest evaluation: ${latestEvaluation.status}`;
        runtime.out(latestEvaluation.status === 'PASS' ? okLine(line) : failLine(line));
        for (const reason of latestEvaluation.reasons.slice(0, 6)) {
          runtime.out(dim(`    ${reason.slice(0, 200)}`));
        }
      }

      if (failedChecks.length > 0) {
        runtime.out('');
        runtime.out(reportTitle('Which checks failed?'));
        for (const check of failedChecks.slice(0, 15)) {
          runtime.out(
            failLine(
              `  ${check.level}/${check.name}: ${check.outcome}` +
                `${check.detail !== undefined ? ` — ${check.detail.slice(0, 160)}` : ''}`,
            ),
          );
        }
      }
      if ((latestEvaluation?.failedCriteria.length ?? 0) > 0) {
        runtime.out(
          failLine(`  failed acceptance criteria: ${latestEvaluation?.failedCriteria.join(', ')}`),
        );
      }

      if (repeating.length > 0) {
        runtime.out('');
        runtime.out(reportTitle('What keeps happening?'));
        for (const [fingerprint, count] of repeating.slice(0, 5)) {
          runtime.out(warnLine(`  failure ${fingerprint} recurred ${count} time(s)`));
        }
      }

      if (latestAssessment !== undefined) {
        runtime.out('');
        runtime.out(reportTitle('What kind of failure is it?'));
        runtime.out(
          infoLine(
            `  ${latestAssessment.category} from ${latestAssessment.source} ` +
              `(${latestAssessment.recoverability}, basis ${latestAssessment.basis})`,
          ),
        );
        runtime.out(dim(`    ${latestAssessment.likelyCause.slice(0, 300)}`));
        if (latestAssessment.runawaySignals.length > 0) {
          runtime.out(warnLine(`  runaway signals: ${latestAssessment.runawaySignals.join(', ')}`));
        }
      }

      runtime.out('');
      runtime.out(reportTitle('What did SpecBridge decide, and why?'));
      if (latestDecision === undefined) {
        runtime.out(dim('  No recovery decision has been made for this task.'));
      } else {
        runtime.out(
          infoLine(`  ${latestDecision.action}  [${latestDecision.reasonCode}]`),
        );
        runtime.out(dim(`    ${latestDecision.reason.slice(0, 300)}`));
        runtime.out(
          dim(
            `    strategy change: ${latestDecision.strategyChange}` +
              `${latestDecision.applied ? '' : ' (not yet acted on)'}`,
          ),
        );
        if (latestDecision.requestedCapability !== undefined) {
          runtime.out(
            dim(
              `    requested ${latestDecision.requestedCapability.kind} capability — a requirement, ` +
                'not an authorization: spend policy and the scheduler still decide.',
            ),
          );
        }
      }

      runtime.out('');
      runtime.out(reportTitle('How much budget remains?'));
      runtime.out(
        infoLine(
          `  attempts ${remaining.attempts}/${budgets.maxTaskAttempts}   ` +
            `repairs ${remaining.repairs}/${budgets.maxRepairCyclesPerTask}   ` +
            `replans ${remaining.replans}/${budgets.maxReplansPerTask}   ` +
            `transient retries ${remaining.transientRetries}/${budgets.maxTransientRetries}`,
        ),
      );
      const cost = ledger.reliability;
      runtime.out(
        dim(
          `  failed attempts: ${cost.failedAttempts}` +
            `${cost.failedAttemptMs !== null ? `, ${(cost.failedAttemptMs / 1000).toFixed(1)}s` : ''}` +
            `${cost.failedAttemptTokens !== null ? `, ${cost.failedAttemptTokens} token(s)` : ''}` +
            `${cost.failedAttemptCostUsd !== null ? `, $${cost.failedAttemptCostUsd.toFixed(4)}` : ''}` +
            ' spent without a verified completion',
        ),
      );

      runtime.out('');
      runtime.out(reportTitle('What would unblock it?'));
      const remediation =
        latestDecision !== undefined && latestDecision.remediation.length > 0
          ? latestDecision.remediation
          : job.blocker?.remediation ?? [
              'Nothing is blocked: resume the job and the scheduler will continue.',
            ];
      for (const line of remediation.slice(0, 8)) runtime.out(dim(`  ${line}`));
    });

  // -------------------------------------------------------------------------
  // explain-context — what context was selected for this task, and why
  // -------------------------------------------------------------------------
  orchestrate
    .command('explain-context')
    .description(
      'Explain the context selected for one task: which repository artifacts were included, ' +
        'which were excluded and why, what was compressed, and how large the package was (read-only)',
    )
    .argument('<jobId>')
    .argument('<nodeId>')
    .option('--attempt <attemptId>', 'explain the package built for one specific attempt')
    .option('--json', 'output a machine-readable JSON report')
    .action((jobId: string, nodeId: string, options: { attempt?: string; json?: boolean }) => {
      const context = loadExecutionContext(runtime);
      const workspace = context.workspace;
      const job = requireJobState(workspace, jobId);
      const graph =
        job.graphRevision > 0 ? requireGraphRevision(workspace, jobId, job.graphRevision) : undefined;
      const node = graph?.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node === undefined) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Node ${nodeId} does not exist in the active graph of job ${jobId}.`,
          {
            exitCode: EXIT_CODES.usageError,
            remediation: [`List the graph with \`${CLI_BIN} orchestrate job ${jobId}\`.`],
          },
        );
      }

      const plans = listContextSelectionPlans(workspace, jobId, {
        nodeId,
        ...(options.attempt !== undefined ? { attemptId: options.attempt } : {}),
      });
      const plan = plans.at(-1);
      const strategy = context.config.orchestration.jobs.context.efficiency.strategy;
      if (plan === undefined) {
        if (options.json === true) {
          jsonOut(runtime, 'orchestrate-explain-context', {
            job: { jobId, status: job.status },
            node: { nodeId, taskId: node.parentTaskId },
            strategy,
            plan: null,
            expansion: readContextExpansionState(workspace, jobId, nodeId) ?? null,
          });
          return;
        }
        runtime.out(reportTitle(`Task ${node.parentTaskId} (${nodeId})`));
        runtime.out(
          strategy === 'LEGACY'
            ? infoLine(
                '  Context strategy is LEGACY: assembly uses durable state only, with no repository ' +
                  'retrieval to explain.',
              )
            : dim('  No context selection has been recorded for this task yet.'),
        );
        return;
      }

      const metrics =
        plan.attemptId === undefined
          ? undefined
          : readContextMetrics(workspace, jobId, plan.attemptId);
      const explanation = explainContextSelection({
        plan,
        ...(metrics !== undefined ? { metrics } : {}),
      });
      const expansion = readContextExpansionState(workspace, jobId, nodeId);

      if (options.json === true) {
        jsonOut(runtime, 'orchestrate-explain-context', {
          job: { jobId, status: job.status },
          node: { nodeId, taskId: node.parentTaskId, title: node.title },
          strategy,
          explanation,
          metrics: metrics ?? null,
          expansion: expansion ?? null,
          planCount: plans.length,
        });
        return;
      }

      runtime.out(renderContextExplanation(explanation));
      if (expansion !== undefined && expansion.expansionsThisTask > 0) {
        runtime.out('');
        runtime.out(
          infoLine(
            `  Retrieval has widened ${expansion.expansionsThisTask} time(s) on this task; ` +
              `it is currently at ${expansion.level}.`,
          ),
        );
      }
      if (plans.length > 1) {
        runtime.out('');
        runtime.out(dim(`  ${plans.length} context plans recorded; showing the most recent.`));
      }
    });
}
