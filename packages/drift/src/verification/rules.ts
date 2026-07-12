import { existsSync } from 'node:fs';
import path from 'node:path';
import { MarkdownDocument, normalizedTaskPlanText } from '@specbridge/compat-kiro';
import type { TaskItem } from '@specbridge/compat-kiro';
import { isLikelyNonRequirementTask, taskMentionsTests } from '@specbridge/compat-kiro';
import type { VerificationDiagnostic, WorkspaceInfo } from '@specbridge/core';
import type { EvidenceReasonCode } from '@specbridge/evidence';
import type { SpecVerificationContext } from './context.js';
import type {
  GlobalVerificationRule,
  ResolvedRuleConfig,
  SpecVerificationRule,
  VerificationRule,
} from './rule-engine.js';
import { makeDiagnostic } from './rule-engine.js';
import { IMMUTABLE_PROTECTED_PATHS, compilePathMatchers } from './policy.js';

/**
 * Built-in verification rules SBV001–SBV025.
 *
 * The registry at the bottom of this file is the single source of truth for
 * rule IDs. IDs are stable: rules are never silently renumbered, and removed
 * rules would leave a documented gap rather than shifting later IDs.
 */

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function repoRelative(workspace: WorkspaceInfo, absolutePath: string): string {
  return path.relative(workspace.rootDir, absolutePath).split(path.sep).join('/');
}

/** Paths that are workflow/VCS infrastructure, never implementation. */
function isSpecInfraPath(candidate: string): boolean {
  return (
    candidate === '.git' ||
    candidate.startsWith('.git/') ||
    candidate.startsWith('.kiro/') ||
    candidate.startsWith('.specbridge/')
  );
}

function doneLeafTasks(context: SpecVerificationContext): TaskItem[] {
  const model = context.spec.tasks;
  if (model === undefined) return [];
  return model.allTasks.filter((task) => task.children.length === 0 && task.state === 'done');
}

function tasksFilePath(context: SpecVerificationContext): string | undefined {
  const filePath = context.spec.documents.tasks?.filePath;
  return filePath !== undefined ? repoRelative(context.workspace, filePath) : undefined;
}

function taskFileLocation(
  context: SpecVerificationContext,
  task: Pick<TaskItem, 'line'>,
): { path: string; line: number } | null {
  const filePath = tasksFilePath(context);
  return filePath !== undefined ? { path: filePath, line: task.line + 1 } : null;
}

/** The selected spec's own workflow files (exempt from SBV006 by design). */
function ownWorkflowPaths(specName: string, candidate: string): boolean {
  return (
    candidate.startsWith(`.kiro/specs/${specName}/`) ||
    candidate === `.specbridge/state/specs/${specName}.json` ||
    candidate === `.specbridge/policies/${specName}.json`
  );
}

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i;
const TEST_COMMAND_PATTERN = /test/i;

/* ------------------------------------------------------------------ *
 * SBV001 — Required spec file missing
 * ------------------------------------------------------------------ */

const sbv001: SpecVerificationRule = {
  id: 'SBV001',
  title: 'Required spec file missing',
  category: 'workspace',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'A feature spec is missing requirements.md, design.md, or tasks.md, or a bugfix spec is missing bugfix.md, design.md, or tasks.md.',
  resolution:
    'Create the missing document (specbridge spec new scaffolds Kiro-compatible files), or remove the incomplete spec folder.',
  evaluate(context, resolved) {
    const type = context.spec.classification.type;
    if (type !== 'feature' && type !== 'bugfix') return [];
    const required =
      type === 'bugfix'
        ? ['bugfix.md', 'design.md', 'tasks.md']
        : ['requirements.md', 'design.md', 'tasks.md'];
    const present = new Set(context.spec.folder.files.map((file) => file.fileName.toLowerCase()));
    return required
      .filter((fileName) => !present.has(fileName))
      .map((fileName) =>
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `The ${type} spec "${context.specName}" is missing ${fileName}.`,
          specName: context.specName,
          file: { path: `.kiro/specs/${context.specName}/${fileName}` },
          evidence: { specType: type, missingFile: fileName },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV002 — Spec approval stale
 * ------------------------------------------------------------------ */

const sbv002: SpecVerificationRule = {
  id: 'SBV002',
  title: 'Spec approval stale',
  category: 'approval',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'An approved stage document no longer matches its recorded approval hash. For the tasks stage, checkbox-only progress is NOT stale (hash semantics v2); any other byte change is.',
  resolution:
    'Review the changed document and re-approve the stage (specbridge spec approve <name> --stage <stage>), or restore the approved content.',
  evaluate(context, resolved) {
    if (context.evaluation === undefined) return [];
    return context.evaluation.stages
      .filter((stage) => stage.effective === 'modified-after-approval')
      .map((stage) =>
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `The approved ${stage.stage} stage of "${context.specName}" changed after approval (approved hash ${stage.stored.approvedHash?.slice(0, 12) ?? '(none)'}…, current ${stage.currentHash?.slice(0, 12) ?? 'missing'}…).`,
          specName: context.specName,
          file: { path: stage.stored.file },
          evidence: {
            stage: stage.stage,
            approvedHash: stage.stored.approvedHash,
            currentHash: stage.currentHash ?? null,
            approvedAt: stage.stored.approvedAt,
          },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV003 — Approval prerequisite invalid
 * ------------------------------------------------------------------ */

const sbv003: SpecVerificationRule = {
  id: 'SBV003',
  title: 'Approval prerequisite invalid',
  category: 'approval',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'A later-stage approval depends on an earlier stage that is stale, revoked, or was never approved.',
  resolution:
    'Re-approve the earlier stage first, then re-approve the dependent stage — approvals form a chain.',
  evaluate(context, resolved) {
    if (context.evaluation === undefined) return [];
    const diagnostics: VerificationDiagnostic[] = [];
    for (const stage of context.evaluation.stages) {
      if (stage.stored.status !== 'approved') continue;
      if (stage.effective === 'stale-prerequisite') {
        diagnostics.push(
          makeDiagnostic({
            rule: this,
            severity: resolved.severity,
            message: `The ${stage.stage} approval of "${context.specName}" is invalid because an earlier stage changed after it was approved.`,
            specName: context.specName,
            file: { path: stage.stored.file },
            evidence: { stage: stage.stage, prerequisites: stage.prerequisites },
          }),
        );
        continue;
      }
      const unapproved = stage.prerequisites.filter((prerequisite) => {
        const evaluation = context.evaluation?.stages.find((s) => s.stage === prerequisite);
        return evaluation !== undefined && evaluation.stored.status !== 'approved';
      });
      if (unapproved.length > 0) {
        diagnostics.push(
          makeDiagnostic({
            rule: this,
            severity: resolved.severity,
            message: `The ${stage.stage} stage of "${context.specName}" is approved although ${unapproved.join(' and ')} ${unapproved.length === 1 ? 'is' : 'are'} not.`,
            specName: context.specName,
            file: { path: stage.stored.file },
            evidence: { stage: stage.stage, unapprovedPrerequisites: unapproved },
          }),
        );
      }
    }
    return diagnostics;
  },
};

/* ------------------------------------------------------------------ *
 * SBV004 — Completed task lacks verified evidence
 * ------------------------------------------------------------------ */

const sbv004: SpecVerificationRule = {
  id: 'SBV004',
  title: 'Completed task lacks verified evidence',
  category: 'evidence',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'A task checkbox is [x] but no verified or manually accepted evidence record exists for it. Error severity when the policy sets requireVerifiedTaskEvidence.',
  resolution:
    'Run the task through specbridge spec run (which records evidence), accept it explicitly with specbridge spec accept-task, or uncheck the box.',
  evaluate(context, resolved) {
    const severity = context.policy.requireVerifiedTaskEvidence ? 'error' : resolved.severity;
    return doneLeafTasks(context)
      .filter((task) => {
        const assessment = context.evidence.assessmentsByTask.get(task.id);
        // Stale evidence is reported separately (SBV011/SBV015); structurally
        // invalid records are not usable evidence and count as absent here.
        return (
          assessment === undefined ||
          assessment.bucket === 'missing' ||
          assessment.bucket === 'invalid'
        );
      })
      .map((task) => {
        const assessment = context.evidence.assessmentsByTask.get(task.id);
        const invalidOnly = assessment?.bucket === 'invalid';
        return makeDiagnostic({
          rule: this,
          severity,
          message: invalidOnly
            ? `Task ${task.id} ("${task.title}") is checked but its only evidence records are structurally invalid.`
            : `Task ${task.id} ("${task.title}") is checked but has no verified or manually accepted evidence.`,
          specName: context.specName,
          taskId: task.id,
          file: taskFileLocation(context, task),
          evidence: {
            evidenceRequired: context.policy.requireVerifiedTaskEvidence,
            checkboxState: task.stateChar,
            invalidRecordsOnly: invalidOnly,
          },
        });
      });
  },
};

/* ------------------------------------------------------------------ *
 * SBV005 — Changed file outside declared impact area
 * ------------------------------------------------------------------ */

const sbv005: SpecVerificationRule = {
  id: 'SBV005',
  title: 'Changed file outside declared impact area',
  category: 'impact-area',
  defaultSeverity: { advisory: 'warning', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'Verifying a single named spec whose policy declares impact areas: a changed repository file matches none of them. (In --changed/--all runs, cross-spec coverage is reported by SBV014 instead.)',
  resolution:
    'Revert the unrelated change, split it into its own change set, or extend the impact areas in the spec verification policy after review.',
  evaluate(context, resolved) {
    if (context.selectionMode !== 'single') return [];
    if (context.policy.impactAreas.length === 0) return [];
    const matcher = compilePathMatchers(context.policy.impactAreas);
    return context.changedFiles
      .filter((file) => !isSpecInfraPath(file.path))
      .filter((file) => matcher(file.path).length === 0)
      .map((file) =>
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `${file.path} is outside the impact areas declared for ${context.specName}.`,
          specName: context.specName,
          file: { path: file.path },
          evidence: {
            changedPath: file.path,
            changeType: file.changeType,
            declaredImpactAreas: context.policy.impactAreas,
          },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV006 — Protected path modified
 * ------------------------------------------------------------------ */

const sbv006: GlobalVerificationRule = {
  id: 'SBV006',
  title: 'Protected path modified',
  category: 'protected-path',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'global',
  triggeredWhen:
    'The comparison touches a protected path (.kiro/**, .specbridge/state/**, .specbridge/config.json, .git/**, or configured additions). The verified specs’ own spec files, sidecar state, and policy are exempt — changing them is spec authoring, which the approval rules govern — and checkbox-only tasks.md progress is always exempt.',
  resolution:
    'Remove the protected-path change from this change set, or — if this is deliberate spec authoring for a spec not under verification — verify that spec too.',
  async evaluate(context, resolved) {
    if (!context.comparison.ok) return [];
    const selectedSpecs = context.specContexts.map((spec) => spec.specName);
    const patterns = new Set<string>();
    for (const spec of context.specContexts) {
      for (const pattern of spec.policy.protectedPaths) patterns.add(pattern);
    }
    if (patterns.size === 0) {
      for (const pattern of ['.kiro/**', '.specbridge/state/**', '.specbridge/config.json', '.git/**']) {
        patterns.add(pattern);
      }
    }
    const matcher = compilePathMatchers([...patterns]);
    const immutableMatcher = compilePathMatchers([...IMMUTABLE_PROTECTED_PATHS]);

    const diagnostics: VerificationDiagnostic[] = [];
    for (const file of context.comparison.changedFiles) {
      const matched = matcher(file.path);
      if (matched.length === 0) continue;

      const owningSpec = selectedSpecs.find((specName) => ownWorkflowPaths(specName, file.path));
      if (owningSpec !== undefined) {
        // Spec authoring of a spec under verification: sanctioned, but for a
        // modified tasks.md distinguish checkbox progress from plan edits
        // (plan edits are separately flagged by SBV023).
        let note = 'spec-authoring change of a verified spec';
        if (
          file.path === `.kiro/specs/${owningSpec}/tasks.md` &&
          (file.changeType === 'modified' || file.changeType === 'renamed')
        ) {
          const specContext = context.specContexts.find((spec) => spec.specName === owningSpec);
          const checkboxOnly =
            specContext !== undefined ? await isCheckboxOnlyChange(specContext, file.path) : false;
          note = checkboxOnly
            ? 'checkbox-only task progress (expected)'
            : 'task plan edited (see SBV023)';
        }
        diagnostics.push(
          makeDiagnostic({
            rule: this,
            severity: 'info',
            message: `${file.path} changed — ${note}.`,
            specName: owningSpec,
            file: { path: file.path },
            evidence: { matchedPatterns: matched, exempt: true, note },
          }),
        );
        continue;
      }

      const severity = immutableMatcher(file.path).length > 0 ? 'error' : resolved.severity;
      diagnostics.push(
        makeDiagnostic({
          rule: this,
          severity,
          message: `Protected path ${file.path} was ${file.changeType === 'deleted' ? 'deleted' : 'modified'} by this change set.`,
          file: { path: file.path },
          evidence: {
            matchedPatterns: matched,
            changeType: file.changeType,
            selectedSpecs,
          },
        }),
      );
    }
    return diagnostics;
  },
};

async function isCheckboxOnlyChange(
  context: SpecVerificationContext,
  repoPath: string,
): Promise<boolean> {
  const baseContent = await context.readBaseContent(repoPath);
  if (baseContent === undefined) return false;
  const currentDocument = context.spec.documents.tasks;
  if (currentDocument === undefined) return false;
  const baseDocument = MarkdownDocument.fromText(baseContent);
  return normalizedTaskPlanText(baseDocument) === normalizedTaskPlanText(currentDocument);
}

/* ------------------------------------------------------------------ *
 * SBV007 — Requirement has no implementation task
 * ------------------------------------------------------------------ */

const sbv007: SpecVerificationRule = {
  id: 'SBV007',
  title: 'Requirement has no implementation task',
  category: 'requirements',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'An identifiable requirement ID is referenced by no task — neither directly nor through any of its acceptance criteria. Error severity when the policy sets requireRequirementTaskLinks.',
  resolution:
    'Add an implementation task referencing the requirement (e.g. a _Requirements: 1.2_ detail line), or remove the requirement if it is obsolete.',
  evaluate(context, resolved) {
    const { catalog, references } = context.traceability;
    if (catalog.requirements.length === 0 || context.spec.tasks === undefined) return [];
    const severity = context.policy.requireRequirementTaskLinks ? 'error' : resolved.severity;
    const referenced = new Set(
      references
        .map((reference) => reference.canonical)
        .filter((canonical): canonical is string => canonical !== undefined),
    );
    const requirementsFile = context.spec.documents.requirements?.filePath;
    const filePath =
      requirementsFile !== undefined ? repoRelative(context.workspace, requirementsFile) : undefined;

    return catalog.requirements
      .filter((requirement) => {
        for (const canonical of referenced) {
          if (canonical === requirement.canonical) return false;
          const entry = catalog.byCanonical.get(canonical);
          if (entry !== undefined && entry.requirementCanonical === requirement.canonical) {
            return false;
          }
        }
        return true;
      })
      .map((requirement) =>
        makeDiagnostic({
          rule: this,
          severity,
          message: `Requirement ${requirement.displayId}${requirement.title !== undefined ? ` ("${requirement.title}")` : ''} is not referenced by any task.`,
          specName: context.specName,
          requirementId: requirement.displayId,
          file: filePath !== undefined ? { path: filePath, line: requirement.line + 1 } : null,
          evidence: {
            canonicalId: requirement.canonical,
            criteria: catalog.entries
              .filter(
                (entry) =>
                  entry.kind === 'criterion' &&
                  entry.requirementCanonical === requirement.canonical,
              )
              .map((entry) => entry.displayId),
          },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV008 — Task has no requirement reference
 * ------------------------------------------------------------------ */

const sbv008: SpecVerificationRule = {
  id: 'SBV008',
  title: 'Task has no requirement reference',
  category: 'tasks',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'heuristic',
  scope: 'spec',
  triggeredWhen:
    'Requirement linking is in use in this tasks document, but a leaf implementation task carries no requirement reference. Clearly non-requirement work (documentation, release, cleanup chores) is excluded.',
  resolution:
    'Add a _Requirements: …_ detail line to the task, or leave it unlinked deliberately if it is supporting work.',
  evaluate(context, resolved) {
    const model = context.spec.tasks;
    if (model === undefined) return [];
    const { references, catalog } = context.traceability;
    if (references.length === 0 || catalog.requirements.length === 0) return [];
    const tasksWithReferences = new Set(references.map((reference) => reference.taskId));

    return model.allTasks
      .filter(
        (task) =>
          task.children.length === 0 &&
          !tasksWithReferences.has(task.id) &&
          !isLikelyNonRequirementTask(task),
      )
      .map((task) =>
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `Task ${task.id} ("${task.title}") has no requirement reference while other tasks in this plan are linked.`,
          specName: context.specName,
          taskId: task.id,
          file: taskFileLocation(context, task),
          evidence: { linkedTasks: tasksWithReferences.size, totalTasks: model.allTasks.length },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV009 — Task references unknown requirement
 * ------------------------------------------------------------------ */

const sbv009: SpecVerificationRule = {
  id: 'SBV009',
  title: 'Task references unknown requirement',
  category: 'tasks',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'A task references a requirement or acceptance-criterion ID that does not exist in the requirements document. References recognized only heuristically (keyword phrases) warn instead of erroring.',
  resolution:
    'Fix the reference to point at an existing requirement ID, or add the missing requirement to requirements.md and re-approve it.',
  evaluate(context, resolved) {
    const { catalog, references } = context.traceability;
    if (catalog.entries.length === 0) return [];
    const filePath = tasksFilePath(context);
    return references
      .filter(
        (reference) =>
          reference.canonical === undefined || !catalog.byCanonical.has(reference.canonical),
      )
      .map((reference) =>
        makeDiagnostic({
          rule: this,
          severity: reference.confidence === 'heuristic' ? 'warning' : resolved.severity,
          message: `Task ${reference.taskId} references "${reference.raw}", which matches no requirement or acceptance criterion in requirements.md.`,
          specName: context.specName,
          taskId: reference.taskId,
          requirementId: reference.raw,
          file: filePath !== undefined ? { path: filePath, line: reference.line + 1 } : null,
          evidence: {
            reference: reference.raw,
            canonical: reference.canonical ?? null,
            method: reference.method,
            knownIds: catalog.entries.slice(0, 20).map((entry) => entry.displayId),
          },
          confidence: reference.confidence,
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV010 — Completed parent task has incomplete child task
 * ------------------------------------------------------------------ */

const sbv010: SpecVerificationRule = {
  id: 'SBV010',
  title: 'Completed parent task has incomplete child task',
  category: 'tasks',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen: 'A parent task checkbox is [x] while at least one of its subtasks is not.',
  resolution: 'Finish (or uncheck) the open subtasks, or uncheck the parent task.',
  evaluate(context, resolved) {
    const model = context.spec.tasks;
    if (model === undefined) return [];
    const diagnostics: VerificationDiagnostic[] = [];
    const openDescendants = (task: TaskItem): TaskItem[] => {
      const open: TaskItem[] = [];
      for (const child of task.children) {
        if (child.state !== 'done') open.push(child);
        open.push(...openDescendants(child));
      }
      return open;
    };
    for (const task of model.allTasks) {
      if (task.children.length === 0 || task.state !== 'done') continue;
      const open = openDescendants(task);
      if (open.length === 0) continue;
      diagnostics.push(
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `Parent task ${task.id} is checked but ${open.length} of its subtasks ${open.length === 1 ? 'is' : 'are'} not complete (${open.map((child) => child.id).join(', ')}).`,
          specName: context.specName,
          taskId: task.id,
          file: taskFileLocation(context, task),
          evidence: { incompleteChildren: open.map((child) => child.id) },
        }),
      );
    }
    return diagnostics;
  },
};

/* ------------------------------------------------------------------ *
 * SBV011 / SBV015 — evidence freshness rules
 * ------------------------------------------------------------------ */

const SBV011_CODES: ReadonlySet<EvidenceReasonCode> = new Set([
  'task-identity-changed',
  'task-missing',
  'history-diverged',
  'stage-not-approved',
]);
const SBV015_CODES: ReadonlySet<EvidenceReasonCode> = new Set([
  'document-hash-changed',
  'design-hash-changed',
  'plan-hash-changed',
  'approved-after-evidence',
]);

function staleEvidenceDiagnostics(
  rule: SpecVerificationRule,
  context: SpecVerificationContext,
  resolved: ResolvedRuleConfig,
  codes: ReadonlySet<EvidenceReasonCode>,
): VerificationDiagnostic[] {
  const diagnostics: VerificationDiagnostic[] = [];
  for (const task of doneLeafTasks(context)) {
    const assessment = context.evidence.assessmentsByTask.get(task.id);
    if (assessment === undefined || assessment.bucket !== 'stale') continue;
    const best = assessment.best;
    if (best === undefined) continue;
    const matching = best.reasons.filter((reason) => codes.has(reason.code));
    if (matching.length === 0) continue;
    diagnostics.push(
      makeDiagnostic({
        rule,
        severity: resolved.severity,
        message: `Task ${task.id} is checked but its evidence is stale: ${matching.map((reason) => reason.message).join('; ')}.`,
        specName: context.specName,
        taskId: task.id,
        file: taskFileLocation(context, task),
        evidence: {
          runId: best.record.runId,
          evidenceStatus: best.record.status,
          manualAcceptance: best.manual,
          reasons: matching.map((reason) => ({ code: reason.code, message: reason.message })),
          evaluatedAt: best.record.evaluatedAt,
        },
      }),
    );
  }
  return diagnostics;
}

const sbv011: SpecVerificationRule = {
  id: 'SBV011',
  title: 'Task evidence is stale',
  category: 'evidence',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'A checked task has evidence whose recorded task identity, commit lineage, or approval linkage no longer matches the repository (the task text changed, history diverged, or a referenced stage is no longer approved).',
  resolution:
    'Re-run the task (specbridge spec run) or re-accept it (specbridge spec accept-task) so fresh evidence is recorded, or uncheck the box.',
  evaluate(context, resolved) {
    return staleEvidenceDiagnostics(this, context, resolved, SBV011_CODES);
  },
};

const sbv015: SpecVerificationRule = {
  id: 'SBV015',
  title: 'Spec changed after implementation evidence',
  category: 'evidence',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'The requirements/bugfix document, design, or task plan changed (or was re-approved) after the evidence for a checked task was recorded — the implementation was verified against an older spec.',
  resolution:
    'Re-run or re-accept the affected tasks against the current spec so the evidence describes what is approved now.',
  evaluate(context, resolved) {
    return staleEvidenceDiagnostics(this, context, resolved, SBV015_CODES);
  },
};

/* ------------------------------------------------------------------ *
 * SBV012 / SBV013 / SBV025 — verification command rules
 * ------------------------------------------------------------------ */

const sbv012: GlobalVerificationRule = {
  id: 'SBV012',
  title: 'Required verification command failed',
  category: 'verification-command',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'global',
  triggeredWhen:
    'A trusted verification command required by a spec policy failed, could not start, or did not run in this verification with no reusable passing evidence.',
  resolution:
    'Fix the failing command locally, or run the verification with --run-verification so a current result is produced.',
  evaluate(context, resolved) {
    const diagnostics: VerificationDiagnostic[] = [];
    for (const command of context.commands.commands) {
      if (!command.required || command.passed || command.timedOut) continue;
      const specName =
        command.requiredBySpecs.length === 1 ? (command.requiredBySpecs[0] ?? null) : null;
      const message =
        command.disposition === 'not-run'
          ? `Required verification command "${command.name}" did not run in this verification and no current evidence covers it.`
          : command.spawnFailed
            ? `Required verification command "${command.name}" could not start (${command.result?.status ?? 'spawn failure'}).`
            : `Required verification command "${command.name}" failed with exit code ${command.exitCode ?? 'unknown'}.`;
      diagnostics.push(
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message,
          specName,
          evidence: {
            command: command.name,
            argv: command.argv,
            disposition: command.disposition,
            exitCode: command.exitCode,
            spawnFailed: command.spawnFailed,
            requiredBySpecs: command.requiredBySpecs,
            stderrTail: command.result?.stderrTail.slice(-2000) ?? null,
          },
        }),
      );
    }
    return diagnostics;
  },
};

const sbv013: GlobalVerificationRule = {
  id: 'SBV013',
  title: 'Required verification command missing',
  category: 'verification-command',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'global',
  triggeredWhen:
    'A spec policy requires a verification command by name, but no command with that name is configured in .specbridge/config.json.',
  resolution:
    'Add the command to verification.commands in .specbridge/config.json (argv array form), or remove the name from the policy.',
  evaluate(context, resolved) {
    return context.commands.missingRequired.map(({ name, requiredBySpecs }) =>
      makeDiagnostic({
        rule: this,
        severity: resolved.severity,
        message: `Verification command "${name}" is required by ${requiredBySpecs.join(', ')} but is not configured in .specbridge/config.json.`,
        specName: requiredBySpecs.length === 1 ? (requiredBySpecs[0] ?? null) : null,
        evidence: { command: name, requiredBySpecs },
      }),
    );
  },
};

const sbv025: GlobalVerificationRule = {
  id: 'SBV025',
  title: 'Verification command timed out',
  category: 'verification-command',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'global',
  triggeredWhen:
    'A trusted verification command exceeded its configured timeout. Required commands error; optional commands warn.',
  resolution:
    'Raise the command timeout in .specbridge/config.json, or make the command faster/scoped.',
  evaluate(context, resolved) {
    return context.commands.commands
      .filter((command) => command.timedOut)
      .map((command) =>
        makeDiagnostic({
          rule: this,
          severity: command.required ? resolved.severity : 'warning',
          message: `Verification command "${command.name}" timed out after ${command.durationMs ?? '?'} ms.`,
          specName:
            command.requiredBySpecs.length === 1 ? (command.requiredBySpecs[0] ?? null) : null,
          evidence: {
            command: command.name,
            argv: command.argv,
            required: command.required,
            durationMs: command.durationMs,
          },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV014 — Unmapped changed file
 * ------------------------------------------------------------------ */

const sbv014: GlobalVerificationRule = {
  id: 'SBV014',
  title: 'Unmapped changed file',
  category: 'mapping',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'deterministic',
  scope: 'global',
  triggeredWhen:
    'In --changed or --all verification, a changed source or test file maps to no spec: no spec directory, impact area, task evidence, or design reference claims it.',
  resolution:
    'Add the path to the owning spec’s impact areas, create a spec for the work, or accept unmapped changes by policy (rules.SBV014).',
  evaluate(context, resolved) {
    if (context.selection.mode === 'single') return [];
    return context.unmappedFiles.map((file) =>
      makeDiagnostic({
        rule: this,
        severity: resolved.severity,
        message: `${file.path} does not map to any spec (no impact area, evidence, or spec reference claims it).`,
        file: { path: file.path },
        evidence: { changedPath: file.path, changeType: file.changeType },
      }),
    );
  },
};

/* ------------------------------------------------------------------ *
 * SBV016 — Task marked complete before task-plan approval
 * ------------------------------------------------------------------ */

const sbv016: SpecVerificationRule = {
  id: 'SBV016',
  title: 'Task marked complete before task-plan approval',
  category: 'approval',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'A managed spec has checked tasks while its task plan is not approved (never approved, or approval revoked). Unmanaged specs (no sidecar state) are not judged.',
  resolution:
    'Approve the task plan first (specbridge spec approve <name> --stage tasks), or uncheck the boxes.',
  evaluate(context, resolved) {
    const state = context.spec.state;
    if (state === undefined || context.spec.tasks === undefined) return [];
    const tasksStage = context.evaluation?.stages.find((stage) => stage.stage === 'tasks');
    if (tasksStage === undefined || tasksStage.stored.status === 'approved') return [];
    return context.spec.tasks.allTasks
      .filter((task) => task.state === 'done')
      .map((task) =>
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `Task ${task.id} is checked but the task plan of "${context.specName}" has never been approved (status: ${tasksStage.stored.status}).`,
          specName: context.specName,
          taskId: task.id,
          file: taskFileLocation(context, task),
          evidence: { tasksStageStatus: tasksStage.stored.status },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV017 — No test evidence for test-required task
 * ------------------------------------------------------------------ */

const sbv017: SpecVerificationRule = {
  id: 'SBV017',
  title: 'No test evidence for test-required task',
  category: 'evidence',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'heuristic',
  scope: 'spec',
  triggeredWhen:
    'A checked task (or its referenced requirement) explicitly mentions tests, but its valid evidence contains neither a passing test command nor changed test files. Error severity when the policy sets requireTestEvidence. Test-language detection is heuristic.',
  resolution:
    'Run the configured test command as part of the task (spec run records it), or record a manual acceptance explaining how the tests were covered.',
  evaluate(context, resolved) {
    const model = context.spec.tasks;
    const tasksDocument = context.spec.documents.tasks;
    if (model === undefined || tasksDocument === undefined) return [];
    const severity = context.policy.requireTestEvidence ? 'error' : resolved.severity;
    const { catalog, references } = context.traceability;
    const diagnostics: VerificationDiagnostic[] = [];

    for (const task of doneLeafTasks(context)) {
      const assessment = context.evidence.assessmentsByTask.get(task.id);
      if (assessment === undefined || assessment.bucket !== 'valid') continue; // missing/stale covered elsewhere

      const taskWantsTests = taskMentionsTests(tasksDocument, model, task);
      const requirementWantsTests = references.some((reference) => {
        if (reference.taskId !== task.id || reference.canonical === undefined) return false;
        const entry = catalog.byCanonical.get(reference.canonical);
        if (entry === undefined) return false;
        if (entry.testRequired) return true;
        const requirement = catalog.byCanonical.get(entry.requirementCanonical);
        return requirement?.testRequired === true;
      });
      if (!taskWantsTests && !requirementWantsTests) continue;

      const record = assessment.best?.record;
      if (record === undefined) continue;
      const passingTestCommand = record.verificationCommands.some(
        (command) =>
          command.passed &&
          (TEST_COMMAND_PATTERN.test(command.name) ||
            command.argv.some((argument) => TEST_COMMAND_PATTERN.test(argument))),
      );
      const testFilesChanged = record.changedFiles.some((file) =>
        TEST_PATH_PATTERN.test(file.path),
      );
      if (passingTestCommand || testFilesChanged) continue;

      diagnostics.push(
        makeDiagnostic({
          rule: this,
          severity,
          message: `Task ${task.id} indicates tests (${taskWantsTests ? 'task text' : 'referenced requirement'}), but its evidence shows no passing test command and no changed test files.`,
          specName: context.specName,
          taskId: task.id,
          file: taskFileLocation(context, task),
          evidence: {
            taskMentionsTests: taskWantsTests,
            requirementMentionsTests: requirementWantsTests,
            evidenceRunId: record.runId,
            recordedCommands: record.verificationCommands.map((command) => command.name),
            testEvidenceRequired: context.policy.requireTestEvidence,
          },
        }),
      );
    }
    return diagnostics;
  },
};

/* ------------------------------------------------------------------ *
 * SBV018 — Design path reference does not exist
 * ------------------------------------------------------------------ */

const sbv018: SpecVerificationRule = {
  id: 'SBV018',
  title: 'Design path reference does not exist',
  category: 'design',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'design.md explicitly references a repository path (in backticks or a Markdown link) that exists neither relative to the repository root nor relative to the spec folder. Glob patterns are not checked.',
  resolution:
    'Fix the path in design.md, or delete the reference if the file was intentionally removed (then re-approve the design).',
  evaluate(context, resolved) {
    const designDocument = context.spec.documents.design;
    if (designDocument === undefined) return [];
    const designFile = designDocument.filePath;
    const designRepoPath =
      designFile !== undefined ? repoRelative(context.workspace, designFile) : undefined;
    const specDir = path.join(context.workspace.rootDir, '.kiro', 'specs', context.specName);

    return context.traceability.designPathReferences
      .filter((reference) => !reference.isGlob)
      .filter((reference) => {
        const fromRoot = path.join(
          context.workspace.rootDir,
          reference.path.split('/').join(path.sep),
        );
        const fromSpecDir = path.join(specDir, reference.path.split('/').join(path.sep));
        return !existsSync(fromRoot) && !existsSync(fromSpecDir);
      })
      .map((reference) =>
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `design.md references \`${reference.raw}\`, which does not exist in the repository.`,
          specName: context.specName,
          file:
            designRepoPath !== undefined
              ? { path: designRepoPath, line: reference.line + 1 }
              : null,
          evidence: { referencedPath: reference.path, method: reference.method },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV019 — Changed file not represented in execution evidence
 * ------------------------------------------------------------------ */

const sbv019: SpecVerificationRule = {
  id: 'SBV019',
  title: 'Changed file not represented in execution evidence',
  category: 'evidence',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'The spec has valid task evidence, yet the comparison contains implementation files that no evidence record accounts for — work happened outside recorded task runs.',
  resolution:
    'Run the remaining work as tasks (spec run records the files), or accept that untracked edits reduce evidence coverage.',
  evaluate(context, resolved) {
    const hasValidEvidence = [...context.evidence.assessmentsByTask.values()].some(
      (assessment) => assessment.bucket === 'valid',
    );
    if (!hasValidEvidence) return [];

    const evidencePaths = new Set<string>();
    for (const assessment of context.evidence.assessmentsByTask.values()) {
      for (const item of assessment.all) {
        if (item.validity !== 'valid') continue;
        for (const file of item.record.changedFiles) evidencePaths.add(file.path);
      }
    }

    const candidates =
      context.selectionMode === 'single' ? context.changedFiles : context.specChangedFiles;
    return candidates
      .filter((file) => !isSpecInfraPath(file.path))
      .filter((file) => !evidencePaths.has(file.path))
      .map((file) =>
        makeDiagnostic({
          rule: this,
          severity: resolved.severity,
          message: `${file.path} changed but appears in no valid task evidence for ${context.specName}.`,
          specName: context.specName,
          file: { path: file.path },
          evidence: { changedPath: file.path, changeType: file.changeType },
        }),
      );
  },
};

/* ------------------------------------------------------------------ *
 * SBV020 — Verification policy invalid
 * ------------------------------------------------------------------ */

const sbv020: SpecVerificationRule = {
  id: 'SBV020',
  title: 'Verification policy invalid',
  category: 'workspace',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'The spec’s verification policy file exists but is not valid JSON, does not match the versioned schema, or contains rejected glob patterns. Verification then runs with secure defaults.',
  resolution:
    'Fix the policy file (specbridge spec policy validate <name> pinpoints the problem), or delete it to use defaults.',
  evaluate(context, resolved) {
    return context.policy.policyDiagnostics.map((diagnostic) =>
      makeDiagnostic({
        rule: this,
        severity: resolved.severity,
        message: diagnostic.message,
        specName: context.specName,
        file: context.policy.policyPath !== undefined ? { path: context.policy.policyPath } : null,
        evidence: { code: diagnostic.code },
      }),
    );
  },
};

/* ------------------------------------------------------------------ *
 * SBV021 — Diff base unavailable
 * ------------------------------------------------------------------ */

const sbv021: GlobalVerificationRule = {
  id: 'SBV021',
  title: 'Diff base unavailable',
  category: 'git',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'global',
  triggeredWhen:
    'The requested Git comparison cannot be resolved: a ref does not exist locally, no merge base exists, the clone is shallow, or the directory is not a git work tree.',
  resolution:
    'Fetch the missing refs yourself (SpecBridge never fetches automatically). In GitHub Actions, check out with actions/checkout@v4 and fetch-depth: 0.',
  evaluate(context, resolved) {
    const failure = context.comparison.failure;
    if (context.comparison.ok || failure === undefined) return [];
    return [
      makeDiagnostic({
        rule: this,
        severity: resolved.severity,
        message: failure.message,
        evidence: {
          reason: failure.reason,
          shallowClone: failure.shallow,
          comparison: context.comparison.descriptor.label,
        },
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * SBV022 — Ambiguous affected-spec mapping
 * ------------------------------------------------------------------ */

const sbv022: GlobalVerificationRule = {
  id: 'SBV022',
  title: 'Ambiguous affected-spec mapping',
  category: 'mapping',
  defaultSeverity: { advisory: 'warning', strict: 'warning' },
  confidence: 'deterministic',
  scope: 'global',
  triggeredWhen:
    'A changed file maps to more than one spec (overlapping impact areas or evidence). Every matching spec is verified; the overlap itself is reported.',
  resolution:
    'Narrow the overlapping impact areas so each path has one owning spec, or accept the shared ownership deliberately.',
  evaluate(context, resolved) {
    return context.ambiguousFiles.map((entry) =>
      makeDiagnostic({
        rule: this,
        severity: resolved.severity,
        message: `${entry.path} maps to ${entry.specs.length} specs: ${entry.specs
          .map((spec) => `${spec.name} (via ${spec.via.join(', ')})`)
          .join('; ')}.`,
        file: { path: entry.path },
        evidence: { specs: entry.specs },
      }),
    );
  },
};

/* ------------------------------------------------------------------ *
 * SBV023 — Tasks document unexpectedly changed
 * ------------------------------------------------------------------ */

const sbv023: SpecVerificationRule = {
  id: 'SBV023',
  title: 'Tasks document unexpectedly changed',
  category: 'tasks',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'The comparison modifies a managed spec’s tasks.md beyond checkbox transitions — task text, IDs, hierarchy, or references changed relative to the comparison base.',
  resolution:
    'If the plan change is intentional, review and re-approve the task plan; otherwise revert the tasks.md edit.',
  async evaluate(context, resolved) {
    if (context.spec.state === undefined) return []; // unmanaged specs are not judged
    if (!context.comparison.ok) return [];
    const repoPath = `.kiro/specs/${context.specName}/tasks.md`;
    const changed = context.changedFiles.find(
      (file) =>
        file.path === repoPath &&
        (file.changeType === 'modified' || file.changeType === 'renamed'),
    );
    if (changed === undefined) return [];
    const currentDocument = context.spec.documents.tasks;
    if (currentDocument === undefined) return [];
    const baseContent = await context.readBaseContent(repoPath);
    if (baseContent === undefined) return [];
    const baseDocument = MarkdownDocument.fromText(baseContent);
    if (normalizedTaskPlanText(baseDocument) === normalizedTaskPlanText(currentDocument)) {
      return []; // checkbox-only progress — expected
    }
    return [
      makeDiagnostic({
        rule: this,
        severity: resolved.severity,
        message: `tasks.md of "${context.specName}" changed beyond checkbox progress in this comparison (task text, IDs, hierarchy, or references differ from the base).`,
        specName: context.specName,
        file: { path: repoPath },
        evidence: {
          comparison: context.comparison.descriptor.label,
          changeType: changed.changeType,
        },
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * SBV024 — Evidence points outside repository
 * ------------------------------------------------------------------ */

const sbv024: SpecVerificationRule = {
  id: 'SBV024',
  title: 'Evidence points outside repository',
  category: 'evidence',
  defaultSeverity: { advisory: 'error', strict: 'error' },
  confidence: 'deterministic',
  scope: 'spec',
  triggeredWhen:
    'An evidence record lists changed-file paths that escape the repository (absolute paths or .. traversal). Such records are never trusted.',
  resolution:
    'Delete or regenerate the corrupt evidence record; evidence must only reference repository-relative paths.',
  evaluate(context, resolved) {
    const diagnostics: VerificationDiagnostic[] = [];
    for (const [taskId, assessment] of context.evidence.assessmentsByTask) {
      for (const item of assessment.all) {
        if (item.pathViolations.length === 0) continue;
        diagnostics.push(
          makeDiagnostic({
            rule: this,
            severity: resolved.severity,
            message: `Evidence record ${item.record.runId} for task ${taskId} references paths outside the repository: ${item.pathViolations.join(', ')}.`,
            specName: context.specName,
            taskId,
            evidence: { runId: item.record.runId, paths: item.pathViolations },
          }),
        );
      }
    }
    return diagnostics;
  },
};

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

/**
 * Every built-in rule in ID order. This list is the registry: tests assert
 * the IDs are unique, contiguous where documented, and stable.
 */
export function builtInVerificationRules(): readonly VerificationRule[] {
  return [
    sbv001,
    sbv002,
    sbv003,
    sbv004,
    sbv005,
    sbv006,
    sbv007,
    sbv008,
    sbv009,
    sbv010,
    sbv011,
    sbv012,
    sbv013,
    sbv014,
    sbv015,
    sbv016,
    sbv017,
    sbv018,
    sbv019,
    sbv020,
    sbv021,
    sbv022,
    sbv023,
    sbv024,
    sbv025,
  ];
}

export function findRule(ruleId: string): VerificationRule | undefined {
  return builtInVerificationRules().find((rule) => rule.id === ruleId.toUpperCase());
}
