import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic } from './types.js';
import type { WorkspaceInfo } from './workspace.js';

/**
 * Versioned `.specbridge/config.json` schema for agent runners, trusted
 * verification commands, and execution policy (v0.3).
 *
 * Safety rules enforced here, not downstream:
 *   - commands are argv arrays — shell strings are rejected outright
 *   - no null bytes anywhere
 *   - `bypassPermissions` and `dangerously-skip-permissions` are rejected,
 *     never warned about and never silently corrected
 *   - verification commands can only come from this file, never from spec
 *     content or model output
 *
 * Backward compatibility: every field is optional with a safe default, so a
 * v0.2 config file (`{ "defaultRunner": ..., "runners": { name: { command } } }`)
 * parses unchanged. Unknown fields survive via passthrough.
 */

export const AGENT_CONFIG_SCHEMA_VERSION = '1.0.0';

const FORBIDDEN_PERMISSION_MODE = 'bypassPermissions';
const FORBIDDEN_FLAG_FRAGMENTS = ['dangerously-skip-permissions', 'dangerously_skip_permissions'];

function containsNullByte(value: string): boolean {
  return value.includes('\0');
}

const safeString = z
  .string()
  .refine((value) => !containsNullByte(value), { message: 'must not contain null bytes' });

const safeNonEmptyString = safeString.refine((value) => value.length > 0, {
  message: 'must not be empty',
});

/**
 * One trusted verification command. argv arrays only: `["pnpm", "test"]`.
 * A single-element argv containing whitespace is almost certainly a shell
 * string (`["pnpm test"]`) and is rejected — split it into arguments.
 */
export const verificationCommandSchema = z
  .object({
    name: safeNonEmptyString,
    argv: z
      .array(safeNonEmptyString)
      .min(1, 'argv must contain at least the executable')
      .superRefine((argv, ctx) => {
        if (argv.length === 1 && /\s/.test(argv[0] ?? '')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `"${argv[0]}" looks like a shell command string. ` +
              'Verification commands must be argv arrays, e.g. ["pnpm", "test"].',
          });
        }
      }),
    timeoutMs: z.number().int().min(1000).max(86_400_000).default(600_000),
    required: z.boolean().default(true),
  })
  .passthrough();
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export const DEFAULT_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;

export const DEFAULT_ALLOWED_BASH_RULES = [
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(pnpm test *)',
  'Bash(pnpm typecheck *)',
  'Bash(pnpm lint *)',
  'Bash(pnpm build *)',
  'Bash(npm test *)',
  'Bash(npm run test *)',
  'Bash(npm run build *)',
] as const;

/**
 * Claude Code runner configuration. SpecBridge only ever invokes the local
 * executable configured here; it never stores or reads credentials.
 */
export const claudeRunnerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Executable name or path, resolved without any shell interpolation. */
    command: safeNonEmptyString.default('claude'),
    /**
     * Arguments always placed before SpecBridge's own arguments. Lets the
     * executable be an interpreter (e.g. command "node", commandArgs
     * ["path/to/cli.js"]). Used by the offline test harness.
     */
    commandArgs: z.array(safeNonEmptyString).default([]),
    model: safeNonEmptyString.nullable().default(null),
    effort: safeNonEmptyString.nullable().default(null),
    maxTurns: z.number().int().min(1).max(1000).default(30),
    maxBudgetUsd: z.number().positive().nullable().default(null),
    timeoutMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
    permissionMode: z.enum(CLAUDE_PERMISSION_MODES).default('acceptEdits'),
    loadProjectConfiguration: z.boolean().default(true),
    /** Tools available during task execution. Stage generation restricts further. */
    tools: z.array(safeNonEmptyString).default([...DEFAULT_CLAUDE_TOOLS]),
    allowedBashRules: z.array(safeNonEmptyString).default([...DEFAULT_ALLOWED_BASH_RULES]),
    maxStdoutBytes: z.number().int().min(1024).default(10 * 1024 * 1024),
    maxStderrBytes: z.number().int().min(1024).default(1024 * 1024),
  })
  .passthrough();
export type ClaudeRunnerConfig = z.infer<typeof claudeRunnerConfigSchema>;

/** Deterministic mock runner scenarios (offline; used by tests and demos). */
export const MOCK_SCENARIOS = [
  'success',
  'invalid-markdown',
  'malformed-output',
  'no-change',
  'blocked',
  'failed',
  'timeout',
  'cancelled',
  'permission-denied',
  'stderr-noise',
  'claims-untested',
  'protected-path',
  'modify-tasks-doc',
  'resume-failure',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const mockRunnerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    scenario: z.enum(MOCK_SCENARIOS).default('success'),
    /**
     * Workspace-relative file the mock runner creates/appends for successful
     * task scenarios. Must stay inside the workspace.
     */
    changeFile: safeNonEmptyString
      .refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), {
        message: 'must be a workspace-relative path without ".." segments',
      })
      .default('specbridge-mock-change.txt'),
  })
  .passthrough();
export type MockRunnerConfig = z.infer<typeof mockRunnerConfigSchema>;

/** Any other runner entry (unknown/unsupported): tolerated, surfaced honestly. */
const genericRunnerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: safeNonEmptyString.optional(),
  })
  .passthrough();

export const executionPolicySchema = z
  .object({
    requireCleanWorkingTree: z.boolean().default(true),
    stopOnUnverifiedTask: z.boolean().default(true),
    capturePatch: z.boolean().default(true),
    maximumPatchBytes: z.number().int().min(1024).default(10_485_760),
    /**
     * Additional protected path prefixes (workspace-relative, forward
     * slashes). `.kiro`, `.specbridge`, and `.git` are always protected.
     */
    protectedPaths: z
      .array(
        safeNonEmptyString.refine(
          (value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'),
          { message: 'must be a workspace-relative path without ".." segments' },
        ),
      )
      .default([]),
  })
  .passthrough();
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export const verificationConfigSchema = z
  .object({
    commands: z.array(verificationCommandSchema).default([]),
  })
  .passthrough();
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;

export const agentConfigSchema = z
  .object({
    schemaVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default(AGENT_CONFIG_SCHEMA_VERSION),
    defaultRunner: safeNonEmptyString.default('claude-code'),
    runners: z
      .object({
        'claude-code': claudeRunnerConfigSchema.default({}),
        mock: mockRunnerConfigSchema.default({}),
      })
      .catchall(genericRunnerConfigSchema)
      .default({}),
    verification: verificationConfigSchema.default({}),
    execution: executionPolicySchema.default({}),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (config.schemaVersion !== undefined && !config.schemaVersion.startsWith('1.')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schemaVersion'],
        message: `schema version ${config.schemaVersion} is not supported by this SpecBridge version`,
      });
    }
    // Defense in depth: no configuration is allowed to smuggle a permission
    // bypass in, whatever field it hides in.
    const serialized = JSON.stringify(config);
    for (const fragment of FORBIDDEN_FLAG_FRAGMENTS) {
      if (serialized.toLowerCase().includes(fragment)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `configuration contains "${fragment}", which SpecBridge never passes to any runner. ` +
            'Remove it; there is no supported way to skip runner permission checks.',
        });
      }
    }
    if (serialized.includes(FORBIDDEN_PERMISSION_MODE)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `"${FORBIDDEN_PERMISSION_MODE}" is not a supported permission mode. ` +
          `SpecBridge only supports: ${CLAUDE_PERMISSION_MODES.join(', ')}.`,
      });
    }
  });
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** The fully defaulted configuration used when no config file exists. */
export function defaultAgentConfig(): AgentConfig {
  return agentConfigSchema.parse({});
}

export interface AgentConfigReadResult {
  path: string;
  exists: boolean;
  /** Present when the file is absent (defaults) or parsed successfully. */
  config?: AgentConfig;
  diagnostics: Diagnostic[];
}

/**
 * Read and validate `.specbridge/config.json` for runner execution.
 *
 * Fail-closed contract: a config file that exists but cannot be validated
 * yields NO config (callers must refuse to execute), unlike the tolerant
 * v0.2 reader used by read-only commands.
 */
export function readAgentConfig(workspace: WorkspaceInfo): AgentConfigReadResult {
  const configPath = path.join(workspace.sidecarDir, 'config.json');
  if (!existsSync(configPath)) {
    return { path: configPath, exists: false, config: defaultAgentConfig(), diagnostics: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (cause) {
    return {
      path: configPath,
      exists: true,
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

  const result = agentConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      path: configPath,
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'CONFIG_INVALID_SHAPE',
          message: `Configuration file is not a valid runner configuration: ${issues}`,
          file: configPath,
        },
      ],
    };
  }

  return { path: configPath, exists: true, config: result.data, diagnostics: [] };
}
