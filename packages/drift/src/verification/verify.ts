import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { discoverSpecs, requireSpec } from '@specbridge/compat-kiro';
import type {
  ExtensionVerifierHook,
  ExtensionVerifierReportEntry,
  FailOnThreshold,
  ReportChangedFile,
  SelectionMode,
  SpecEvidenceSummary,
  SpecTraceabilitySummary,
  SpecVerificationResult,
  VerificationCommandReport,
  VerificationDiagnostic,
  VerificationReport,
  WorkspaceInfo,
} from '@specbridge/core';
import {
  SpecBridgeError,
  VERIFICATION_DIAGNOSTIC_SCHEMA_VERSION,
  VERIFICATION_REPORT_SCHEMA_VERSION,
  countDiagnostics,
  reachesFailureThreshold,
  readAgentConfig,
  sortVerificationDiagnostics,
  verificationReportSchema,
  writeFileAtomic,
} from '@specbridge/core';
import type { EvidenceAssessment } from '@specbridge/evidence';
import type { AffectedSpecsResult } from './affected.js';
import { resolveAffectedSpecs } from './affected.js';
import type { OrchestratedCommands } from './commands.js';
import { orchestrateVerificationCommands } from './commands.js';
import type { ComparisonChangedFile, ComparisonRequest, ResolvedComparison } from './comparison.js';
import { resolveComparison } from './comparison.js';
import type { GlobalVerificationContext, SpecVerificationContext } from './context.js';
import { buildSpecVerificationContext, createRunCaches } from './context.js';
import { evaluateGlobalRules, evaluateSpecRules } from './rule-engine.js';
import { builtInVerificationRules } from './rules.js';

/**
 * Verification orchestration: resolve the comparison, select specs, build
 * contexts (each spec parsed once), orchestrate trusted commands, evaluate
 * the rule engine, and assemble a schema-validated report.
 *
 * Read-only guarantee: the only writes this module ever performs are
 * verification artifacts (command logs and report.json) under the caller's
 * reports directory — and only when commands actually execute. Spec content,
 * approval state, task state, and evidence are never touched.
 */

export type VerifySelection =
  | { mode: 'single'; spec: string }
  | { mode: 'changed' }
  | { mode: 'all' };

export interface VerifySpecsRequest {
  workspace: WorkspaceInfo;
  selection: VerifySelection;
  comparison: ComparisonRequest;
  /** CLI tri-state: true = run all configured, false = never run, undefined = auto. */
  runVerification?: boolean;
  strict?: boolean;
  failOn: FailOnThreshold;
  explicitPolicyPath?: string;
  toolVersion: string;
  /**
   * Absolute directory for verification artifacts. `<dir>/<verificationId>/`
   * is created only when trusted commands execute (command logs plus
   * report.json); a run without command execution writes nothing.
   */
  reportsDir?: string;
  /**
   * When false, no artifacts are written at all — command logs and
   * report.json are skipped even when commands execute. Used by MCP callers
   * whose persistence is an explicit opt-in. Default true (CLI behavior
   * unchanged).
   */
  persistArtifacts?: boolean;
  clock?: () => Date;
  idFactory?: () => string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /**
   * v0.7.1: injected runner for policy-configured extension verifiers.
   * Supplied by the CLI (backed by @specbridge/extensions); the verification
   * engine itself stays extension-free. When absent, extension verifier
   * policy entries are reported as unavailable through SBV026 so a required
   * verifier can never be silently skipped.
   */
  extensionVerifiers?: ExtensionVerifierHook;
}

export interface VerifySpecsResult {
  report: VerificationReport;
  exitCode: number;
  /** Created artifacts directory, when commands executed. */
  artifactsDir?: string;
}

/** Exit codes for `spec verify` (documented in docs/ci-quality-gates.md). */
export const VERIFY_EXIT_CODES = {
  passed: 0,
  thresholdReached: 1,
  invalidInput: 2,
  comparisonUnavailable: 3,
  commandFailedToStart: 4,
  commandTimeout: 5,
} as const;

export async function verifySpecs(request: VerifySpecsRequest): Promise<VerifySpecsResult> {
  const now = (request.clock ?? ((): Date => new Date()))();
  const verificationId = (request.idFactory ?? randomUUID)();
  const workspace = request.workspace;

  const configRead = readAgentConfig(workspace);
  if (configRead.config === undefined) {
    // Fail-closed: an invalid trusted-command configuration is a setup error.
    throw new SpecBridgeError(
      'INVALID_STATE',
      `Cannot verify: ${configRead.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
    );
  }
  const config = configRead.config;

  request.onProgress?.(`Resolving comparison (${describeComparison(request.comparison)})…`);
  const comparison = await resolveComparison(workspace.rootDir, request.comparison, {
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });

  // ---- Spec selection -------------------------------------------------------
  const caches = createRunCaches();
  const selectionMode: SelectionMode = request.selection.mode;
  let affectedResult: AffectedSpecsResult = { affected: [], unmapped: [], ambiguous: [] };
  const specContexts: SpecVerificationContext[] = [];

  if (comparison.ok) {
    if (selectionMode !== 'single') {
      affectedResult = resolveAffectedSpecs(workspace, comparison.changedFiles, {
        ...(request.strict !== undefined ? { strict: request.strict } : {}),
      });
    }

    const selectedFolders =
      request.selection.mode === 'single'
        ? [requireSpec(workspace, request.selection.spec)]
        : request.selection.mode === 'all'
          ? discoverSpecs(workspace)
          : discoverSpecs(workspace).filter((folder) =>
              affectedResult.affected.some((spec) => spec.specName === folder.name),
            );

    for (const folder of selectedFolders) {
      request.onProgress?.(`Analyzing spec ${folder.name}…`);
      const matchedBy = affectedResult.affected
        .find((spec) => spec.specName === folder.name)
        ?.matches.flatMap((match) => match.via.map((via) => `${via}: ${match.file}`));
      specContexts.push(
        await buildSpecVerificationContext({
          workspace,
          folder,
          config,
          comparison,
          selectionMode,
          caches,
          ...(request.strict !== undefined ? { strict: request.strict } : {}),
          ...(request.explicitPolicyPath !== undefined
            ? { explicitPolicyPath: request.explicitPolicyPath }
            : {}),
          ...(matchedBy !== undefined ? { matchedBy: dedupe(matchedBy) } : {}),
          now,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        }),
      );
    }
  }

  // ---- Trusted verification commands ---------------------------------------
  const persistArtifacts = request.persistArtifacts !== false;
  let artifactsDir: string | undefined;
  const ensureArtifactsDir = (): string => {
    if (artifactsDir === undefined) {
      const base = request.reportsDir ?? path.join(workspace.sidecarDir, 'reports');
      artifactsDir = path.join(base, verificationId);
    }
    return artifactsDir;
  };

  const requiredBySpec = new Map<string, string[]>();
  const evidenceBySpec = new Map<string, readonly EvidenceAssessment[]>();
  for (const context of specContexts) {
    requiredBySpec.set(context.specName, context.policy.requiredVerificationCommands);
    evidenceBySpec.set(context.specName, context.evidence.flattened);
  }

  const commands: OrchestratedCommands = comparison.ok
    ? await orchestrateVerificationCommands({
        config,
        requiredBySpec,
        runVerification: request.runVerification,
        workspaceRoot: workspace.rootDir,
        ...(comparison.descriptor.headSha !== null
          ? { headSha: comparison.descriptor.headSha }
          : {}),
        evidenceBySpec,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        ...(request.onProgress !== undefined ? { onProgress: request.onProgress } : {}),
        ...(persistArtifacts
          ? {
              onCommandFinished: (
                result: { name: string },
                stdout: string,
                stderr: string,
              ): void => {
                const dir = ensureArtifactsDir();
                const safeName = result.name.replace(/[^A-Za-z0-9._-]+/g, '-');
                writeFileAtomic(path.join(dir, 'commands', `${safeName}.stdout.log`), stdout);
                writeFileAtomic(path.join(dir, 'commands', `${safeName}.stderr.log`), stderr);
              },
            }
          : {}),
      })
    : { mode: 'none', commands: [], missingRequired: [] };

  // ---- Rule evaluation ------------------------------------------------------
  const rules = builtInVerificationRules();
  const diagnosticsBySpec = new Map<string, VerificationDiagnostic[]>();
  for (const context of specContexts) {
    const { diagnostics } = await evaluateSpecRules(rules, context);
    diagnosticsBySpec.set(context.specName, diagnostics);
  }

  const globalContext: GlobalVerificationContext = {
    workspace,
    comparison,
    selection: { mode: selectionMode },
    specContexts,
    unmappedFiles: affectedResult.unmapped,
    ambiguousFiles: affectedResult.ambiguous,
    commands,
    now,
  };
  const globalResult = await evaluateGlobalRules(rules, globalContext);

  // Global-rule diagnostics that name a selected spec are reported with it.
  const selectedNames = new Set(specContexts.map((context) => context.specName));
  const globalDiagnostics: VerificationDiagnostic[] = [];
  for (const diagnostic of globalResult.diagnostics) {
    if (diagnostic.specName !== null && selectedNames.has(diagnostic.specName)) {
      diagnosticsBySpec.get(diagnostic.specName)?.push(diagnostic);
    } else {
      globalDiagnostics.push(diagnostic);
    }
  }

  // ---- Extension verifiers (v0.7.1) ----------------------------------------
  // Explicit policy opt-ins, executed out of process via the injected hook.
  // Extension results feed the gate only through the SBV026 rollup below —
  // built-in rules (including protected-path checks) already ran and cannot
  // be altered from here.
  const extensionVerifierResults: ExtensionVerifierReportEntry[] = [];
  let extensionVerifiersConfigured = false;
  for (const context of specContexts) {
    const entries = context.policy.extensionVerifiers;
    if (entries.length === 0) {
      continue;
    }
    extensionVerifiersConfigured = true;
    const changedFiles = (
      selectionMode === 'single' ? context.changedFiles : context.specChangedFiles
    ).map((file) => ({ path: file.path, changeType: file.changeType }));

    let entryResults: ExtensionVerifierReportEntry[];
    if (request.extensionVerifiers === undefined) {
      entryResults = entries.map((entry) => ({
        extensionId: entry.extension,
        extensionVersion: 'unknown',
        specName: context.specName,
        required: entry.required,
        status: 'error',
        summary: 'no extension verifier runner is available in this verification context',
        durationMs: 0,
        diagnostics: [],
      }));
    } else {
      try {
        entryResults = await request.extensionVerifiers({
          specName: context.specName,
          entries,
          changedFiles,
        });
      } catch (cause) {
        // The hook contract says it never throws; treat a throw as a crash of
        // every configured verifier rather than of SpecBridge.
        entryResults = entries.map((entry) => ({
          extensionId: entry.extension,
          extensionVersion: 'unknown',
          specName: context.specName,
          required: entry.required,
          status: 'error',
          summary: cause instanceof Error ? cause.message : String(cause),
          durationMs: 0,
          diagnostics: [],
        }));
      }
    }

    const sbv026Override = context.policy.ruleOverrides['SBV026'];
    for (const entryResult of entryResults) {
      extensionVerifierResults.push(entryResult);
      const problem = entryResult.status === 'failed' || entryResult.status === 'error';
      const warningStatus = entryResult.status === 'warning';
      if ((!problem && !warningStatus) || sbv026Override?.enabled === false) {
        continue;
      }
      const severity: 'error' | 'warning' =
        entryResult.required && problem
          ? (sbv026Override?.severity === 'warning' ? 'warning' : 'error')
          : 'warning';
      diagnosticsBySpec.get(context.specName)?.push({
        schemaVersion: VERIFICATION_DIAGNOSTIC_SCHEMA_VERSION,
        ruleId: 'SBV026',
        title: 'Extension verifier reported failure',
        severity,
        category: 'verification-command',
        message:
          `Extension verifier "${entryResult.extensionId}" (${entryResult.required ? 'required' : 'optional'}) ` +
          `reported ${entryResult.status}` +
          (entryResult.summary !== null ? `: ${entryResult.summary}` : '.'),
        remediation:
          'See the extensionVerifiers section of the report for the extension diagnostics, or run ' +
          `\`specbridge extension doctor ${entryResult.extensionId}\` if the extension could not run.`,
        specName: context.specName,
        taskId: null,
        requirementId: null,
        file: null,
        evidence: {
          extensionId: entryResult.extensionId,
          extensionVersion: entryResult.extensionVersion,
          status: entryResult.status,
          required: entryResult.required,
          diagnosticCount: entryResult.diagnostics.length,
        },
        confidence: 'deterministic',
      });
    }
  }

  // ---- Report assembly ------------------------------------------------------
  const specResults: SpecVerificationResult[] = specContexts.map((context) => {
    const diagnostics = sortVerificationDiagnostics(diagnosticsBySpec.get(context.specName) ?? []);
    const counts = countDiagnostics(diagnostics);
    const files = selectionMode === 'single' ? context.changedFiles : context.specChangedFiles;
    return {
      specName: context.specName,
      specType: context.spec.state?.specType ?? context.spec.classification.type,
      workflowMode: context.spec.state?.workflowMode ?? 'unknown',
      managed: context.spec.state !== undefined,
      result: reachesFailureThreshold(counts, request.failOn) ? 'failed' : 'passed',
      policyMode: context.policy.mode,
      policyPath: context.policy.policyExists ? (context.policy.policyPath ?? null) : null,
      matchedBy: context.matchedBy,
      changedFiles: files.map(toReportChangedFile),
      traceability: traceabilitySummary(context),
      evidence: evidenceSummary(context),
      diagnostics,
    };
  });

  const sortedGlobal = sortVerificationDiagnostics(globalDiagnostics);
  const allDiagnostics = [...sortedGlobal, ...specResults.flatMap((spec) => spec.diagnostics)];
  const totals = countDiagnostics(allDiagnostics);
  const failed = reachesFailureThreshold(totals, request.failOn);

  const report: VerificationReport = {
    schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
    tool: { name: 'specbridge', version: request.toolVersion },
    verificationId,
    createdAt: now.toISOString(),
    comparison: comparison.descriptor,
    selection: {
      mode: selectionMode,
      specs: specContexts.map((context) => context.specName),
    },
    summary: {
      result: failed || !comparison.ok ? 'failed' : 'passed',
      specsVerified: specContexts.length,
      errors: totals.errors,
      warnings: totals.warnings,
      info: totals.info,
    },
    specResults,
    globalDiagnostics: sortedGlobal,
    verificationCommands: commands.commands.map(toCommandReport),
    ...(extensionVerifiersConfigured ? { extensionVerifiers: extensionVerifierResults } : {}),
  };

  // Never emit an invalid report — validate before anything leaves this module.
  verificationReportSchema.parse(report);

  if (persistArtifacts && artifactsDir !== undefined) {
    writeFileAtomic(
      path.join(artifactsDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }

  return {
    report,
    exitCode: resolveExitCode(report, comparison, commands, request.failOn),
    ...(artifactsDir !== undefined ? { artifactsDir } : {}),
  };
}

function describeComparison(request: ComparisonRequest): string {
  if (request.mode === 'diff') return `${request.base}...${request.head}`;
  return request.mode;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function toReportChangedFile(file: ComparisonChangedFile): ReportChangedFile {
  return {
    path: file.path,
    oldPath: file.oldPath ?? null,
    changeType: file.changeType,
    binary: file.binary,
    insertions: file.insertions ?? null,
    deletions: file.deletions ?? null,
  };
}

function toCommandReport(
  command: OrchestratedCommands['commands'][number],
): VerificationCommandReport {
  return {
    name: command.name,
    argv: command.argv,
    required: command.required,
    disposition: command.disposition,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    timedOut: command.timedOut,
    passed: command.passed,
    requiredBySpecs: command.requiredBySpecs,
  };
}

function traceabilitySummary(context: SpecVerificationContext): SpecTraceabilitySummary {
  const { catalog, references } = context.traceability;
  const referenced = new Set(
    references
      .map((reference) => reference.canonical)
      .filter((canonical): canonical is string => canonical !== undefined),
  );
  let requirementsWithTasks = 0;
  for (const requirement of catalog.requirements) {
    let covered = false;
    for (const canonical of referenced) {
      if (
        canonical === requirement.canonical ||
        catalog.byCanonical.get(canonical)?.requirementCanonical === requirement.canonical
      ) {
        covered = true;
        break;
      }
    }
    if (covered) requirementsWithTasks += 1;
  }
  const tasks = context.spec.tasks?.allTasks ?? [];
  const tasksWithReferences = new Set(references.map((reference) => reference.taskId));
  return {
    requirements: catalog.requirements.length,
    requirementsWithTasks,
    tasks: tasks.length,
    tasksWithRequirements: tasks.filter((task) => tasksWithReferences.has(task.id)).length,
  };
}

function evidenceSummary(context: SpecVerificationContext): SpecEvidenceSummary {
  const summary = { valid: 0, stale: 0, missing: 0, invalid: 0, manuallyAccepted: 0 };
  const model = context.spec.tasks;
  if (model === undefined) return summary;
  for (const task of model.allTasks) {
    if (task.children.length > 0 || task.state !== 'done') continue;
    const assessment = context.evidence.assessmentsByTask.get(task.id);
    if (assessment === undefined || assessment.bucket === 'missing') {
      summary.missing += 1;
    } else if (assessment.bucket === 'valid') {
      summary.valid += 1;
      if (assessment.best?.manual === true) summary.manuallyAccepted += 1;
    } else if (assessment.bucket === 'stale') {
      summary.stale += 1;
    } else {
      summary.invalid += 1;
    }
  }
  summary.invalid += context.evidence.invalidRecordCount;
  return summary;
}

function resolveExitCode(
  report: VerificationReport,
  comparison: ResolvedComparison,
  commands: OrchestratedCommands,
  failOn: FailOnThreshold,
): number {
  if (!comparison.ok) return VERIFY_EXIT_CODES.comparisonUnavailable;

  const allDiagnostics = [
    ...report.globalDiagnostics,
    ...report.specResults.flatMap((spec) => spec.diagnostics),
  ];
  // An invalid policy is a setup error (exit 2), not a mere finding.
  if (allDiagnostics.some((diagnostic) => diagnostic.ruleId === 'SBV020')) {
    return VERIFY_EXIT_CODES.invalidInput;
  }
  const requiredSpawnFailed = commands.commands.some(
    (command) => command.required && command.spawnFailed,
  );
  if (requiredSpawnFailed) return VERIFY_EXIT_CODES.commandFailedToStart;
  const requiredTimedOut = commands.commands.some(
    (command) => command.required && command.timedOut,
  );
  if (requiredTimedOut) return VERIFY_EXIT_CODES.commandTimeout;

  const counts = countDiagnostics(allDiagnostics);
  return reachesFailureThreshold(counts, failOn)
    ? VERIFY_EXIT_CODES.thresholdReached
    : VERIFY_EXIT_CODES.passed;
}
