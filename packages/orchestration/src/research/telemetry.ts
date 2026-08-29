import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from '@specbridge/core';
import { assertInsideWorkspace, writeFileAtomic } from '@specbridge/core';
import { z } from 'zod';
import type {
  ResearchGateDecision,
  ResearchProviderExecutionResult,
  ResearchUsage,
} from './contracts.js';
import {
  RESEARCH_GATE_DECISIONS,
  RESEARCH_TELEMETRY_SCHEMA_VERSION,
} from './contracts.js';
import { researchRootDir } from './store.js';

const decisionCountsSchema = z.object(
  Object.fromEntries(RESEARCH_GATE_DECISIONS.map((decision) => [decision, z.number().int().nonnegative()])) as {
    [K in ResearchGateDecision]: z.ZodNumber;
  },
);

export const researchTelemetrySchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default(RESEARCH_TELEMETRY_SCHEMA_VERSION),
    gateConsidered: z.number().int().nonnegative(),
    decisions: decisionCountsSchema,
    providerCalls: z.number().int().nonnegative(),
    successfulResearch: z.number().int().nonnegative(),
    inconclusiveResearch: z.number().int().nonnegative(),
    failedResearch: z.number().int().nonnegative(),
    reusedReports: z.number().int().nonnegative(),
    budgetRefusals: z.number().int().nonnegative(),
    reportedUsage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        providerReportedCost: z.number().nonnegative(),
        subagentCount: z.number().int().nonnegative(),
        reports: z.number().int().nonnegative(),
      })
      .strict(),
    totalDurationMs: z.number().int().nonnegative(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ResearchTelemetry = z.infer<typeof researchTelemetrySchema>;

function zeroDecisionCounts(): Record<ResearchGateDecision, number> {
  return Object.fromEntries(RESEARCH_GATE_DECISIONS.map((decision) => [decision, 0])) as Record<
    ResearchGateDecision,
    number
  >;
}
export function emptyResearchTelemetry(now: Date): ResearchTelemetry {
  return {
    schemaVersion: RESEARCH_TELEMETRY_SCHEMA_VERSION,
    gateConsidered: 0,
    decisions: zeroDecisionCounts(),
    providerCalls: 0,
    successfulResearch: 0,
    inconclusiveResearch: 0,
    failedResearch: 0,
    reusedReports: 0,
    budgetRefusals: 0,
    reportedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerReportedCost: 0,
      subagentCount: 0,
      reports: 0,
    },
    totalDurationMs: 0,
    updatedAt: now.toISOString(),
  };
}

export function researchTelemetryFile(workspace: WorkspaceInfo): string {
  return assertInsideWorkspace(workspace.rootDir, path.join(researchRootDir(workspace), 'telemetry.json'));
}

/** Corrupt telemetry is preserved and treated as absent; it is never authority. */
export function readResearchTelemetry(
  workspace: WorkspaceInfo,
  now: Date = new Date(),
): { telemetry: ResearchTelemetry; diagnostic?: string } {
  const file = researchTelemetryFile(workspace);
  if (!existsSync(file)) return { telemetry: emptyResearchTelemetry(now) };
  try {
    const parsed = researchTelemetrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success
      ? { telemetry: parsed.data }
      : { telemetry: emptyResearchTelemetry(now), diagnostic: 'research telemetry is schema-invalid' };
  } catch {
    return { telemetry: emptyResearchTelemetry(now), diagnostic: 'research telemetry is unreadable' };
  }
}

function writeTelemetry(workspace: WorkspaceInfo, value: ResearchTelemetry): ResearchTelemetry {
  const telemetry = researchTelemetrySchema.parse(value);
  const file = researchTelemetryFile(workspace);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(telemetry, null, 2)}\n`);
  return telemetry;
}

export function recordResearchGateTelemetry(
  workspace: WorkspaceInfo,
  decision: ResearchGateDecision,
  now: Date,
): ResearchTelemetry {
  const current = readResearchTelemetry(workspace, now).telemetry;
  return writeTelemetry(workspace, {
    ...current,
    gateConsidered: current.gateConsidered + 1,
    decisions: { ...current.decisions, [decision]: current.decisions[decision] + 1 },
    updatedAt: now.toISOString(),
  });
}

function addUsage(current: ResearchTelemetry, usage: ResearchUsage | undefined): ResearchTelemetry['reportedUsage'] {
  if (usage === undefined) return current.reportedUsage;
  return {
    inputTokens: current.reportedUsage.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: current.reportedUsage.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: current.reportedUsage.totalTokens + (usage.totalTokens ?? 0),
    providerReportedCost:
      current.reportedUsage.providerReportedCost + (usage.providerReportedCost ?? 0),
    subagentCount: current.reportedUsage.subagentCount + (usage.subagentCount ?? 0),
    reports: current.reportedUsage.reports + 1,
  };
}

export function recordResearchReuseTelemetry(
  workspace: WorkspaceInfo,
  now: Date,
): ResearchTelemetry {
  const current = readResearchTelemetry(workspace, now).telemetry;
  return writeTelemetry(workspace, {
    ...current,
    reusedReports: current.reusedReports + 1,
    updatedAt: now.toISOString(),
  });
}

export function recordResearchBudgetRefusalTelemetry(
  workspace: WorkspaceInfo,
  now: Date,
): ResearchTelemetry {
  const current = readResearchTelemetry(workspace, now).telemetry;
  return writeTelemetry(workspace, {
    ...current,
    budgetRefusals: current.budgetRefusals + 1,
    updatedAt: now.toISOString(),
  });
}

export function recordResearchProviderTelemetry(
  workspace: WorkspaceInfo,
  result: ResearchProviderExecutionResult,
  durationMs: number,
  now: Date,
): ResearchTelemetry {
  const current = readResearchTelemetry(workspace, now).telemetry;
  const report = result.ok ? result.report : undefined;
  return writeTelemetry(workspace, {
    ...current,
    providerCalls: current.providerCalls + 1,
    successfulResearch:
      current.successfulResearch + (report?.status === 'COMPLETED' ? 1 : 0),
    inconclusiveResearch:
      current.inconclusiveResearch + (report?.status === 'INCONCLUSIVE' ? 1 : 0),
    failedResearch: current.failedResearch + (result.ok ? 0 : 1),
    reportedUsage: addUsage(current, report?.usage),
    totalDurationMs: current.totalDurationMs + Math.max(0, Math.trunc(durationMs)),
    updatedAt: now.toISOString(),
  });
}
