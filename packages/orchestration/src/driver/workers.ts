import type { AgentConfig, WorkspaceInfo } from '@specbridge/core';
import { effectiveLocalInputCharacters } from '@specbridge/core';
import {
  LocalModelManager,
  createDefaultRunnerRegistry,
  localStructuredInference,
} from '@specbridge/runners';
import type { LocalModelEvent, RunnerRegistry } from '@specbridge/runners';
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
  /**
   * A bounded excerpt of what the worker actually returned.
   *
   * Carried ONLY for invalid output, and only so an operator can see it. The
   * vNext.10.1 dogfood blocked a job with "the response is not a single
   * valid JSON document" and retained nothing at all — a message with no
   * evidence behind it, which is exactly what this codebase refuses to do
   * everywhere else. Never parsed, never repaired, never acted on: mining
   * JSON out of prose is the silent malformed-output repair the contract
   * validator exists to refuse.
   */
  observed?: string | undefined;
}

/** The bound on a retained excerpt. Enough to recognise, too little to act on. */
export const OBSERVED_OUTPUT_EXCERPT_CHARS = 600;

/**
 * A response that is an AUTHENTICATION failure wearing the shape of output.
 *
 * The vNext.10.1 dogfood hit this: the worker exited zero and its result body
 * was "Failed to authenticate. API Error: 401 OAuth access token has expired.
 * Re-authenticate to continue." Because it is not JSON, it was classified
 * `invalid-output` and the job blocked on "the response is not a single valid
 * JSON document" — technically true, and the least useful sentence available.
 * An expired credential is a HUMAN prerequisite, and saying so is the
 * difference between a five-second fix and a morning of confusion.
 *
 * Three conditions together, because a legitimate plan can talk about
 * authentication — the very specification that produced this run is about
 * identity verification. It must have FAILED validation, it must be short
 * enough to be an error rather than a document, and it must carry an
 * unambiguous credential signature.
 */
const AUTH_FAILURE_PATTERN = new RegExp(
  String.raw`\b(401|403|unauthorized|unauthenticated|failed to authenticate` +
    String.raw`|re-?authenticate|oauth[^.]{0,40}\bexpired\b|token has expired` +
    String.raw`|expired token|invalid api key|api key not found|please log ?in` +
    String.raw`|credentials? (are )?(invalid|missing|expired))\b`,
  'i',
);

const AUTH_FAILURE_MAX_CHARS = 2_000;

export function looksLikeAuthenticationFailure(text: string): boolean {
  const collapsed = text.trim();
  if (collapsed.length === 0 || collapsed.length > AUTH_FAILURE_MAX_CHARS) return false;
  // A JSON DOCUMENT is never an authentication error, whatever words it
  // contains. This is the discriminator that matters: the specification
  // behind the dogfood is about identity verification, and a perfectly good
  // plan for it says "reject an unauthorized passenger with a 401-shaped
  // response". An auth failure is a bare error string, not a document.
  try {
    JSON.parse(collapsed);
    return false;
  } catch {
    // Not JSON — which is the only case that reaches here in production
    // anyway, since this runs only after contract validation failed.
  }
  return AUTH_FAILURE_PATTERN.test(collapsed);
}

/** A bounded, single-line excerpt of an offending response. */
export function observedExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, OBSERVED_OUTPUT_EXCERPT_CHARS);
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

  let corrected = false;
  /** The most recent response that failed validation, for the failure record. */
  let lastObserved: string | undefined;
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
      lastObserved = retried.text;
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
    lastObserved = result.text;
    userPrompt = `${invocation.packet}\n\n${correctionMessage(invocation.role, validated.problem)}`;
    corrected = true;
  }
  return {
    ok: false,
    kind: 'invalid-output',
    problem: `The local ${invocation.role} output stayed invalid after ${invocation.maxCorrections} bounded correction(s).`,
    ...(lastObserved !== undefined ? { observed: observedExcerpt(lastObserved) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Large-agent worker (Claude Code, inspect-only)
// ---------------------------------------------------------------------------

export interface LargeRoleInvocation {
  workspace: WorkspaceInfo;
  config: AgentConfig;
  /** Optional for backwards compatibility; production injects the shared registry. */
  registry?: RunnerRegistry | undefined;
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
 * Run one reasoning role on the explicitly selected runner profile.
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
  const registry = invocation.registry ?? createDefaultRunnerRegistry(invocation.config);
  let profile;
  try {
    profile = registry.getProfile(invocation.runnerProfile);
  } catch (cause) {
    return {
      ok: false,
      kind: 'worker-unavailable',
      problem: cause instanceof Error ? cause.message : `Runner profile "${invocation.runnerProfile}" is unavailable.`,
    };
  }
  if (profile.config.enabled !== true || profile.runner.invokeStructured === undefined) {
    return {
      ok: false,
      kind: 'worker-unavailable',
      problem:
        profile.config.enabled !== true
          ? `Runner profile "${invocation.runnerProfile}" is disabled.`
          : `Runner profile "${invocation.runnerProfile}" does not support structured orchestration roles.`,
    };
  }

  const prompt = [
    roleSystemPrompt(invocation.role),
    '',
    `SpecBridge orchestration role: ${invocation.role}`,
    '',
    invocation.packet,
  ].join('\n');

  const result = await profile.runner.invokeStructured({
    prompt,
    toolPolicy: 'inspect-only',
    schemaName: invocation.role,
    outputJsonSchema: AGENT_OUTPUT_JSON_SCHEMAS[invocation.role],
  }, {
    workspaceRoot: invocation.workspace.rootDir,
    runDir: invocation.scratchDir,
    timeoutMs: invocation.timeoutMs,
    ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
  });
  if (result.outcome === 'cancelled') {
    return { ok: false, kind: 'cancelled', problem: result.failureReason ?? 'The role invocation was cancelled.' };
  }
  if (result.outcome !== 'completed' || result.text === undefined) {
    const observed = result.invalidStructuredOutput;
    return {
      ok: false,
      kind: result.outcome === 'malformed-output' ? 'invalid-output' : 'worker-unavailable',
      problem:
        result.failureReason ??
        result.error?.message ??
        `Runner profile "${invocation.runnerProfile}" ended with ${result.outcome}.`,
      ...(observed !== undefined ? { observed: observedExcerpt(observed) } : {}),
    };
  }
  const validated = validateAgentOutput(invocation.role, result.text);
  if (!validated.ok) {
    return {
      ok: false,
      kind: 'invalid-output',
      problem: validated.problem,
      observed: observedExcerpt(result.text),
    };
  }
  return {
    ok: true,
    output: validated.output,
    raw: result.text,
    usage: {
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      costUsd: result.cost?.currency === 'USD' ? result.cost.amount : null,
    },
    corrected: false,
  };
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
