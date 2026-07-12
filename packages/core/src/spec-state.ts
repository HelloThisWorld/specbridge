import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic, StageName } from './types.js';
import { WORKFLOW_STATUS_VALUES } from './types.js';
import type { WorkspaceInfo } from './workspace.js';
import { assertInsideWorkspace, writeFileAtomic } from './workspace.js';

/**
 * Sidecar workflow state lives in `.specbridge/state/specs/<name>.json`.
 *
 * It records everything SpecBridge knows about a spec that the `.kiro`
 * Markdown files do not express: workflow mode, stage approvals, approval
 * hashes, and timestamps. `.kiro` files are never used to store this data,
 * and approval is never inferred from file existence — only from here.
 *
 * The schema is versioned. Readers accept any 1.x file; unknown extra
 * properties written by newer 1.x versions survive a read-modify-write.
 */

export const SPEC_STATE_SCHEMA_VERSION = '1.0.0';

/**
 * Approval-hash semantics version recorded per stage.
 *
 * Version "2" (v0.4) adds `approvedPlanHash` for the tasks stage: a SHA-256
 * over the tasks document with only checkbox state characters normalized, so
 * `[ ]` → `[x]` progress does not invalidate an approved task plan while any
 * other byte change (task text, IDs, hierarchy, references) still does.
 * Requirements, bugfix, and design approvals remain exact-byte hashes only.
 */
export const TASK_PLAN_HASH_SEMANTICS_VERSION = '2';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const stageApprovalSchema = z.object({
  status: z.enum(['blocked', 'draft', 'approved']),
  /** Workspace-relative path with forward slashes, e.g. `.kiro/specs/x/design.md`. */
  file: z.string().min(1),
  /** ISO-8601 timestamp of the recorded approval, or null when not approved. */
  approvedAt: z.string().datetime({ offset: true }).nullable(),
  /** SHA-256 (hex) of the exact approved file bytes, or null when not approved. */
  approvedHash: z.string().regex(SHA256_HEX, 'must be a lowercase sha256 hex digest').nullable(),
  /**
   * Tasks stage only: SHA-256 of the approved document with checkbox state
   * normalized (semantics version 2). Absent on stages approved before v0.4
   * and on non-tasks stages; the exact `approvedHash` remains authoritative
   * for audit either way.
   */
  approvedPlanHash: z
    .string()
    .regex(SHA256_HEX, 'must be a lowercase sha256 hex digest')
    .nullable()
    .optional(),
  hashAlgorithm: z.literal('sha256').optional(),
  hashSemanticsVersion: z.string().optional(),
});

export type StageApproval = z.infer<typeof stageApprovalSchema>;

const stagesSchema = z
  .object({
    requirements: stageApprovalSchema.optional(),
    bugfix: stageApprovalSchema.optional(),
    design: stageApprovalSchema,
    tasks: stageApprovalSchema,
  })
  .passthrough();

export const specWorkflowStateSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    specName: z.string().min(1),
    specType: z.enum(['feature', 'bugfix']),
    workflowMode: z.enum(['requirements-first', 'design-first', 'quick']),
    origin: z
      .enum(['created-by-specbridge', 'existing-kiro-workspace'])
      .default('created-by-specbridge'),
    status: z.enum(WORKFLOW_STATUS_VALUES),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    stages: stagesSchema,
  })
  // Unknown top-level fields written by newer 1.x SpecBridge versions must survive.
  .passthrough()
  .superRefine((state, ctx) => {
    const documentStage = state.specType === 'bugfix' ? 'bugfix' : 'requirements';
    const wrongStage = state.specType === 'bugfix' ? 'requirements' : 'bugfix';
    if (state.stages[documentStage] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', documentStage],
        message: `a ${state.specType} spec must have a "${documentStage}" stage`,
      });
    }
    if (state.stages[wrongStage] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', wrongStage],
        message: `a ${state.specType} spec must not have a "${wrongStage}" stage`,
      });
    }
    for (const [name, stage] of Object.entries(state.stages)) {
      if (stage === undefined || typeof stage !== 'object') continue;
      const approval = stage as StageApproval;
      const approved = approval.status === 'approved';
      if (approved && (approval.approvedAt === null || approval.approvedHash === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', name],
          message: 'an approved stage must record approvedAt and approvedHash',
        });
      }
      if (!approved && (approval.approvedAt !== null || approval.approvedHash !== null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', name],
          message: 'a stage that is not approved must have null approvedAt and approvedHash',
        });
      }
      if (
        !approved &&
        approval.approvedPlanHash !== null &&
        approval.approvedPlanHash !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', name],
          message: 'a stage that is not approved must not record approvedPlanHash',
        });
      }
    }
  });

export type SpecWorkflowState = z.infer<typeof specWorkflowStateSchema>;

/** Stages recorded in a state file, preserving the stored (workflow) order. */
export function stateStageNames(state: SpecWorkflowState): StageName[] {
  const known: StageName[] = [];
  for (const key of Object.keys(state.stages)) {
    if (key === 'requirements' || key === 'bugfix' || key === 'design' || key === 'tasks') {
      known.push(key);
    }
  }
  return known;
}

export function stateStage(state: SpecWorkflowState, stage: StageName): StageApproval | undefined {
  const value = (state.stages as Record<string, unknown>)[stage];
  return value === undefined ? undefined : (value as StageApproval);
}

export const specbridgeConfigSchema = z
  .object({
    defaultRunner: z.string().optional(),
    runners: z.record(z.object({ command: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export type SpecbridgeConfig = z.infer<typeof specbridgeConfigSchema>;

export interface SpecStateReadResult {
  path: string;
  exists: boolean;
  state?: SpecWorkflowState;
  diagnostics: Diagnostic[];
}

export function specStatePath(workspace: WorkspaceInfo, specName: string): string {
  // The spec name comes from a directory listing or user input; guard it.
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'state', 'specs', `${specName}.json`),
  );
}

/** Directory that holds one JSON state file per spec. */
export function specStateDir(workspace: WorkspaceInfo): string {
  return path.join(workspace.sidecarDir, 'state', 'specs');
}

function invalidStateDiagnostic(statePath: string, parsed: unknown, issues: string): Diagnostic {
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (record['schemaVersion'] === undefined && record['specName'] !== undefined) {
    return {
      severity: 'warning',
      code: 'SIDECAR_STATE_LEGACY',
      message:
        'Sidecar state file predates the versioned 1.0.0 schema; ignoring it. ' +
        'Re-approve the stages you trust to regenerate it (the .kiro files are unaffected).',
      file: statePath,
    };
  }
  const version = record['schemaVersion'];
  if (typeof version === 'string' && !version.startsWith('1.')) {
    return {
      severity: 'warning',
      code: 'SIDECAR_STATE_UNSUPPORTED_VERSION',
      message: `Sidecar state schema version ${version} is not supported by this SpecBridge version; ignoring it.`,
      file: statePath,
    };
  }
  return {
    severity: 'warning',
    code: 'SIDECAR_STATE_INVALID_SHAPE',
    message: `Sidecar state file does not match the expected schema; ignoring it. (${issues})`,
    file: statePath,
  };
}

/** Read sidecar state. Missing or invalid state never throws — it degrades to diagnostics. */
export function readSpecState(workspace: WorkspaceInfo, specName: string): SpecStateReadResult {
  const statePath = specStatePath(workspace, specName);
  if (!existsSync(statePath)) {
    return { path: statePath, exists: false, diagnostics: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (cause) {
    return {
      path: statePath,
      exists: true,
      diagnostics: [
        {
          severity: 'warning',
          code: 'SIDECAR_STATE_UNREADABLE',
          message: `Could not read sidecar state: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: statePath,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      path: statePath,
      exists: true,
      diagnostics: [
        {
          severity: 'warning',
          code: 'SIDECAR_STATE_INVALID_JSON',
          message: 'Sidecar state file is not valid JSON; ignoring it.',
          file: statePath,
        },
      ],
    };
  }

  const result = specWorkflowStateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      path: statePath,
      exists: true,
      diagnostics: [invalidStateDiagnostic(statePath, parsed, issues)],
    };
  }

  if (result.data.specName !== specName) {
    return {
      path: statePath,
      exists: true,
      diagnostics: [
        {
          severity: 'warning',
          code: 'SIDECAR_STATE_NAME_MISMATCH',
          message: `Sidecar state file records specName "${result.data.specName}" but is stored as ${specName}.json; ignoring it.`,
          file: statePath,
        },
      ],
    };
  }

  return { path: statePath, exists: true, state: result.data, diagnostics: [] };
}

/** Persist sidecar state atomically. Creates `.specbridge/state/specs/` on demand. */
export function writeSpecState(workspace: WorkspaceInfo, state: SpecWorkflowState): string {
  const statePath = specStatePath(workspace, state.specName);
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

export interface SpecbridgeConfigReadResult {
  path: string;
  exists: boolean;
  config?: SpecbridgeConfig;
  diagnostics: Diagnostic[];
}

/** Read `.specbridge/config.json` tolerantly. */
export function readSpecbridgeConfig(workspace: WorkspaceInfo): SpecbridgeConfigReadResult {
  const configPath = path.join(workspace.sidecarDir, 'config.json');
  if (!existsSync(configPath)) {
    return { path: configPath, exists: false, diagnostics: [] };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const result = specbridgeConfigSchema.safeParse(parsed);
    if (!result.success) {
      return {
        path: configPath,
        exists: true,
        diagnostics: [
          {
            severity: 'warning',
            code: 'CONFIG_INVALID_SHAPE',
            message: 'Configuration file does not match the expected schema; ignoring it.',
            file: configPath,
          },
        ],
      };
    }
    return { path: configPath, exists: true, config: result.data, diagnostics: [] };
  } catch (cause) {
    return {
      path: configPath,
      exists: true,
      diagnostics: [
        {
          severity: 'warning',
          code: 'CONFIG_INVALID_JSON',
          message: `Configuration file could not be parsed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          file: configPath,
        },
      ],
    };
  }
}
