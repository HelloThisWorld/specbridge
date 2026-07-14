import type {
  Diagnostic,
  OpenAiCompatibleProfileConfig,
  StageRunnerReport,
} from '@specbridge/core';
import {
  STAGE_RUNNER_REPORT_JSON_SCHEMA,
  openAiCompatibleProfileSchema,
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
import { safeHttpRequest } from '../shared/http-client.js';
import type { OpenAiChatMessage } from './client.js';
import {
  buildOpenAiRequestBody,
  indicatesStructuredOutputUnsupported,
  openAiModelsResponseSchema,
  parseOpenAiResponse,
  redactSecretValue,
  weakerStructuredOutputMode,
} from './client.js';

/**
 * OpenAI-compatible model-API runner (v0.6.1) — AUTHORING ONLY.
 *
 * Scope: stage generation, stage refinement, model listing (only when the
 * profile declares a supported /models endpoint), schema-validated
 * structured output. Explicitly unsupported: task execution, task resume,
 * repository modification, autonomous tool loops, arbitrary function
 * calling, shell execution. There is no coding agent wrapped around the
 * generic API — the adapter sends bounded requests and returns candidates
 * that SpecBridge validates and applies (or refuses) itself.
 *
 * Credential rule: the profile stores an environment-variable NAME only.
 * The value is read at request time from exactly that variable, sent as
 * the Authorization header (never across origins), redacted from every
 * retained byte, and never stored.
 */

export const OPENAI_COMPATIBLE_DECLARED_CAPABILITIES: RunnerCapabilitySet = capabilitySet([
  'stageGeneration',
  'stageRefinement',
  'structuredFinalOutput',
  'usageReporting',
  'localOnly',
  'supportsSystemPrompt',
  'supportsJsonSchema',
  'supportsCancellation',
]);

type StructuredOutputMode = OpenAiCompatibleProfileConfig['structuredOutput'];

interface OpenAiFailure {
  outcome: 'failed' | 'timed-out' | 'cancelled' | 'malformed-output';
  failureReason: string;
  error: NormalizedRunnerError;
}

function classifyHttpFailure(
  result: Extract<SafeHttpResult, { ok: false }>,
  redact: (text: string) => string,
): OpenAiFailure {
  switch (result.kind) {
    case 'timeout':
      return {
        outcome: 'timed-out',
        failureReason: result.detail,
        error: runnerError({ code: 'timed_out', message: `The endpoint request timed out: ${result.detail}.` }),
      };
    case 'cancelled':
      return {
        outcome: 'cancelled',
        failureReason: result.detail,
        error: runnerError({ code: 'cancelled', message: 'The endpoint request was cancelled.' }),
      };
    case 'response-too-large':
      return {
        outcome: 'failed',
        failureReason: result.detail,
        error: runnerError({
          code: 'output_limit_exceeded',
          message: 'The endpoint response exceeded the configured size limit.',
          remediation: ['Raise maximumOutputBytes on the profile if this was legitimate.'],
        }),
      };
    case 'redirect-rejected':
      return {
        outcome: 'failed',
        failureReason: result.detail,
        error: runnerError({
          code: 'endpoint_unreachable',
          message: `The endpoint redirect was refused: ${result.detail}.`,
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
          message: 'The endpoint returned an unexpected content type.',
          retryable: false,
        }),
      };
    case 'http-error': {
      const status = result.status ?? 0;
      const excerpt = redact(result.bodyExcerpt ?? '').toLowerCase();
      if (status === 401 || status === 403) {
        return {
          outcome: 'failed',
          failureReason: result.detail,
          error: runnerError({
            code: 'authentication_required',
            message: `The endpoint refused the request (HTTP ${status}).`,
            remediation: [
              'Set the configured API-key environment variable before running (SpecBridge never stores key values).',
            ],
            providerCode: String(status),
          }),
        };
      }
      if (status === 429 && /insufficient_quota|quota|billing/.test(excerpt)) {
        return {
          outcome: 'failed',
          failureReason: result.detail,
          error: runnerError({
            code: 'quota_exceeded',
            message: 'The endpoint reported an exhausted quota.',
            remediation: ['Check your provider plan and usage, then retry explicitly.'],
            providerCode: '429',
          }),
        };
      }
      if (status === 429) {
        return {
          outcome: 'failed',
          failureReason: result.detail,
          error: runnerError({
            code: 'rate_limited',
            message: 'The endpoint reported a rate limit (HTTP 429).',
            providerCode: '429',
          }),
        };
      }
      if (status === 404 && /model/.test(excerpt)) {
        return {
          outcome: 'failed',
          failureReason: result.detail,
          error: runnerError({
            code: 'model_not_found',
            message: 'The configured model is not available on the endpoint.',
            remediation: ['List models with "specbridge runner models <profile>" (when the endpoint supports it).'],
            providerCode: '404',
          }),
        };
      }
      return {
        outcome: 'failed',
        failureReason: result.detail,
        error: runnerError({
          code: 'api_error',
          message: `The endpoint answered HTTP ${status}.`,
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
          message: 'The endpoint could not be reached.',
          remediation: ['Start the local server or fix the profile baseUrl.'],
        }),
      };
  }
}

export class OpenAiCompatibleRunner implements AgentRunner {
  readonly name = 'openai-compatible';
  readonly kind = 'openai-compatible';
  readonly category = 'model-api';
  readonly declaredCapabilities: RunnerCapabilitySet;
  /** Orchestration may perform ONE structured-output correction retry. */
  readonly supportsStructuredOutputCorrection = true;
  private readonly config: OpenAiCompatibleProfileConfig;

  constructor(config?: Partial<OpenAiCompatibleProfileConfig>) {
    this.config = openAiCompatibleProfileSchema.parse({
      runner: 'openai-compatible',
      ...(config ?? {}),
    });
    this.declaredCapabilities = {
      ...OPENAI_COMPATIBLE_DECLARED_CAPABILITIES,
      // Native JSON Schema constraining is a per-endpoint capability the
      // profile declares through its structured-output mode.
      supportsJsonSchema: this.config.structuredOutput === 'json-schema',
    };
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  private urlValidation(): ReturnType<typeof validateRunnerBaseUrl> {
    return validateRunnerBaseUrl(this.config.baseUrl, {
      allowInsecureHttp: this.config.allowInsecureHttp,
    });
  }

  /** The API-key VALUE, read at request time only. Never stored, never logged. */
  private apiKeyValue(): string | undefined {
    const variable = this.config.apiKeyEnvironmentVariable;
    if (variable === null) return undefined;
    const value = process.env[variable];
    return value !== undefined && value.length > 0 ? value : undefined;
  }

  private redact(text: string): string {
    return redactSecretValue(text, this.apiKeyValue());
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.config.headers };
    const key = this.apiKeyValue();
    if (key !== undefined) headers['authorization'] = `Bearer ${key}`;
    return headers;
  }

  private endpointUrl(pathSuffix: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${pathSuffix}`;
  }

  private profileCapabilities(loopback: boolean): RunnerCapabilitySet {
    return {
      ...this.declaredCapabilities,
      localOnly: loopback,
      requiresNetwork: !loopback,
    };
  }

  async detect(context: RunnerDetectionContext): Promise<RunnerDetectionResult> {
    const diagnostics: Diagnostic[] = [];
    const url = this.urlValidation();
    const capabilities: RunnerCapability[] = [];
    const keyVariable = this.config.apiKeyEnvironmentVariable;
    const keyConfigured = keyVariable !== null;
    const keyPresent = this.apiKeyValue() !== undefined;
    const authentication = !keyConfigured ? 'not-applicable' : keyPresent ? 'unknown' : 'unauthenticated';
    const base: Pick<
      RunnerDetectionResult,
      'runner' | 'kind' | 'executable' | 'authentication' | 'category' | 'capabilitySet' | 'networkBacked'
    > = {
      runner: this.name,
      kind: 'openai-compatible',
      executable: this.config.baseUrl,
      authentication,
      category: this.category,
      capabilitySet: this.profileCapabilities(url.loopback),
      networkBacked: !url.loopback,
    };

    if (!this.config.enabled) {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_DISABLED',
        message:
          'This openai-compatible profile is disabled in .specbridge/config.json (enabled = false). ' +
          'Enable it explicitly to use the endpoint for spec authoring.',
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
      if (this.config.allowInsecureHttp && url.protocol === 'http:') {
        diagnostics.push({
          severity: 'warning',
          code: 'RUNNER_INSECURE_HTTP',
          message:
            'INSECURE: allowInsecureHttp permits plain HTTP to a non-loopback endpoint. ' +
            'Prompts and responses travel unencrypted; use HTTPS outside private development networks.',
        });
      }
    }
    if (keyConfigured && !keyPresent) {
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_API_KEY_VARIABLE_UNSET',
        message:
          `The configured API-key environment variable "${keyVariable ?? ''}" is not set. ` +
          'Export it before running (SpecBridge stores only the variable NAME, never a value).',
      });
    }

    capabilities.push({
      id: 'structured-output',
      label: `Structured output (${this.config.structuredOutput})`,
      available: true,
      required: true,
      detail: 'the complete response is validated by SpecBridge with a bounded correction retry',
    });
    capabilities.push({
      id: 'api-style',
      label: `API style: ${this.config.apiStyle}`,
      available: true,
      required: true,
    });

    // Doctor never sends an inference request. A safe non-inference request
    // (GET /models) runs only when the profile explicitly declares the
    // endpoint supports it.
    if (this.config.modelsEndpoint) {
      const signal = context.timeoutMs !== undefined ? AbortSignal.timeout(context.timeoutMs) : undefined;
      const models = await safeHttpRequest({
        method: 'GET',
        url: this.endpointUrl('/models'),
        timeoutMs: Math.min(context.timeoutMs ?? 15_000, 15_000),
        maxResponseBytes: 1024 * 1024,
        headers: this.requestHeaders(),
        maxRedirects: 3,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!models.ok) {
        if (models.kind === 'http-error' && (models.status === 401 || models.status === 403)) {
          diagnostics.push({
            severity: 'error',
            code: 'RUNNER_UNAUTHENTICATED',
            message: `The endpoint refused GET /models (HTTP ${models.status}). Configure and export the API-key variable yourself.`,
          });
          capabilities.push({ id: 'endpoint', label: 'Endpoint reachable', available: true, required: true });
          return { ...base, authentication: 'unauthenticated', status: 'unauthenticated', capabilities, diagnostics, supportLevel: 'production' };
        }
        diagnostics.push({
          severity: 'error',
          code: 'RUNNER_ENDPOINT_UNREACHABLE',
          message: `The endpoint is unreachable: ${this.redact(models.detail)}. Start the server or fix the profile baseUrl.`,
        });
        capabilities.push({ id: 'endpoint', label: 'Endpoint reachable', available: false, required: true });
        return { ...base, status: 'unavailable', capabilities, diagnostics, supportLevel: 'unavailable' };
      }
      capabilities.push({ id: 'endpoint', label: 'Endpoint reachable (GET /models)', available: true, required: true });
      capabilities.push({ id: 'model-list', label: 'Model listing', available: true, required: false });
    } else {
      diagnostics.push({
        severity: 'info',
        code: 'RUNNER_REACHABILITY_NOT_PROBED',
        message:
          'Endpoint reachability was not probed: the profile declares no safe non-inference request ' +
          '(set "modelsEndpoint": true when the endpoint supports GET /models). ' +
          'Use "specbridge runner test <profile> --network" for a bounded inference probe.',
      });
    }

    let status: RunnerDetectionResult['status'] = 'available';
    if (this.config.model === null) {
      status = 'misconfigured';
      diagnostics.push({
        severity: 'error',
        code: 'RUNNER_MODEL_NOT_CONFIGURED',
        message:
          'No model is configured for this profile. SpecBridge never selects or guesses a model — ' +
          'set "model" explicitly (use "specbridge runner models <profile>" when the endpoint lists models).',
      });
      capabilities.push({ id: 'configured-model', label: 'Configured model present', available: false, required: true });
    } else {
      capabilities.push({ id: 'configured-model', label: 'Configured model present', available: true, required: true });
    }
    if (keyConfigured && !keyPresent) status = 'misconfigured';

    return { ...base, status, capabilities, diagnostics, supportLevel: 'production' };
  }

  executionBoundaryNote(_policy: RunnerToolPolicy): string {
    return (
      'Model API (authoring only): no repository access, no tools, no shell, no source modification; ' +
      'the returned document is an unapproved candidate.'
    );
  }

  async listModels(context: RunnerDetectionContext): Promise<RunnerModelListResult> {
    if (!this.config.modelsEndpoint) {
      return {
        supported: false,
        models: [],
        detail:
          'This profile does not declare a supported /models endpoint (set "modelsEndpoint": true when it exists). ' +
          'SpecBridge never guesses model names and never lists models by inference.',
      };
    }
    const url = this.urlValidation();
    if (!url.ok) {
      return { supported: true, models: [], detail: `baseUrl invalid: ${url.problems.join('; ')}` };
    }
    const signal = context.timeoutMs !== undefined ? AbortSignal.timeout(context.timeoutMs) : undefined;
    const result = await safeHttpRequest({
      method: 'GET',
      url: this.endpointUrl('/models'),
      timeoutMs: Math.min(context.timeoutMs ?? 15_000, 15_000),
      maxResponseBytes: 1024 * 1024,
      expectJson: true,
      headers: this.requestHeaders(),
      maxRedirects: 3,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!result.ok) {
      return { supported: true, models: [], detail: `model listing failed: ${this.redact(result.detail)}` };
    }
    const parsed = openAiModelsResponseSchema.safeParse(safeJson(result.bodyText));
    if (!parsed.success) {
      return { supported: true, models: [], detail: 'the endpoint returned an unexpected model list shape' };
    }
    return {
      supported: true,
      // Only fields the endpoint actually reports — capabilities are never
      // inferred from a model name or provider branding.
      models: parsed.data.data.map((model) => ({
        name: model.id,
        ...(model.owned_by !== undefined ? { family: model.owned_by } : {}),
        ...(model.created !== undefined
          ? { modifiedAt: new Date(model.created * 1000).toISOString() }
          : {}),
        location: url.loopback ? ('local' as const) : ('remote' as const),
      })),
    };
  }

  async generateStage(
    input: StageGenerationInput,
    execution: RunnerExecutionOptions,
  ): Promise<StageGenerationResult> {
    const started = Date.now();
    const failure = (problem: OpenAiFailure, rawStdout = ''): StageGenerationResult => ({
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
          message: `The openai-compatible profile baseUrl is invalid: ${url.problems.join('; ')}`,
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
          remediation: ['Set "model" on the profile explicitly.'],
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

    const messages: OpenAiChatMessage[] = [{ role: 'user', content: input.prompt }];
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

    const attempt = await this.requestOnce(model, messages, this.config.structuredOutput, execution);
    if (!attempt.ok) {
      // An unsupported structured-output mode falls back ONLY when the
      // profile explicitly allows it — never silently.
      if (
        attempt.unsupportedMode &&
        this.config.allowStructuredOutputFallback &&
        weakerStructuredOutputMode(this.config.structuredOutput) !== undefined
      ) {
        const weaker = weakerStructuredOutputMode(this.config.structuredOutput) as StructuredOutputMode;
        const retry = await this.requestOnce(model, messages, weaker, execution);
        if (retry.ok) {
          const result = this.mapCompleted(retry.body, retry.mode, model, started);
          result.warnings.push(
            `the endpoint rejected structured-output mode "${this.config.structuredOutput}"; ` +
              `the profile explicitly allows fallback and "${weaker}" was used`,
          );
          return result;
        }
        return failure(retry.failure, retry.retained ?? '');
      }
      if (attempt.unsupportedMode) {
        return failure(
          {
            outcome: 'failed',
            failureReason: `the endpoint does not support structured-output mode "${this.config.structuredOutput}"`,
            error: runnerError({
              code: 'structured_output_unsupported',
              message: `The endpoint rejected structured-output mode "${this.config.structuredOutput}".`,
              remediation: [
                'Configure a mode the endpoint supports (json-object or strict-json-prompt), or set ' +
                  '"allowStructuredOutputFallback": true to permit the explicit downgrade.',
              ],
            }),
          },
          attempt.retained ?? '',
        );
      }
      return failure(attempt.failure, attempt.retained ?? '');
    }
    return this.mapCompleted(attempt.body, attempt.mode, model, started);
  }

  private async requestOnce(
    model: string,
    messages: OpenAiChatMessage[],
    mode: StructuredOutputMode,
    execution: RunnerExecutionOptions,
  ): Promise<
    | { ok: true; body: string; mode: StructuredOutputMode }
    | { ok: false; failure: OpenAiFailure; unsupportedMode: boolean; retained?: string }
  > {
    const path = this.config.apiStyle === 'chat-completions' ? '/chat/completions' : '/responses';
    const result = await safeHttpRequest({
      method: 'POST',
      url: this.endpointUrl(path),
      body: buildOpenAiRequestBody(this.config.apiStyle, {
        model,
        messages,
        temperature: this.config.temperature,
        structuredOutput: mode,
        jsonSchema: STAGE_RUNNER_REPORT_JSON_SCHEMA,
        schemaName: 'stage_runner_report',
      }),
      timeoutMs: execution.timeoutMs,
      maxResponseBytes: this.config.maximumOutputBytes,
      expectJson: true,
      headers: this.requestHeaders(),
      maxRedirects: 3,
      ...(execution.signal !== undefined ? { signal: execution.signal } : {}),
    });
    if (!result.ok) {
      const unsupportedMode =
        mode !== 'strict-json-prompt' &&
        result.kind === 'http-error' &&
        indicatesStructuredOutputUnsupported(result.status, result.bodyExcerpt);
      return {
        ok: false,
        failure: classifyHttpFailure(result, (text) => this.redact(text)),
        unsupportedMode,
        ...(result.kind === 'http-error' && result.bodyExcerpt !== undefined
          ? { retained: this.redact(result.bodyExcerpt) }
          : {}),
      };
    }
    return { ok: true, body: result.bodyText, mode };
  }

  private mapCompleted(
    bodyText: string,
    mode: StructuredOutputMode,
    model: string,
    started: number,
  ): StageGenerationResult {
    const retained = this.redact(bodyText);
    const parsed = parseOpenAiResponse(this.config.apiStyle, bodyText);
    const usage: RunnerUsage = {
      model: parsed.model ?? model,
      inputTokens: parsed.usage?.inputTokens ?? null,
      cachedInputTokens: parsed.usage?.cachedInputTokens ?? null,
      outputTokens: parsed.usage?.outputTokens ?? null,
      reasoningTokens: null,
      requestCount: 1,
      durationMs: Math.max(0, Date.now() - started),
    };
    const base = {
      runner: this.name,
      rawStdout: retained,
      rawStderr: '',
      durationMs: Math.max(0, Date.now() - started),
      warnings: [] as string[],
      usage,
      cost: { currency: null, amount: null, source: 'unavailable' as const },
    };
    if (parsed.text === undefined) {
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: parsed.problem ?? 'the endpoint returned no usable content',
        error: runnerError({
          code: 'api_error',
          message: `The endpoint response could not be used: ${parsed.problem ?? 'no content'}.`,
          retryable: false,
        }),
      };
    }
    // Strict structured output for EVERY mode: the complete response text
    // must BE one JSON document. Markdown fences, prose, and substring
    // extraction are never accepted, whatever the mode.
    const candidate = strictJsonParse(parsed.text);
    const report = candidate === undefined ? undefined : stageRunnerReportSchema.safeParse(candidate);
    if (report === undefined || !report.success) {
      const problems =
        report !== undefined && !report.success
          ? report.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; ')
          : 'the response content is not a bare JSON document';
      return {
        ...base,
        outcome: 'malformed-output',
        failureReason: `structured output invalid (${mode}): ${problems}`,
        error: runnerError({
          code: 'structured_output_invalid',
          message: 'The model response did not validate against the stage report schema.',
          details: { problems: problems.slice(0, 2000) },
        }),
        // Retained for inspection and the bounded correction retry; never
        // applied. (Bounded: the transport already enforces response limits.)
        invalidStructuredOutput:
          parsed.text.length > 100_000 ? parsed.text.slice(0, 100_000) : parsed.text,
      };
    }
    return {
      ...base,
      outcome: 'completed',
      report: report.data as StageRunnerReport,
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
        'the openai-compatible runner is authoring-only: it cannot execute implementation tasks and never modifies repository files',
      rawStdout: '',
      rawStderr: '',
      durationMs: 0,
      warnings: [],
      resumeSupported: false,
      error: runnerError({
        code: 'unsupported_operation',
        message: 'Model API runners cannot execute implementation tasks.',
        remediation: ['Use an agent CLI profile (claude-code or codex-cli) for task execution.'],
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
