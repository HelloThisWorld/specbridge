import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import {
  answerClarification,
  buildQuotaForecast,
  cancelJob,
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
  readJobCheckpoint,
  readJobEvents,
  readLatestWorkGraph,
  readNodePlan,
  readProjection as readObjectiveProjection,
  readQuotaTelemetryFile,
  readSchedulingDecisions,
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
}
