import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@specbridge/core';
import { readSpecState, resolveWorkspace } from '@specbridge/core';
import type { SpecAnalysis } from '@specbridge/compat-kiro';
import {
  MarkdownDocument,
  analyzeSpec,
  parseBugfix,
  parseDesign,
  parseRequirements,
  parseTasks,
  requireSpec,
} from '@specbridge/compat-kiro';
import type { StageAnalysisOptions, WorkflowEvaluation } from '@specbridge/workflow';
import {
  analyzeSpecStage,
  analyzeSpecWorkflow,
  classifyEars,
  evaluateWorkflow,
  findVaguePhrases,
  scanPlaceholders,
} from '@specbridge/workflow';
import { fixturePath } from '../helpers.js';

function evaluationOf(workspace: WorkspaceInfo, name: string): WorkflowEvaluation | undefined {
  const stateRead = readSpecState(workspace, name);
  return stateRead.state !== undefined ? evaluateWorkflow(workspace, stateRead.state) : undefined;
}

function specOf(fixture: string, name: string): { workspace: WorkspaceInfo; spec: SpecAnalysis } {
  const workspace = resolveWorkspace(fixturePath(fixture));
  if (workspace === undefined) throw new Error(`no workspace in fixture ${fixture}`);
  return { workspace, spec: analyzeSpec(workspace, requireSpec(workspace, name)) };
}

const STRICT: StageAnalysisOptions = {
  placeholderSeverity: 'error',
  missingFileSeverity: 'error',
  prerequisitesApproved: true,
};

function codes(diagnostics: { code: string }[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe('requirements analysis', () => {
  it('valid requirements produce no errors (test 40)', () => {
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const result = analyzeSpecStage(spec, 'requirements', STRICT);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('a manually edited spec with custom headings produces no errors (test 53 analysis half)', () => {
    const { spec } = specOf('v02-manually-edited', 'search-filters');
    const result = analyzeSpecStage(spec, 'requirements', STRICT);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('missing acceptance criteria is an error (test 41)', () => {
    const document = MarkdownDocument.fromText(`# Requirements Document

## Introduction

Intro.

## Requirements

### Requirement 1: No criteria here
`);
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, requirements: document },
      requirements: parseRequirements(document),
    };
    const result = analyzeSpecStage(patched, 'requirements', STRICT);
    expect(codes(result.diagnostics)).toContain('REQUIREMENTS_NO_CRITERIA');
    expect(result.diagnostics.find((d) => d.code === 'REQUIREMENTS_NO_CRITERIA')?.severity).toBe('error');
  });

  it('duplicate requirement ids are errors (test 42)', () => {
    const document = MarkdownDocument.fromText(`# Requirements Document

## Requirements

### Requirement 1: First

#### Acceptance Criteria

1. WHEN a, THE SYSTEM SHALL b.

### Requirement 1: Duplicate

#### Acceptance Criteria

1. WHEN c, THE SYSTEM SHALL d.
`);
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, requirements: document },
      requirements: parseRequirements(document),
    };
    const result = analyzeSpecStage(patched, 'requirements', STRICT);
    const duplicate = result.diagnostics.find((d) => d.code === 'REQUIREMENTS_DUPLICATE_ID');
    expect(duplicate?.severity).toBe('error');
  });

  it('placeholder content is detected with line numbers (test 43)', () => {
    const { spec } = specOf('v02-placeholder-heavy', 'notification-preferences');
    const result = analyzeSpecStage(spec, 'requirements', STRICT);
    const placeholders = result.diagnostics.filter((d) => d.code === 'REQUIREMENTS_PLACEHOLDER');
    expect(placeholders.length).toBeGreaterThan(5);
    expect(placeholders.every((d) => d.severity === 'error')).toBe(true);
    expect(placeholders.some((d) => d.message.includes('<role>'))).toBe(true);
    expect(placeholders.every((d) => d.line !== undefined)).toBe(true);
  });

  it('valid EARS criteria are recognized without warnings (test 44)', () => {
    const { spec } = specOf('v02-valid-ears', 'session-timeout');
    const result = analyzeSpecStage(spec, 'requirements', STRICT);
    expect(codes(result.diagnostics)).not.toContain('REQUIREMENTS_EARS_MALFORMED');
    expect(codes(result.diagnostics)).not.toContain('REQUIREMENTS_CRITERION_NOT_TESTABLE');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('classifies each documented EARS pattern', () => {
    expect(classifyEars('WHEN a user logs in, THE SYSTEM SHALL create a session.')).toBe('ears');
    expect(classifyEars('IF the token expired, THEN THE SYSTEM SHALL return 401.')).toBe('ears');
    expect(classifyEars('WHILE a sync runs, THE SYSTEM SHALL queue new writes.')).toBe('ears');
    expect(classifyEars('WHERE SSO is enabled, THE SYSTEM SHALL redirect to the IdP.')).toBe('ears');
    expect(classifyEars('The system SHALL log every request.')).toBe('ears');
    expect(classifyEars('WHEN a session is idle for 30 minutes.')).toBe('ears-malformed');
    expect(classifyEars('The page loads fast.')).toBe('plain');
  });

  it('malformed EARS and vague criteria produce warnings (test 45)', () => {
    const { spec } = specOf('v02-invalid-ears', 'session-timeout');
    const result = analyzeSpecStage(spec, 'requirements', STRICT);
    const byCode = codes(result.diagnostics);
    expect(byCode).toContain('REQUIREMENTS_EARS_MALFORMED');
    expect(byCode).toContain('REQUIREMENTS_VAGUE_CRITERION');
    expect(byCode).toContain('REQUIREMENTS_CRITERION_NOT_TESTABLE');
    for (const code of [
      'REQUIREMENTS_EARS_MALFORMED',
      'REQUIREMENTS_VAGUE_CRITERION',
      'REQUIREMENTS_CRITERION_NOT_TESTABLE',
    ]) {
      expect(result.diagnostics.find((d) => d.code === code)?.severity).toBe('warning');
    }
    expect(findVaguePhrases('The feature works correctly and handles input gracefully.')).toEqual([
      'works correctly',
      'handles',
      'gracefully',
    ]);
  });
});

describe('bugfix analysis', () => {
  it('valid bugfix documents produce no errors', () => {
    const { spec } = specOf('v02-bugfix-spec', 'login-timeout-fix');
    const result = analyzeSpecStage(spec, 'bugfix', STRICT);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('missing unchanged behavior is detected (test 46)', () => {
    const document = MarkdownDocument.fromText(`# Bugfix Document

## Current Behavior

Sessions expire after 5 minutes.

## Expected Behavior

Sessions expire after 30 minutes.

## Reproduction

1. Wait.

## Evidence

- Logs: expiry claim in the past.

## Regression Risks

- Refresh flow.
`);
    const { spec } = specOf('v02-bugfix-spec', 'login-timeout-fix');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, bugfix: document },
      bugfix: parseBugfix(document),
    };
    const result = analyzeSpecStage(patched, 'bugfix', STRICT);
    expect(codes(result.diagnostics)).toContain('BUGFIX_NO_UNCHANGED_BEHAVIOR');
  });

  it('identical current and expected behavior is an error', () => {
    const document = MarkdownDocument.fromText(`# Bugfix Document

## Current Behavior

The cart total is rounded down.

## Expected Behavior

The cart total is rounded down.

## Unchanged Behavior

- Everything else.
`);
    const { spec } = specOf('v02-bugfix-spec', 'login-timeout-fix');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, bugfix: document },
      bugfix: parseBugfix(document),
    };
    const result = analyzeSpecStage(patched, 'bugfix', STRICT);
    const identical = result.diagnostics.find((d) => d.code === 'BUGFIX_BEHAVIOR_IDENTICAL');
    expect(identical?.severity).toBe('error');
  });
});

describe('design analysis', () => {
  it('missing testing strategy is detected (test 47)', () => {
    const document = MarkdownDocument.fromText(`# Design Document

## Overview

A real design overview with actual content.

## Architecture

Single-module approach.

## Components and Interfaces

- One component.

## Failure Handling

- Errors are returned to the caller.

## Security Considerations

- None beyond the platform defaults.

## Risks and Trade-offs

- None.
`);
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, design: document },
      design: parseDesign(document),
    };
    const result = analyzeSpecStage(patched, 'design', STRICT);
    const finding = result.diagnostics.find((d) => d.code === 'DESIGN_NO_TESTING_STRATEGY');
    expect(finding?.severity).toBe('warning');
  });

  it('a pending design stub reports placeholders as warnings while blocked', () => {
    const { spec, workspace } = specOf('v02-requirements-first', 'notification-preferences');
    const evaluation = evaluationOf(workspace, 'notification-preferences');
    const result = analyzeSpecWorkflow(spec, evaluation);
    const designPlaceholders = result.diagnostics.filter((d) => d.code.startsWith('DESIGN_PLACEHOLDER'));
    // Design stage is draft (requirements approved) so placeholders are errors there;
    // tasks is still blocked so its placeholders are warnings.
    expect(designPlaceholders.every((d) => d.severity === 'error')).toBe(true);
    const tasksPlaceholders = result.diagnostics.filter((d) => d.code.startsWith('TASKS_PLACEHOLDER'));
    expect(tasksPlaceholders.every((d) => d.severity === 'warning')).toBe(true);
  });
});

describe('tasks analysis', () => {
  it('a task plan without a test task is flagged (test 48)', () => {
    const document = MarkdownDocument.fromText(`# Implementation Plan

- [ ] 1. Implement the feature
- [ ] 2. Update documentation
`);
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, tasks: document },
      tasks: parseTasks(document),
    };
    const result = analyzeSpecStage(patched, 'tasks', STRICT);
    expect(codes(result.diagnostics)).toContain('TASKS_NO_TEST_TASK');
  });

  it('nested task consistency is checked (test 49)', () => {
    const document = MarkdownDocument.fromText(`# Implementation Plan

- [x] 1. Parent marked complete
  - [ ] 1.1 Required child still open
  - [x] 1.2 Done child
- [ ] 2. Add tests
- [ ] 3. Verify behavior
`);
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, tasks: document },
      tasks: parseTasks(document),
    };
    const result = analyzeSpecStage(patched, 'tasks', STRICT);
    const finding = result.diagnostics.find((d) => d.code === 'TASKS_PARENT_COMPLETE_CHILD_OPEN');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('1');
  });

  it('tasks referencing nonexistent requirement ids are flagged', () => {
    const document = MarkdownDocument.fromText(`# Implementation Plan

- [ ] 1. Implement something
  - _Requirements: 9.9_
- [ ] 2. Add tests
- [ ] 3. Verify behavior
`);
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, tasks: document },
      tasks: parseTasks(document),
    };
    const result = analyzeSpecStage(patched, 'tasks', STRICT);
    const finding = result.diagnostics.find((d) => d.code === 'TASKS_UNKNOWN_REQUIREMENT_REF');
    expect(finding?.message).toContain('9.9');
  });

  it('completed tasks before approval are flagged when the plan is unapproved', () => {
    const document = MarkdownDocument.fromText(`# Implementation Plan

- [x] 1. Implement something already
- [ ] 2. Add tests
- [ ] 3. Verify behavior
`);
    const { spec } = specOf('v02-requirements-first', 'notification-preferences');
    const patched: SpecAnalysis = {
      ...spec,
      documents: { ...spec.documents, tasks: document },
      tasks: parseTasks(document),
    };
    const result = analyzeSpecStage(patched, 'tasks', {
      ...STRICT,
      stageStatus: 'draft',
    });
    expect(codes(result.diagnostics)).toContain('TASKS_COMPLETED_BEFORE_APPROVAL');
  });
});

describe('placeholder scanning', () => {
  it('recognizes every placeholder family and ignores code fences', () => {
    const document = MarkdownDocument.fromText(`# Doc

As a <role> I want <capability>.

TODO: finish this. TBD.

- Add edge cases here.

Describe the correct behavior here.

\`\`\`html
<div>not a placeholder</div>
TODO: not scanned either
\`\`\`

Real content line that stays unflagged.
`);
    const scan = scanPlaceholders(document);
    const texts = scan.hits.map((hit) => hit.text).join('\n');
    expect(texts).toContain('<role>');
    expect(texts).toContain('<capability>');
    expect(texts).toContain('TODO');
    expect(texts).toContain('Add edge cases here.');
    expect(texts).toContain('Describe the correct behavior here.');
    expect(texts).not.toContain('div');
    expect(scan.placeholderOnly).toBe(false);
  });
});
