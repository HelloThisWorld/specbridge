import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Diagnostic } from './types.js';
import type { WorkspaceInfo } from './workspace.js';
import { assertInsideWorkspace, writeFileAtomic } from './workspace.js';

/**
 * Sidecar state lives in `.specbridge/state/specs/<name>.json`.
 *
 * It records everything SpecBridge knows about a spec that the `.kiro`
 * Markdown files do not express (workflow mode, approvals, verification
 * configuration). `.kiro` files are never used to store this data.
 */

export const approvalSchema = z.object({
  approved: z.boolean(),
  approvedAt: z.string().optional(),
  approvedBy: z.string().optional(),
});

export const specStatusValues = [
  'DRAFT',
  'REQUIREMENTS_APPROVED',
  'DESIGN_APPROVED',
  'READY_FOR_EXECUTION',
  'IN_PROGRESS',
  'COMPLETE',
] as const;

export const specStateSchema = z
  .object({
    specName: z.string().min(1),
    specType: z.enum(['feature', 'bugfix']),
    workflowMode: z.enum(['requirements-first', 'design-first', 'quick']),
    status: z.enum(specStatusValues),
    approvals: z
      .object({
        requirements: approvalSchema.optional(),
        design: approvalSchema.optional(),
        tasks: approvalSchema.optional(),
      })
      .optional(),
    declaredImpactAreas: z.array(z.string()).optional(),
    verificationCommands: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  // Unknown fields written by newer SpecBridge versions must survive.
  .passthrough();

export type SpecState = z.infer<typeof specStateSchema>;
export type SpecStatus = (typeof specStatusValues)[number];

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
  state?: SpecState;
  diagnostics: Diagnostic[];
}

export function specStatePath(workspace: WorkspaceInfo, specName: string): string {
  // The spec name comes from a directory listing or user input; guard it.
  return assertInsideWorkspace(
    workspace.rootDir,
    path.join(workspace.sidecarDir, 'state', 'specs', `${specName}.json`),
  );
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

  const result = specStateSchema.safeParse(parsed);
  if (!result.success) {
    return {
      path: statePath,
      exists: true,
      diagnostics: [
        {
          severity: 'warning',
          code: 'SIDECAR_STATE_INVALID_SHAPE',
          message: `Sidecar state file does not match the expected schema; ignoring it. (${result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')})`,
          file: statePath,
        },
      ],
    };
  }

  return { path: statePath, exists: true, state: result.data, diagnostics: [] };
}

/** Persist sidecar state atomically. Creates `.specbridge/state/specs/` on demand. */
export function writeSpecState(workspace: WorkspaceInfo, state: SpecState): string {
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
