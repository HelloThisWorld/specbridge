import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceInfo } from './workspace.js';
import { writeFileAtomic } from './workspace.js';
import { SpecBridgeError } from './errors.js';
import type { AgentConfigFileV1 } from './agent-config.js';
import { agentConfigSchema } from './agent-config.js';
import {
  BUILT_IN_PROFILE_NAMES,
  RUNNER_CONFIG_SCHEMA_VERSION,
  V1_RUNNER_NAME_TO_PROFILE,
  agentConfigV2Schema,
} from './runner-config.js';

/**
 * Explicit v1 → v2 configuration migration.
 *
 * Nothing here runs automatically: reading a v1 file keeps working through
 * the version-transparent reader, and only `specbridge config migrate
 * --apply` rewrites the file — atomically, with a recoverable backup, after
 * validating the result.
 *
 * Guarantees (tested):
 *   - the effective Claude Code default behavior is preserved
 *   - Codex and Ollama profiles are created DISABLED
 *   - trusted verification commands and execution policy are preserved
 *   - unknown safe top-level fields are preserved
 *   - no credential value is ever created
 *   - a dry run writes nothing; a failed apply leaves the original intact
 */

const KNOWN_V1_TOP_LEVEL = new Set([
  'schemaVersion',
  'defaultRunner',
  'runners',
  'verification',
  'execution',
]);
const KNOWN_V1_RUNNERS = new Set(['claude-code', 'mock', 'codex', 'ollama']);

export interface ConfigMigrationPlan {
  fromVersion: string;
  toVersion: string;
  /** Human-readable field mappings, in application order. */
  changes: string[];
  /** Dropped or unmappable entries (still recoverable from the backup). */
  warnings: string[];
  /** The complete v2 file content the migration would write. */
  migrated: Record<string, unknown>;
}

export type ConfigMigrationPlanResult =
  | { kind: 'already-current'; version: string }
  | { kind: 'invalid'; problems: string[] }
  | { kind: 'plan'; plan: ConfigMigrationPlan };

function migrateRunnersSection(
  v1: AgentConfigFileV1,
  changes: string[],
  warnings: string[],
): Record<string, unknown> {
  const profiles: Record<string, unknown> = {};

  profiles[BUILT_IN_PROFILE_NAMES['claude-code']] = {
    runner: 'claude-code',
    ...v1.runners['claude-code'],
  };
  changes.push(
    `runners.claude-code → runnerProfiles.${BUILT_IN_PROFILE_NAMES['claude-code']} (all fields preserved; behavior unchanged)`,
  );

  profiles[BUILT_IN_PROFILE_NAMES.mock] = { runner: 'mock', ...v1.runners.mock };
  changes.push(`runners.mock → runnerProfiles.${BUILT_IN_PROFILE_NAMES.mock} (all fields preserved)`);

  const codexEntry = v1.runners['codex'];
  const codexExecutable =
    codexEntry !== undefined &&
    typeof codexEntry === 'object' &&
    typeof (codexEntry as { command?: unknown }).command === 'string'
      ? ((codexEntry as { command: string }).command as string)
      : 'codex';
  profiles[BUILT_IN_PROFILE_NAMES['codex-cli']] = {
    runner: 'codex-cli',
    enabled: false,
    command: { executable: codexExecutable, args: [] },
  };
  changes.push(
    `runnerProfiles.${BUILT_IN_PROFILE_NAMES['codex-cli']} added DISABLED (executable "${codexExecutable}"; enable it explicitly to use Codex)`,
  );

  profiles[BUILT_IN_PROFILE_NAMES.ollama] = { runner: 'ollama', enabled: false };
  changes.push(
    `runnerProfiles.${BUILT_IN_PROFILE_NAMES.ollama} added DISABLED (loopback http://127.0.0.1:11434; enable it explicitly to use Ollama)`,
  );

  for (const name of Object.keys(v1.runners)) {
    if (!KNOWN_V1_RUNNERS.has(name)) {
      warnings.push(
        `runners.${name} has no v0.6 runner implementation and was not migrated ` +
          '(it remains in the backup file; openai-compatible and similar providers are planned for v0.6.1).',
      );
    }
  }
  return profiles;
}

/** Build the migration plan from raw file JSON. Pure: writes nothing. */
export function planConfigMigration(raw: unknown): ConfigMigrationPlanResult {
  const declared =
    raw !== null && typeof raw === 'object'
      ? (raw as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (typeof declared === 'string' && declared.startsWith('2.')) {
    const check = agentConfigV2Schema.safeParse(raw);
    if (!check.success) {
      return {
        kind: 'invalid',
        problems: check.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      };
    }
    return { kind: 'already-current', version: declared };
  }

  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  const v1 = parsed.data;
  const changes: string[] = [];
  const warnings: string[] = [];

  changes.push(`schemaVersion ${v1.schemaVersion} → ${RUNNER_CONFIG_SCHEMA_VERSION}`);

  const defaultRunner = V1_RUNNER_NAME_TO_PROFILE[v1.defaultRunner] ?? v1.defaultRunner;
  if (defaultRunner === v1.defaultRunner) {
    changes.push(`defaultRunner "${v1.defaultRunner}" preserved`);
  } else {
    changes.push(
      `defaultRunner "${v1.defaultRunner}" → profile "${defaultRunner}" (same runner implementation; behavior unchanged)`,
    );
  }

  const runnerProfiles = migrateRunnersSection(v1, changes, warnings);
  changes.push('verification (trusted commands) preserved unchanged');
  changes.push('execution policy preserved unchanged');
  changes.push('operationDefaults added (all null — every operation keeps using defaultRunner)');
  changes.push('runnerPolicy added with safe defaults (automatic fallback stays disabled)');
  changes.push('fallbacks added empty (no automatic provider switching)');

  // Preserve unknown safe top-level fields (already validated against
  // forbidden fragments by the v1 schema parse).
  const preservedUnknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_V1_TOP_LEVEL.has(key)) {
      preservedUnknown[key] = value;
      changes.push(`unknown field "${key}" preserved unchanged`);
    }
  }

  const migrated: Record<string, unknown> = {
    schemaVersion: RUNNER_CONFIG_SCHEMA_VERSION,
    defaultRunner,
    operationDefaults: { stageGeneration: null, stageRefinement: null, taskExecution: null },
    runnerProfiles,
    runnerPolicy: {
      allowAutomaticFallback: false,
      allowNetworkRunners: true,
      requireExplicitRunnerForNetworkAccess: true,
      requireExplicitRunnerForPaidApi: true,
    },
    fallbacks: { stageGeneration: [], stageRefinement: [] },
    verification: v1.verification,
    execution: v1.execution,
    ...preservedUnknown,
  };

  // The plan must produce a file the validator accepts — checked here so a
  // dry run already proves the apply would succeed.
  const validated = agentConfigV2Schema.safeParse(migrated);
  if (!validated.success) {
    return {
      kind: 'invalid',
      problems: validated.error.issues.map(
        (issue) => `migrated configuration would be invalid — ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }

  return {
    kind: 'plan',
    plan: {
      fromVersion: v1.schemaVersion,
      toVersion: RUNNER_CONFIG_SCHEMA_VERSION,
      changes,
      warnings,
      migrated,
    },
  };
}

export interface ConfigMigrationApplied {
  configPath: string;
  backupPath: string;
}

/** First free backup path: config.v1.backup.json, then -2, -3, … */
function backupPathFor(configPath: string): string {
  const base = path.join(path.dirname(configPath), 'config.v1.backup.json');
  if (!existsSync(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(path.dirname(configPath), `config.v1.backup-${index}.json`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new SpecBridgeError('INVALID_STATE', 'Could not allocate a configuration backup path.');
}

/**
 * Apply a migration plan atomically:
 *   1. copy the ORIGINAL file bytes to a recoverable backup
 *   2. write the new file atomically (temp file + rename)
 *   3. re-read and validate the final file; restore the original on failure
 */
export function applyConfigMigration(
  workspace: WorkspaceInfo,
  plan: ConfigMigrationPlan,
): ConfigMigrationApplied {
  const configPath = path.join(workspace.sidecarDir, 'config.json');
  if (!existsSync(configPath)) {
    throw new SpecBridgeError('INVALID_STATE', `No configuration file exists at ${configPath}.`);
  }
  const originalBytes = readFileSync(configPath);
  const backupPath = backupPathFor(configPath);
  writeFileAtomic(backupPath, originalBytes.toString('utf8'));

  writeFileAtomic(configPath, `${JSON.stringify(plan.migrated, null, 2)}\n`);

  let finalCheck: ReturnType<typeof agentConfigV2Schema.safeParse>;
  try {
    finalCheck = agentConfigV2Schema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (cause) {
    writeFileAtomic(configPath, originalBytes.toString('utf8'));
    throw new SpecBridgeError(
      'INVALID_STATE',
      `Migration produced an unreadable file and was rolled back: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!finalCheck.success) {
    writeFileAtomic(configPath, originalBytes.toString('utf8'));
    throw new SpecBridgeError(
      'INVALID_STATE',
      'Migration produced an invalid file and was rolled back. The original configuration is unchanged.',
    );
  }
  return { configPath, backupPath };
}
