import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CLI_BIN, EXIT_CODES, SpecBridgeError } from '@specbridge/core';
import type {
  ApprovalSummary,
  BuildLifecycle,
  DiscoveryResult,
  IntakeDeps,
  IntakeOverview,
  ProductQuestion,
  SpecIntakeState,
} from '@specbridge/intake';
import {
  abandonIntake,
  answerIntakeQuestion,
  approveIntake,
  computeIntakeTelemetry,
  describeIntake,
  listSpecIntakes,
  recordFeatureOutcome,
  requireIntakeFor,
  runIntakeDiscovery,
  runSealAndBuild,
  startSpecIntake,
  startSpecIntakeFromFile,
} from '@specbridge/intake';
import { createInProcessDriverHost } from '@specbridge/autonomy';
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
import { loadExecutionContext } from '../execution-context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge spec start|discover|answer|intake` and `spec approve --build`
 * — the vNext.10.1 Zero-Touch Spec Intake surface.
 *
 * The whole product workflow is four commands, and only one of them carries
 * human authority:
 *
 *   spec start <name> --file <spec>   submit a specification
 *   spec discover <name>              see what discovery asks (it runs itself)
 *   spec answer <name> <Q> "…"        answer one product question
 *   spec approve <name> --build       APPROVE AND BUILD — the one human act
 *
 * After the last one, ordinary engineering needs nobody. Everything the old
 * workflow required in between — `mission contract-ready`, `mission
 * synthesize`, three `spec approve --stage` calls, `autonomy seal`,
 * `overnight preflight`, `overnight run` — still exists and still works, and
 * none of it is required here.
 *
 * `spec approve --build` is deliberately CLI-only, exactly like
 * `autonomy seal` and `mission ccr`. No MCP tool authorizes a build.
 */

function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

function intakeDeps(runtime: CliRuntime): IntakeDeps {
  const context = loadExecutionContext(runtime);
  return {
    workspace: context.workspace,
    config: context.config,
    clock: () => runtime.now(),
    host: 'cli',
  };
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch (cause) {
    throw new SpecBridgeError(
      'INVALID_ARGUMENT',
      `Could not read the specification from standard input: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderQuestion(runtime: CliRuntime, question: ProductQuestion, index: number): void {
  runtime.out('');
  runtime.out(blockedLine(`${index}. [${question.questionId}] ${question.question}`));
  runtime.out(dim(`   Why it matters: ${question.whyItMatters}`));
  runtime.out(dim(`   Affects: ${question.productSurface}`));
  runtime.out(dim(`   Not answered by evidence: ${question.evidenceGap}`));
  for (const [optionIndex, option] of question.options.entries()) {
    runtime.out(dim(`   (${optionIndex + 1}) ${option}`));
  }
}

/**
 * The approval summary.
 *
 * Product language, deliberately short, and deliberately NOT the three
 * generated documents. Dumping requirements/design/tasks back at somebody
 * and calling it an approval gate trains people to scroll past it; what a
 * person needs to authorize a build is what CHANGES.
 */
function renderSummary(runtime: CliRuntime, summary: ApprovalSummary): void {
  runtime.out(sectionTitle('Goal'));
  runtime.out(`  ${summary.goal}`);
  if (summary.newContracts.length > 0) {
    runtime.out(sectionTitle('New product surfaces'));
    for (const contract of summary.newContracts) {
      runtime.out(
        okLine(`  ${contract.contractId} ${contract.title} (${contract.requirements} requirement(s))`),
      );
    }
  }
  runtime.out(sectionTitle('Existing contracts affected'));
  if (summary.changedContractIds.length === 0 && summary.extendedContractIds.length === 0) {
    runtime.out(okLine('  none — no existing sealed contract is modified'));
  } else {
    for (const contractId of summary.changedContractIds) {
      runtime.out(failLine(`  ${contractId} would CHANGE`));
    }
    for (const contractId of summary.extendedContractIds) {
      runtime.out(warnLine(`  ${contractId} would be extended`));
    }
  }
  if (summary.decisions.length > 0) {
    runtime.out(sectionTitle('Important decisions'));
    for (const decision of summary.decisions) {
      runtime.out(`  ${decision.questionId}: ${decision.answer}`);
    }
  }
  if (summary.nonGoals.length > 0) {
    runtime.out(sectionTitle('Explicit non-goals'));
    for (const nonGoal of summary.nonGoals.slice(0, 8)) runtime.out(dim(`  ${nonGoal}`));
  }
  runtime.out('');
  runtime.out(infoLine(`Acceptance criteria: ${summary.acceptanceCriteriaCount}`));
  runtime.out(
    summary.openBlockers === 0
      ? okLine('Remaining blockers: 0')
      : blockedLine(`Remaining blockers: ${summary.openBlockers}`),
  );
}

function renderDiscovery(runtime: CliRuntime, result: DiscoveryResult): void {
  const open = result.questions.filter((question) => question.status === 'open');
  runtime.out(
    dim(
      `Grounded in ${result.grounding.evidence.length} piece(s) of repository evidence ` +
        `(${result.grounding.existingProduct ? 'existing product truth found' : 'no prior SpecBridge product truth'}).`,
    ),
  );
  runtime.out(
    dim(
      `${result.analysis.items.length} material statement(s) classified; ` +
        `${result.refusals.length} candidate question(s) refused as engineering or already answered.`,
    ),
  );
  if (open.length === 0) {
    runtime.out('');
    runtime.out(okLine('No open product questions.'));
    return;
  }
  runtime.out('');
  runtime.out(reportTitle(`${open.length} product question(s) need your decision`));
  open.forEach((question, index) => renderQuestion(runtime, question, index + 1));
}

function renderLifecycle(runtime: CliRuntime, lifecycle: BuildLifecycle): void {
  runtime.out(sectionTitle('Build lifecycle'));
  for (const step of lifecycle.steps) {
    const line = `  ${step.step}: ${step.status}${step.detail !== undefined ? ` — ${step.detail}` : ''}`;
    if (step.status === 'FAILED') runtime.out(failLine(line));
    else if (step.status === 'COMPLETED' || step.status === 'RECONCILED') runtime.out(okLine(line));
    else runtime.out(dim(line));
  }
}

function intakeSummary(intake: SpecIntakeState): Record<string, unknown> {
  return {
    intakeId: intake.intakeId,
    name: intake.name,
    status: intake.status,
    missionId: intake.missionId,
    specName: intake.specName ?? null,
    sealId: intake.sealId ?? null,
    jobId: intake.jobId ?? null,
    approvalId: intake.approvalId ?? null,
    sourceContentHash: intake.sourceContentHash,
    baselineCommit: intake.baselineCommit,
    counters: intake.counters,
  };
}

function overviewJson(overview: IntakeOverview): Record<string, unknown> {
  return {
    intake: intakeSummary(overview.intake),
    source:
      overview.source === undefined
        ? null
        : {
            kind: overview.source.kind,
            originPath: overview.source.originPath ?? null,
            byteLength: overview.source.byteLength,
            contentHash: overview.source.contentHash,
            storedAt: overview.source.storedAt,
            outline: overview.source.outline,
            chunks: overview.source.chunks.length,
          },
    grounding:
      overview.grounding === undefined
        ? null
        : {
            baselineCommit: overview.grounding.baselineCommit,
            existingProduct: overview.grounding.existingProduct,
            evidence: overview.grounding.evidence.length,
            priorMissionIds: overview.grounding.priorMissionIds,
            buildSystem: overview.grounding.buildSystem,
            modules: overview.grounding.modules,
          },
    delta:
      overview.analysis === undefined
        ? null
        : {
            counts: overview.analysis.counts,
            complete: overview.analysis.complete,
            modifiedContractIds: overview.analysis.modifiedContractIds,
            extendedContractIds: overview.analysis.extendedContractIds,
            items: overview.analysis.items.map((item) => ({
              itemId: item.itemId,
              classification: item.classification,
              statement: item.statement,
              rationale: item.rationale,
              existingContractId: item.existingContractId ?? null,
            })),
          },
    questions: overview.questions.map((question) => ({
      questionId: question.questionId,
      kind: question.kind,
      status: question.status,
      question: question.question,
      whyItMatters: question.whyItMatters,
      productSurface: question.productSurface,
      evidenceGap: question.evidenceGap,
      resolves: question.resolves,
      options: question.options,
      answer: question.answer ?? null,
    })),
    refusals: overview.refusals.map((refusal) => ({
      refusalId: refusal.refusalId,
      reason: refusal.reason,
      engineeringSurface: refusal.engineeringSurface ?? null,
      candidate: refusal.candidate,
      detail: refusal.detail,
    })),
    approval:
      overview.approval === undefined
        ? null
        : {
            approvalId: overview.approval.approvalId,
            approvedAt: overview.approval.approvedAt,
            approvedVia: overview.approval.approvedVia,
            authorityDigest: overview.approval.authorityDigest,
            newContractIds: overview.approval.newContractIds,
            changedContractIds: overview.approval.changedContractIds,
            acceptanceCriteria: overview.approval.acceptanceCriteria.length,
            sealId: overview.approval.sealId ?? null,
          },
    lifecycle:
      overview.lifecycle === undefined
        ? null
        : {
            outcome: overview.lifecycle.outcome ?? null,
            specName: overview.lifecycle.specName ?? null,
            sealId: overview.lifecycle.sealId ?? null,
            jobId: overview.lifecycle.jobId ?? null,
            humanPrerequisites: overview.lifecycle.humanPrerequisites,
            resolvedPrerequisites: overview.lifecycle.resolvedPrerequisites,
            steps: overview.lifecycle.steps.map((step) => ({
              step: step.step,
              status: step.status,
              detail: step.detail ?? null,
              result: step.result ?? null,
            })),
          },
    summary: overview.summary ?? null,
  };
}

// ---------------------------------------------------------------------------
// spec start
// ---------------------------------------------------------------------------

export function registerSpecIntakeCommands(spec: Command, runtime: CliRuntime): void {
  spec
    .command('start <name>')
    .description('Submit a product/feature specification and start repository-grounded discovery')
    .option('--file <path>', 'read the specification from a file')
    .option('--text <text>', 'the specification as inline text')
    .option('--stdin', 'read the specification from standard input')
    .option('--goal <text>', 'explicit one-line goal (derived from the document otherwise)')
    .option('--spec-name <name>', 'name for the synthesized Kiro spec (default: the intake name)')
    .option('--json', 'machine-readable output')
    .addHelpText(
      'after',
      `
The submitted document is stored verbatim under
.specbridge/intake/<id>/source/ and stays inspectable forever: it is product
evidence, and no summary of it ever replaces it.

Discovery runs immediately, grounded in this repository — existing specs,
prior missions, sealed contracts, constitution rules, ADRs, modules, and the
build system. It asks only questions that need PRODUCT authority; engineering
decisions are delegated and are never asked about.

Examples:
  ${CLI_BIN} spec start airport-demo --file ./demo-spec.md
  ${CLI_BIN} spec start airport-demo --stdin < demo-spec.md`,
    )
    .action(
      (
        name: string,
        options: {
          file?: string;
          text?: string;
          stdin?: boolean;
          goal?: string;
          specName?: string;
          json?: boolean;
        },
      ) => {
        const sources = [options.file, options.text, options.stdin === true ? 'stdin' : undefined]
          .filter((value) => value !== undefined).length;
        if (sources === 0) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            'A specification is required. Pass --file <path>, --text "…", or --stdin.',
          );
        }
        if (sources > 1) {
          throw new SpecBridgeError(
            'INVALID_ARGUMENT',
            'Pass exactly one of --file, --text, or --stdin.',
          );
        }

        const deps = intakeDeps(runtime);
        const started =
          options.file !== undefined
            ? startSpecIntakeFromFile(deps, {
                name,
                file: options.file,
                ...(options.goal !== undefined ? { goal: options.goal } : {}),
                ...(options.specName !== undefined ? { specName: options.specName } : {}),
              })
            : startSpecIntake(deps, {
                name,
                kind: options.stdin === true ? 'stdin' : 'text',
                content: options.stdin === true ? readStdin() : (options.text ?? ''),
                ...(options.goal !== undefined ? { goal: options.goal } : {}),
                ...(options.specName !== undefined ? { specName: options.specName } : {}),
              });

        const discovery = runIntakeDiscovery(deps, started.intake.intakeId);

        if (options.json === true) {
          jsonOut(runtime, 'spec-intake-start/v1', {
            intake: intakeSummary(discovery.intake),
            source: {
              byteLength: started.source.byteLength,
              contentHash: started.source.contentHash,
              storedAt: started.source.storedAt,
              chunks: started.source.chunks.length,
              outline: started.source.outline,
            },
            questions: discovery.questions
              .filter((question) => question.status === 'open')
              .map((question) => ({
                questionId: question.questionId,
                kind: question.kind,
                question: question.question,
                whyItMatters: question.whyItMatters,
                productSurface: question.productSurface,
                evidenceGap: question.evidenceGap,
                options: question.options,
              })),
            readiness: discovery.readiness,
          });
          return;
        }

        runtime.out(reportTitle(`Spec intake ${discovery.intake.intakeId} — ${name}`));
        runtime.out(
          infoLine(
            `Ingested ${started.source.byteLength} bytes into ${started.source.chunks.length} ` +
              `section(s); stored at ${started.source.storedAt}`,
          ),
        );
        renderDiscovery(runtime, discovery);
        runtime.out('');
        if (discovery.readiness.ready) {
          runtime.out(okLine('Specification ready.'));
          runtime.out(dim(`  Approve and build: ${CLI_BIN} spec approve ${name} --build`));
        } else {
          runtime.out(
            dim(`  Answer with: ${CLI_BIN} spec answer ${name} <questionId> "your answer"`),
          );
        }
      },
    );

  // ---------------------------------------------------------------------------
  // spec discover
  // ---------------------------------------------------------------------------
  spec
    .command('discover <name>')
    .description('Re-run repository-grounded discovery and show the open product questions')
    .option('--json', 'machine-readable output')
    .action((name: string, options: { json?: boolean }) => {
      const deps = intakeDeps(runtime);
      const intake = requireIntakeFor(deps, name);
      const discovery = runIntakeDiscovery(deps, intake.intakeId);
      if (options.json === true) {
        jsonOut(runtime, 'spec-intake-discover/v1', {
          intake: intakeSummary(discovery.intake),
          readiness: discovery.readiness,
          questions: discovery.questions.map((question) => ({
            questionId: question.questionId,
            kind: question.kind,
            status: question.status,
            question: question.question,
            whyItMatters: question.whyItMatters,
            productSurface: question.productSurface,
            evidenceGap: question.evidenceGap,
            resolves: question.resolves,
            options: question.options,
            answer: question.answer ?? null,
          })),
          refusals: discovery.refusals.map((refusal) => ({
            refusalId: refusal.refusalId,
            reason: refusal.reason,
            engineeringSurface: refusal.engineeringSurface ?? null,
            candidate: refusal.candidate,
          })),
          delta: discovery.analysis.counts,
        });
        if (!discovery.readiness.ready) runtime.exitCode = EXIT_CODES.gateFailure;
        return;
      }
      runtime.out(reportTitle(`Discovery — ${discovery.intake.name} (${discovery.intake.status})`));
      renderDiscovery(runtime, discovery);
      runtime.out('');
      if (discovery.readiness.ready) {
        const overview = describeIntake(deps, intake.intakeId);
        if (overview.summary !== undefined) renderSummary(runtime, overview.summary);
        runtime.out('');
        runtime.out(okLine('Specification ready.'));
        runtime.out(dim(`  Approve and build: ${CLI_BIN} spec approve ${name} --build`));
      } else {
        for (const reason of discovery.readiness.reasons) runtime.out(warnLine(reason));
        runtime.exitCode = EXIT_CODES.gateFailure;
      }
    });

  // ---------------------------------------------------------------------------
  // spec answer
  // ---------------------------------------------------------------------------
  spec
    .command('answer <name> <questionId> <answer...>')
    .description('Record your answer to one open product question')
    .option('--json', 'machine-readable output')
    .action(
      (
        name: string,
        questionId: string,
        answerWords: string[],
        options: { json?: boolean },
      ) => {
        const deps = intakeDeps(runtime);
        const intake = requireIntakeFor(deps, name);
        const result = answerIntakeQuestion(deps, intake.intakeId, {
          questionId,
          answer: answerWords.join(' '),
        });
        if (options.json === true) {
          jsonOut(runtime, 'spec-intake-answer/v1', {
            questionId: result.question.questionId,
            decisionId: result.question.decisionId ?? null,
            readiness: result.discovery.readiness,
            openQuestionIds: result.discovery.readiness.openQuestionIds,
          });
          return;
        }
        runtime.out(okLine(`Recorded your answer to ${questionId}.`));
        const open = result.discovery.questions.filter((question) => question.status === 'open');
        if (open.length > 0) {
          runtime.out(infoLine(`${open.length} product question(s) remain.`));
          open.forEach((question, index) => renderQuestion(runtime, question, index + 1));
          return;
        }
        if (result.discovery.readiness.ready) {
          runtime.out('');
          const overview = describeIntake(deps, intake.intakeId);
          if (overview.summary !== undefined) renderSummary(runtime, overview.summary);
          runtime.out('');
          runtime.out(okLine('Specification ready.'));
          runtime.out(dim(`  Approve and build: ${CLI_BIN} spec approve ${name} --build`));
        } else {
          for (const reason of result.discovery.readiness.reasons) runtime.out(warnLine(reason));
        }
      },
    );

  // ---------------------------------------------------------------------------
  // spec intake — inspection and resume
  // ---------------------------------------------------------------------------
  spec
    .command('intake [name]')
    .description('Inspect spec intakes; with --resume, continue an interrupted build')
    .option('--resume', 'continue the seal-and-build lifecycle idempotently')
    .option('--no-launch', 'with --resume, stop after creating the job')
    .option('--json', 'machine-readable output')
    .action(
      async (
        name: string | undefined,
        options: { resume?: boolean; launch?: boolean; json?: boolean },
      ) => {
        const deps = intakeDeps(runtime);
        if (name === undefined) {
          const listed = listSpecIntakes(deps);
          if (options.json === true) {
            jsonOut(runtime, 'spec-intake-list/v1', {
              intakes: listed.intakes.map(intakeSummary),
              diagnostics: listed.diagnostics,
            });
            return;
          }
          runtime.out(reportTitle('Spec intakes'));
          if (listed.intakes.length === 0) {
            runtime.out(
              dim(`  none — start one with \`${CLI_BIN} spec start <name> --file <spec-file>\``),
            );
            return;
          }
          for (const intake of listed.intakes) {
            const line = `  ${intake.intakeId}  ${intake.status}  ${intake.name}`;
            runtime.out(
              intake.status === 'BUILT'
                ? okLine(line)
                : intake.status === 'BLOCKED'
                  ? failLine(line)
                  : infoLine(line),
            );
          }
          for (const diagnostic of listed.diagnostics) runtime.out(warnLine(diagnostic.message));
          return;
        }

        const intake = requireIntakeFor(deps, name);
        if (options.resume === true) {
          await runBuild(runtime, deps, intake.intakeId, {
            launch: options.launch !== false,
            json: options.json === true,
            subject: name,
          });
          return;
        }

        const overview = describeIntake(deps, intake.intakeId);
        const telemetry = computeIntakeTelemetry(deps, intake.intakeId);
        if (options.json === true) {
          jsonOut(runtime, 'spec-intake-show/v1', {
            ...overviewJson(overview),
            telemetry: telemetry as unknown as Record<string, unknown>,
          });
          return;
        }
        runtime.out(reportTitle(`Spec intake ${overview.intake.intakeId} — ${overview.intake.name}`));
        runtime.out(infoLine(`Status: ${overview.intake.status}`));
        if (overview.source !== undefined) {
          runtime.out(
            dim(
              `Source: ${overview.source.byteLength} bytes, sha256 ` +
                `${overview.source.contentHash.slice(0, 16)}…, stored at ${overview.source.storedAt}`,
            ),
          );
        }
        if (overview.summary !== undefined) renderSummary(runtime, overview.summary);
        if (overview.approval !== undefined) {
          runtime.out('');
          runtime.out(
            okLine(
              `Approved by a human at ${overview.approval.approvedAt} via ` +
                `${overview.approval.approvedVia} (${overview.approval.approvalId}, authority ` +
                `${overview.approval.authorityDigest})`,
            ),
          );
        }
        if (overview.lifecycle !== undefined) renderLifecycle(runtime, overview.lifecycle);
        runtime.out(sectionTitle('Zero-touch boundary'));
        runtime.out(dim(`  discoveryHumanTurns: ${telemetry.discoveryHumanTurns}`));
        runtime.out(dim(`  productQuestionsAsked: ${telemetry.productQuestionsAsked}`));
        runtime.out(dim(`  questionsRefused: ${telemetry.questionsRefused}`));
        runtime.out(dim(`  authorityApprovalCount: ${telemetry.authorityApprovalCount}`));
        const interventions = telemetry.humanInterventionsAfterSeal;
        runtime.out(
          interventions === null
            ? dim('  humanInterventionsAfterSeal: n/a (no build has run yet)')
            : interventions === 0
              ? okLine('  humanInterventionsAfterSeal: 0')
              : failLine(`  humanInterventionsAfterSeal: ${interventions}`),
        );
      },
    );

  // ---------------------------------------------------------------------------
  // spec abandon
  // ---------------------------------------------------------------------------
  spec
    .command('abandon-intake <name>')
    .description('Abandon a spec intake (final; the record stays readable)')
    .requiredOption('--reason <text>')
    .action((name: string, options: { reason: string }) => {
      const deps = intakeDeps(runtime);
      const intake = requireIntakeFor(deps, name);
      const abandoned = abandonIntake(deps, intake.intakeId, options.reason);
      runtime.out(okLine(`Spec intake ${abandoned.intakeId} is ${abandoned.status}.`));
    });
}

// ---------------------------------------------------------------------------
// The one human authority action
// ---------------------------------------------------------------------------

/**
 * `spec approve <name> --build`: approve the discovered specification and
 * authorize SpecBridge to build it.
 *
 * Registered from `spec-approve.ts` so the `--build` flag lives on the same
 * command as `--stage`, which keeps the existing per-stage workflow exactly
 * where it has always been and makes the relationship between the two
 * obvious: one approves a document, the other approves a product.
 */
export async function runApproveAndBuild(
  runtime: CliRuntime,
  name: string,
  options: {
    json?: boolean;
    maxSpend?: string;
    lanes?: string;
    launch: boolean;
    maxCycles?: string;
  },
): Promise<void> {
  const deps = intakeDeps(runtime);
  const intake = requireIntakeFor(deps, name);
  const lanes = (options.lanes ?? 'LOCAL,SUBSCRIPTION')
    .split(',')
    .map((lane) => lane.trim().toUpperCase())
    .filter(
      (lane): lane is 'LOCAL' | 'SUBSCRIPTION' | 'API' =>
        lane === 'LOCAL' || lane === 'SUBSCRIPTION' || lane === 'API',
    );

  const approved = approveIntake(deps, {
    intakeId: intake.intakeId,
    via: 'cli',
    maxApiSpendUsd: options.maxSpend !== undefined ? Number(options.maxSpend) : null,
    allowedLanes: lanes.length > 0 ? lanes : ['LOCAL'],
  });

  if (options.json !== true) {
    runtime.out(reportTitle(`Approved: ${intake.name}`));
    runtime.out(
      okLine(
        `Human authority recorded as ${approved.approval.approvalId} ` +
          `(authority ${approved.approval.authorityDigest}).`,
      ),
    );
    runtime.out(dim('Everything from here is unattended.'));
    runtime.out('');
  }

  await runBuild(runtime, deps, intake.intakeId, {
    launch: options.launch,
    json: options.json === true,
    subject: name,
    ...(options.maxCycles !== undefined ? { maxCycles: Number(options.maxCycles) } : {}),
  });
}

async function runBuild(
  runtime: CliRuntime,
  deps: IntakeDeps,
  intakeId: string,
  options: { launch: boolean; json: boolean; subject: string; maxCycles?: number },
): Promise<void> {
  const context = loadExecutionContext(runtime);
  const result = await runSealAndBuild(deps, {
    intakeId,
    launch: options.launch,
    // A FACTORY, because the deps the driver runs under are not known until
    // the unattended runtime has resolved the seal and built the authority
    // resolver. Constructing the host here would give the driver deps with no
    // resolver, and it would start asking about architecture at 03:00.
    host: (runDeps) =>
      createInProcessDriverHost({
        ...(runDeps as Record<string, unknown>),
        registry: context.registry,
      } as never),
    ...(options.maxCycles !== undefined ? { maxCycles: options.maxCycles } : {}),
    onEvent: (event) => {
      if (!options.json) runtime.out(dim(`  ${event.kind}: ${event.message}`));
    },
  });

  // Record what the build produced in the product's feature lineage, so the
  // NEXT specification's discovery can see it.
  recordFeatureOutcome(deps, intakeId, {
    ...(result.lifecycle.sealId !== undefined ? { sealId: result.lifecycle.sealId } : {}),
    ...(result.lifecycle.specName !== undefined ? { specName: result.lifecycle.specName } : {}),
    ...(result.lifecycle.jobId !== undefined ? { jobId: result.lifecycle.jobId } : {}),
    outcome: result.outcome,
  });

  const telemetry = computeIntakeTelemetry(deps, intakeId);

  if (options.json) {
    jsonOut(runtime, 'spec-intake-build/v1', {
      intakeId,
      outcome: result.outcome,
      specName: result.lifecycle.specName ?? null,
      sealId: result.lifecycle.sealId ?? null,
      jobId: result.lifecycle.jobId ?? null,
      humanPrerequisites: result.humanPrerequisites,
      steps: result.lifecycle.steps.map((step) => ({
        step: step.step,
        status: step.status,
        detail: step.detail ?? null,
      })),
      stop: result.unattended?.stop ?? null,
      telemetry: telemetry as unknown as Record<string, unknown>,
    });
  } else {
    runtime.out('');
    renderLifecycle(runtime, result.lifecycle);
    runtime.out('');
    switch (result.outcome) {
      case 'COMPLETED':
        runtime.out(reportTitle('COMPLETED'));
        runtime.out(okLine(result.unattended?.stop.kind ?? 'the job reached contract closure'));
        break;
      case 'LAUNCHED':
        runtime.out(
          options.launch
            ? warnLine('The unattended run stopped without a terminal product state; the job is resumable.')
            : okLine(`Ready to run: ${CLI_BIN} spec intake ${options.subject} --resume`),
        );
        break;
      case 'NEEDS_AUTHORITY':
        runtime.out(reportTitle('NEEDS_AUTHORITY'));
        runtime.out(
          blockedLine(
            result.unattended?.stop.kind === 'needs-authority'
              ? result.unattended.stop.question
              : 'a product decision is required',
          ),
        );
        break;
      case 'HUMAN_PREREQUISITE_REQUIRED':
        runtime.out(reportTitle('HUMAN_ACTION_REQUIRED'));
        runtime.out(
          failLine(
            'The build did not start: prerequisites only a person can satisfy remain.',
          ),
        );
        for (const prerequisite of result.humanPrerequisites) {
          runtime.out(dim(`  ${prerequisite}`));
        }
        runtime.out(
          dim(`  Fix them, then: ${CLI_BIN} spec intake ${options.subject} --resume`),
        );
        break;
      default:
        runtime.out(reportTitle('STOPPED'));
        runtime.out(
          failLine(
            result.lifecycle.steps.find((step) => step.status === 'FAILED')?.detail ??
              'a lifecycle step failed',
          ),
        );
        runtime.out(dim(`  Resume with: ${CLI_BIN} spec intake ${options.subject} --resume`));
        break;
    }
    runtime.out(sectionTitle('Zero-touch boundary'));
    runtime.out(
      dim(
        `  discoveryHumanTurns ${telemetry.discoveryHumanTurns} · ` +
          `authorityApprovalCount ${telemetry.authorityApprovalCount}`,
      ),
    );
    const interventions = telemetry.humanInterventionsAfterSeal;
    runtime.out(
      interventions === null
        ? dim('  humanInterventionsAfterSeal: n/a')
        : interventions === 0
          ? okLine('  humanInterventionsAfterSeal: 0')
          : failLine(`  humanInterventionsAfterSeal: ${interventions}`),
    );
  }

  if (result.outcome !== 'COMPLETED' && result.outcome !== 'LAUNCHED') {
    runtime.exitCode = EXIT_CODES.gateFailure;
  }
}
