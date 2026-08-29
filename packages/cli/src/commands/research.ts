import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import { CLI_BIN, SpecBridgeError } from '@specbridge/core';
import {
  RESEARCH_DEPTHS,
  RESEARCH_RECORD_STATUSES,
  getResearchProviderHealth,
  listResearchRecords,
  readResearchRecord,
  researchRequestSchema,
  startResearch,
} from '@specbridge/orchestration';
import {
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

interface InvestigateOptions {
  depth: string;
  id?: string;
  topic: string[];
  knownFact: string[];
  observedFailure: string[];
  failedStrategy: string[];
  constraint: string[];
  contextRef: string[];
  answer: string[];
  operation?: string;
  job?: string;
  allowSecondarySources?: boolean;
  allowUnsourced?: boolean;
  json?: boolean;
}
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function deps(runtime: CliRuntime) {
  const context = loadExecutionContext(runtime);
  return {
    workspace: context.workspace,
    config: context.config,
    clock: () => runtime.now(),
  };
}

function jsonOut(runtime: CliRuntime, data: Record<string, unknown>): void {
  runtime.outRaw(
    serializeJsonReport(
      createJsonReport('specbridge.research.v1', `${CLI_BIN} ${VERSION}`, data),
    ),
  );
}

function renderRecord(runtime: CliRuntime, record: ReturnType<typeof listResearchRecords>['records'][number]): void {
  runtime.out(reportTitle(`Research ${record.researchId}`));
  runtime.out(
    record.status === 'COMPLETED'
      ? okLine(`${record.status} · ${record.provider} · ${record.depth}`)
      : record.status === 'INCONCLUSIVE'
        ? warnLine(`${record.status} · ${record.provider} · ${record.depth}`)
        : infoLine(`${record.status} · ${record.provider} · ${record.depth}`),
  );
  runtime.out(record.request.question);
  if (record.report !== undefined) {
    runtime.out(sectionTitle('Findings'));
    for (const finding of record.report.findings) {
      runtime.out(`  [${finding.kind}] ${finding.statement}`);
      if (finding.sourceRefs.length > 0) runtime.out(dim(`      sources: ${finding.sourceRefs.join(', ')}`));
    }
    if (record.report.recommendations.length > 0) {
      runtime.out(sectionTitle('Recommendations (not authority)'));
      for (const recommendation of record.report.recommendations) runtime.out(`  ${recommendation}`);
    }
    if (record.report.unresolved.length > 0 || record.report.conflicts.length > 0) {
      runtime.out(sectionTitle('Unresolved / conflicts'));
      for (const value of [...record.report.unresolved, ...record.report.conflicts]) runtime.out(`  ${value}`);
    }
    if (record.report.sourceRefs.length > 0) {
      runtime.out(sectionTitle('Sources'));
      for (const source of record.report.sourceRefs) {
        runtime.out(`  ${source.refId}: ${source.title ?? source.url ?? source.providerSourceId ?? '(provider reference)'}`);
      }
    }
  }
  if (record.failure !== undefined) {
    runtime.out(failLine(`${record.failure.classification}: ${record.failure.message}`));
  }
  runtime.out(dim('Research is evidence, not product, Mission, task, or completion authority.'));
}

export function registerResearchCommands(program: Command, runtime: CliRuntime): void {
  const research = program
    .command('research')
    .description('Optional bounded external research: status, manual execution, and durable records');

  research
    .command('status')
    .description('Show research configuration and normalized provider health')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const d = deps(runtime);
      const health = await getResearchProviderHealth(d);
      const policy = d.config.research;
      const providerEnabled = policy.provider === 'deerflow' && policy.providers.deerflow.enabled;
      if (options.json === true) {
        jsonOut(runtime, { policy: { enabled: policy.enabled, provider: policy.provider, strategy: policy.strategy, providerEnabled }, health });
        return;
      }
      runtime.out(reportTitle('Research provider'));
      runtime.out(infoLine(`research: ${policy.enabled ? 'enabled' : 'disabled'} · provider: ${policy.provider} (${providerEnabled ? 'enabled' : 'disabled'})`));
      runtime.out(
        health.status === 'HEALTHY'
          ? okLine(`health: ${health.status}`)
          : health.status === 'DEGRADED' || health.status === 'UNKNOWN'
            ? warnLine(`health: ${health.status}${health.detail !== undefined ? ` — ${health.detail}` : ''}`)
            : failLine(`health: ${health.status}${health.detail !== undefined ? ` — ${health.detail}` : ''}`),
      );
    });

  research
    .command('investigate <question...>')
    .description('Execute or exactly reuse one explicit bounded research request')
    .option('--depth <depth>', `research intent: ${RESEARCH_DEPTHS.join(' | ')}`, 'QUICK')
    .option('--id <research-id>', 'explicit durable research id')
    .option('--topic <tag>', 'explicit reuse topic tag (repeatable)', collect, [])
    .option('--known-fact <text>', 'bounded known fact (repeatable)', collect, [])
    .option('--observed-failure <text>', 'bounded observed failure (repeatable)', collect, [])
    .option('--failed-strategy <text>', 'bounded failed strategy (repeatable)', collect, [])
    .option('--constraint <text>', 'bounded research constraint (repeatable)', collect, [])
    .option('--context-ref <ref>', 'reference to bounded current-system context (repeatable)', collect, [])
    .option('--answer <question>', 'specific question the report must answer (repeatable)', collect, [])
    .option('--operation <id>', 'operation id for QUICK/DEEP budget accounting')
    .option('--job <id>', 'job id for total research budget accounting')
    .option('--allow-secondary-sources', 'do not prefer primary sources')
    .option('--allow-unsourced', 'allow a completed result without source references')
    .option('--json', 'machine-readable output')
    .action(async (questionParts: string[], options: InvestigateOptions) => {
      if (!RESEARCH_DEPTHS.includes(options.depth as (typeof RESEARCH_DEPTHS)[number])) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `--depth must be ${RESEARCH_DEPTHS.join(' or ')}.`);
      }
      const question = questionParts.join(' ').trim();
      const parsed = researchRequestSchema.safeParse({
        researchId: options.id ?? `research-${randomUUID()}`,
        depth: options.depth,
        question,
        topicTags: options.topic,
        context: {
          knownFacts: options.knownFact,
          observedFailures: options.observedFailure,
          failedStrategies: options.failedStrategy,
          constraints: options.constraint,
          contextRefs: options.contextRef,
        },
        expectedOutput: { questionsToAnswer: options.answer.length > 0 ? options.answer : [question] },
        sourcePolicy: {
          preferPrimarySources: options.allowSecondarySources !== true,
          requireSources: options.allowUnsourced !== true,
        },
      });
      if (!parsed.success) {
        throw new SpecBridgeError(
          'INVALID_ARGUMENT',
          `Invalid bounded research request: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      }
      const result = await startResearch(
        deps(runtime),
        parsed.data,
        {
          ...(options.operation !== undefined ? { operationId: options.operation } : {}),
          ...(options.job !== undefined ? { jobId: options.job } : {}),
        },
      );
      if (options.json === true) {
        jsonOut(runtime, result as unknown as Record<string, unknown>);
        if (!result.ok) runtime.exitCode = 1;
        return;
      }
      if (!result.ok) {
        runtime.out(failLine(`${result.failure.classification}: ${result.failure.message}`));
        runtime.out(dim('No report was fabricated and no control-plane authority changed.'));
        runtime.exitCode = 1;
        return;
      }
      if (result.reused) runtime.out(okLine(`Exact prior research reused; provider was not called.`));
      renderRecord(runtime, result.record);
    });

  research
    .command('show <research-id>')
    .description('Show one durable ResearchRecord')
    .option('--json', 'machine-readable output')
    .action((researchId: string, options: { json?: boolean }) => {
      const read = readResearchRecord(runtime.workspace(), researchId);
      if (read.kind !== 'ok') {
        const detail =
          read.kind === 'missing'
            ? 'not found'
            : read.kind === 'unsupported-version'
              ? `uses unsupported schema ${read.version}`
              : `is corrupt and preserved at ${read.file}`;
        throw new SpecBridgeError('INVALID_ARGUMENT', `Research record ${researchId} ${detail}.`);
      }
      if (options.json === true) jsonOut(runtime, { record: read.record });
      else renderRecord(runtime, read.record);
    });

  research
    .command('list')
    .description('List durable ResearchRecord summaries')
    .option('--status <status>', `filter: ${RESEARCH_RECORD_STATUSES.join(' | ')}`)
    .option('--topic <tag>', 'filter by an exact explicit topic tag')
    .option('--json', 'machine-readable output')
    .action((options: { status?: string; topic?: string; json?: boolean }) => {
      if (
        options.status !== undefined &&
        !RESEARCH_RECORD_STATUSES.includes(options.status as (typeof RESEARCH_RECORD_STATUSES)[number])
      ) {
        throw new SpecBridgeError('INVALID_ARGUMENT', `--status must be ${RESEARCH_RECORD_STATUSES.join(', ')}.`);
      }
      const listed = listResearchRecords(runtime.workspace());
      const records = listed.records
        .filter((record) => options.status === undefined || record.status === options.status)
        .filter((record) => options.topic === undefined || record.topicTags.includes(options.topic));
      if (options.json === true) {
        jsonOut(runtime, { records, diagnostics: listed.diagnostics });
        return;
      }
      runtime.out(reportTitle('Research records'));
      if (records.length === 0) runtime.out(dim('No matching research records.'));
      for (const record of records) {
        runtime.out(`${record.researchId}  ${record.status}  ${record.depth}  ${record.request.question}`);
      }
      for (const diagnostic of listed.diagnostics) runtime.out(warnLine(diagnostic.message));
    });
}
