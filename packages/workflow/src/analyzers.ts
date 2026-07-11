import type { Diagnostic, DiagnosticSeverity, StageName, StageStatus } from '@specbridge/core';
import { hasErrors } from '@specbridge/core';
import type { MarkdownDocument, SpecAnalysis, TaskItem } from '@specbridge/compat-kiro';
import { classifyEars, findVaguePhrases, looksTestable, taskStartsWithVagueVerb } from './ears.js';
import { scanPlaceholders } from './placeholders.js';

/**
 * Deterministic, offline spec analysis.
 *
 * Every check runs on the tolerant parse models from @specbridge/compat-kiro
 * plus the raw line-preserving document. No model, no network, no
 * randomness: the same bytes always produce the same findings.
 *
 * Severity contract (enforced by `spec approve`):
 * - `error`   — blocks approval of the analyzed stage
 * - `warning` — reported, never blocks (unless the user passes --strict)
 * - `info`    — context only
 */

export interface StageAnalysisOptions {
  /**
   * Severity of placeholder findings. Placeholders are errors for the stage
   * being approved (or any active stage) and warnings for stages that are
   * still blocked behind an unapproved prerequisite.
   */
  placeholderSeverity: 'error' | 'warning';
  /** Severity when the stage file does not exist (info for blocked stages). */
  missingFileSeverity: DiagnosticSeverity;
  /** Stored stage status, when the spec is managed. Enables state-aware checks. */
  stageStatus?: StageStatus;
  /**
   * False when a prerequisite stage is not approved yet. Used only for the
   * "design written before its prerequisite was approved" advisory.
   */
  prerequisitesApproved?: boolean;
}

export interface StageAnalysis {
  stage: StageName;
  fileName: string;
  filePath?: string;
  fileExists: boolean;
  diagnostics: Diagnostic[];
}

export interface SpecAnalysisResult {
  specName: string;
  stages: StageAnalysis[];
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  hasErrors: boolean;
}

function diag(
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  file?: string,
  line?: number,
): Diagnostic {
  return {
    severity,
    code,
    message,
    ...(file !== undefined ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

function isDocumentEmpty(document: MarkdownDocument): boolean {
  return document.lines.every((line) => line.text.trim().length === 0);
}

function pushPlaceholderDiagnostics(
  document: MarkdownDocument,
  code: string,
  options: StageAnalysisOptions,
  diagnostics: Diagnostic[],
): void {
  const scan = scanPlaceholders(document);
  for (const hit of scan.hits) {
    diagnostics.push(
      diag(
        options.placeholderSeverity,
        code,
        `Placeholder content: ${hit.text}`,
        document.filePath,
        hit.line + 1,
      ),
    );
  }
  if (scan.placeholderOnly) {
    diagnostics.push(
      diag(
        options.placeholderSeverity,
        `${code}_ONLY`,
        'The document consists entirely of template placeholders; replace them with real content.',
        document.filePath,
      ),
    );
  }
}

function sectionText(document: MarkdownDocument, startLine: number, endLine: number): string {
  return document
    .getText(startLine + 1, endLine)
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSectionMatching(document: MarkdownDocument, pattern: RegExp): boolean {
  return document.headings().some((heading) => pattern.test(heading.text));
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

const ERROR_BEHAVIOR = /\b(if|error|errors|fail|fails|failure|invalid|unavailable|timeout|times out|reject|rejects|denied|missing|exception)\b/i;
const OUT_OF_SCOPE_SECTION = /out of scope|non-goals|exclusions|not in scope/i;
const NFR_SECTION = /non-functional|quality attributes|\bnfr\b/i;
const INTRO_SECTION = /^(introduction|overview|summary)$/i;

export function analyzeRequirementsStage(
  spec: SpecAnalysis,
  options: StageAnalysisOptions,
): StageAnalysis {
  const document = spec.documents.requirements;
  const diagnostics: Diagnostic[] = [];
  const filePath = document?.filePath;

  if (document === undefined || spec.requirements === undefined) {
    diagnostics.push(
      diag(
        options.missingFileSeverity,
        'REQUIREMENTS_MISSING',
        'requirements.md does not exist. Create it (or run "spec new" for a template in a fresh spec).',
        spec.folder.dir,
      ),
    );
    return { stage: 'requirements', fileName: 'requirements.md', fileExists: false, diagnostics };
  }

  if (isDocumentEmpty(document)) {
    diagnostics.push(
      diag('error', 'REQUIREMENTS_EMPTY', 'requirements.md is empty.', filePath),
    );
    return {
      stage: 'requirements',
      fileName: 'requirements.md',
      ...(filePath !== undefined ? { filePath } : {}),
      fileExists: true,
      diagnostics,
    };
  }

  const model = spec.requirements;
  pushPlaceholderDiagnostics(document, 'REQUIREMENTS_PLACEHOLDER', options, diagnostics);

  if (model.title === undefined) {
    diagnostics.push(
      diag('warning', 'REQUIREMENTS_NO_TITLE', 'No top-level "# ..." title found.', filePath),
    );
  }
  const hasIntroduction =
    model.introduction !== undefined ||
    document.sections().some((s) => s.heading.level <= 2 && INTRO_SECTION.test(s.heading.text.trim()));
  if (!hasIntroduction) {
    diagnostics.push(
      diag(
        'warning',
        'REQUIREMENTS_NO_INTRODUCTION',
        'No Introduction/Overview/Summary section found.',
        filePath,
      ),
    );
  }

  if (model.requirements.length === 0) {
    diagnostics.push(
      diag(
        'error',
        'REQUIREMENTS_NONE',
        'No requirements recognized. Add at least one "### Requirement 1: <title>" block with acceptance criteria.',
        filePath,
      ),
    );
  }

  // Duplicate requirement ids make task references ambiguous — error.
  const seenIds = new Map<string, number>();
  for (const requirement of model.requirements) {
    const previous = seenIds.get(requirement.id);
    if (previous !== undefined) {
      diagnostics.push(
        diag(
          'error',
          'REQUIREMENTS_DUPLICATE_ID',
          `Requirement id ${requirement.id} appears more than once (also on line ${previous}).`,
          filePath,
          requirement.headingLine + 1,
        ),
      );
    } else {
      seenIds.set(requirement.id, requirement.headingLine + 1);
    }
  }

  let anyUserStory = false;
  let anyErrorBehavior = false;

  for (const requirement of model.requirements) {
    if (requirement.userStory !== undefined && requirement.userStory.length > 0) {
      anyUserStory = true;
    }

    if (requirement.criteria.length === 0) {
      diagnostics.push(
        diag(
          'error',
          'REQUIREMENTS_NO_CRITERIA',
          `Requirement ${requirement.id} has no acceptance criteria.`,
          filePath,
          requirement.headingLine + 1,
        ),
      );
      continue;
    }

    const seenCriteria = new Map<string, number>();
    for (const criterion of requirement.criteria) {
      const previous = seenCriteria.get(criterion.number);
      if (previous !== undefined) {
        diagnostics.push(
          diag(
            'error',
            'REQUIREMENTS_DUPLICATE_CRITERION',
            `Acceptance criterion ${criterion.id} is numbered more than once (also on line ${previous}).`,
            filePath,
            criterion.line + 1,
          ),
        );
      } else {
        seenCriteria.set(criterion.number, criterion.line + 1);
      }

      if (criterion.text.trim().length === 0) {
        diagnostics.push(
          diag(
            'error',
            'REQUIREMENTS_EMPTY_CRITERION',
            `Acceptance criterion ${criterion.id} has no text.`,
            filePath,
            criterion.line + 1,
          ),
        );
        continue;
      }

      if (ERROR_BEHAVIOR.test(criterion.text)) anyErrorBehavior = true;

      const ears = classifyEars(criterion.text);
      if (ears === 'ears-malformed') {
        diagnostics.push(
          diag(
            'warning',
            'REQUIREMENTS_EARS_MALFORMED',
            `Acceptance criterion ${criterion.id} starts an EARS pattern (WHEN/IF/WHILE/WHERE) but has no "SHALL <behavior>" clause.`,
            filePath,
            criterion.line + 1,
          ),
        );
      } else if (ears === 'plain' && !looksTestable(criterion.text)) {
        diagnostics.push(
          diag(
            'warning',
            'REQUIREMENTS_CRITERION_NOT_TESTABLE',
            `Acceptance criterion ${criterion.id} is not written in a recognizable testable form (consider "WHEN <condition>, THE SYSTEM SHALL <behavior>").`,
            filePath,
            criterion.line + 1,
          ),
        );
      }

      const vague = findVaguePhrases(criterion.text);
      if (vague.length > 0) {
        diagnostics.push(
          diag(
            'warning',
            'REQUIREMENTS_VAGUE_CRITERION',
            `Acceptance criterion ${criterion.id} uses vague wording (${vague.join(', ')}); state observable behavior instead.`,
            filePath,
            criterion.line + 1,
          ),
        );
      }
    }
  }

  if (model.requirements.length > 0 && !anyUserStory) {
    diagnostics.push(
      diag(
        'warning',
        'REQUIREMENTS_NO_USER_STORIES',
        'No user stories found (expected "**User Story:** As a <role>, I want <capability>, so that <benefit>.").',
        filePath,
      ),
    );
  }
  if (model.requirements.length > 0 && !anyErrorBehavior) {
    diagnostics.push(
      diag(
        'warning',
        'REQUIREMENTS_NO_ERROR_BEHAVIOR',
        'No acceptance criterion covers error or exceptional behavior (e.g. "IF <error condition>, THEN THE SYSTEM SHALL <safe behavior>").',
        filePath,
      ),
    );
  }
  if (!hasSectionMatching(document, OUT_OF_SCOPE_SECTION)) {
    diagnostics.push(
      diag(
        'warning',
        'REQUIREMENTS_NO_OUT_OF_SCOPE',
        'No "Out of Scope" (or Non-Goals) section found; explicitly excluded behavior prevents scope creep.',
        filePath,
      ),
    );
  }
  if (!hasSectionMatching(document, NFR_SECTION)) {
    diagnostics.push(
      diag(
        'warning',
        'REQUIREMENTS_NO_NFR',
        'No non-functional requirements section found (performance, security, reliability, observability, compatibility).',
        filePath,
      ),
    );
  }

  // Parser-level detail worth surfacing: unnumbered criteria note.
  for (const parserDiagnostic of model.diagnostics) {
    if (parserDiagnostic.code === 'REQUIREMENTS_UNNUMBERED_CRITERIA') {
      diagnostics.push(parserDiagnostic);
    }
  }

  return {
    stage: 'requirements',
    fileName: 'requirements.md',
    ...(filePath !== undefined ? { filePath } : {}),
    fileExists: true,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Bugfix
// ---------------------------------------------------------------------------

export function analyzeBugfixStage(
  spec: SpecAnalysis,
  options: StageAnalysisOptions,
): StageAnalysis {
  const document = spec.documents.bugfix;
  const diagnostics: Diagnostic[] = [];
  const filePath = document?.filePath;

  if (document === undefined || spec.bugfix === undefined) {
    diagnostics.push(
      diag(
        options.missingFileSeverity,
        'BUGFIX_MISSING',
        'bugfix.md does not exist. Create it (or run "spec new --type bugfix" for a template in a fresh spec).',
        spec.folder.dir,
      ),
    );
    return { stage: 'bugfix', fileName: 'bugfix.md', fileExists: false, diagnostics };
  }

  if (isDocumentEmpty(document)) {
    diagnostics.push(diag('error', 'BUGFIX_EMPTY', 'bugfix.md is empty.', filePath));
    return {
      stage: 'bugfix',
      fileName: 'bugfix.md',
      ...(filePath !== undefined ? { filePath } : {}),
      fileExists: true,
      diagnostics,
    };
  }

  const model = spec.bugfix;
  pushPlaceholderDiagnostics(document, 'BUGFIX_PLACEHOLDER', options, diagnostics);

  const current = model.concepts['current-behavior'];
  const expected = model.concepts['expected-behavior'];

  if (current === undefined) {
    diagnostics.push(
      diag(
        'error',
        'BUGFIX_NO_CURRENT_BEHAVIOR',
        'No "Current Behavior" section found; describe the observed incorrect behavior.',
        filePath,
      ),
    );
  }
  if (expected === undefined) {
    diagnostics.push(
      diag(
        'error',
        'BUGFIX_NO_EXPECTED_BEHAVIOR',
        'No "Expected Behavior" section found; describe the correct behavior.',
        filePath,
      ),
    );
  }
  if (model.concepts['unchanged-behavior'] === undefined) {
    diagnostics.push(
      diag(
        'warning',
        'BUGFIX_NO_UNCHANGED_BEHAVIOR',
        'No "Unchanged Behavior" section found; list behavior that must remain unchanged to bound the fix.',
        filePath,
      ),
    );
  }
  if (model.concepts.reproduction === undefined) {
    diagnostics.push(
      diag(
        'warning',
        'BUGFIX_NO_REPRODUCTION',
        'No "Reproduction" section found; deterministic reproduction steps make the fix verifiable.',
        filePath,
      ),
    );
  }
  if (model.concepts.evidence === undefined) {
    diagnostics.push(
      diag(
        'warning',
        'BUGFIX_NO_EVIDENCE',
        'No "Evidence" section found (logs, error messages, failing tests, source locations).',
        filePath,
      ),
    );
  }
  const hasRegressionDiscussion =
    model.concepts['regression-protection'] !== undefined ||
    hasSectionMatching(document, /regression/i);
  if (!hasRegressionDiscussion) {
    diagnostics.push(
      diag(
        'warning',
        'BUGFIX_NO_REGRESSION_RISKS',
        'No regression risk discussion found; identify behavior that could regress.',
        filePath,
      ),
    );
  }

  if (current !== undefined && expected !== undefined) {
    const currentText = sectionText(document, current.startLine, current.endLine).toLowerCase();
    const expectedText = sectionText(document, expected.startLine, expected.endLine).toLowerCase();
    if (currentText.length > 0 && currentText === expectedText) {
      diagnostics.push(
        diag(
          'error',
          'BUGFIX_BEHAVIOR_IDENTICAL',
          'Current Behavior and Expected Behavior are identical; a bugfix must describe what changes.',
          filePath,
          current.startLine + 1,
        ),
      );
    }
  }

  return {
    stage: 'bugfix',
    fileName: 'bugfix.md',
    ...(filePath !== undefined ? { filePath } : {}),
    fileExists: true,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

interface SectionCheck {
  code: string;
  pattern: RegExp;
  message: string;
}

const FEATURE_DESIGN_CHECKS: SectionCheck[] = [
  { code: 'DESIGN_NO_OVERVIEW', pattern: /overview|introduction|summary/i, message: 'No Overview section found.' },
  { code: 'DESIGN_NO_ARCHITECTURE', pattern: /architecture|approach|implementation|how it works/i, message: 'No Architecture (or implementation approach) section found.' },
  { code: 'DESIGN_NO_COMPONENTS', pattern: /component|module|service|structure/i, message: 'No Components section found.' },
  { code: 'DESIGN_NO_INTERFACES', pattern: /interface|api|contract|component/i, message: 'No interface discussion found (interfaces, APIs, or contracts).' },
  { code: 'DESIGN_NO_FAILURE_HANDLING', pattern: /failure|error[- ]handling|resilience|fault/i, message: 'No Failure Handling section found.' },
  { code: 'DESIGN_NO_SECURITY', pattern: /security|threat|auth/i, message: 'No Security Considerations section found.' },
  { code: 'DESIGN_NO_TESTING_STRATEGY', pattern: /testing|test strategy|test plan|validation/i, message: 'No Testing Strategy section found.' },
  { code: 'DESIGN_NO_RISKS', pattern: /risk|trade-?off|alternatives/i, message: 'No Risks and Trade-offs (or Alternatives Considered) section found.' },
];

const BUGFIX_DESIGN_CHECKS: SectionCheck[] = [
  { code: 'DESIGN_NO_ROOT_CAUSE', pattern: /root cause/i, message: 'No Root Cause section found.' },
  { code: 'DESIGN_NO_PROPOSED_FIX', pattern: /proposed fix|fix approach|solution/i, message: 'No Proposed Fix section found.' },
  { code: 'DESIGN_NO_COMPONENTS', pattern: /component|affected/i, message: 'No Affected Components section found.' },
  { code: 'DESIGN_NO_FAILURE_HANDLING', pattern: /failure|error[- ]handling/i, message: 'No Failure Handling section found.' },
  { code: 'DESIGN_NO_REGRESSION_PROTECTION', pattern: /regression/i, message: 'No Regression Protection section found.' },
  { code: 'DESIGN_NO_TESTING_STRATEGY', pattern: /validation|testing|verification/i, message: 'No Validation Strategy section found.' },
];

export function analyzeDesignStage(
  spec: SpecAnalysis,
  options: StageAnalysisOptions,
): StageAnalysis {
  const document = spec.documents.design;
  const diagnostics: Diagnostic[] = [];
  const filePath = document?.filePath;

  if (document === undefined || spec.design === undefined) {
    diagnostics.push(
      diag(
        options.missingFileSeverity,
        'DESIGN_MISSING',
        'design.md does not exist yet.',
        spec.folder.dir,
      ),
    );
    return { stage: 'design', fileName: 'design.md', fileExists: false, diagnostics };
  }

  if (isDocumentEmpty(document)) {
    diagnostics.push(diag('error', 'DESIGN_EMPTY', 'design.md is empty.', filePath));
    return {
      stage: 'design',
      fileName: 'design.md',
      ...(filePath !== undefined ? { filePath } : {}),
      fileExists: true,
      diagnostics,
    };
  }

  pushPlaceholderDiagnostics(document, 'DESIGN_PLACEHOLDER', options, diagnostics);

  const scan = scanPlaceholders(document);
  const isPendingStub = scan.placeholderOnly;

  // Section checks only make sense once the document has real content;
  // a generated "pending" stub already reports placeholder findings above.
  if (!isPendingStub) {
    const checks = spec.classification.type === 'bugfix' ? BUGFIX_DESIGN_CHECKS : FEATURE_DESIGN_CHECKS;
    for (const check of checks) {
      if (!hasSectionMatching(document, check.pattern)) {
        diagnostics.push(diag('warning', check.code, check.message, filePath));
      }
    }

    if (options.prerequisitesApproved === false) {
      diagnostics.push(
        diag(
          'warning',
          'DESIGN_BEFORE_PREREQUISITE_APPROVAL',
          'design.md already has real content, but its prerequisite stage is not approved yet. Approve the earlier stage first so the design has a stable base.',
          filePath,
        ),
      );
    }
  }

  return {
    stage: 'design',
    fileName: 'design.md',
    ...(filePath !== undefined ? { filePath } : {}),
    fileExists: true,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const IMPLEMENTATION_TASK = /\b(implement|build|create|add|write|develop|code|refactor|fix|update|remove|migrate|wire|integrate)\b/i;
const TEST_TASK = /\b(test|tests|tested|testing|regression)\b/i;
const VALIDATION_TASK = /\b(verify|validate|validation|confirm|check|run)\b/i;

function collectRequirementIds(spec: SpecAnalysis): Set<string> | undefined {
  const model = spec.requirements;
  if (model === undefined || model.requirements.length === 0) return undefined;
  const ids = new Set<string>();
  for (const requirement of model.requirements) {
    ids.add(requirement.id);
    for (const criterion of requirement.criteria) {
      ids.add(criterion.id);
    }
  }
  return ids;
}

function walkTasks(tasks: TaskItem[], visit: (task: TaskItem) => void): void {
  for (const task of tasks) {
    visit(task);
    walkTasks(task.children, visit);
  }
}

export function analyzeTasksStage(
  spec: SpecAnalysis,
  options: StageAnalysisOptions,
): StageAnalysis {
  const document = spec.documents.tasks;
  const diagnostics: Diagnostic[] = [];
  const filePath = document?.filePath;

  if (document === undefined || spec.tasks === undefined) {
    diagnostics.push(
      diag(
        options.missingFileSeverity,
        'TASKS_MISSING',
        'tasks.md does not exist yet.',
        spec.folder.dir,
      ),
    );
    return { stage: 'tasks', fileName: 'tasks.md', fileExists: false, diagnostics };
  }

  if (isDocumentEmpty(document)) {
    diagnostics.push(diag('error', 'TASKS_EMPTY', 'tasks.md is empty.', filePath));
    return {
      stage: 'tasks',
      fileName: 'tasks.md',
      ...(filePath !== undefined ? { filePath } : {}),
      fileExists: true,
      diagnostics,
    };
  }

  const model = spec.tasks;
  pushPlaceholderDiagnostics(document, 'TASKS_PLACEHOLDER', options, diagnostics);

  // The tolerant parser already reports malformed checkboxes, duplicate
  // numbers, and unknown checkbox states; its findings are part of the
  // stage analysis verbatim.
  diagnostics.push(...model.diagnostics);

  if (model.allTasks.length === 0) {
    diagnostics.push(
      diag(
        'error',
        'TASKS_NONE',
        'No Markdown checkbox tasks recognized (expected "- [ ] 1. Task title" lines).',
        filePath,
      ),
    );
    return {
      stage: 'tasks',
      fileName: 'tasks.md',
      ...(filePath !== undefined ? { filePath } : {}),
      fileExists: true,
      diagnostics,
    };
  }

  let anyImplementation = false;
  let anyTest = false;
  let anyValidation = false;
  let completedCount = 0;

  walkTasks(model.tasks, (task) => {
    if (IMPLEMENTATION_TASK.test(task.title)) anyImplementation = true;
    if (TEST_TASK.test(task.title)) anyTest = true;
    if (VALIDATION_TASK.test(task.title)) anyValidation = true;
    if (task.state === 'done') completedCount += 1;

    const vagueVerb = taskStartsWithVagueVerb(task.title);
    if (vagueVerb !== undefined) {
      diagnostics.push(
        diag(
          'warning',
          'TASKS_VAGUE_TASK',
          `Task ${task.id} starts with the vague verb "${vagueVerb}"; describe a concrete, verifiable action.`,
          filePath,
          task.line + 1,
        ),
      );
    }

    if (task.state === 'done' && task.children.some((c) => !c.optional && c.state !== 'done')) {
      diagnostics.push(
        diag(
          'warning',
          'TASKS_PARENT_COMPLETE_CHILD_OPEN',
          `Task ${task.id} is marked complete but has incomplete required sub-tasks.`,
          filePath,
          task.line + 1,
        ),
      );
    }
  });

  if (!anyImplementation) {
    diagnostics.push(
      diag('warning', 'TASKS_NO_IMPLEMENTATION', 'No implementation task found.', filePath),
    );
  }
  if (!anyTest) {
    diagnostics.push(
      diag('warning', 'TASKS_NO_TEST_TASK', 'No test task found; add automated tests for the acceptance criteria.', filePath),
    );
  }
  if (!anyValidation) {
    diagnostics.push(
      diag('warning', 'TASKS_NO_VALIDATION_TASK', 'No verification/validation task found.', filePath),
    );
  }

  const knownIds = collectRequirementIds(spec);
  if (knownIds !== undefined) {
    walkTasks(model.tasks, (task) => {
      for (const ref of task.requirementRefs) {
        if (!knownIds.has(ref)) {
          diagnostics.push(
            diag(
              'warning',
              'TASKS_UNKNOWN_REQUIREMENT_REF',
              `Task ${task.id} references requirement "${ref}", which does not exist in requirements.md.`,
              filePath,
              task.line + 1,
            ),
          );
        }
      }
    });
  }

  if (
    completedCount > 0 &&
    options.stageStatus !== undefined &&
    options.stageStatus !== 'approved'
  ) {
    diagnostics.push(
      diag(
        'warning',
        'TASKS_COMPLETED_BEFORE_APPROVAL',
        `${completedCount} task${completedCount === 1 ? ' is' : 's are'} already marked complete, but the task plan is not approved yet.`,
        filePath,
      ),
    );
  }

  return {
    stage: 'tasks',
    fileName: 'tasks.md',
    ...(filePath !== undefined ? { filePath } : {}),
    fileExists: true,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function analyzeSpecStage(
  spec: SpecAnalysis,
  stage: StageName,
  options: StageAnalysisOptions,
): StageAnalysis {
  switch (stage) {
    case 'requirements':
      return analyzeRequirementsStage(spec, options);
    case 'bugfix':
      return analyzeBugfixStage(spec, options);
    case 'design':
      return analyzeDesignStage(spec, options);
    case 'tasks':
      return analyzeTasksStage(spec, options);
  }
}

export function combineStageAnalyses(
  specName: string,
  stages: StageAnalysis[],
): SpecAnalysisResult {
  const diagnostics = stages.flatMap((stage) => stage.diagnostics);
  return {
    specName,
    stages,
    diagnostics,
    errorCount: diagnostics.filter((d) => d.severity === 'error').length,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
    hasErrors: hasErrors(diagnostics),
  };
}
