import { Buffer } from 'node:buffer';
import type {
  Diagnostic,
  OllamaProfileConfig,
  StageRunnerReport,
} from '@specbridge/core';
import {
  STAGE_RUNNER_REPORT_JSON_SCHEMA,
  ollamaProfileSchema,
  stageRunnerReportSchema,
  validateRunnerBaseUrl,
} from '@specbridge/core';
import type {
  AgentRunner,
  RunnerCapability,
  RunnerDetectionContext,
  RunnerDetectionResult,
  RunnerExecutionOptions,
  RunnerModelListResult,
  RunnerSelfTestResult,
  RunnerToolPolicy,
  StageGenerationInput,
  StageGenerationResult,
  TaskExecutionInput,
  TaskExecutionResult,
} from '../contract.js';
import type { RunnerCapabilitySet } from '../contracts/capabilities.js';
import { capabilitySet } from '../contracts/capabilities.js';
import type { NormalizedRunnerError } from '../contracts/errors.js';
import { runnerError } from '../contracts/errors.js';
import type { RunnerUsage } from '../contracts/usage.js';
import type { SafeHttpResult } from '../shared/http-client.js';
import {
  fetchOllamaModels,
  fetchOllamaVersion,
  ollamaChatResponseSchema,
  ollamaTagsResponseSchema,
  ollamaVersionResponseSchema,
  postOllamaChat,
  redactOllamaResponseForRetention,
} from './client.js';
import type { OllamaChatMessage } from './client.js';

/**
 * Ollama model-API runner (v0.6) — AUTHORING ONLY.
 *
 * Scope: stage generation, stage refinement, local model enumeration,
 * schema-validated structured output. Explicitly unsupported: task
 * execution, task resume, repository modification, tool execution, shell
 * execution, source-file writing. There is no autonomous coding-agent loop
 * around Ollama — the adapter sends bounded chat requests and returns
 * candidates that SpecBridge validates and applies (or refuses) itself.
 *
 * Data boundary: the request contains exactly the assembled authoring
 * prompt (steering + approved stages + instruction), size-limited. The
 * adapter never reads repository files, never sends `.env` or credential
 * material, and talks only to the configured endpoint (loopback by
 * default; remote endpoints are network-backed and never selected
 * implicitly).
 */

export const OLLAMA_DECLARED_CAPABILITIES: RunnerCapabilitySet = capabilitySet([
  'stageGeneration',
  'stageRefinement',
  'structuredFinalOutput',
  'usageReporting',
  'localOnly',
  'supportsSystemPrompt',
  'supportsJsonSchema',
  'supportsCancellation',
]);

interface OllamaFailure {
  outcome: 'failed' | 'timed-out' | 'cancelled' | 'malformed-output';
  failureReason: string;
  error: NormalizedRunnerError;
}

function classifyHttpFailure(result: Extract<SafeHttpResult, { ok: false }>): OllamaFailure {
  switch (result.kind) {
    case 'timeout':
      return {
        outcome: 'timed-out',
        failureReason: result.detail,
        error: runnerError({ code: 'timed_out', message: `The Ollama request timed out: ${result.detail}.` }),
      };
    case 'cancelled':
      return {
        outcome: 'cancelled',
        failureReason: result.detail,
        error: runnerError({ code: 'cancelled', message: 'The Ollama request was cancelled.' }),
      };
    case 'response-too-large':
      return {
        outcome: 'failed',
        failureReason: result.detail,
        error: runnerError({
          code: 'output_limit_exceeded',
          message: `The Ollama response exceeded the configured size limit.`,
          remediation: ['Raise maximumOutputBytes on the profile if this was legitimate.'],
        }),
      };
    case 'redirect-rejected':
      return {
        outcome: 'failed',
        failureReason: result.detail,
        error: runnerError({
          code: 'endpoint_unreachable',
          message: 'The Ollama endpoint answered with a redirect, which is never followed.',
          remediation: ['Configure the final endpoint URL directly.'],
          retryable: false,
        }),
      };
    case 'invalid-content-type':
      return {
        outcome: 'malformed-output',
        failureReason: result.detail,
        error: runnerError({
          code: 'api_error',
          message: `The Ollama endpoint returned an unexpected content type.`,
          retryable: false,
        }),
      };
    case 'http-error': {
      const status = result.status ?? 0;
      if (status === 429) {
        return {
          outcome: 'failed',
          failureReason: result.detail,
          error: runnerError({
            code: 'rate_limited',
            message: 'The Ollama endpoint reported a rate limit (HTTP 429).',
            providerCode: '429',
          }),
        };
      }
      if (status === 401 || status === 403) {
        return {
          outcome: 'failed',
          failureReason: result.detail,
          error: runnerError({
            code: 'authentication_required',
            message: `The Ollama endpoint refused the request (HTTP ${status}).`,
            providerCode: String(status),
          }),
        };
      }
      if (status === 404 && (result.bodyExcerpt ?? '').toLowerCase().includes('model')) {
        return {
          outcome: 'failed',
          failureReason: result.detail,
          error: runnerError({
            code: 'model_not_found',
            message: 'The configured model is not available on the Ollama endpoint.',
            remediation: ['List local models with "specbridge runner models <profile>".'],
            providerCode: '404',
          }),
        };
      }
      return {
        outcome: 'failed',
        failureReason: result.detail,
        error: runnerError({
          code: 'api_error',
          message: `The Ollama endpoint answered HTTP ${status}.`,
          providerCode: String(status),
          retryable: status >= 500,
        }),
      };
    }
    case 'unreachable':
      return {
        outcome: 'failed',
        failureReason: result.detail,
        error: runnerError({
          code: 'endpoint_unreachable',
          message: 'The Ollama endpoint could not be reached.',
          remediation: ['Start Ollama locally (`ollama serve`) or fix the profile baseUrl.'],
        }),
      };
  }
}

export class OllamaRunner implements AgentRunner {
  readonly name = 'ollama';
  readonly kind = 'ollama';
  readonly category = 'model-api';
  readonly declaredCapabilities = OLLAMA_DECLARED_CAPABILITIES;
  /** Orchestration may perform ONE structured-output correction retry. */
  readonly supportsStructuredOutputCorrection = true;
  private readonly config: OllamaProfileConfig;

  constructor(config?: Partial<OllamaProfileConfig>) {
    this.config = ollamaProfileSchema.parse({ runner: 'ollama', ...(config ?? {}) });
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  private urlValidation(): ReturnType<typeof validateRunnerBaseUrl> {
    return validateRunnerBaseUrl(this.config.baseUrl, {
      allowInsecureHttp: this.config.allowInsecureHttp,
    });
  }

  private profileCapabilities(loopback: boolean): RunnerCapabilitySet {
    return {
      ...OLLAMA_DECLARED_CAPABILITIES,
      localOnly: loopback,
      requiresNetwork: !loopback,
    };
  }

  async detect(context: RunnerDetectionContext): Promise<RunnerDetectionResult> {
    const diagnostics: Diagnostic[] = [];
    const url = this.urlValidation();
    const capabilities: RunnerCapability[] = [];
    const base: Pick<
      RunnerDetectionResult,
      'runner' | 'kind' | 'executable' | 'authentication' | 'category' | 'capabilitySet' | 'networkBacked'
    > = {
      runner: this.name,
      kind: 'ollama',
      executable: this.config.baseUrl,
      authentication: 'not-applicable',
      category: this.category,
      capabilitySet: this.profileCapabilities(url.loopback),
      networkBacked: !url.loopback,
    };

    if (!this.config.enabled) {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_DISABLED',
        message:
          'This Ollama profile is disabled in .specbridge/config.json (enabled = false). ' +
          'Enable it explicitly to use Ollama for spec authoring.',
      });
      return { ...base, status: 'misconfigured', capabilities, diagnostics, supportLevel: 'production' };
    }
    if (!url.ok) {
      for (const problem of url.problems) {
        diagnostics.push({ severity: 'error', code: 'RUNNER_ENDPOINT_INVALID', message: `baseUrl: ${problem}` });
      }
      return { ...base, status: 'misconfigured', capabilities, diagnostics, supportLevel: 'production' };
    }
    if (!url.loopback) {
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_NETWORK_BACKED',
        message: `The endpoint ${url.hostname ?? ''} is not loopback: requests leave this machine (network-backed). Explicit selection is required.`,
      });
    }

    // Endpoint reachability (read-only; no model request).
    const signal = context.timeoutMs !== undefined ? AbortSignal.timeout(context.timeoutMs) : undefined;
    const versionResult = await fetchOllamaVersion(this.config, signal);
    if (!versionResult.ok) {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_ENDPOINT_UNREACHABLE',
        message: `The Ollama endpoint is unreachable: ${versionResult.detail}. Start it with "ollama serve" or fix the profile baseUrl.`,
      });
      capabilities.push({ id: 'endpoint', label: 'Endpoint reachable', available: false, required: true });
      return { ...base, status: 'unavailable', capabilities, diagnostics, supportLevel: 'unavailable' };
    }
    capabilities.push({ id: 'endpoint', label: 'Endpoint reachable', available: true, required: true });
    let version: string | undefined;
    const versionParsed = ollamaVersionResponseSchema.safeParse(safeJson(versionResult.bodyText));
    if (versionParsed.success) version = versionParsed.data.version;

    // Model inventory (read-only listing; never pulls, never selects).
    const tagsResult = await fetchOllamaModels(this.config, signal);
    let modelNames: string[] = [];
    if (tagsResult.ok) {
      const tags = ollamaTagsResponseSchema.safeParse(safeJson(tagsResult.bodyText));
      if (tags.success) modelNames = tags.data.models.map((model) => model.name);
      capabilities.push({ id: 'model-list', label: 'Model listing', available: tags.success, required: false });
    } else {
      capabilities.push({ id: 'model-list', label: 'Model listing', available: false, required: false });
      diagnostics.push({
        severity: 'warning',
        code: 'RUNNER_MODEL_LIST_FAILED',
        message: `Model listing failed: ${tagsResult.detail}.`,
      });
    }

    capabilities.push({
      id: 'structured-output',
      label: 'Structured output (JSON Schema format field)',
      available: true,
      required: true,
      detail: 'validated by SpecBridge with a bounded correction retry',
    });

    let status: RunnerDetectionResult['status'] = 'available';
    if (this.config.model === null) {
      status = 'misconfigured';
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_MODEL_NOT_CONFIGURED',
        message:
          'No model is configured for this profile. SpecBridge never selects a model automatically — ' +
          'list local models with "specbridge runner models <profile>" and set "model" explicitly.' +
          (modelNames.length > 0 ? ` Locally available: ${modelNames.slice(0, 8).join(', ')}.` : ''),
      });
      capabilities.push({ id: 'configured-model', label: 'Configured model present', available: false, required: true });
    } else if (tagsResult.ok && modelNames.length > 0 && !modelNames.includes(this.config.model)) {
      status = 'misconfigured';
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_MODEL_MISSING',
        message:
          `The configured model "${this.config.model}" is not present on the endpoint. ` +
          'SpecBridge never pulls models automatically — pull it yourself (ollama pull) or configure an available model.' +
          (modelNames.length > 0 ? ` Locally available: ${modelNames.slice(0, 8).join(', ')}.` : ''),
      });
      capabilities.push({ id: 'configured-model', label: 'Configured model present', available: false, required: true });
    } else if (this.config.model !== null) {
      capabilities.push({ id: 'configured-model', label: 'Configured model present', available: true, required: true });
    }

    return {
      ...base,
      status,
      ...(version !== undefined ? { version } : {}),
      capabilities,
      diagnostics,
      supportLevel: 'production',
    };
  }

  executionBoundaryNote(_policy: RunnerToolPolicy): string {
    return 'Model API (authoring only): no repository access, no tools, no shell; the returned document is an unapproved candidate.';
  }

  async listModels(context: RunnerDetectionContext): Promise<RunnerModelListResult> {
    const url = this.urlValidation();
    if (!url.ok) {
      return { supported: true, models: [], detail: `baseUrl invalid: ${url.problems.join('; ')}` };
    }
    const signal = context.timeoutMs !== undefined ? AbortSignal.timeout(context.timeoutMs) : undefined;
    const result = await fetchOllamaModels(this.config, signal);
    if (!result.ok) {
      return { supported: true, models: [], detail: `model listing failed: ${result.detail}` };
    }
    const tags = ollamaTagsResponseSchema.safeParse(safeJson(result.bodyText));
    if (!tags.success) {
      return { supported: true, models: [], detail: 'the endpoint returned an unexpected model list shape' };
    }
    return {
      supported: true,
      models: tags.data.models.map((model) => ({
        name: model.name,
        ...(model.size !== undefined ? { sizeBytes: model.size } : {}),
        ...(model.details?.family !== undefined ? { family: model.details.family } : {}),
        ...(model.details?.parameter_size !== undefined
          ? { parameterSize: model.details.parameter_size }
          : {}),
        ...(model.details?.quantization_level !== undefined
          ? { quantization: model.details.quantization_level }
          : {}),
        ...(model.modified_at !== undefined ? { modifiedAt: model.modified_at } : {}),
        location: url.loopback ? ('local' as const) : ('remote' as const),
      })),
    };
  }

  async generateStage(
    input: StageGenerationInput,
    execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    const started = Date.now();
    const failure = (problem: OllamaFailure, rawStdout = ''): StageGenerationResult => ({
      runner: this.name,
      outcome: problem.outcome,
      failureReason: problem.failureReason,
      rawStdout,
      rawStderr: '',
      durationMs: Math.max(0, Date.now() - started),
      warnings: [],
      error: problem.error,
      cost: { currency: null, amount: null, source: 'unavailable' },
    });

    const url = this.urlValidation();
    if (!url.ok) {
      return failure({
        outcome: 'failed',
        failureReason: `the profile baseUrl is invalid: ${url.problems.join('; ')}`,
        error: runnerError({
          code: 'invalid_configuration',
          message: `The Ollama profile baseUrl is invalid: ${url.problems.join('; ')}`,
        }),
      });
    }
    const model = execution.model ?? this.config.model;
    if (model === null || model === undefined) {
      return failure({
        outcome: 'failed',
        failureReason: 'no model is configured for this profile',
        error: runnerError({
          code: 'invalid_configuration',
          message: 'No model is configured; SpecBridge never selects one automatically.',
          remediation: ['Run "specbridge runner models <profile>" and set "model" on the profile.'],
        }),
      });
    }
    if (input.prompt.length > this.config.maximumInputCharacters) {
      return failure({
        outcome: 'failed',
        failureReason: `the assembled prompt (${input.prompt.length} characters) exceeds maximumInputCharacters (${this.config.maximumInputCharacters})`,
        error: runnerError({
          code: 'invalid_configuration',
          message: 'The authoring input exceeds the configured size limit for this profile.',
          remediation: ['Reduce the spec/steering context or raise maximumInputCharacters explicitly.'],
        }),
      });
    }

    const messages: OllamaChatMessage[] = [{ role: 'user', content: input.prompt }];
    if (input.correction !== undefined) {
      messages.push(
        { role: 'assistant', content: input.correction.previousOutput },
        {
          role: 'user',
          content:
            'Your previous response was not a valid structured result. ' +
            `Validation problems: ${input.correction.problems}. ` +
            'Return ONLY one corrected JSON document matching the required schema — no prose, no code fences.',
        },
      );
    }

    const result = await postOllamaChat(this.config, {
      model,
      messages,
      format: STAGE_RUNNER_REPORT_JSON_SCHEMA,
      temperature: this.config.temperature,
      timeoutMs: execution.timeoutMs,
      maxResponseBytes: this.config.maximumOutputBytes,
      ...(execution.signal !== undefined ? { signal: execution.signal } : {}),
    });
    if (!result.ok) {
      return failure(classifyHttpFailure(result));
    }

    const retained = redactOllamaResponseForRetention(result.bodyText);
    const parsedBody = ollamaChatResponseSchema.safeParse(safeJson(result.bodyText));
    if (!parsedBody.success) {
      return failure(
        {
          outcome: 'malformed-output',
          failureReason: 'the endpoint response did not match the Ollama chat response shape',
          error: runnerError({
            code: 'api_error',
            message: 'The Ollama endpoint returned an unexpected response shape.',
            retryable: false,
          }),
        },
        retained,
      );
    }

    const usage = usageFromChat(parsedBody.data, model, Date.now() - started);
    const content = parsedBody.data.message.content;
    // Strict structured output: the content must BE one JSON document.
    // Markdown fences or prose around JSON are not accepted.
    const candidate = strictJsonParse(content);
    const report = candidate === undefined ? undefined : stageRunnerReportSchema.safeParse(candidate);
    if (report === undefined || !report.success) {
      const problems =
        report !== undefined && !report.success
          ? report.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; ')
          : 'the message content is not a bare JSON document';
      return {
        runner: this.name,
        outcome: 'malformed-output',
        failureReason: `structured output invalid: ${problems}`,
        rawStdout: retained,
        rawStderr: '',
        durationMs: Math.max(0, Date.now() - started),
        warnings: [],
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The model response did not validate against the stage report schema.',
          details: { problems: problems.slice(0, 2000) },
        }),
        usage,
        cost: { currency: null, amount: null, source: 'unavailable' },
        // Retained for inspection and the bounded correction retry; never
        // applied. (Bounded: the transport already enforces response limits.)
        invalidStructuredOutput: content.length > 100_000 ? content.slice(0, 100_000) : content,
      };
    }

    const stageReport = report.data as StageRunnerReport;
    return {
      runner: this.name,
      outcome: 'completed',
      rawStdout: retained,
      rawStderr: '',
      durationMs: Math.max(0, Date.now() - started),
      warnings: [],
      report: stageReport,
      usage,
      cost: { currency: null, amount: null, source: 'unavailable' },
    };
  }

  /**
   * Task execution is NOT a capability of a model-API runner. Selection
   * rejects the operation before any request; this defensive implementation
   * exists only to satisfy the AgentRunner interface and performs no HTTP
   * request and no repository access.
   */
  executeTask(
    _input: TaskExecutionInput,
    _execution: RunnerExecutionOptions,
  ): Promise<TaskExecutionResult> {
    return Promise.resolve({
      runner: this.name,
      outcome: 'failed',
      failureReason:
        'the ollama runner is authoring-only: it cannot execute implementation tasks and never modifies repository files',
      rawStdout: '',
      rawStderr: '',
      durationMs: 0,
      warnings: [],
      resumeSupported: false,
      error: runnerError({
        code: 'unsupported_operation',
        message: 'Model API runners cannot execute implementation tasks.',
        remediation: ['Use an agent CLI profile (claude-code or codex) for task execution.'],
      }),
      cost: { currency: null, amount: null, source: 'unavailable' },
    });
  }

  /** Minimal bounded structured-output probe (`runner test --network`). */
  async selfTest(execution: RunnerExecutionOptions): Promise<RunnerSelfTestResult> {
    const result = await this.generateStage(
      {
        specName: 'runner-self-test',
        stage: 'requirements',
        intent: 'generate',
        prompt:
          'This is a connectivity self test. Reply with exactly one JSON document: ' +
          '{"schemaVersion":"1.0.0","stage":"requirements","markdown":"# Self Test","summary":"self test"} and nothing else.',
        promptVersion: 'self-test',
        toolPolicy: 'read-only',
      },
      { ...execution, timeoutMs: Math.min(execution.timeoutMs, 60_000) },
    );
    return {
      ok: result.outcome === 'completed' && result.report !== undefined,
      detail:
        result.outcome === 'completed'
          ? 'structured output validated'
          : (result.failureReason ?? `self test failed (${result.outcome})`),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function strictJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function usageFromChat(
  response: { prompt_eval_count?: number | undefined; eval_count?: number | undefined },
  model: string,
  durationMs: number,
): RunnerUsage {
  return {
    model,
    inputTokens: response.prompt_eval_count ?? null,
    cachedInputTokens: null,
    outputTokens: response.eval_count ?? null,
    reasoningTokens: null,
    requestCount: 1,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

/** Approximate input size (characters) for runner-plan reporting. */
export function ollamaInputCharacters(prompt: string): number {
  return Buffer.from(prompt, 'utf8').toString('utf8').length;
}
