import { rmSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, ClaudeProfileConfig, WorkspaceInfo } from '@specbridge/core';
import {
  LocalModelManager,
  buildClaudeInvocation,
  localStructuredInference,
  parseClaudeEnvelope,
  probeClaude,
  runSafeProcess,
  usageFromEnvelope,
  costFromEnvelope,
} from '@specbridge/runners';
import type { LocalModelEvent } from '@specbridge/runners';
import {
  AGENT_OUTPUT_JSON_SCHEMAS,
  correctionMessage,
  validateAgentOutput,
} from '../agents/contracts.js';
import type { AgentContractRole, AgentOutputFor } from '../agents/contracts.js';
import { roleSystemPrompt } from '../agents/prompts.js';
import { OrchestrationError } from '../errors.js';

/**
 * Role workers: how one bounded reasoning invocation actually runs.
 *
 * Two implementations behind one result shape:
 *   - the LOCAL worker calls the managed llama.cpp endpoint through the
 *     shared OpenAI-compatible transport
 *   - the LARGE worker invokes Claude Code in inspect-only print mode (the
 *     same invocation machinery the authoring path uses: read-only tools,
 *     JSON schema, no permission bypass)
 *
 * Both validate the COMPLETE response against the role contract; both are
 * ephemeral (nothing here holds state between calls beyond the shared local
 * server process); and both return failures as data — a worker failure is
 * never allowed to look like a task failure.
 */

export interface RoleWorkerSuccess<Role extends AgentContractRole> {
  ok: true;
  output: AgentOutputFor<Role>;
  /** The validated raw JSON text (persisted as the agent result document). */
  raw: string;
  usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  /** True when a bounded correction round was needed. */
  corrected: boolean;
}

export interface RoleWorkerFailure {
  ok: false;
  kind: 'worker-unavailable' | 'invalid-output' | 'cancelled' | 'context-exceeded';
  problem: string;
}

export type RoleWorkerResult<Role extends AgentContractRole> =
  | RoleWorkerSuccess<Role>
  | RoleWorkerFailure;

// ---------------------------------------------------------------------------
// Local worker
// ---------------------------------------------------------------------------

export interface LocalRoleInvocation {
  manager: LocalModelManager;
  config: AgentConfig;
  role: AgentContractRole;
  packet: string;
  /** Bounded correction retries for invalid structured output. */
  maxCorrections: number;
  /** Called before each inference request (budget accounting). */
  onInferenceCall: () => void;
  signal?: AbortSignal | undefined;
}

export async function runLocalRole<Role extends AgentContractRole>(
  invocation: LocalRoleInvocation & { role: Role },
): Promise<RoleWorkerResult<Role>> {
  const local = invocation.config.localInference;
  const system = roleSystemPrompt(invocation.role);
  if (system.length + invocation.packet.length > local.maximumInputCharacters) {
    return {
      ok: false,
      kind: 'context-exceeded',
      problem: `The packet exceeds the configured local input limit of ${local.maximumInputCharacters} characters.`,
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

  let corrected = false;
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
      jsonSchema: AGENT_OUTPUT_JSON_SCHEMAS[invocation.role],
      schemaName: invocation.role,
      temperature: local.temperature,
      timeoutMs: local.requestTimeoutMs,
      maxOutputBytes: local.maxOutputBytes,
      ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
    });
    if (!result.ok) {
      if (result.kind === 'cancelled') {
        return { ok: false, kind: 'cancelled', problem: result.problem };
      }
      // A transport failure mid-conversation usually means the server died;
      // one bounded re-ensure (which itself enforces the restart budget)
      // then a single retry of THIS attempt.
      const revived = await invocation.manager.ensureStarted(invocation.signal);
      if (!revived.ok) {
        return { ok: false, kind: 'worker-unavailable', problem: `${result.problem}; ${revived.problem}` };
      }
      invocation.onInferenceCall();
      const retried = await localStructuredInference({
        baseUrl: revived.baseUrl,
        systemPrompt: system,
        userPrompt,
        jsonSchema: AGENT_OUTPUT_JSON_SCHEMAS[invocation.role],
        schemaName: invocation.role,
        temperature: local.temperature,
        timeoutMs: local.requestTimeoutMs,
        maxOutputBytes: local.maxOutputBytes,
        ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
      });
      if (!retried.ok) {
        return { ok: false, kind: 'worker-unavailable', problem: retried.problem };
      }
      const validated = validateAgentOutput(invocation.role, retried.text);
      if (validated.ok) {
        return {
          ok: true,
          output: validated.output,
          raw: retried.text,
          ...(retried.usage !== undefined
            ? { usage: { ...retried.usage, costUsd: null } }
            : {}),
          corrected,
        };
      }
      userPrompt = `${invocation.packet}\n\n${correctionMessage(invocation.role, validated.problem)}`;
      corrected = true;
      continue;
    }
    const validated = validateAgentOutput(invocation.role, result.text);
    if (validated.ok) {
      return {
        ok: true,
        output: validated.output,
        raw: result.text,
        ...(result.usage !== undefined ? { usage: { ...result.usage, costUsd: null } } : {}),
        corrected,
      };
    }
    userPrompt = `${invocation.packet}\n\n${correctionMessage(invocation.role, validated.problem)}`;
    corrected = true;
  }
  return {
    ok: false,
    kind: 'invalid-output',
    problem: `The local ${invocation.role} output stayed invalid after ${invocation.maxCorrections} bounded correction(s).`,
  };
}

// ---------------------------------------------------------------------------
// Large-agent worker (Claude Code, inspect-only)
// ---------------------------------------------------------------------------

export interface LargeRoleInvocation {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  /** Runner profile name of the large-agent worker. */
  runnerProfile: string;
  role: AgentContractRole;
  packet: string;
  /** Scratch directory for the invocation's temp files (schema file). */
  scratchDir: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * Run one reasoning role on Claude Code.
 *
 * Inspect-only: the invocation gets Read/Glob/Grep, never Edit/Write/Bash,
 * so a reasoning dispatch cannot mutate the repository whatever the model
 * decides — the same boundary stage generation already relies on. The
 * response is the structured role document, schema-constrained where the
 * installed CLI supports it and fully validated here regardless.
 */
export async function runLargeRole<Role extends AgentContractRole>(
  invocation: LargeRoleInvocation & { role: Role },
): Promise<RoleWorkerResult<Role>> {
  const profile = invocation.config.runnerProfiles[invocation.runnerProfile];
  if (profile === undefined || profile.runner !== 'claude-code') {
    return {
      ok: false,
      kind: 'worker-unavailable',
      problem: `Runner profile "${invocation.runnerProfile}" is not a Claude Code profile.`,
    };
  }
  const claudeProfile = profile as ClaudeProfileConfig;

  const probe = await probeClaude(claudeProfile, {
    ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
  });
  if (!probe.found || probe.status === 'unavailable' || probe.status === 'error') {
    return {
      ok: false,
      kind: 'worker-unavailable',
      problem: `The Claude Code CLI is not available (status ${probe.status}).`,
    };
  }

  const prompt = [
    roleSystemPrompt(invocation.role),
    '',
    `SpecBridge orchestration role: ${invocation.role}`,
    '',
    invocation.packet,
  ].join('\n');

  const plan = buildClaudeInvocation({
    config: claudeProfile,
    probe,
    prompt,
    toolPolicy: 'inspect-only',
    outputJsonSchema: AGENT_OUTPUT_JSON_SCHEMAS[invocation.role],
    execution: {
      workspaceRoot: invocation.workspace.rootDir,
      runDir: invocation.scratchDir,
      timeoutMs: invocation.timeoutMs,
    },
  });

  try {
    const processResult = await runSafeProcess({
      executable: plan.executable,
      argv: plan.argv,
      cwd: invocation.workspace.rootDir,
      timeoutMs: invocation.timeoutMs,
      stdin: plan.stdin,
      ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
    });
    if (processResult.status === 'cancelled') {
      return { ok: false, kind: 'cancelled', problem: 'The role invocation was cancelled.' };
    }
    if (processResult.status !== 'ok' && processResult.status !== 'nonzero-exit') {
      return {
        ok: false,
        kind: 'worker-unavailable',
        problem: processResult.failureReason ?? `the runner process ended with status ${processResult.status}`,
      };
    }
    const parsed = parseClaudeEnvelope(processResult.stdout);
    if (parsed.problem !== undefined) {
      return { ok: false, kind: 'invalid-output', problem: parsed.problem };
    }
    const text =
      parsed.structuredResult !== undefined
        ? JSON.stringify(parsed.structuredResult)
        : (parsed.reportText ?? '');
    const validated = validateAgentOutput(invocation.role, text);
    if (!validated.ok) {
      return { ok: false, kind: 'invalid-output', problem: validated.problem };
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
        // Only provider-reported USD amounts count; nothing is fabricated.
        costUsd: cost !== null && cost !== undefined && cost.currency === 'USD' ? cost.amount : null,
      },
      corrected: false,
    };
  } finally {
    // The scratch directory holds only this invocation's temp schema file.
    try {
      rmSync(path.join(invocation.scratchDir, 'tmp'), { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort; nothing durable lives there.
    }
  }
}

/** Build (or reuse) the shared local model manager for a driver run. */
export function createLocalManager(
  config: AgentConfig,
  onEvent: (event: LocalModelEvent) => void,
): LocalModelManager | undefined {
  if (!config.localInference.enabled) return undefined;
  return new LocalModelManager({ config: config.localInference, onEvent });
}

/** Fail closed when a role reaches a worker implementation it must not. */
export function assertReasoningRole(role: string): asserts role is AgentContractRole {
  if (!['CLASSIFIER', 'PLANNER', 'CRITIC', 'DIAGNOSER', 'REPLANNER'].includes(role)) {
    throw new OrchestrationError('SBO034', `${role} is not a reasoning role.`);
  }
}
