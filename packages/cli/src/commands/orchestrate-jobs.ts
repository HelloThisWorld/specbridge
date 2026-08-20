import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import {
  answerClarification,
  cancelJob,
  createJob,
  driveJob,
  executionPlanSchema,
  listJobs,
  readCandidate,
  readConflicts,
  readEvaluations,
  readJobCheckpoint,
  readJobEvents,
  readLatestWorkGraph,
  readNodePlan,
  readProjection as readObjectiveProjection,
  readWorkerRecords,
  requireGraphRevision,
  requireJobState,
  resolveWorkers,
  reviewNodePlan,
} from '@specbridge/orchestration';
import { localModelDoctor } from '@specbridge/runners';
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
}
