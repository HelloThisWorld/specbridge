import path from 'node:path';
import { z } from 'zod';

/**
 * The v1 (v0.3–v0.5) `.specbridge/config.json` file schema for agent
 * runners, trusted verification commands, and execution policy.
 *
 * v0.6 introduces the v2 multi-runner schema and the version-transparent
 * reader in ./runner-config.ts. This module stays authoritative for:
 *   - parsing v1 files (still fully supported before explicit migration)
 *   - the claude-code and mock runner option schemas (shared by v2 profiles)
 *   - the verification and execution policy schemas (identical in v2)
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

export const FORBIDDEN_PERMISSION_MODE = 'bypassPermissions';
/**
 * Substrings that must never appear anywhere in a configuration file,
 * whatever field they hide in. The v1 list covers Claude Code permission
 * bypasses; v0.6 adds the unrestricted Codex execution modes.
 */
export const FORBIDDEN_FLAG_FRAGMENTS = [
  'dangerously-skip-permissions',
  'dangerously_skip_permissions',
  'dangerously-bypass-approvals-and-sandbox',
  'danger-full-access',
  '--yolo',
  'skip-git-repo-check',
];

function containsNullByte(value: string): boolean {
  return value.includes('\0');
}

export const safeString = z
  .string()
  .refine((value) => !containsNullByte(value), { message: 'must not contain null bytes' });

export const safeNonEmptyString = safeString.refine((value) => value.length > 0, {
  message: 'must not be empty',
});

/**
 * Reject configurations that smuggle a permission bypass or unrestricted
 * sandbox mode in, whatever field it hides in. Shared by the v1 and v2
 * schemas (defense in depth).
 */
export function forbiddenFragmentIssues(serialized: string): string[] {
  const issues: string[] = [];
  const lower = serialized.toLowerCase();
  for (const fragment of FORBIDDEN_FLAG_FRAGMENTS) {
    if (lower.includes(fragment)) {
      issues.push(
        `configuration contains "${fragment}", which SpecBridge never passes to any runner. ` +
          'Remove it; there is no supported way to skip runner permission or sandbox checks.',
      );
    }
  }
  if (serialized.includes(FORBIDDEN_PERMISSION_MODE)) {
    issues.push(
      `"${FORBIDDEN_PERMISSION_MODE}" is not a supported permission mode. ` +
        `SpecBridge only supports: ${CLAUDE_PERMISSION_MODES.join(', ')}.`,
    );
  }
  return issues;
}

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
export const genericRunnerConfigSchema = z
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
        message: `schema version ${config.schemaVersion} is not a v1 configuration`,
      });
    }
    for (const message of forbiddenFragmentIssues(JSON.stringify(config))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });
/** The v1 FILE shape. The resolved in-memory model is AgentConfig (v2). */
export type AgentConfigFileV1 = z.infer<typeof agentConfigSchema>;

/** The fully defaulted v1 file configuration (kept for tests and migration). */
export function defaultAgentConfig(): AgentConfigFileV1 {
  return agentConfigSchema.parse({});
}
