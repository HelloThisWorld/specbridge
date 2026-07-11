import type { ConcreteSpecType, ConcreteWorkflowMode, StageName } from '@specbridge/core';

/**
 * Offline Markdown templates for new specs.
 *
 * Rules:
 * - Plain Markdown only. No front matter, no HTML comments, no SpecBridge
 *   metadata — every generated file must be openable by Kiro unchanged.
 * - Workflow state ("> Status:" lines) is human-readable prose only; the
 *   sidecar state is authoritative.
 * - Placeholders are deliberately machine-recognizable (angle-bracket tokens
 *   and "... here." instruction lines) so `spec analyze` can block approval
 *   until they are replaced with real content.
 * - Generated files always use LF line endings and end with a newline.
 */

export interface TemplateInput {
  title: string;
  /** May span multiple Markdown paragraphs; inserted verbatim. */
  description: string;
}

export interface RenderedSpecFile {
  fileName: string;
  stage: StageName;
  content: string;
}

/** Default description when neither --description nor --from-file is given. */
export const DEFAULT_FEATURE_DESCRIPTION = 'Add a short description of the feature here.';
export const DEFAULT_BUGFIX_DESCRIPTION = 'Add a short description of the bug here.';

/**
 * Exact body lines (trimmed) that mark a generated pending-stage document.
 * The analyzer treats a line matching one of these as placeholder content.
 */
export const TEMPLATE_PLACEHOLDER_LINES: readonly string[] = [
  'Design will be completed after requirements approval.',
  'Requirements will be derived and validated after the initial design review.',
  'Define implementation tasks after design approval.',
  'Define implementation tasks after requirements and design approval.',
];

function joinLines(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function introBlock(input: TemplateInput): string[] {
  const description = input.description.trim();
  return [`**${input.title}**`, '', ...description.split(/\r?\n/)];
}

function featureRequirements(input: TemplateInput): string {
  return joinLines([
    '# Requirements Document',
    '',
    '## Introduction',
    '',
    ...introBlock(input),
    '',
    '## Glossary',
    '',
    '| Term | Definition |',
    '| --- | --- |',
    '| <term> | <definition> |',
    '',
    '## Requirements',
    '',
    '### Requirement 1: <initial requirement title>',
    '',
    '**User Story:** As a <role>, I want <capability>, so that <benefit>.',
    '',
    '#### Acceptance Criteria',
    '',
    '1. WHEN <condition or event>, THE SYSTEM SHALL <expected behavior>.',
    '2. IF <error or exceptional condition>, THEN THE SYSTEM SHALL <safe behavior>.',
    '',
    '## Non-Functional Requirements',
    '',
    '- Performance: add measurable performance expectations here.',
    '- Security: add authentication, authorization, and data-handling expectations here.',
    '- Reliability: add availability and failure-recovery expectations here.',
    '- Observability: add logging, metrics, and alerting expectations here.',
    '- Compatibility: add platform and integration constraints here.',
    '',
    '## Edge Cases',
    '',
    '- Add edge cases here.',
    '',
    '## Out of Scope',
    '',
    '- Add explicitly excluded behavior here.',
  ]);
}

function featureDesign(input: TemplateInput): string {
  return joinLines([
    '# Design Document',
    '',
    '## Overview',
    '',
    ...introBlock(input),
    '',
    '## Goals',
    '',
    '- Add concrete goals here.',
    '',
    '## Non-Goals',
    '',
    '- Add explicitly excluded goals here.',
    '',
    '## Architecture',
    '',
    'Describe the overall approach here.',
    '',
    '## Components and Interfaces',
    '',
    '- Add affected components and their interfaces here.',
    '',
    '## Data Model',
    '',
    '- Add new or changed data structures here.',
    '',
    '## Control Flow',
    '',
    'Describe the main control flow here.',
    '',
    '## Failure Handling',
    '',
    '- Add failure modes and how the system handles them here.',
    '',
    '## Security Considerations',
    '',
    '- Add authentication, authorization, and data-protection concerns here.',
    '',
    '## Observability',
    '',
    '- Add logging, metrics, and tracing decisions here.',
    '',
    '## Testing Strategy',
    '',
    '- Add unit, integration, and regression testing plans here.',
    '',
    '## Risks and Trade-offs',
    '',
    '- Add known risks and accepted trade-offs here.',
    '',
    '## Alternatives Considered',
    '',
    '- Add rejected alternatives and why they were rejected here.',
  ]);
}

function pendingDesign(): string {
  return joinLines([
    '# Design Document',
    '',
    '> Status: Pending requirements approval.',
    '',
    '## Overview',
    '',
    'Design will be completed after requirements approval.',
  ]);
}

function pendingRequirements(): string {
  return joinLines([
    '# Requirements Document',
    '',
    '> Status: Pending design review.',
    '',
    '## Introduction',
    '',
    'Requirements will be derived and validated after the initial design review.',
  ]);
}

function pendingTasksAfterDesign(): string {
  return joinLines([
    '# Implementation Plan',
    '',
    '> Status: Pending design approval.',
    '',
    '- [ ] Define implementation tasks after design approval.',
  ]);
}

function pendingTasksAfterBoth(): string {
  return joinLines([
    '# Implementation Plan',
    '',
    '> Status: Pending requirements and design approval.',
    '',
    '- [ ] Define implementation tasks after requirements and design approval.',
  ]);
}

function quickTasks(): string {
  return joinLines([
    '# Implementation Plan',
    '',
    '- [ ] 1. Review and refine requirements.',
    '- [ ] 2. Confirm the proposed design.',
    '- [ ] 3. Implement the primary behavior.',
    '- [ ] 4. Add automated tests for acceptance criteria.',
    '- [ ] 5. Verify error handling and edge cases.',
    '- [ ] 6. Update documentation where required.',
  ]);
}

function bugfixDocument(input: TemplateInput): string {
  return joinLines([
    '# Bugfix Document',
    '',
    '## Summary',
    '',
    ...introBlock(input),
    '',
    '## Current Behavior',
    '',
    'Describe the observed incorrect behavior here.',
    '',
    '## Expected Behavior',
    '',
    'Describe the correct behavior here.',
    '',
    '## Unchanged Behavior',
    '',
    '- List behavior that must remain unchanged here.',
    '',
    '## Reproduction',
    '',
    '1. Add reproduction steps here.',
    '',
    '## Evidence',
    '',
    '- Logs: add relevant log lines here.',
    '- Error messages: add exact error text here.',
    '- Screenshots: add links or paths here.',
    '- Failing tests: add failing test names here.',
    '- Relevant source locations: add file paths here.',
    '',
    '## Constraints',
    '',
    '- Add implementation or compatibility constraints here.',
    '',
    '## Regression Risks',
    '',
    '- Add behavior that could regress here.',
  ]);
}

function bugfixDesign(): string {
  return joinLines([
    '# Fix Design',
    '',
    '## Root Cause',
    '',
    'Document the confirmed or suspected root cause here.',
    '',
    '## Proposed Fix',
    '',
    'Describe the smallest safe fix here.',
    '',
    '## Affected Components',
    '',
    '- Add affected files and components here.',
    '',
    '## Failure Handling',
    '',
    '- Add failure modes introduced or fixed by this change here.',
    '',
    '## Alternatives Considered',
    '',
    '- Add rejected alternatives and why they were rejected here.',
    '',
    '## Regression Protection',
    '',
    '- Add the regression tests that will guard this fix here.',
    '',
    '## Validation Strategy',
    '',
    '- Add the checks that prove the fix works here.',
  ]);
}

function bugfixTasks(): string {
  return joinLines([
    '# Bugfix Implementation Plan',
    '',
    '- [ ] 1. Reproduce the bug with deterministic evidence.',
    '- [ ] 2. Confirm the root cause.',
    '- [ ] 3. Implement the smallest safe fix.',
    '- [ ] 4. Add regression tests.',
    '- [ ] 5. Verify unchanged behavior.',
    '- [ ] 6. Run the required validation checks.',
    '- [ ] 7. Document remaining risks.',
  ]);
}

/**
 * Render the three Markdown files for a new spec.
 *
 * Bugfix specs use the same file set in every mode (`bugfix.md`, a fix
 * design, and a bugfix plan) — the workflow mode only changes the approval
 * order enforced through sidecar state.
 */
export function renderSpecTemplates(
  specType: ConcreteSpecType,
  mode: ConcreteWorkflowMode,
  input: TemplateInput,
): RenderedSpecFile[] {
  if (specType === 'bugfix') {
    return [
      { fileName: 'bugfix.md', stage: 'bugfix', content: bugfixDocument(input) },
      { fileName: 'design.md', stage: 'design', content: bugfixDesign() },
      { fileName: 'tasks.md', stage: 'tasks', content: bugfixTasks() },
    ];
  }
  switch (mode) {
    case 'requirements-first':
      return [
        { fileName: 'requirements.md', stage: 'requirements', content: featureRequirements(input) },
        { fileName: 'design.md', stage: 'design', content: pendingDesign() },
        { fileName: 'tasks.md', stage: 'tasks', content: pendingTasksAfterDesign() },
      ];
    case 'design-first':
      return [
        { fileName: 'requirements.md', stage: 'requirements', content: pendingRequirements() },
        { fileName: 'design.md', stage: 'design', content: featureDesign(input) },
        { fileName: 'tasks.md', stage: 'tasks', content: pendingTasksAfterBoth() },
      ];
    case 'quick':
      return [
        { fileName: 'requirements.md', stage: 'requirements', content: featureRequirements(input) },
        { fileName: 'design.md', stage: 'design', content: featureDesign(input) },
        { fileName: 'tasks.md', stage: 'tasks', content: quickTasks() },
      ];
  }
}
