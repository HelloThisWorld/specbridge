import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import type { Diagnostic, PolicyMode, WorkspaceInfo } from '@specbridge/core';
import { VERIFICATION_RULE_ID_PATTERN } from '@specbridge/core';

/**
 * Spec-specific verification policy.
 *
 * One JSON file per spec under `.specbridge/policies/<spec-name>.json` —
 * plain configuration, never executable, never a spec stage, and never
 * required: verification falls back to secure built-in defaults.
 *
 * Precedence (weakest to strongest):
 *   1. secure built-in defaults (protected paths below)
 *   2. global project configuration (`.specbridge/config.json`)
 *   3. this per-spec policy file
 *   4. explicit CLI flags (`--strict` may only tighten checks)
 *
 * `.git/**` protection is unconditional and cannot be configured away.
 */

export const VERIFICATION_POLICY_SCHEMA_VERSION = '1.0.0';

/**
 * Protected paths that are always enforced during implementation
 * verification, regardless of configuration.
 */
export const BUILT_IN_PROTECTED_PATHS = [
  '.kiro/**',
  '.specbridge/state/**',
  '.specbridge/config.json',
  '.git/**',
] as const;

/** The one protected pattern that no configuration layer may remove. */
export const IMMUTABLE_PROTECTED_PATHS = ['.git/**'] as const;

const GLOB_MAX_LENGTH = 512;

export interface GlobPatternIssue {
  pattern: string;
  reason: string;
}

/**
 * Validate one glob pattern for use against repository-relative paths.
 * Patterns are matched with picomatch (documented in docs/verification-policy.md).
 */
export function validateGlobPattern(pattern: string): GlobPatternIssue | undefined {
  if (pattern.length === 0) return { pattern, reason: 'pattern is empty' };
  if (pattern.length > GLOB_MAX_LENGTH) {
    return { pattern, reason: `pattern exceeds ${GLOB_MAX_LENGTH} characters` };
  }
  if (pattern.includes('\0')) return { pattern, reason: 'pattern contains a null byte' };
  if (pattern.includes('\\')) {
    return {
      pattern,
      reason: 'pattern contains a backslash; use forward slashes for repository paths',
    };
  }
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) {
    return { pattern, reason: 'pattern must be repository-relative, not absolute' };
  }
  if (pattern.split('/').includes('..')) {
    return { pattern, reason: 'pattern must not contain ".." path traversal segments' };
  }
  try {
    picomatch(pattern);
  } catch (cause) {
    return {
      pattern,
      reason: `pattern is not a valid glob: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  return undefined;
}

const globPatternSchema = z.string().superRefine((pattern, ctx) => {
  const issue = validateGlobPattern(pattern);
  if (issue !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.reason });
  }
});

export const policyRuleOverrideSchema = z
  .object({
    enabled: z.boolean().default(true),
    severity: z.enum(['error', 'warning', 'info']).optional(),
  })
  .passthrough();
export type PolicyRuleOverride = z.infer<typeof policyRuleOverrideSchema>;

export const verificationPolicySchema = z
  .object({
    schemaVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default(VERIFICATION_POLICY_SCHEMA_VERSION),
    specName: z.string().min(1),
    mode: z.enum(['advisory', 'strict']).default('advisory'),
    impactAreas: z.array(globPatternSchema).default([]),
    protectedPaths: z.array(globPatternSchema).default([]),
    /** Names of trusted commands (from `.specbridge/config.json`) that must pass. */
    requiredVerificationCommands: z.array(z.string().min(1)).default([]),
    requireVerifiedTaskEvidence: z.boolean().default(false),
    requireRequirementTaskLinks: z.boolean().default(false),
    requireTestEvidence: z.boolean().default(false),
    rules: z
      .record(
        z.string().regex(VERIFICATION_RULE_ID_PATTERN, 'rule keys must look like SBV005'),
        policyRuleOverrideSchema,
      )
      .default({}),
  })
  .passthrough()
  .superRefine((policy, ctx) => {
    if (!policy.schemaVersion.startsWith('1.')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schemaVersion'],
        message: `schema version ${policy.schemaVersion} is not supported by this SpecBridge version`,
      });
    }
  });
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;

export function policyDir(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, 'policies');
}

export function policyPath(workspace: WorkspaceInfo, specName: string): string {
  const resolved = path.resolve(policyDir(workspace), `${specName}.json`);
  const relative = path.relative(workspace.rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    // A spec name is a directory name; anything that escapes is hostile input.
    return path.join(policyDir(workspace), 'invalid-spec-name.json');
  }
  return resolved;
}

export interface PolicyReadResult {
  /** Absolute path that was read (or would be read). */
  path: string;
  exists: boolean;
  policy?: VerificationPolicy;
  diagnostics: Diagnostic[];
}

/**
 * Read one policy file. Fail-closed: an existing file that does not validate
 * yields NO policy plus error diagnostics (surfaced as SBV020 by the rule
 * engine) — verification then runs with secure defaults, never with a
 * half-understood policy.
 */
export function readVerificationPolicy(
  workspace: WorkspaceInfo,
  specName: string,
  explicitPath?: string,
): PolicyReadResult {
  const filePath =
    explicitPath !== undefined
      ? path.resolve(workspace.rootDir, explicitPath)
      : policyPath(workspace, specName);
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false, diagnostics: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (cause) {
    return {
      path: filePath,
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'POLICY_INVALID_JSON',
          message: `Verification policy is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: filePath,
        },
      ],
    };
  }

  const result = verificationPolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      path: filePath,
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'POLICY_INVALID_SHAPE',
          message: `Verification policy does not match the versioned schema: ${issues}`,
          file: filePath,
        },
      ],
    };
  }

  if (explicitPath === undefined && result.data.specName !== specName) {
    return {
      path: filePath,
      exists: true,
      diagnostics: [
        {
          severity: 'error',
          code: 'POLICY_NAME_MISMATCH',
          message: `Verification policy records specName "${result.data.specName}" but is stored as ${specName}.json.`,
          file: filePath,
        },
      ],
    };
  }

  return { path: filePath, exists: true, policy: result.data, diagnostics: [] };
}

/** Fully resolved policy after applying every precedence layer. */
export interface EffectivePolicy {
  specName: string;
  mode: PolicyMode;
  /** True when `--strict` raised the mode beyond the stored policy. */
  strictFromCli: boolean;
  impactAreas: string[];
  /** Merged protected paths; always contains the built-ins. */
  protectedPaths: string[];
  requiredVerificationCommands: string[];
  requireVerifiedTaskEvidence: boolean;
  requireRequirementTaskLinks: boolean;
  requireTestEvidence: boolean;
  ruleOverrides: Record<string, PolicyRuleOverride>;
  /** Workspace-relative policy file path when a file was used. */
  policyPath?: string;
  policyExists: boolean;
  /** Error diagnostics from an unreadable/invalid policy file (SBV020). */
  policyDiagnostics: Diagnostic[];
}

export interface ResolveEffectivePolicyOptions {
  /** Additional protected paths from global configuration. */
  globalProtectedPaths?: string[];
  /** CLI `--strict`: tighten to strict mode (never loosens). */
  strict?: boolean;
  /** Explicit `--policy <path>` override. */
  explicitPolicyPath?: string;
}

export function resolveEffectivePolicy(
  workspace: WorkspaceInfo,
  specName: string,
  options: ResolveEffectivePolicyOptions = {},
): EffectivePolicy {
  const read = readVerificationPolicy(workspace, specName, options.explicitPolicyPath);
  const policy = read.policy;

  const protectedPaths: string[] = [...BUILT_IN_PROTECTED_PATHS];
  for (const pattern of options.globalProtectedPaths ?? []) {
    // Global config stores prefix-style protected paths; normalize a plain
    // directory prefix into a glob that covers the whole subtree.
    const validated = validateGlobPattern(pattern);
    if (validated !== undefined) continue;
    const asGlob = /[*?[\]{}]/.test(pattern)
      ? pattern
      : `${pattern.replace(/\/+$/, '')}/**`;
    if (!protectedPaths.includes(asGlob)) protectedPaths.push(asGlob);
  }
  for (const pattern of policy?.protectedPaths ?? []) {
    if (!protectedPaths.includes(pattern)) protectedPaths.push(pattern);
  }

  const storedMode: PolicyMode = policy?.mode ?? 'advisory';
  const strictFromCli = options.strict === true && storedMode !== 'strict';
  const mode: PolicyMode = options.strict === true ? 'strict' : storedMode;

  const workspaceRelativePolicyPath = path
    .relative(workspace.rootDir, read.path)
    .split(path.sep)
    .join('/');

  return {
    specName,
    mode,
    strictFromCli,
    impactAreas: [...(policy?.impactAreas ?? [])],
    protectedPaths,
    requiredVerificationCommands: [...(policy?.requiredVerificationCommands ?? [])],
    requireVerifiedTaskEvidence: policy?.requireVerifiedTaskEvidence ?? false,
    requireRequirementTaskLinks: policy?.requireRequirementTaskLinks ?? false,
    requireTestEvidence: policy?.requireTestEvidence ?? false,
    ruleOverrides: { ...(policy?.rules ?? {}) },
    ...(read.exists ? { policyPath: workspaceRelativePolicyPath } : {}),
    policyExists: read.exists,
    policyDiagnostics: read.diagnostics,
  };
}

/** Compiled matcher over repository-relative POSIX paths. */
export function compilePathMatchers(patterns: readonly string[]): (candidate: string) => string[] {
  const matchers = patterns.map((pattern) => ({
    pattern,
    isMatch: picomatch(pattern, { dot: true }),
  }));
  return (candidate: string): string[] => {
    const posix = candidate.split('\\').join('/');
    return matchers.filter(({ isMatch }) => isMatch(posix)).map(({ pattern }) => pattern);
  };
}
