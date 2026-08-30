import { failLine, infoLine, okLine, reportTitle, sectionTitle, warnLine } from './terminal-report.js';

interface FractionMetric {
  numerator: number | null;
  denominator: number | null;
  value: number | null;
}

interface TokenTelemetry {
  knownTokens: number | null;
  coverage: { ratio: number | null; complete: boolean };
}

/** Structural view keeps the renderer independent from the runtime collector. */
export interface ExecutionTelemetryReportView {
  jobId: string;
  outcome: {
    status: string;
    authoritativeJobStatus: string;
    verification: 'PASS' | 'FAIL' | 'UNAVAILABLE';
    closure: 'PASS' | 'FAIL' | 'UNAVAILABLE';
  };
  period: { durationMs: number | null; activeExecutionMs: number | null };
  human: {
    zeroTouchAfterSeal: boolean;
    interventionsAfterSeal: number;
    decisionsBeforeSeal: number | null;
    approvals: number;
    authorityEscalationsAfterSeal: number | null;
  };
  work: {
    total: number;
    completedImplementation: number;
    accounting: Record<string, number>;
    objectives: Array<{
      objectiveNodeId: string;
      graphRevision: number | null;
      total: number;
      implementationAttempts: number;
      secondaryAttempts: number;
      strongBuilderAttempts: number;
    }>;
    units: Array<{
      objectiveNodeId: string;
      workUnitId: string;
      accounting: string;
      builderPath: string;
      implementationAttempts: number;
      verification: string;
    }>;
  };
  attempts: { uniqueImplementationAttempts: number };
  secondary: {
    eligibility: { eligible: number };
    selection: { secondarySelected: number };
    funnel: { initialPass: number; repairPass: number };
    initialSuccessRate: FractionMetric;
    repairRecoveryRate: FractionMetric;
    toStrongFallbackRate: FractionMetric;
    builderTokens: TokenTelemetry;
  };
  strong: {
    builderAttempts: number;
    evaluatorAttempts: number;
    implementationTokens: TokenTelemetry;
    evaluatorTokens: TokenTelemetry;
  };
  research: {
    scope: string;
    considered: number | null;
    providerCalls: number;
    priorResearchReused: number;
    avoidanceRatio: FractionMetric;
    reuseRate: FractionMetric;
    newQuick: number;
    newDeep: number;
  };
  cooldown: {
    episodes: number;
    totalDurationMs: number | null;
    usefulWorkDuringSubscriptionCooldown: number;
    avoidableIdlePeriods: number;
    timeline: Array<{ at: string; type: string; detail: string }>;
  };
  reliability: {
    processRestarts: number;
    supervisorRestarts: number;
    candidatesReusedAfterRestart: number;
    candidateRebuildsAfterRestart: number;
    completedWorkRedoCount: number;
  };
  verification: { passes: number; attempts: number; failures: number };
  closure: { earned: number; waived: number; unresolved: number };
  efficiency: { strongBuilderAvoidanceRatio: FractionMetric };
  qualificationSummary: {
    secondaryToStrongFallback: number;
    usefulWorkDuringSubscriptionCooldown: number;
    humanInterventionsAfterSeal: number;
    completedWorkRedoCount: number;
  };
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
}

export interface RenderExecutionTelemetryOptions {
  verbose?: boolean | undefined;
}

function percent(metric: FractionMetric): string {
  return metric.value === null ? 'n/a' : `${(metric.value * 100).toFixed(1)}%`;
}

function tokens(metric: TokenTelemetry): string {
  if (metric.knownTokens === null) return 'n/a (provider did not report usage)';
  const coverage = metric.coverage.ratio === null
    ? 'n/a'
    : `${Math.round(metric.coverage.ratio * 100)}%`;
  return `${metric.knownTokens.toLocaleString('en-US')} known (${coverage} attempt coverage${metric.coverage.complete ? ', complete' : ', partial'})`;
}

function duration(value: number | null): string {
  if (value === null) return 'n/a';
  if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)}h`;
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  return `${(value / 1_000).toFixed(1)}s`;
}

/**
 * Compact operator report. It renders normalized aggregates and bounded
 * references, never prompts, raw source, model output, or verification logs.
 */
export function renderExecutionTelemetryReport(
  report: ExecutionTelemetryReportView,
  options: RenderExecutionTelemetryOptions = {},
): string {
  const lines: string[] = [reportTitle(`Job ${report.jobId} — ${report.outcome.status}`)];
  lines.push(infoLine(`authoritative state: ${report.outcome.authoritativeJobStatus}`));
  lines.push(infoLine(`elapsed ${duration(report.period.durationMs)} · active ${duration(report.period.activeExecutionMs)}`));

  lines.push('', sectionTitle('Zero-touch status'));
  lines.push(
    report.human.zeroTouchAfterSeal
      ? okLine('ZeroTouchAfterSeal: true (0 human interventions)')
      : failLine(`ZeroTouchAfterSeal: false (${report.human.interventionsAfterSeal} intervention(s))`),
  );
  lines.push(infoLine(`pre-seal decisions ${report.human.decisionsBeforeSeal ?? 'n/a'} · approvals ${report.human.approvals} · post-seal authority stops ${report.human.authorityEscalationsAfterSeal ?? 'n/a'}`));

  lines.push('', sectionTitle('Work summary'));
  lines.push(infoLine(`${report.work.total} WorkUnit(s) · ${report.work.accounting.completed} completed · ${report.work.accounting.failed} failed · ${report.work.accounting.waiting} waiting`));
  lines.push(infoLine(`${report.work.completedImplementation} implementation WorkUnit(s) integrated · ${report.attempts.uniqueImplementationAttempts} unique implementation attempt(s)`));

  lines.push('', sectionTitle('Secondary Builder efficiency'));
  lines.push(infoLine(`${report.secondary.eligibility.eligible} eligible · ${report.secondary.selection.secondarySelected} selected · ${report.secondary.funnel.initialPass} initial pass · ${report.secondary.funnel.repairPass} repair pass`));
  lines.push(infoLine(`StrongBuilderAvoidanceRatio ${percent(report.efficiency.strongBuilderAvoidanceRatio)} (${report.efficiency.strongBuilderAvoidanceRatio.numerator ?? 'n/a'}/${report.efficiency.strongBuilderAvoidanceRatio.denominator ?? 'n/a'})`));
  lines.push(infoLine(`SecondaryInitialSuccessRate ${percent(report.secondary.initialSuccessRate)} · SecondaryRepairRecoveryRate ${percent(report.secondary.repairRecoveryRate)} · fallback ${percent(report.secondary.toStrongFallbackRate)}`));
  lines.push(infoLine(`Secondary builder tokens: ${tokens(report.secondary.builderTokens)}`));

  lines.push('', sectionTitle('Strong usage'));
  lines.push(infoLine(`${report.strong.builderAttempts} Strong Builder attempt(s) · ${report.strong.evaluatorAttempts} Strong Evaluator attempt(s)`));
  lines.push(infoLine(`Strong implementation tokens: ${tokens(report.strong.implementationTokens)}`));
  lines.push(infoLine(`Strong evaluator tokens: ${tokens(report.strong.evaluatorTokens)}`));

  lines.push('', sectionTitle('Research efficiency'));
  lines.push(infoLine(`scope ${report.research.scope} · considered ${report.research.considered ?? 'n/a'} · new calls ${report.research.providerCalls} · reused ${report.research.priorResearchReused}`));
  lines.push(infoLine(`ResearchAvoidanceRatio ${percent(report.research.avoidanceRatio)} · reuse rate ${percent(report.research.reuseRate)} · QUICK ${report.research.newQuick} · DEEP ${report.research.newDeep}`));

  lines.push('', sectionTitle('Subscription cooldown'));
  lines.push(infoLine(`${report.cooldown.episodes} episode(s) · ${duration(report.cooldown.totalDurationMs)} known duration · ${report.cooldown.usefulWorkDuringSubscriptionCooldown} useful WorkUnit(s)`));
  lines.push(
    report.cooldown.avoidableIdlePeriods === 0
      ? okLine('AvoidableIdleDuringCooldown: 0')
      : warnLine(`AvoidableIdleDuringCooldown: ${report.cooldown.avoidableIdlePeriods}`),
  );

  lines.push('', sectionTitle('Reliability / resume'));
  lines.push(infoLine(`restarts ${report.reliability.processRestarts + report.reliability.supervisorRestarts} · candidates reused ${report.reliability.candidatesReusedAfterRestart} · candidate rebuilds ${report.reliability.candidateRebuildsAfterRestart}`));
  lines.push(
    report.reliability.completedWorkRedoCount === 0
      ? okLine('CompletedWorkRedoCount: 0')
      : failLine(`CompletedWorkRedoCount: ${report.reliability.completedWorkRedoCount}`),
  );

  lines.push('', sectionTitle('Verification & closure'));
  lines.push(
    report.outcome.verification === 'PASS'
      ? okLine(`verification PASS (${report.verification.passes}/${report.verification.attempts} WorkUnit evaluation passes)`)
      : report.outcome.verification === 'FAIL'
        ? failLine(`verification FAIL (${report.verification.failures} WorkUnit evaluation failure(s))`)
        : warnLine(`verification n/a (${report.verification.passes} WorkUnit evaluation pass(es), authoritative job evidence unavailable)`),
  );
  lines.push(
    report.outcome.closure === 'PASS'
      ? okLine(`closure PASS (${report.closure.earned} earned, ${report.closure.waived} waived)`)
      : report.outcome.closure === 'FAIL'
        ? failLine(`closure FAIL (${report.closure.unresolved} unresolved)`)
        : warnLine('closure n/a (no closure ledger)'),
  );

  if (report.diagnostics.length > 0) {
    lines.push('', sectionTitle('Diagnostics'));
    for (const diagnostic of report.diagnostics.slice(0, options.verbose === true ? 200 : 10)) {
      lines.push(
        diagnostic.severity === 'error'
          ? failLine(`${diagnostic.code}: ${diagnostic.message}`)
          : diagnostic.severity === 'warning'
            ? warnLine(`${diagnostic.code}: ${diagnostic.message}`)
            : infoLine(`${diagnostic.code}: ${diagnostic.message}`),
      );
    }
  }

  if (options.verbose === true) {
    lines.push('', sectionTitle('Objective accounting'));
    for (const objective of report.work.objectives) {
      lines.push(infoLine(`${objective.objectiveNodeId} · revision ${objective.graphRevision ?? 'n/a'} · ${objective.total} WorkUnit(s) · ${objective.implementationAttempts} implementation attempt(s) (${objective.secondaryAttempts} Secondary, ${objective.strongBuilderAttempts} Strong)`));
    }
    lines.push('', sectionTitle('WorkUnit accounting'));
    for (const unit of report.work.units) {
      lines.push(infoLine(`${unit.objectiveNodeId}/${unit.workUnitId} · ${unit.accounting} · ${unit.builderPath} · ${unit.implementationAttempts} attempt(s) · verification ${unit.verification}`));
    }
    if (report.cooldown.timeline.length > 0) {
      lines.push('', sectionTitle('Cooldown timeline'));
      for (const entry of report.cooldown.timeline) {
        lines.push(infoLine(`${entry.at} · ${entry.type} · ${entry.detail}`));
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Markdown form for persisted engineering/Phase-10 evidence. */
export function renderExecutionTelemetryMarkdown(report: ExecutionTelemetryReportView): string {
  const summary = report.qualificationSummary;
  return [
    `# Job ${report.jobId} execution report`,
    '',
    `- Outcome: **${report.outcome.status}** (authoritative state: ${report.outcome.authoritativeJobStatus})`,
    `- ZeroTouchAfterSeal: **${report.human.zeroTouchAfterSeal}**`,
    `- StrongBuilderAvoidanceRatio: **${percent(report.efficiency.strongBuilderAvoidanceRatio)}**`,
    `- SecondaryInitialSuccessRate: **${percent(report.secondary.initialSuccessRate)}**`,
    `- SecondaryRepairRecoveryRate: **${percent(report.secondary.repairRecoveryRate)}**`,
    `- SecondaryToStrongFallback: **${summary.secondaryToStrongFallback}**`,
    `- ResearchAvoidanceRatio: **${percent(report.research.avoidanceRatio)}**`,
    `- UsefulWorkDuringSubscriptionCooldown: **${summary.usefulWorkDuringSubscriptionCooldown}**`,
    `- humanInterventionsAfterSeal: **${summary.humanInterventionsAfterSeal}**`,
    `- CompletedWorkRedoCount: **${summary.completedWorkRedoCount}**`,
    `- Verification: **${report.outcome.verification}**`,
    `- Closure: **${report.outcome.closure}**`,
    '',
    'Metrics are derived evidence. They do not grant completion, verification, or product authority.',
    '',
  ].join('\n');
}
