import path from 'node:path';
import type { AgentConfig, ClaudeProfileConfig, WorkspaceInfo } from '@specbridge/core';
import { effectiveLocalInputCharacters } from '@specbridge/core';
import {
  buildClaudeInvocation,
  cleanupTempFiles,
  costFromEnvelope,
  localStructuredInference,
  claudeFailureProblem,
  parseClaudeEnvelope,
  probeClaude,
  runSafeProcess,
  usageFromEnvelope,
} from '@specbridge/runners';
import type { ClaudeProbe, LocalModelManager } from '@specbridge/runners';
import { correctionMessage } from '../agents/contracts.js';
import type { ObjectiveContractRole, ObjectiveOutputFor } from './contracts.js';
import { OBJECTIVE_OUTPUT_JSON_SCHEMAS, validateObjectiveOutput } from './contracts.js';
import { objectiveRoleSystemPrompt } from './prompts.js';

/**
 * Objective role workers: how one bounded invocation of a DECOMPOSER,
 * EVALUATOR, AGGREGATOR, or BUILDER actually runs.
 *
 * The same three invariants as driver/workers.ts:
 *   - the COMPLETE response is validated against the role contract
 *   - a worker failure is data, never a task failure
 *   - reasoning roles are read-only; only the BUILDER gets edit-capable
 *     tools, and its working directory is the isolated worktree — the
 *     invocation cannot reach the canonical checkout because its cwd IS its
 *     entire workspace and the packet says so
 */

export interface ObjectiveWorkerUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface ObjectiveWorkerSuccess<Role extends ObjectiveContractRole> {
  ok: true;
  output: ObjectiveOutputFor<Role>;
  raw: string;
  usage?: ObjectiveWorkerUsage;
}

export interface ObjectiveWorkerFailure {
  ok: false;
  kind: 'worker-unavailable' | 'invalid-output' | 'cancelled' | 'context-exceeded';
  problem: string;
}

export type ObjectiveWorkerResult<Role extends ObjectiveContractRole> =
  | ObjectiveWorkerSuccess<Role>
  | ObjectiveWorkerFailure;

// ---------------------------------------------------------------------------
// Local role worker (llama.cpp; read-only reasoning roles only)
//
// BUILDER capability is provided separately by SecondaryObjectiveBuilder:
// it has a different bounded packet/edit contract and is selected explicitly,
// so it must not be smuggled through this reasoning-role API.
// ---------------------------------------------------------------------------

export interface LocalObjectiveInvocation<Role extends ObjectiveContractRole> {
  manager: LocalModelManager;
  config: AgentConfig;
  role: Role;
  packet: string;
  maxCorrections: number;
  onInferenceCall: () => void;
  signal?: AbortSignal | undefined;
}

export async function runLocalObjectiveRole<Role extends ObjectiveContractRole>(
  invocation: LocalObjectiveInvocation<Role>,
): Promise<ObjectiveWorkerResult<Role>> {
  if (invocation.role === 'BUILDER') {
    return {
      ok: false,
      kind: 'worker-unavailable',
      problem: 'Use the explicitly selected SecondaryObjectiveBuilder for direct-model BUILDER work.',
    };
  }
  const local = invocation.config.localInference;
  const system = objectiveRoleSystemPrompt(invocation.role);
  const inputCeiling = effectiveLocalInputCharacters(local);
  if (system.length + invocation.packet.length > inputCeiling) {
    return {
      ok: false,
      kind: 'context-exceeded',
      problem:
        `The packet is ${system.length + invocation.packet.length} characters and the local ` +
        `input ceiling is ${inputCeiling} — the lower of the configured ` +
        `${local.maximumInputCharacters}-character limit and what a ${local.contextSize}-token ` +
        `context can hold.`,
    };
  }
  const started = await invocation.manager.ensureStarted(invocation.signal);
  if (!started.ok) {
    return {
      ok: false,
      kind: started.kind === 'cancelled' ? 'cancelled' : 'worker-unavailable',
      problem: started.problem,
    };
  }
  let userPrompt = invocation.packet;
  for (let attempt = 0; attempt <= invocation.maxCorrections; attempt += 1) {
    if (invocation.signal?.aborted === true) {
      return { ok: false, kind: 'cancelled', problem: 'The role invocation was cancelled.' };
    }
    invocation.onInferenceCall();
    invocation.manager.touch();
    const result = await localStructuredInference({
      baseUrl: started.baseUrl,
      systemPrompt: system,
      userPrompt,
      jsonSchema: OBJECTIVE_OUTPUT_JSON_SCHEMAS[invocation.role],
      schemaName: invocation.role,
      temperature: local.temperature,
      timeoutMs: local.requestTimeoutMs,
      maxOutputBytes: local.maxOutputBytes,
      ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: result.kind === 'cancelled' ? 'cancelled' : 'worker-unavailable',
        problem: result.problem,
      };
    }
    const validated = validateObjectiveOutput(invocation.role, result.text);
    if (validated.ok) {
      return {
        ok: true,
        output: validated.output,
        raw: result.text,
        ...(result.usage !== undefined ? { usage: { ...result.usage, costUsd: null } } : {}),
      };
    }
    userPrompt = `${invocation.packet}\n\n${correctionMessage(invocation.role as never, validated.problem)}`;
  }
  return {
    ok: false,
    kind: 'invalid-output',
    problem: `The local ${invocation.role} output stayed invalid after ${invocation.maxCorrections} bounded correction(s).`,
  };
}

// ---------------------------------------------------------------------------
// Large-agent worker (Claude Code)
// ---------------------------------------------------------------------------

export interface LargeObjectiveInvocation<Role extends ObjectiveContractRole> {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  runnerProfile: string;
  role: Role;
  packet: string;
  /**
   * The invocation's working directory: the canonical root for read-only
   * reasoning roles, the ISOLATED WORKTREE for the builder. This is the
   * isolation boundary — a builder's whole world is this directory.
   */
  cwd: string;
  /** Scratch directory for the temp output-schema file. */
  scratchDir: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  cachedProbe?: ClaudeProbe | undefined;
}

/**
 * Run one objective role on Claude Code. Reasoning roles get read-only
 * tools; the BUILDER gets the configured implementation tool policy — the
 * same policy task execution already uses, no wider.
 */
export async function runLargeObjectiveRole<Role extends ObjectiveContractRole>(
  invocation: LargeObjectiveInvocation<Role>,
): Promise<ObjectiveWorkerResult<Role> & { probe?: ClaudeProbe }> {
  const profile = invocation.config.runnerProfiles[invocation.runnerProfile];
  if (profile === undefined || profile.runner !== 'claude-code') {
    return {
      ok: false,
      kind: 'worker-unavailable',
      problem: `Runner profile "${invocation.runnerProfile}" is not a Claude Code profile.`,
    };
  }
  const claudeProfile = profile as ClaudeProfileConfig;
  const probe =
    invocation.cachedProbe ??
    (await probeClaude(claudeProfile, {
      ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
    }));
  if (!probe.found || probe.status === 'unavailable' || probe.status === 'error') {
    return {
      ok: false,
      kind: 'worker-unavailable',
      problem: `The Claude Code CLI is not available (status ${probe.status}).`,
    };
  }

  const prompt = [
    objectiveRoleSystemPrompt(invocation.role),
    '',
    `SpecBridge orchestration role: ${invocation.role}`,
    '',
    invocation.packet,
  ].join('\n');

  const plan = buildClaudeInvocation({
    config: claudeProfile,
    probe,
    prompt,
    toolPolicy: invocation.role === 'BUILDER' ? 'implementation' : 'inspect-only',
    outputJsonSchema: OBJECTIVE_OUTPUT_JSON_SCHEMAS[invocation.role],
    execution: {
      workspaceRoot: invocation.cwd,
      runDir: invocation.scratchDir,
      timeoutMs: invocation.timeoutMs,
    },
  });

  try {
    const processResult = await runSafeProcess({
      executable: plan.executable,
      argv: plan.argv,
      cwd: invocation.cwd,
      timeoutMs: invocation.timeoutMs,
      stdin: plan.stdin,
      ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
    });
    if (processResult.status === 'cancelled') {
      return { ok: false, kind: 'cancelled', problem: 'The worker invocation was cancelled.', probe };
    }
    if (processResult.status !== 'ok' && processResult.status !== 'nonzero-exit') {
      return {
        ok: false,
        kind: 'worker-unavailable',
        problem: processResult.failureReason ?? `the worker process ended with status ${processResult.status}`,
        probe,
      };
    }
    const parsed = parseClaudeEnvelope(processResult.stdout);
    if (parsed.problem !== undefined) {
      // See runLargeRole: a non-zero exit without an envelope must keep the
      // CLI's bounded stderr diagnostic, and remains a worker failure.
      return {
        ok: false,
        kind: 'invalid-output',
        problem: claudeFailureProblem(parsed.problem, processResult),
        probe,
      };
    }
    const text =
      parsed.structuredResult !== undefined
        ? JSON.stringify(parsed.structuredResult)
        : (parsed.reportText ?? '');
    const validated = validateObjectiveOutput(invocation.role, text);
    if (!validated.ok) {
      return { ok: false, kind: 'invalid-output', problem: validated.problem, probe };
    }
    const usage = usageFromEnvelope(parsed.envelope, 0);
    const cost = costFromEnvelope(parsed.envelope);
    return {
      ok: true,
      output: validated.output,
      raw: text,
      usage: {
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: cost !== null && cost !== undefined && cost.currency === 'USD' ? cost.amount : null,
      },
      probe,
    };
  } finally {
    cleanupTempFiles(plan);
    try {
      const { rmSync } = await import('node:fs');
      rmSync(path.join(invocation.scratchDir, 'tmp'), { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort.
    }
  }
}
