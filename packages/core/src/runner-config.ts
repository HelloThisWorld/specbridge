import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic } from './types.js';
import type { WorkspaceInfo } from './workspace.js';
import type {
  AgentConfigFileV1,
  ClaudeRunnerConfig,
  ExecutionPolicy,
  MockRunnerConfig,
  VerificationConfig,
} from './agent-config.js';
import {
  agentConfigSchema,
  claudeRunnerConfigSchema,
  executionPolicySchema,
  forbiddenFragmentIssues,
  mockRunnerConfigSchema,
  safeNonEmptyString,
  verificationConfigSchema,
} from './agent-config.js';

/**
 * The v2 (v0.6) multi-runner `.specbridge/config.json` schema, plus the
 * version-transparent reader every runner-facing command uses.
 *
 * A configuration FILE is either v1 (`schemaVersion 1.x`, still fully
 * supported) or v2 (`schemaVersion 2.x`). Both resolve into the same
 * in-memory model, `AgentConfig`, so nothing downstream branches on the file
 * version. Explicit migration (`specbridge config migrate`) rewrites the
 * file; reading NEVER mutates it.
 *
 * Safety rules:
 *   - no credential values, ever (credential-looking keys are rejected)
 *   - command configuration is executable + argv arrays; shell strings are
 *     rejected
 *   - permission-bypass and unrestricted-sandbox fragments are rejected
 *     anywhere in the file
 *   - base URLs: http(s) only, no embedded credentials, loopback by default;
 *     remote endpoints need HTTPS (or an explicit, clearly-labeled insecure
 *     development override)
 *   - new runners (codex, ollama) default to DISABLED; nothing is silently
 *     enabled or selected
 */

export const RUNNER_CONFIG_SCHEMA_VERSION = '2.0.0';

/**
 * Runner implementations registered by the default registry. v0.6.0 shipped
 * claude-code, codex-cli, ollama, and mock; v0.6.1 adds gemini-cli,
 * openai-compatible (authoring only), and the experimental antigravity-cli.
 */
export const RUNNER_IMPLEMENTATIONS = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'ollama',
  'openai-compatible',
  'antigravity-cli',
  'mock',
] as const;
export type RunnerImplementation = (typeof RUNNER_IMPLEMENTATIONS)[number];

/** Built-in profile names (synthesized when a config file omits them). */
export const BUILT_IN_PROFILE_NAMES = {
  'claude-code': 'claude-code',
  'codex-cli': 'codex-default',
  'gemini-cli': 'gemini-default',
  ollama: 'ollama-local',
  'openai-compatible': 'openai-compatible-local',
  'antigravity-cli': 'antigravity',
  mock: 'mock',
} as const;

export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Base URL safety (shared with the Ollama adapter)
// ---------------------------------------------------------------------------

export interface BaseUrlValidation {
  ok: boolean;
  problems: string[];
  /** True for localhost / 127.0.0.0/8 / [::1]. */
  loopback: boolean;
  protocol?: string;
  hostname?: string;
  port?: string;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Validate a runner base URL. Rejects: non-http(s) schemes (file:, ftp:, …),
 * embedded credentials, null bytes, query/fragment noise, malformed hosts,
 * and plain-HTTP remote endpoints unless `allowInsecureHttp` is explicitly
 * set for a private development endpoint.
 */
export function validateRunnerBaseUrl(
  raw: string,
  options?: { allowInsecureHttp?: boolean },
): BaseUrlValidation {
  const problems: string[] = [];
  if (raw.includes('\0')) {
    return { ok: false, problems: ['must not contain null bytes'], loopback: false };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problems: [`"${raw}" is not a valid absolute URL`], loopback: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`unsupported URL scheme "${url.protocol}" — only http: and https: are allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('must not embed credentials (username/password) in the URL');
  }
  if (url.hostname === '') {
    problems.push('must include a hostname');
  }
  if (url.search !== '' || url.hash !== '') {
    problems.push('must not include a query string or fragment');
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:' && !loopback && options?.allowInsecureHttp !== true) {
    problems.push(
      'remote endpoints must use https: by default. For a private development endpoint, ' +
        'set "allowInsecureHttp": true on the profile (clearly labeled as insecure).',
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    loopback,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
  };
}

// ---------------------------------------------------------------------------
// Profile schemas
// ---------------------------------------------------------------------------

/**
 * Executable + argv array. A plain command string is rejected: SpecBridge
 * never assembles shell strings for runner processes.
 */
export const commandSpecSchema = z.preprocess(
  (value, ctx) => {
    if (typeof value === 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `"${value}" is a shell command string. Runner commands must be ` +
          '{"executable": "...", "args": [...]} — arguments are never shell-interpolated.',
      });
      return z.NEVER;
    }
    return value;
  },
  z
    .object({
      executable: safeNonEmptyString,
      args: z.array(safeNonEmptyString).default([]),
    })
    .strict(),
);
export type CommandSpec = { executable: string; args: string[] };

export const claudeProfileSchema = claudeRunnerConfigSchema.extend({
  runner: z.literal('claude-code'),
});
export type ClaudeProfileConfig = z.infer<typeof claudeProfileSchema>;

export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/**
 * Codex CLI profile. The user installs and authenticates Codex
 * independently; SpecBridge never stores credentials and never enables an
 * unrestricted sandbox mode (`danger-full-access` is rejected at the schema
 * root, and the invocation layer asserts it again).
 */
export const codexProfileSchema = z
  .object({
    runner: z.literal('codex-cli'),
    enabled: z.boolean().default(false),
    command: commandSpecSchema.default({ executable: 'codex', args: [] }),
    model: safeNonEmptyString.nullable().default(null),
    /** Sandbox for TASK EXECUTION. Authoring always runs read-only. */
    sandbox: z.enum(CODEX_SANDBOX_MODES).default('workspace-write'),
    persistSessions: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
    maxStdoutBytes: z.number().int().min(1024).default(10 * 1024 * 1024),
    maxStderrBytes: z.number().int().min(1024).default(1024 * 1024),
  })
  .passthrough();
export type CodexProfileConfig = z.infer<typeof codexProfileSchema>;

/**
 * Ollama profile — authoring only. The default endpoint is loopback; remote
 * endpoints are network-backed, need HTTPS (or the explicit insecure
 * override), and are never selected implicitly.
 */
export const ollamaProfileSchema = z
  .object({
    runner: z.literal('ollama'),
    enabled: z.boolean().default(false),
    baseUrl: safeNonEmptyString.default('http://127.0.0.1:11434'),
    model: safeNonEmptyString.nullable().default(null),
    temperature: z.number().min(0).max(2).default(0),
    timeoutMs: z.number().int().min(1000).max(86_400_000).default(300_000),
    maximumInputCharacters: z.number().int().min(1000).default(500_000),
    maximumOutputBytes: z.number().int().min(1024).default(2_097_152),
    /** Explicit development override for private plain-HTTP endpoints. */
    allowInsecureHttp: z.boolean().default(false),
  })
  .passthrough();
export type OllamaProfileConfig = z.infer<typeof ollamaProfileSchema>;

export const mockProfileSchema = mockRunnerConfigSchema.extend({
  runner: z.literal('mock'),
});
export type MockProfileConfig = z.infer<typeof mockProfileSchema>;

/**
 * Gemini CLI approval modes SpecBridge is allowed to pass. `yolo` is not a
 * value of either enum and is additionally rejected by the invocation-layer
 * assertion — there is no configuration that produces an unrestricted run.
 */
export const GEMINI_AUTHORING_APPROVAL_MODES = ['plan'] as const;
export type GeminiAuthoringApprovalMode = (typeof GEMINI_AUTHORING_APPROVAL_MODES)[number];
export const GEMINI_EXECUTION_APPROVAL_MODES = ['auto_edit', 'default'] as const;
export type GeminiExecutionApprovalMode = (typeof GEMINI_EXECUTION_APPROVAL_MODES)[number];

/**
 * Gemini CLI profile (v0.6.1). The user installs and authenticates the
 * Gemini CLI independently; SpecBridge never reads Google credential stores,
 * never triggers a login, never trusts a folder, and never passes YOLO or
 * any other unrestricted approval mode.
 */
export const geminiProfileSchema = z
  .object({
    runner: z.literal('gemini-cli'),
    enabled: z.boolean().default(false),
    command: commandSpecSchema.default({ executable: 'gemini', args: [] }),
    model: safeNonEmptyString.nullable().default(null),
    /** Authoring is always read-only; only plan mode is accepted. */
    approvalModeForAuthoring: z.enum(GEMINI_AUTHORING_APPROVAL_MODES).default('plan'),
    /** Task execution may auto-approve EDITS only — never shell commands. */
    approvalModeForExecution: z.enum(GEMINI_EXECUTION_APPROVAL_MODES).default('auto_edit'),
    /** Pass --sandbox when the installed CLI supports it. */
    sandbox: z.boolean().default(true),
    /**
     * Extra tools to allow during task execution, on top of the adapter's
     * bounded read/edit set. Shell-execution tools are rejected.
     */
    allowedTools: z
      .array(safeNonEmptyString)
      .default([])
      .refine(
        (tools) =>
          tools.every((tool) => !/^(run_shell_command|shell|bash|execute_command|terminal)$/i.test(tool)),
        {
          message:
            'shell-execution tools cannot be allowed: SpecBridge never grants the Gemini CLI arbitrary shell access',
        },
      ),
    /** Pass the extension-restriction flag when supported (default on). */
    disabledExtensions: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
    maxStdoutBytes: z.number().int().min(1024).default(10 * 1024 * 1024),
    maxStderrBytes: z.number().int().min(1024).default(1024 * 1024),
  })
  .passthrough();
export type GeminiProfileConfig = z.infer<typeof geminiProfileSchema>;

export const OPENAI_COMPATIBLE_API_STYLES = ['chat-completions', 'responses'] as const;
export type OpenAiCompatibleApiStyle = (typeof OPENAI_COMPATIBLE_API_STYLES)[number];

export const OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_MODES = [
  'json-schema',
  'json-object',
  'strict-json-prompt',
] as const;
export type OpenAiCompatibleStructuredOutputMode =
  (typeof OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_MODES)[number];

/** Environment-variable NAMES only — never values. */
const environmentVariableNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'must be an environment-variable NAME (letters, digits, underscore); SpecBridge never stores key values',
  );

/** Header names an openai-compatible profile may set. Credential-bearing
 * headers are rejected: authentication goes through apiKeyEnvironmentVariable
 * exclusively, so no key value can ever land in the configuration file. */
const FORBIDDEN_HEADER_NAME_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

const safeHeadersSchema = z
  .record(z.string().max(1024))
  .superRefine((headers, ctx) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[A-Za-z0-9-]+$/.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `header name "${name}" is invalid (letters, digits, and "-" only)`,
        });
      }
      if (FORBIDDEN_HEADER_NAME_PATTERN.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `header "${name}" would carry a credential value. SpecBridge never stores credentials; ` +
            'use apiKeyEnvironmentVariable (a variable NAME) instead.',
        });
      }
      if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `header "${name}" contains control characters`,
        });
      }
    }
  });

/**
 * OpenAI-compatible model API profile (v0.6.1) — AUTHORING ONLY.
 *
 * No task execution, no tool loop, no repository writes. The endpoint is
 * loopback by default; remote endpoints need HTTPS (or the explicit,
 * clearly-insecure development override) and are never selected implicitly.
 * Authentication is configured as an environment-variable NAME; the value is
 * read at request time only and never stored, logged, or retained.
 */
export const openAiCompatibleProfileSchema = z
  .object({
    runner: z.literal('openai-compatible'),
    enabled: z.boolean().default(false),
    baseUrl: safeNonEmptyString.default('http://127.0.0.1:8000/v1'),
    apiStyle: z.enum(OPENAI_COMPATIBLE_API_STYLES).default('chat-completions'),
    model: safeNonEmptyString.nullable().default(null),
    structuredOutput: z.enum(OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_MODES).default('json-schema'),
    /**
     * Explicit permission to fall back from the configured structured-output
     * mode to the next weaker one when the endpoint rejects it. Off by
     * default: an unsupported mode is an error, never a silent downgrade.
     */
    allowStructuredOutputFallback: z.boolean().default(false),
    /** Name of the environment variable holding the API key (never a value). */
    apiKeyEnvironmentVariable: environmentVariableNameSchema.nullable().default(null),
    /** Static capability declaration: the endpoint supports GET /models. */
    modelsEndpoint: z.boolean().default(false),
    /** Custom safe headers (credential-bearing header names are rejected). */
    headers: safeHeadersSchema.default({}),
    temperature: z.number().min(0).max(2).default(0),
    timeoutMs: z.number().int().min(1000).max(86_400_000).default(300_000),
    maximumInputCharacters: z.number().int().min(1000).default(500_000),
    maximumOutputBytes: z.number().int().min(1024).default(2_097_152),
    /** Explicit development override for private plain-HTTP endpoints (INSECURE). */
    allowInsecureHttp: z.boolean().default(false),
  })
  .passthrough();
export type OpenAiCompatibleProfileConfig = z.infer<typeof openAiCompatibleProfileSchema>;

/**
 * Antigravity CLI profile (v0.6.1) — EXPERIMENTAL, detection only.
 *
 * The adapter detects the executable, version, and documented capabilities.
 * It never automates the interactive TUI, never uses a PTY, never logs in,
 * and never executes authoring or tasks in v0.6.1.
 */
export const antigravityProfileSchema = z
  .object({
    runner: z.literal('antigravity-cli'),
    enabled: z.boolean().default(false),
    command: commandSpecSchema.default({ executable: 'agy', args: [] }),
    /** Always true: the adapter is experimental and cannot be marked otherwise. */
    experimental: z.literal(true).default(true),
    timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
  })
  .passthrough();
export type AntigravityProfileConfig = z.infer<typeof antigravityProfileSchema>;

/**
 * v0.7.1: a profile backed by an installed runner *extension* (out-of-process
 * stdio adapter behind the frozen v0.6.0 runner contract). Backward
 * compatible: a new discriminated-union variant, nothing else changes.
 * Extension profiles start disabled and are never selected automatically.
 */
export const extensionRunnerProfileSchema = z
  .object({
    runner: z.literal('extension'),
    /** ID of the installed, enabled runner extension this profile uses. */
    extensionId: z.string().min(1).max(64),
    /** Extension profiles must be explicitly enabled to register at all. */
    enabled: z.boolean().default(false),
    model: z.string().min(1).max(200).optional(),
    /** Per-operation timeout in milliseconds. */
    timeoutMs: z.number().int().min(1).max(3_600_000).default(300_000),
    /** Extension-owned configuration passed through the protocol verbatim. */
    configuration: z.record(z.unknown()).default({}),
  })
  .strict();
export type ExtensionRunnerProfileConfig = z.infer<typeof extensionRunnerProfileSchema>;

export const runnerProfileSchema = z.discriminatedUnion('runner', [
  claudeProfileSchema,
  codexProfileSchema,
  geminiProfileSchema,
  ollamaProfileSchema,
  openAiCompatibleProfileSchema,
  antigravityProfileSchema,
  mockProfileSchema,
  extensionRunnerProfileSchema,
]);
export type RunnerProfileConfig = z.infer<typeof runnerProfileSchema>;

export function isExtensionRunnerProfile(
  profile: RunnerProfileConfig,
): profile is ExtensionRunnerProfileConfig {
  return profile.runner === 'extension';
}

// ---------------------------------------------------------------------------
// Policy, defaults, fallbacks
// ---------------------------------------------------------------------------

export const runnerPolicySchema = z
  .object({
    allowAutomaticFallback: z.boolean().default(false),
    allowNetworkRunners: z.boolean().default(true),
    requireExplicitRunnerForNetworkAccess: z.boolean().default(true),
    requireExplicitRunnerForPaidApi: z.boolean().default(true),
  })
  .passthrough();
export type RunnerPolicy = z.infer<typeof runnerPolicySchema>;

export const operationDefaultsSchema = z
  .object({
    stageGeneration: safeNonEmptyString.nullable().default(null),
    stageRefinement: safeNonEmptyString.nullable().default(null),
    taskExecution: safeNonEmptyString.nullable().default(null),
  })
  .passthrough();
export type OperationDefaults = z.infer<typeof operationDefaultsSchema>;

export const fallbacksSchema = z
  .object({
    stageGeneration: z.array(safeNonEmptyString).default([]),
    stageRefinement: z.array(safeNonEmptyString).default([]),
  })
  .passthrough();
export type FallbackConfig = z.infer<typeof fallbacksSchema>;

// ---------------------------------------------------------------------------
// v2 file schema
// ---------------------------------------------------------------------------

/** Key names that look like stored credentials — rejected everywhere. */
const CREDENTIAL_KEY_PATTERN = /^(api[-_]?keys?|auth[-_]?tokens?|access[-_]?tokens?|secrets?|passwords?|credentials?)$/i;

function credentialKeyIssues(value: unknown, breadcrumb: string[]): string[] {
  if (value === null || typeof value !== 'object') return [];
  const issues: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      issues.push(
        `field "${[...breadcrumb, key].join('.')}" looks like a stored credential. ` +
          'SpecBridge never stores credential values; authenticate through the provider itself.',
      );
    }
    issues.push(...credentialKeyIssues(child, [...breadcrumb, key]));
  }
  return issues;
}

export const agentConfigV2Schema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    defaultRunner: safeNonEmptyString.default(BUILT_IN_PROFILE_NAMES['claude-code']),
    operationDefaults: operationDefaultsSchema.default({}),
    runnerProfiles: z.record(runnerProfileSchema).default({}),
    runnerPolicy: runnerPolicySchema.default({}),
    fallbacks: fallbacksSchema.default({}),
    verification: verificationConfigSchema.default({}),
    execution: executionPolicySchema.default({}),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (!config.schemaVersion.startsWith('2.')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schemaVersion'],
        message: `schema version ${config.schemaVersion} is not a v2 configuration`,
      });
    }
    for (const name of Object.keys(config.runnerProfiles)) {
      if (!PROFILE_NAME_PATTERN.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runnerProfiles', name],
          message: `profile name "${name}" is invalid (allowed: letters, digits, ".", "_", "-")`,
        });
      }
    }
    for (const [name, profile] of Object.entries(config.runnerProfiles)) {
      if (profile.runner === 'ollama' || profile.runner === 'openai-compatible') {
        const url = validateRunnerBaseUrl(profile.baseUrl, {
          allowInsecureHttp: profile.allowInsecureHttp,
        });
        for (const problem of url.problems) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['runnerProfiles', name, 'baseUrl'],
            message: problem,
          });
        }
      }
    }
    for (const message of forbiddenFragmentIssues(JSON.stringify(config))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    for (const message of credentialKeyIssues(config, [])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });
export type AgentConfigFileV2 = z.infer<typeof agentConfigV2Schema>;

// ---------------------------------------------------------------------------
// Resolved in-memory model
// ---------------------------------------------------------------------------

/**
 * The resolved runner configuration every runner-facing feature consumes.
 * Version-transparent: produced from a v1 file, a v2 file, or defaults.
 */
export interface AgentConfig {
  /** Resolved model version (always RUNNER_CONFIG_SCHEMA_VERSION). */
  schemaVersion: string;
  /** The schema version of the file this was resolved from. */
  sourceSchemaVersion: string;
  defaultRunner: string;
  operationDefaults: OperationDefaults;
  runnerProfiles: Record<string, RunnerProfileConfig>;
  runnerPolicy: RunnerPolicy;
  fallbacks: FallbackConfig;
  verification: VerificationConfig;
  execution: ExecutionPolicy;
}

function builtInClaudeProfile(base?: Partial<ClaudeRunnerConfig>): ClaudeProfileConfig {
  return claudeProfileSchema.parse({ runner: 'claude-code', ...(base ?? {}) });
}

function builtInMockProfile(base?: Partial<MockRunnerConfig>): MockProfileConfig {
  return mockProfileSchema.parse({ runner: 'mock', ...(base ?? {}) });
}

function builtInCodexProfile(executable?: string): CodexProfileConfig {
  return codexProfileSchema.parse({
    runner: 'codex-cli',
    enabled: false,
    ...(executable !== undefined ? { command: { executable, args: [] } } : {}),
  });
}

function builtInOllamaProfile(): OllamaProfileConfig {
  return ollamaProfileSchema.parse({ runner: 'ollama', enabled: false });
}

function builtInGeminiProfile(): GeminiProfileConfig {
  return geminiProfileSchema.parse({ runner: 'gemini-cli', enabled: false });
}

function builtInOpenAiCompatibleProfile(): OpenAiCompatibleProfileConfig {
  return openAiCompatibleProfileSchema.parse({ runner: 'openai-compatible', enabled: false });
}

function builtInAntigravityProfile(): AntigravityProfileConfig {
  return antigravityProfileSchema.parse({ runner: 'antigravity-cli', enabled: false });
}

/** Add any missing built-in profiles (never overwrites configured ones). */
function withBuiltInProfiles(
  profiles: Record<string, RunnerProfileConfig>,
  options?: { codexExecutable?: string },
): Record<string, RunnerProfileConfig> {
  const result: Record<string, RunnerProfileConfig> = {};
  const add = (name: string, profile: RunnerProfileConfig): void => {
    if (result[name] === undefined) result[name] = profile;
  };
  // Built-ins first for deterministic listing order, then configured extras.
  add(
    BUILT_IN_PROFILE_NAMES['claude-code'],
    profiles[BUILT_IN_PROFILE_NAMES['claude-code']] ?? builtInClaudeProfile(),
  );
  add(
    BUILT_IN_PROFILE_NAMES['codex-cli'],
    profiles[BUILT_IN_PROFILE_NAMES['codex-cli']] ?? builtInCodexProfile(options?.codexExecutable),
  );
  add(
    BUILT_IN_PROFILE_NAMES['gemini-cli'],
    profiles[BUILT_IN_PROFILE_NAMES['gemini-cli']] ?? builtInGeminiProfile(),
  );
  add(
    BUILT_IN_PROFILE_NAMES.ollama,
    profiles[BUILT_IN_PROFILE_NAMES.ollama] ?? builtInOllamaProfile(),
  );
  add(
    BUILT_IN_PROFILE_NAMES['openai-compatible'],
    profiles[BUILT_IN_PROFILE_NAMES['openai-compatible']] ?? builtInOpenAiCompatibleProfile(),
  );
  add(
    BUILT_IN_PROFILE_NAMES['antigravity-cli'],
    profiles[BUILT_IN_PROFILE_NAMES['antigravity-cli']] ?? builtInAntigravityProfile(),
  );
  add(BUILT_IN_PROFILE_NAMES.mock, profiles[BUILT_IN_PROFILE_NAMES.mock] ?? builtInMockProfile());
  for (const [name, profile] of Object.entries(profiles)) add(name, profile);
  return result;
}

/** v1 runner names → v2 profile names (used by resolution AND migration). */
export const V1_RUNNER_NAME_TO_PROFILE: Record<string, string> = {
  'claude-code': BUILT_IN_PROFILE_NAMES['claude-code'],
  mock: BUILT_IN_PROFILE_NAMES.mock,
  codex: BUILT_IN_PROFILE_NAMES['codex-cli'],
  ollama: BUILT_IN_PROFILE_NAMES.ollama,
};

function v1CodexExecutable(v1: AgentConfigFileV1): string | undefined {
  const entry = v1.runners['codex'];
  if (entry === undefined || typeof entry !== 'object') return undefined;
  const command = (entry as { command?: unknown }).command;
  return typeof command === 'string' && command.length > 0 ? command : undefined;
}

/** Resolve a parsed v1 file into the v2 in-memory model (read-only; no file writes). */
export function resolveAgentConfigFromV1(v1: AgentConfigFileV1): AgentConfig {
  const profiles: Record<string, RunnerProfileConfig> = {
    [BUILT_IN_PROFILE_NAMES['claude-code']]: builtInClaudeProfile(v1.runners['claude-code']),
    [BUILT_IN_PROFILE_NAMES.mock]: builtInMockProfile(v1.runners.mock),
  };
  return {
    schemaVersion: RUNNER_CONFIG_SCHEMA_VERSION,
    sourceSchemaVersion: v1.schemaVersion,
    defaultRunner: V1_RUNNER_NAME_TO_PROFILE[v1.defaultRunner] ?? v1.defaultRunner,
    operationDefaults: operationDefaultsSchema.parse({}),
    runnerProfiles: withBuiltInProfiles(profiles, {
      ...(v1CodexExecutable(v1) !== undefined
        ? { codexExecutable: v1CodexExecutable(v1) as string }
        : {}),
    }),
    runnerPolicy: runnerPolicySchema.parse({}),
    fallbacks: fallbacksSchema.parse({}),
    verification: v1.verification,
    execution: v1.execution,
  };
}

/** Resolve a parsed v2 file into the in-memory model. */
export function resolveAgentConfigFromV2(v2: AgentConfigFileV2): AgentConfig {
  return {
    schemaVersion: RUNNER_CONFIG_SCHEMA_VERSION,
    sourceSchemaVersion: v2.schemaVersion,
    defaultRunner: v2.defaultRunner,
    operationDefaults: v2.operationDefaults,
    runnerProfiles: withBuiltInProfiles(v2.runnerProfiles),
    runnerPolicy: v2.runnerPolicy,
    fallbacks: v2.fallbacks,
    verification: v2.verification,
    execution: v2.execution,
  };
}

/** The fully defaulted resolved configuration used when no config file exists. */
export function defaultResolvedAgentConfig(): AgentConfig {
  return {
    schemaVersion: RUNNER_CONFIG_SCHEMA_VERSION,
    sourceSchemaVersion: RUNNER_CONFIG_SCHEMA_VERSION,
    defaultRunner: BUILT_IN_PROFILE_NAMES['claude-code'],
    operationDefaults: operationDefaultsSchema.parse({}),
    runnerProfiles: withBuiltInProfiles({}),
    runnerPolicy: runnerPolicySchema.parse({}),
    fallbacks: fallbacksSchema.parse({}),
    verification: verificationConfigSchema.parse({}),
    execution: executionPolicySchema.parse({}),
  };
}

/** Cross-reference checks that need the RESOLVED profile table. */
export function resolvedConfigDiagnostics(config: AgentConfig): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const missing = (name: string, where: string): void => {
    diagnostics.push({
      severity: 'error',
      code: 'CONFIG_UNKNOWN_PROFILE',
      message: `${where} references unknown runner profile "${name}". Configured profiles: ${Object.keys(config.runnerProfiles).join(', ')}.`,
    });
  };
  if (config.runnerProfiles[config.defaultRunner] === undefined) {
    missing(config.defaultRunner, 'defaultRunner');
  }
  for (const [operation, profile] of Object.entries(config.operationDefaults)) {
    if (typeof profile === 'string' && config.runnerProfiles[profile] === undefined) {
      missing(profile, `operationDefaults.${operation}`);
    }
  }
  for (const [operation, chain] of Object.entries(config.fallbacks)) {
    if (!Array.isArray(chain)) continue;
    for (const profile of chain) {
      if (typeof profile === 'string' && config.runnerProfiles[profile] === undefined) {
        missing(profile, `fallbacks.${operation}`);
      }
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Version-transparent reader
// ---------------------------------------------------------------------------

export interface AgentConfigReadResult {
  path: string;
  exists: boolean;
  /** Present when the file is absent (defaults) or parsed successfully. */
  config?: AgentConfig;
  /** Schema version found in the file ('2.0.0' for the defaults). */
  sourceSchemaVersion?: string;
  /** True when the file is a v1 schema that `config migrate` can upgrade. */
  needsMigration: boolean;
  diagnostics: Diagnostic[];
}

function fileSchemaVersion(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === 'string' ? version : undefined;
}

function zodIssueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Read and validate `.specbridge/config.json` for runner execution,
 * accepting BOTH the v1 and v2 file schemas (v1 stays fully supported until
 * the user migrates explicitly).
 *
 * Fail-closed contract: a config file that exists but cannot be validated
 * yields NO config (callers must refuse to execute), unlike the tolerant
 * v0.2 reader used by read-only commands.
 */
export function readAgentConfig(workspace: WorkspaceInfo): AgentConfigReadResult {
  const configPath = path.join(workspace.sidecarDir, 'config.json');
  if (!existsSync(configPath)) {
    return {
      path: configPath,
      exists: false,
      config: defaultResolvedAgentConfig(),
      sourceSchemaVersion: RUNNER_CONFIG_SCHEMA_VERSION,
      needsMigration: false,
      diagnostics: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (cause) {
    return {
      path: configPath,
      exists: true,
      needsMigration: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'CONFIG_INVALID_JSON',
          message: `Configuration file could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: configPath,
        },
      ],
    };
  }

  const declaredVersion = fileSchemaVersion(parsed);
  const isV2 = declaredVersion !== undefined && declaredVersion.startsWith('2.');
  const invalid = (issues: string): AgentConfigReadResult => ({
    path: configPath,
    exists: true,
    ...(declaredVersion !== undefined ? { sourceSchemaVersion: declaredVersion } : {}),
    needsMigration: false,
    diagnostics: [
      {
        severity: 'error',
        code: 'CONFIG_INVALID_SHAPE',
        message: `Configuration file is not a valid runner configuration: ${issues}`,
        file: configPath,
      },
    ],
  });

  let config: AgentConfig;
  let sourceSchemaVersion: string;
  if (isV2) {
    const result = agentConfigV2Schema.safeParse(parsed);
    if (!result.success) return invalid(zodIssueSummary(result.error));
    config = resolveAgentConfigFromV2(result.data);
    sourceSchemaVersion = result.data.schemaVersion;
  } else {
    const result = agentConfigSchema.safeParse(parsed);
    if (!result.success) return invalid(zodIssueSummary(result.error));
    config = resolveAgentConfigFromV1(result.data);
    sourceSchemaVersion = result.data.schemaVersion;
  }

  const referenceErrors = resolvedConfigDiagnostics(config).filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (referenceErrors.length > 0) {
    return invalid(referenceErrors.map((diagnostic) => diagnostic.message).join('; '));
  }

  return {
    path: configPath,
    exists: true,
    config,
    sourceSchemaVersion,
    needsMigration: !isV2,
    diagnostics: [],
  };
}

/** Look up a profile; undefined when absent (callers produce the error). */
export function profileByName(
  config: AgentConfig,
  name: string,
): RunnerProfileConfig | undefined {
  return config.runnerProfiles[name];
}

/** Type-narrowing profile accessors used by adapters and views. */
export function isClaudeProfile(profile: RunnerProfileConfig): profile is ClaudeProfileConfig {
  return profile.runner === 'claude-code';
}
export function isCodexProfile(profile: RunnerProfileConfig): profile is CodexProfileConfig {
  return profile.runner === 'codex-cli';
}
export function isOllamaProfile(profile: RunnerProfileConfig): profile is OllamaProfileConfig {
  return profile.runner === 'ollama';
}
export function isGeminiProfile(profile: RunnerProfileConfig): profile is GeminiProfileConfig {
  return profile.runner === 'gemini-cli';
}
export function isOpenAiCompatibleProfile(
  profile: RunnerProfileConfig,
): profile is OpenAiCompatibleProfileConfig {
  return profile.runner === 'openai-compatible';
}
export function isAntigravityProfile(
  profile: RunnerProfileConfig,
): profile is AntigravityProfileConfig {
  return profile.runner === 'antigravity-cli';
}
export function isMockProfile(profile: RunnerProfileConfig): profile is MockProfileConfig {
  return profile.runner === 'mock';
}
