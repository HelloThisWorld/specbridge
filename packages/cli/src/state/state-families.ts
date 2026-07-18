import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  MigrationFileStep,
  RecoveryAction,
  RecoveryActionKind,
  RecoveryConfidence,
  RecoveryRisk,
  WorkspaceInfo,
} from '@specbridge/core';
import {
  CLI_BIN,
  MIGRATION_PLAN_SCHEMA_VERSION,
  RUNNER_CONFIG_SCHEMA_VERSION,
  SPEC_STATE_SCHEMA_VERSION,
  planConfigMigration,
  readAgentConfig,
  readSpecState,
  sha256Hex,
  stateStage,
  stateStageNames,
  trySha256File,
} from '@specbridge/core';
import { tryTaskPlanHashOfFile } from '@specbridge/compat-kiro';
import {
  INTERACTIVE_LOCK_SCHEMA_VERSION,
  RUN_RECORD_SCHEMA_VERSION,
  interactiveLockPath,
  listRuns,
  readInteractiveLock,
  runsRootDir,
} from '@specbridge/execution';
import { EVIDENCE_SCHEMA_VERSION, taskEvidenceRecordSchema } from '@specbridge/evidence';
import {
  VERIFICATION_POLICY_SCHEMA_VERSION,
  policyDir,
  readVerificationPolicy,
} from '@specbridge/drift';
import {
  TEMPLATE_MANIFEST_FILE_NAME,
  TEMPLATE_RECORD_SCHEMA_VERSION,
  parseTemplateManifest,
  projectTemplatesDir,
  readTemplateRecords,
  templateRecordsPath,
} from '@specbridge/templates';
import {
  EXTENSION_STATE_SCHEMA_VERSION,
  extensionStatePath,
  installedRootDir,
  loadExtensionPackage,
  permissionGrantsPath,
  readExtensionPackageDirectory,
  readExtensionState,
  readPermissionGrants,
} from '@specbridge/extensions';
import {
  REGISTRIES_SCHEMA_VERSION,
  REGISTRY_CACHE_SCHEMA_VERSION,
  readRegistriesConfig,
  readRegistryCache,
  registriesConfigPath,
  registryCacheDir,
} from '@specbridge/registry';

/**
 * The single registry over every persisted SpecBridge state family.
 *
 * Everything in this module is STRICTLY read-only: collectors use the
 * tolerant readers each owning package already ships, never throw on bad
 * state, and never repair anything. Findings describe what exists; the
 * `migrate` and `state recover` commands are the only places that act, and
 * only after an explicit plan.
 *
 * Recovery proposals attached to findings follow one safety rule set:
 *   - approvals, evidence, and completed tasks are NEVER invented or
 *     reconstructed — no proposal ever touches the evidence family
 *   - user-authored files (config.json, registries.json, policies) get no
 *     automatic proposal; they are fixed manually or from a backup
 *   - security-relevant files (extension state and permission grants) get no
 *     automatic proposal either
 *   - every proposed action moves bytes into quarantine; nothing is destroyed
 */

export type StateFindingStatus =
  | 'valid'
  | 'invalid'
  | 'migration-required'
  | 'recoverable'
  | 'unrecoverable'
  | 'orphaned'
  | 'stale'
  | 'incompatible'
  | 'legacy';

export interface StateFindingRecovery {
  kind: RecoveryActionKind;
  reason: string;
  risk: RecoveryRisk;
  confidence: RecoveryConfidence;
  /** For `restore-from-migration-backup`: workspace-relative backup path. */
  backupPath?: string;
}

export interface StateFinding {
  family: string;
  /** Workspace-relative path with forward slashes. */
  path: string;
  status: StateFindingStatus;
  /** Schema version declared by the file, or null when none was readable. */
  schemaVersion: string | null;
  /** The schema version this SpecBridge writes for the family. */
  currentVersion: string;
  problems: string[];
  recovery?: StateFindingRecovery;
}

export const STATE_FAMILY_IDS = [
  'config',
  'spec-state',
  'runs',
  'evidence',
  'policies',
  'templates',
  'extensions',
  'registries',
] as const;
export type StateFamilyId = (typeof STATE_FAMILY_IDS)[number];

/** Extra family reported only by a full scan (interrupted migration reports). */
export const MIGRATIONS_FAMILY = 'migrations';

function toRel(workspace: WorkspaceInfo, absolute: string): string {
  return path.relative(workspace.rootDir, absolute).split(path.sep).join('/');
}

function toAbs(workspace: WorkspaceInfo, relative: string): string {
  return path.join(workspace.rootDir, ...relative.split('/'));
}

/** Declared schemaVersion of a JSON file, tolerating every parse failure. */
function rawSchemaVersion(absolutePath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (typeof version === 'string') return version;
    }
  } catch {
    // Unreadable or not JSON — the caller already classifies the file.
  }
  return null;
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
  } catch {
    return [];
  }
}

function listDirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
  } catch {
    return [];
  }
}

function finding(
  family: string,
  relPath: string,
  status: StateFindingStatus,
  schemaVersion: string | null,
  currentVersion: string,
  problems: string[],
  recovery?: StateFindingRecovery,
): StateFinding {
  return {
    family,
    path: relPath,
    status,
    schemaVersion,
    currentVersion,
    problems,
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function collectConfigFindings(workspace: WorkspaceInfo): StateFinding[] {
  const read = readAgentConfig(workspace);
  const relPath = toRel(workspace, read.path);
  if (!read.exists) {
    // Safe defaults apply; there is nothing to validate.
    return [finding('config', relPath, 'valid', null, RUNNER_CONFIG_SCHEMA_VERSION, [])];
  }
  const declared = read.sourceSchemaVersion ?? rawSchemaVersion(read.path);
  if (read.config === undefined) {
    return [
      finding(
        'config',
        relPath,
        'invalid',
        declared,
        RUNNER_CONFIG_SCHEMA_VERSION,
        [
          ...read.diagnostics.map((diagnostic) => diagnostic.message),
          'The configuration is user-authored; fix it manually or restore a backup — no automatic recovery is proposed.',
        ],
      ),
    ];
  }
  if (read.needsMigration) {
    return [
      finding('config', relPath, 'migration-required', declared, RUNNER_CONFIG_SCHEMA_VERSION, [
        `The file uses the fully supported v1 schema; an explicit v2 migration is available (${CLI_BIN} migrate plan).`,
      ]),
    ];
  }
  return [finding('config', relPath, 'valid', declared, RUNNER_CONFIG_SCHEMA_VERSION, [])];
}

// ---------------------------------------------------------------------------
// spec-state
// ---------------------------------------------------------------------------

const SPEC_STATE_QUARANTINE_REASON =
  'The spec state file cannot be read as valid workflow state. Quarantining preserves the exact ' +
  'bytes for manual review; approvals are never invented — re-approve the stages you trust after review.';

function collectSpecStateFindings(workspace: WorkspaceInfo, specName?: string): StateFinding[] {
  const stateDir = path.join(workspace.sidecarDir, 'state', 'specs');
  const findings: StateFinding[] = [];
  let names = listJsonFiles(stateDir).map((name) => name.slice(0, -'.json'.length));
  if (specName !== undefined) names = names.filter((name) => name === specName);

  for (const name of names) {
    const absolute = path.join(stateDir, `${name}.json`);
    const relPath = toRel(workspace, absolute);
    const declared = rawSchemaVersion(absolute);

    const specDir = path.join(workspace.kiroDir, 'specs', name);
    if (!existsSync(specDir)) {
      findings.push(
        finding(
          'spec-state',
          relPath,
          'orphaned',
          declared,
          SPEC_STATE_SCHEMA_VERSION,
          [`No matching .kiro/specs/${name}/ directory exists.`],
          {
            kind: 'archive-orphan-state',
            reason:
              `The state file has no matching .kiro/specs/${name}/ directory. Archiving moves it ` +
              'into quarantine (preserved byte-for-byte); nothing inside .kiro is touched.',
            risk: 'low',
            confidence: 'likely',
          },
        ),
      );
      continue;
    }

    const read = readSpecState(workspace, name);
    if (read.state !== undefined) {
      const staleProblems: string[] = [];
      for (const stage of stateStageNames(read.state)) {
        const approval = stateStage(read.state, stage);
        if (approval === undefined || approval.status !== 'approved' || approval.approvedHash === null) {
          continue;
        }
        const stageFile = toAbs(workspace, approval.file);
        const currentHash = trySha256File(stageFile);
        if (currentHash === approval.approvedHash) continue;
        if (
          stage === 'tasks' &&
          currentHash !== undefined &&
          typeof approval.approvedPlanHash === 'string' &&
          tryTaskPlanHashOfFile(stageFile) === approval.approvedPlanHash
        ) {
          // Checkbox progress only — the approved task plan itself is unchanged.
          continue;
        }
        staleProblems.push(
          currentHash === undefined
            ? `${stage}: the approved file ${approval.file} is missing or unreadable.`
            : `${stage}: ${approval.file} changed after approval; re-approve explicitly with ` +
                `"${CLI_BIN} spec approve ${name} --stage ${stage}".`,
        );
      }
      findings.push(
        finding(
          'spec-state',
          relPath,
          staleProblems.length > 0 ? 'stale' : 'valid',
          read.state.schemaVersion,
          SPEC_STATE_SCHEMA_VERSION,
          staleProblems,
        ),
      );
      continue;
    }

    const code = read.diagnostics[0]?.code ?? 'SIDECAR_STATE_INVALID_SHAPE';
    const problems = read.diagnostics.map((diagnostic) => diagnostic.message);
    if (code === 'SIDECAR_STATE_LEGACY') {
      findings.push(finding('spec-state', relPath, 'legacy', declared, SPEC_STATE_SCHEMA_VERSION, problems));
    } else if (code === 'SIDECAR_STATE_UNSUPPORTED_VERSION') {
      findings.push(
        finding('spec-state', relPath, 'incompatible', declared, SPEC_STATE_SCHEMA_VERSION, problems),
      );
    } else if (code === 'SIDECAR_STATE_INVALID_SHAPE' || code === 'SIDECAR_STATE_INVALID_JSON') {
      findings.push(
        finding('spec-state', relPath, 'invalid', declared, SPEC_STATE_SCHEMA_VERSION, problems, {
          kind: 'quarantine-file',
          reason: SPEC_STATE_QUARANTINE_REASON,
          risk: 'medium',
          confidence: 'manual-review',
        }),
      );
    } else {
      // Name mismatch, unreadable, or anything future: report only.
      findings.push(finding('spec-state', relPath, 'invalid', declared, SPEC_STATE_SCHEMA_VERSION, problems));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// runs (run records + the interactive lock)
// ---------------------------------------------------------------------------

function collectRunFindings(workspace: WorkspaceInfo): StateFinding[] {
  const findings: StateFinding[] = [];
  const root = runsRootDir(workspace);
  if (existsSync(root)) {
    const { runs, diagnostics } = listRuns(workspace);
    for (const run of runs) {
      findings.push(
        finding(
          'runs',
          toRel(workspace, path.join(root, run.runId, 'run.json')),
          'valid',
          run.schemaVersion,
          RUN_RECORD_SCHEMA_VERSION,
          [],
        ),
      );
    }
    for (const diagnostic of diagnostics) {
      const runDirAbs = diagnostic.file ?? root;
      const runJson = path.join(runDirAbs, 'run.json');
      const relPath = toRel(workspace, runJson);
      if (existsSync(runJson)) {
        findings.push(
          finding('runs', relPath, 'invalid', rawSchemaVersion(runJson), RUN_RECORD_SCHEMA_VERSION, [diagnostic.message], {
            kind: 'quarantine-file',
            reason:
              'run.json does not match the run record schema. Quarantining preserves the exact bytes ' +
              'for manual review; run history is never rewritten.',
            risk: 'medium',
            confidence: 'manual-review',
          }),
        );
      } else {
        findings.push(
          finding('runs', relPath, 'invalid', null, RUN_RECORD_SCHEMA_VERSION, [
            `${diagnostic.message} (run.json is missing entirely; nothing to quarantine)`,
          ]),
        );
      }
    }
  }

  const lock = readInteractiveLock(workspace);
  const lockRel = toRel(workspace, interactiveLockPath(workspace));
  if (lock.state === 'held') {
    findings.push(
      finding('runs', lockRel, 'valid', lock.lock.schemaVersion, INTERACTIVE_LOCK_SCHEMA_VERSION, [
        `An interactive lock is currently held by run ${lock.lock.runId}; a valid lock is never removed automatically.`,
      ]),
    );
  } else if (lock.state === 'unreadable') {
    findings.push(
      finding('runs', lockRel, 'recoverable', rawSchemaVersion(lock.path), INTERACTIVE_LOCK_SCHEMA_VERSION, [lock.problem], {
        kind: 'remove-stale-lock',
        reason:
          'The interactive lock file exists but cannot be read, so it cannot protect any run. ' +
          'Removal moves it into quarantine (preserved).',
        risk: 'low',
        confidence: 'likely',
      }),
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// evidence (append-only history: findings NEVER carry a recovery proposal)
// ---------------------------------------------------------------------------

function pathEscapesRepository(candidate: string): boolean {
  return path.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..');
}

const EVIDENCE_NOTE =
  'Evidence records are append-only history and are preserved as-is; SpecBridge never proposes ' +
  'automatic recovery for evidence — manual review only.';

function collectEvidenceFindings(workspace: WorkspaceInfo, specName?: string): StateFinding[] {
  const findings: StateFinding[] = [];
  const evidenceRoot = path.join(workspace.sidecarDir, 'evidence');
  let specDirs = listDirectories(evidenceRoot);
  if (specName !== undefined) specDirs = specDirs.filter((name) => name === specName);
  for (const spec of specDirs) {
    for (const taskDir of listDirectories(path.join(evidenceRoot, spec))) {
      for (const fileName of listJsonFiles(path.join(evidenceRoot, spec, taskDir))) {
        const absolute = path.join(evidenceRoot, spec, taskDir, fileName);
        const relPath = toRel(workspace, absolute);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(absolute, 'utf8'));
        } catch {
          findings.push(
            finding('evidence', relPath, 'invalid', null, EVIDENCE_SCHEMA_VERSION, [
              `The evidence record is not valid JSON. ${EVIDENCE_NOTE}`,
            ]),
          );
          continue;
        }
        const result = taskEvidenceRecordSchema.safeParse(parsed);
        if (!result.success) {
          findings.push(
            finding('evidence', relPath, 'invalid', rawSchemaVersion(absolute), EVIDENCE_SCHEMA_VERSION, [
              `The evidence record does not match the versioned schema. ${EVIDENCE_NOTE}`,
            ]),
          );
          continue;
        }
        const escaping = result.data.changedFiles
          .map((change) => change.path)
          .filter((candidate) => pathEscapesRepository(candidate));
        if (escaping.length > 0) {
          findings.push(
            finding('evidence', relPath, 'invalid', result.data.schemaVersion, EVIDENCE_SCHEMA_VERSION, [
              ...escaping.map((candidate) => `Changed file "${candidate}" points outside the repository.`),
              EVIDENCE_NOTE,
            ]),
          );
          continue;
        }
        findings.push(finding('evidence', relPath, 'valid', result.data.schemaVersion, EVIDENCE_SCHEMA_VERSION, []));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// policies (fail-closed already; user-authored, so no recovery proposal)
// ---------------------------------------------------------------------------

function collectPolicyFindings(workspace: WorkspaceInfo, specName?: string): StateFinding[] {
  const findings: StateFinding[] = [];
  let names = listJsonFiles(policyDir(workspace)).map((name) => name.slice(0, -'.json'.length));
  if (specName !== undefined) names = names.filter((name) => name === specName);
  for (const name of names) {
    const read = readVerificationPolicy(workspace, name);
    const relPath = toRel(workspace, read.path);
    if (read.policy === undefined) {
      findings.push(
        finding('policies', relPath, 'invalid', rawSchemaVersion(read.path), VERIFICATION_POLICY_SCHEMA_VERSION, [
          ...read.diagnostics.map((diagnostic) => diagnostic.message),
          'Verification is fail-closed: an invalid policy is never half-applied. The file is user-authored; fix it manually.',
        ]),
      );
    } else {
      findings.push(
        finding('policies', relPath, 'valid', read.policy.schemaVersion, VERIFICATION_POLICY_SCHEMA_VERSION, []),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// templates (append-only records + installed pack manifests)
// ---------------------------------------------------------------------------

function collectTemplateFindings(workspace: WorkspaceInfo): StateFinding[] {
  const findings: StateFinding[] = [];
  const recordsPath = templateRecordsPath(workspace);
  if (existsSync(recordsPath)) {
    const { diagnostics } = readTemplateRecords(workspace);
    const relPath = toRel(workspace, recordsPath);
    if (diagnostics.length > 0) {
      findings.push(
        finding('templates', relPath, 'invalid', null, TEMPLATE_RECORD_SCHEMA_VERSION, [
          ...diagnostics.map((diagnostic) => diagnostic.message),
          'The record log is append-only; the tolerant reader already skips bad lines. No recovery is proposed.',
        ]),
      );
    } else {
      findings.push(finding('templates', relPath, 'valid', null, TEMPLATE_RECORD_SCHEMA_VERSION, []));
    }
  }

  for (const packName of listDirectories(projectTemplatesDir(workspace))) {
    const manifestPath = path.join(projectTemplatesDir(workspace), packName, TEMPLATE_MANIFEST_FILE_NAME);
    const relPath = toRel(workspace, manifestPath);
    if (!existsSync(manifestPath)) {
      findings.push(
        finding('templates', relPath, 'invalid', null, TEMPLATE_RECORD_SCHEMA_VERSION, [
          `Installed template pack "${packName}" has no ${TEMPLATE_MANIFEST_FILE_NAME}; nothing to quarantine.`,
        ]),
      );
      continue;
    }
    const parsed = parseTemplateManifest(readFileSync(manifestPath, 'utf8'));
    const errors = parsed.issues.filter((issue) => issue.severity === 'error');
    if (parsed.manifest === undefined || errors.length > 0) {
      findings.push(
        finding(
          'templates',
          relPath,
          'invalid',
          rawSchemaVersion(manifestPath),
          TEMPLATE_RECORD_SCHEMA_VERSION,
          errors.map((issue) => `[${issue.code}] ${issue.message}`),
          {
            kind: 'quarantine-file',
            reason:
              `The installed template pack manifest for "${packName}" is invalid. Quarantining ` +
              'preserves it for manual review; reinstall the pack from its source afterwards.',
            risk: 'medium',
            confidence: 'manual-review',
          },
        ),
      );
    } else {
      findings.push(
        finding('templates', relPath, 'valid', parsed.manifest.schemaVersion, TEMPLATE_RECORD_SCHEMA_VERSION, []),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// extensions (state + grants are security-relevant: report-only, no proposals)
// ---------------------------------------------------------------------------

function collectExtensionFindings(workspace: WorkspaceInfo): StateFinding[] {
  const findings: StateFinding[] = [];
  const statePath = extensionStatePath(workspace);
  const grantsPath = permissionGrantsPath(workspace);

  const stateRead = readExtensionState(workspace);
  if (stateRead.exists) {
    const relPath = toRel(workspace, statePath);
    if (stateRead.diagnostics.length > 0) {
      findings.push(
        finding('extensions', relPath, 'invalid', rawSchemaVersion(statePath), EXTENSION_STATE_SCHEMA_VERSION, [
          ...stateRead.diagnostics.map((diagnostic) => diagnostic.message),
          'Extension state is security-relevant; no automatic recovery is proposed. Fix or remove the file manually.',
        ]),
      );
    } else {
      findings.push(
        finding('extensions', relPath, 'valid', stateRead.state.schemaVersion, EXTENSION_STATE_SCHEMA_VERSION, []),
      );
    }
  }

  // Installed entries whose package directory disappeared (report-only).
  for (const record of stateRead.state.installed) {
    const dir = path.join(installedRootDir(workspace), record.id, record.version);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      findings.push(
        finding(
          'extensions',
          toRel(workspace, dir),
          'orphaned',
          null,
          EXTENSION_STATE_SCHEMA_VERSION,
          [
            `state.json records ${record.id}@${record.version} as installed, but its package directory is missing. ` +
              `Reinstall it or remove the entry with "${CLI_BIN} extension uninstall ${record.id}".`,
          ],
        ),
      );
    }
  }

  if (existsSync(grantsPath)) {
    const grantsRead = readPermissionGrants(workspace);
    const relPath = toRel(workspace, grantsPath);
    if (grantsRead.diagnostics.length > 0) {
      findings.push(
        finding('extensions', relPath, 'invalid', rawSchemaVersion(grantsPath), EXTENSION_STATE_SCHEMA_VERSION, [
          ...grantsRead.diagnostics.map((diagnostic) => diagnostic.message),
          'Permission grants are security-relevant; no automatic recovery is proposed. Fix or remove the file manually.',
        ]),
      );
    } else {
      // Recompute each granted permission hash from the installed manifest bytes.
      const mismatches: string[] = [];
      for (const [id, grant] of Object.entries(grantsRead.grants.grants)) {
        const installed = stateRead.state.installed.find(
          (record) => record.id === id && record.version === grant.version,
        );
        if (installed === undefined) continue; // covered by the orphan/report checks above
        const dir = path.join(installedRootDir(workspace), id, grant.version);
        if (!existsSync(dir)) continue;
        let recomputed: string | undefined;
        try {
          recomputed = loadExtensionPackage(readExtensionPackageDirectory(dir)).permissionHash;
        } catch {
          recomputed = undefined;
        }
        if (recomputed !== undefined && recomputed !== grant.permissionHash) {
          mismatches.push(
            `The grant for ${id}@${grant.version} no longer matches the installed manifest's permission hash; ` +
              'the extension stays disabled until it is re-enabled with explicit permission acceptance.',
          );
        }
      }
      findings.push(
        finding(
          'extensions',
          relPath,
          mismatches.length > 0 ? 'incompatible' : 'valid',
          grantsRead.grants.schemaVersion,
          EXTENSION_STATE_SCHEMA_VERSION,
          mismatches,
        ),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// registries (user-authored config + disposable caches)
// ---------------------------------------------------------------------------

function collectRegistryFindings(workspace: WorkspaceInfo): StateFinding[] {
  const findings: StateFinding[] = [];
  const configPath = registriesConfigPath(workspace);
  if (existsSync(configPath)) {
    const read = readRegistriesConfig(workspace);
    const relPath = toRel(workspace, configPath);
    if (read.diagnostics.length > 0) {
      findings.push(
        finding('registries', relPath, 'invalid', rawSchemaVersion(configPath), REGISTRIES_SCHEMA_VERSION, [
          ...read.diagnostics.map((diagnostic) => diagnostic.message),
          'registries.json is user-authored; fix it manually — no automatic recovery is proposed.',
        ]),
      );
    } else {
      findings.push(
        finding('registries', relPath, 'valid', read.config.schemaVersion, REGISTRIES_SCHEMA_VERSION, []),
      );
    }
  }

  for (const fileName of listJsonFiles(registryCacheDir(workspace))) {
    const name = fileName.slice(0, -'.json'.length);
    const absolute = path.join(registryCacheDir(workspace), fileName);
    const relPath = toRel(workspace, absolute);
    let read: ReturnType<typeof readRegistryCache>;
    try {
      read = readRegistryCache(workspace, name);
    } catch {
      // A hostile cache file name failed the workspace guard: report only.
      findings.push(
        finding('registries', relPath, 'invalid', null, REGISTRY_CACHE_SCHEMA_VERSION, [
          `Cache entry "${fileName}" has an unsafe name and was ignored.`,
        ]),
      );
      continue;
    }
    if (read.cache !== undefined) {
      findings.push(
        finding('registries', relPath, 'valid', read.cache.schemaVersion, REGISTRY_CACHE_SCHEMA_VERSION, []),
      );
    } else {
      findings.push(
        finding(
          'registries',
          relPath,
          'recoverable',
          rawSchemaVersion(absolute),
          REGISTRY_CACHE_SCHEMA_VERSION,
          read.diagnostics.map((diagnostic) => diagnostic.message),
          {
            kind: 'quarantine-file',
            reason:
              `The cached index "${name}" is corrupt. Registry caches are disposable and are rebuilt by ` +
              `"${CLI_BIN} registry update --network"; the corrupt bytes are preserved in quarantine.`,
            risk: 'low',
            confidence: 'certain',
          },
        ),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// migrations (interrupted reports; full scans only)
// ---------------------------------------------------------------------------

const FAILING_STATUSES: readonly StateFindingStatus[] = [
  'invalid',
  'legacy',
  'incompatible',
  'unrecoverable',
];

function collectInterruptedMigrationFindings(
  workspace: WorkspaceInfo,
  earlier: readonly StateFinding[],
): StateFinding[] {
  const findings: StateFinding[] = [];
  const migrationsDir = path.join(workspace.sidecarDir, 'migrations');
  for (const planId of listDirectories(migrationsDir).filter((name) => name.startsWith('m-'))) {
    const reportDir = path.join(migrationsDir, planId);
    const planPath = path.join(reportDir, 'plan.json');
    if (!existsSync(planPath)) continue;
    if (existsSync(path.join(reportDir, 'result.json'))) continue; // completed; `migrate verify` covers it

    let steps: Array<{ file: string }> = [];
    try {
      const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as { steps?: Array<{ file?: unknown }> };
      steps = (parsed.steps ?? [])
        .filter((step) => typeof step.file === 'string')
        .map((step) => ({ file: step.file as string }));
    } catch {
      findings.push(
        finding(MIGRATIONS_FAMILY, toRel(workspace, planPath), 'invalid', null, MIGRATION_PLAN_SCHEMA_VERSION, [
          `Migration ${planId} was interrupted (no result.json) and its plan.json cannot be parsed; review the report directory manually.`,
        ]),
      );
      continue;
    }

    const reportOnly: string[] = [
      `Migration ${planId} has a plan but no result; it was interrupted before completing.`,
    ];
    for (const step of steps) {
      const backupAbs = path.join(reportDir, 'backups', ...step.file.split('/'));
      const backupExists = existsSync(backupAbs);
      const targetFinding = earlier.find((candidate) => candidate.path === step.file);
      const targetFailing = targetFinding !== undefined && FAILING_STATUSES.includes(targetFinding.status);
      if (targetFailing && backupExists) {
        findings.push(
          finding(
            MIGRATIONS_FAMILY,
            step.file,
            'recoverable',
            rawSchemaVersion(planPath),
            MIGRATION_PLAN_SCHEMA_VERSION,
            [
              `Migration ${planId} was interrupted, ${step.file} currently fails validation, and a backup of the original bytes exists.`,
            ],
            {
              kind: 'restore-from-migration-backup',
              reason:
                `Migration ${planId} was interrupted before recording a result and ${step.file} fails ` +
                'validation. Restoring copies the backed-up original bytes back; the current bytes are ' +
                'quarantined first. Review the migration report before applying.',
              risk: 'medium',
              confidence: 'manual-review',
              backupPath: toRel(workspace, backupAbs),
            },
          ),
        );
      } else {
        reportOnly.push(
          targetFailing
            ? `${step.file} fails validation but no backup exists under the report directory; restore manually.`
            : `${step.file} currently passes its family validation; no restore is proposed.`,
        );
      }
    }
    if (reportOnly.length > 1 || steps.length === 0) {
      findings.push(
        finding(
          MIGRATIONS_FAMILY,
          toRel(workspace, planPath),
          'recoverable',
          rawSchemaVersion(planPath),
          MIGRATION_PLAN_SCHEMA_VERSION,
          reportOnly,
        ),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Collect findings across the requested state families (default: every
 * family including interrupted-migration reports). Read-only: nothing is
 * written, repaired, or deleted, and bad state never throws.
 */
export function collectStateFindings(
  workspace: WorkspaceInfo,
  families?: readonly string[],
  specName?: string,
): StateFinding[] {
  if (!existsSync(workspace.sidecarDir)) return [];
  const wants = (family: string): boolean => families === undefined || families.includes(family);
  const findings: StateFinding[] = [];
  if (wants('config')) findings.push(...collectConfigFindings(workspace));
  if (wants('spec-state')) findings.push(...collectSpecStateFindings(workspace, specName));
  if (wants('runs')) findings.push(...collectRunFindings(workspace));
  if (wants('evidence')) findings.push(...collectEvidenceFindings(workspace, specName));
  if (wants('policies')) findings.push(...collectPolicyFindings(workspace, specName));
  if (wants('templates')) findings.push(...collectTemplateFindings(workspace));
  if (wants('extensions')) findings.push(...collectExtensionFindings(workspace));
  if (wants('registries')) findings.push(...collectRegistryFindings(workspace));
  if (wants(MIGRATIONS_FAMILY)) {
    findings.push(...collectInterruptedMigrationFindings(workspace, findings));
  }
  return findings;
}

/** How `.specbridge/config.json` relates to the current schema. */
export interface ConfigMigrationInspection {
  status: 'missing' | 'invalid' | 'current' | 'migratable';
  problems: string[];
  step?: MigrationFileStep;
}

/**
 * Inspect the configuration for the one real historical migration
 * (config v1 `agent-config 1.0.0` → v2 `runner-config 2.0.0`). Every other
 * persisted schema has been 1.0.0 since its introduction, so no other
 * migration exists. Pure: reads bytes, writes nothing.
 */
export function inspectConfigMigration(workspace: WorkspaceInfo): ConfigMigrationInspection {
  const configPath = path.join(workspace.sidecarDir, 'config.json');
  if (!existsSync(configPath)) return { status: 'missing', problems: [] };
  const bytes = readFileSync(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    return {
      status: 'invalid',
      problems: [
        `.specbridge/config.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    };
  }
  const planned = planConfigMigration(raw);
  if (planned.kind === 'invalid') return { status: 'invalid', problems: planned.problems };
  if (planned.kind === 'already-current') return { status: 'current', problems: [] };
  return {
    status: 'migratable',
    problems: [],
    step: {
      stepId: 'config-v1-to-v2',
      family: 'config',
      file: '.specbridge/config.json',
      fromVersion: planned.plan.fromVersion,
      toVersion: planned.plan.toVersion,
      changes: planned.plan.changes,
      warnings: planned.plan.warnings,
      beforeSha256: sha256Hex(bytes),
      content: `${JSON.stringify(planned.plan.migrated, null, 2)}\n`,
    },
  };
}

/**
 * Every migration step the workspace currently needs. Today that is only the
 * explicit config v1 → v2 rewrite; an invalid configuration produces no step
 * (it is surfaced as a finding instead — migration never guesses).
 */
export function collectMigrationSteps(workspace: WorkspaceInfo): MigrationFileStep[] {
  const inspection = inspectConfigMigration(workspace);
  return inspection.step !== undefined ? [inspection.step] : [];
}

/**
 * Turn the findings' recovery proposals into concrete, hash-bound recovery
 * actions in deterministic order (family, then path; ids `a1`..`aN`).
 * Proposals whose file vanished since the scan are dropped. Pure: writes
 * nothing — `state recover --plan` persists the plan, `--apply` executes it.
 */
export function buildRecoveryActions(
  workspace: WorkspaceInfo,
  findings?: readonly StateFinding[],
): RecoveryAction[] {
  const source = findings ?? collectStateFindings(workspace);
  const proposals = source
    .filter((candidate) => candidate.recovery !== undefined)
    .sort(
      (a, b) => a.family.localeCompare(b.family, 'en') || a.path.localeCompare(b.path, 'en'),
    );
  const actions: RecoveryAction[] = [];
  for (const proposal of proposals) {
    const recovery = proposal.recovery as StateFindingRecovery;
    const absolute = toAbs(workspace, proposal.path);
    if (recovery.kind === 'restore-from-migration-backup') {
      if (recovery.backupPath === undefined) continue;
      const backupSha256 = trySha256File(toAbs(workspace, recovery.backupPath));
      if (backupSha256 === undefined) continue;
      actions.push({
        actionId: `a${actions.length + 1}`,
        kind: recovery.kind,
        reason: recovery.reason,
        risk: recovery.risk,
        file: proposal.path,
        sha256: trySha256File(absolute) ?? null,
        backupPath: recovery.backupPath,
        backupSha256,
        reversible: true,
        confidence: recovery.confidence,
        requiresAcknowledgement: true,
      });
      continue;
    }
    const sha256 = trySha256File(absolute);
    if (sha256 === undefined) continue;
    actions.push({
      actionId: `a${actions.length + 1}`,
      kind: recovery.kind,
      reason: recovery.reason,
      risk: recovery.risk,
      file: proposal.path,
      sha256,
      reversible: true,
      confidence: recovery.confidence,
      requiresAcknowledgement: true,
    });
  }
  return actions;
}
