import { existsSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConcreteSpecType, ConcreteWorkflowMode, WorkspaceInfo } from '@specbridge/core';
import { writeFileAtomic } from '@specbridge/core';
import type { Clock } from '@specbridge/workflow';
import { systemClock } from '@specbridge/workflow';
import { TemplateError } from './errors.js';
import { validateTemplateId } from './ids.js';
import { ALLOWED_TARGETS, TEMPLATE_MANIFEST_FILE_NAME } from './manifest.js';
import { loadTemplatePack } from './pack.js';
import { appendTemplateRecord, newTemplateRecordId, nowIso } from './records.js';

/**
 * Template scaffolding for community contributors.
 *
 * Generates a complete, valid, community-ready template pack: manifest,
 * README with local validation instructions and a contribution checklist,
 * and plain-Markdown template files. No executable code, no installation,
 * no publication — the output is a starting point the author edits and then
 * validates with `specbridge template validate <path>`.
 */

export interface TemplateScaffoldRequest {
  templateId: string;
  kind: ConcreteSpecType;
  modes?: ConcreteWorkflowMode[];
  displayName?: string;
  description?: string;
  license?: string;
  outputPath: string;
  /** Base for resolving a relative outputPath. */
  cwd: string;
}

export interface TemplateScaffoldPlan {
  templateId: string;
  kind: ConcreteSpecType;
  outputDir: string;
  /** Pack-relative POSIX path -> content, in write order. */
  files: Map<string, string>;
}

function titleCase(id: string): string {
  return id
    .split('-')
    .map((part) => (part.length > 0 ? part[0]?.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

const CONTRIBUTION_CHECKLIST = `## Contribution checklist

Before sharing this template (or opening a pull request to add it as a
SpecBridge built-in):

- [ ] \`specbridge template validate ./<this-directory>\` passes with no errors.
- [ ] \`specbridge template preview\` output reads well with realistic variable values.
- [ ] The README documents every variable and shows a copy-pasteable usage example.
- [ ] Template files are plain Markdown — no scripts, no HTML, no front matter.
- [ ] No employer-specific, vendor-locked, or machine-specific content.
- [ ] The manifest "examples" array shows at least one real, working command.
`;

function scaffoldManifest(request: TemplateScaffoldRequest, modes: ConcreteWorkflowMode[]): string {
  const targets = ALLOWED_TARGETS[request.kind];
  const manifest = {
    schemaVersion: '1.0.0',
    id: request.templateId,
    version: '1.0.0',
    displayName: request.displayName ?? titleCase(request.templateId),
    description:
      request.description ??
      `A ${request.kind} spec template. Describe what kind of change this template is for.`,
    kind: request.kind,
    supportedModes: modes,
    defaultMode: modes[0],
    tags: [request.kind === 'bugfix' ? 'bugfix' : 'feature'],
    files: targets.map((target) => ({
      source: `files/${target}.template`,
      target,
      stage: target === 'requirements.md' ? 'requirements' : target === 'bugfix.md' ? 'bugfix' : target === 'design.md' ? 'design' : 'tasks',
      required: true,
    })),
    variables: [
      {
        name: 'actor',
        description: 'Primary user or system actor.',
        type: 'string',
        required: false,
        default: 'user',
      },
    ],
    compatibility: {
      specbridge: '>=1.0.0 <2.0.0',
      kiroLayout: '1',
    },
    license: request.license ?? 'MIT',
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function scaffoldReadme(request: TemplateScaffoldRequest): string {
  const display = request.displayName ?? titleCase(request.templateId);
  return `# ${display} template

${request.description ?? `A ${request.kind} spec template. Describe what kind of change this template is for.`}

## Usage

\`\`\`bash
specbridge template preview ${request.templateId} \\
  --name my-new-spec \\
  --var actor=user

specbridge template apply ${request.templateId} \\
  --name my-new-spec \\
  --var actor=user
\`\`\`

## Variables

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| \`actor\` | string | \`user\` | Primary user or system actor. |

The built-in variables \`specName\`, \`title\`, \`description\`, \`kind\`, and
\`mode\` are always available.

## Validate locally

\`\`\`bash
# From the directory containing this template pack:
specbridge template validate ./${path.basename(request.outputPath)}

# Then install it into a project for a real preview:
specbridge template install ./${path.basename(request.outputPath)}
specbridge template preview project:${request.templateId} --name example-spec
\`\`\`

${CONTRIBUTION_CHECKLIST}`;
}

function featureRequirementsTemplate(): string {
  return `# Requirements Document

## Introduction

**{{title}}**

{{description}}

## Glossary

| Term | Definition |
| --- | --- |
| <term> | <definition> |

## Requirements

### Requirement 1: <initial requirement title>

**User Story:** As a {{actor}}, I want <capability>, so that <benefit>.

#### Acceptance Criteria

1. WHEN <condition or event>, THE SYSTEM SHALL <expected behavior>.
2. IF <error or exceptional condition>, THEN THE SYSTEM SHALL <safe behavior>.

## Non-Functional Requirements

- Performance: add measurable performance expectations here.
- Security: add authentication, authorization, and data-handling expectations here.
- Reliability: add availability and failure-recovery expectations here.
- Observability: add logging, metrics, and alerting expectations here.
- Compatibility: add platform and integration constraints here.

## Edge Cases

- Add edge cases here.

## Out of Scope

- Add explicitly excluded behavior here.
`;
}

function featureDesignTemplate(): string {
  return `# Design Document

## Overview

**{{title}}**

{{description}}

## Goals

- Add concrete goals here.

## Non-Goals

- Add explicitly excluded goals here.

## Architecture

Describe the overall approach here.

## Components and Interfaces

- Add affected components and their interfaces here.

## Data Model

- Add new or changed data structures here.

## Control Flow

Describe the main control flow here.

## Failure Handling

- Add failure modes and how the system handles them here.

## Security Considerations

- Add authentication, authorization, and data-protection concerns here.

## Observability

- Add logging, metrics, and tracing decisions here.

## Testing Strategy

- Add unit, integration, and regression testing plans here.

## Risks and Trade-offs

- Add known risks and accepted trade-offs here.

## Alternatives Considered

- Add rejected alternatives and why they were rejected here.
`;
}

function featureTasksTemplate(): string {
  return `# Implementation Plan

- [ ] 1. <First implementation task for {{title}}.>
- [ ] 2. <Next implementation task.>
- [ ] 3. Add automated tests for the acceptance criteria.
- [ ] 4. Verify error handling and edge cases.
- [ ] 5. Update documentation where required.
`;
}

function bugfixDocumentTemplate(): string {
  return `# Bugfix Document

## Summary

**{{title}}**

{{description}}

## Current Behavior

Describe the observed incorrect behavior here.

## Expected Behavior

Describe the correct behavior here.

## Unchanged Behavior

- List behavior that must remain unchanged here.

## Reproduction

1. Add reproduction steps here.

## Evidence

- Logs: add relevant log lines here.
- Error messages: add exact error text here.
- Failing tests: add failing test names here.
- Relevant source locations: add file paths here.

## Constraints

- Add implementation or compatibility constraints here.

## Regression Risks

- Add behavior that could regress here.
`;
}

function bugfixDesignTemplate(): string {
  return `# Fix Design

## Root Cause

Document the confirmed or suspected root cause here.

## Proposed Fix

Describe the smallest safe fix here.

## Affected Components

- Add affected files and components here.

## Failure Handling

- Add failure modes introduced or fixed by this change here.

## Alternatives Considered

- Add rejected alternatives and why they were rejected here.

## Regression Protection

- Add the regression tests that will guard this fix here.

## Validation Strategy

- Add the checks that prove the fix works here.
`;
}

function bugfixTasksTemplate(): string {
  return `# Bugfix Implementation Plan

- [ ] 1. Reproduce the bug with deterministic evidence.
- [ ] 2. Confirm the root cause.
- [ ] 3. Implement the smallest safe fix.
- [ ] 4. Add regression tests.
- [ ] 5. Verify unchanged behavior.
- [ ] 6. Run the required validation checks.
`;
}

const DEFAULT_MODES: Record<ConcreteSpecType, ConcreteWorkflowMode[]> = {
  feature: ['requirements-first', 'design-first', 'quick'],
  bugfix: ['requirements-first', 'quick'],
};

export function planTemplateScaffold(request: TemplateScaffoldRequest): TemplateScaffoldPlan {
  const idCheck = validateTemplateId(request.templateId);
  if (!idCheck.valid) {
    throw new TemplateError(
      'SBT003',
      `"${request.templateId}" is not a valid template ID:\n${idCheck.problems.map((p) => `  - ${p}`).join('\n')}`,
      'Valid examples: rest-api, database-migration, cli-tool-v2.',
      { templateId: request.templateId },
    );
  }
  const modes = request.modes !== undefined && request.modes.length > 0 ? request.modes : DEFAULT_MODES[request.kind];
  if (new Set(modes).size !== modes.length) {
    throw new TemplateError('SBT015', '--modes contains duplicates.', 'List each mode once.', {});
  }

  const outputDir = path.resolve(request.cwd, request.outputPath);
  const relative = path.relative(path.resolve(request.cwd), outputDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TemplateError(
      'SBT007',
      `Scaffold output ${outputDir} is outside the current directory.`,
      'Scaffold into the directory you are working in, e.g. --output ./my-template.',
      { path: outputDir },
    );
  }
  if (existsSync(outputDir)) {
    throw new TemplateError(
      'SBT025',
      `Scaffold output directory already exists: ${outputDir}.`,
      'Choose a different --output path; scaffolding never overwrites existing files.',
      { path: outputDir },
    );
  }

  const files = new Map<string, string>();
  files.set(TEMPLATE_MANIFEST_FILE_NAME, scaffoldManifest(request, modes));
  files.set('README.md', scaffoldReadme(request));
  if (request.kind === 'feature') {
    files.set('files/requirements.md.template', featureRequirementsTemplate());
    files.set('files/design.md.template', featureDesignTemplate());
    files.set('files/tasks.md.template', featureTasksTemplate());
  } else {
    files.set('files/bugfix.md.template', bugfixDocumentTemplate());
    files.set('files/design.md.template', bugfixDesignTemplate());
    files.set('files/tasks.md.template', bugfixTasksTemplate());
  }

  // Self-check: a scaffolded pack must always validate cleanly.
  const selfCheck = loadTemplatePack({ origin: outputDir, files }, { requireReadme: true });
  if (!selfCheck.valid) {
    throw new TemplateError(
      'SBT025',
      `Internal error: scaffolded pack failed validation: ${selfCheck.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join(' | ')}`,
      'This is a SpecBridge bug — please report it.',
      {},
    );
  }

  return { templateId: request.templateId, kind: request.kind, outputDir, files };
}

export interface TemplateScaffoldResult {
  plan: TemplateScaffoldPlan;
  writtenFiles: string[];
  recordId: string | undefined;
}

/**
 * Write the scaffold atomically (temp dir + rename). When run inside a
 * SpecBridge workspace, a template-scaffold record is appended; outside a
 * workspace the scaffold still works — contributors do not need a `.kiro`
 * project to author a template pack.
 */
export function executeTemplateScaffold(
  plan: TemplateScaffoldPlan,
  workspace: WorkspaceInfo | undefined,
  clock: Clock = systemClock,
  recordId?: string,
): TemplateScaffoldResult {
  const tmpParent =
    workspace !== undefined ? path.join(workspace.sidecarDir, 'tmp') : path.join(tmpdir(), 'specbridge-scaffold');
  const tempDir = path.join(
    tmpParent,
    `template-scaffold-${plan.templateId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const writtenFiles: string[] = [];
  try {
    mkdirSync(tempDir, { recursive: true });
    for (const [relative, content] of plan.files) {
      const target = path.join(tempDir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, content);
    }
    mkdirSync(path.dirname(plan.outputDir), { recursive: true });
    if (existsSync(plan.outputDir)) {
      throw new TemplateError(
        'SBT025',
        `Scaffold output directory was created by another process: ${plan.outputDir}.`,
        'Choose a different --output path; scaffolding never overwrites existing files.',
        { path: plan.outputDir },
      );
    }
    renameSync(tempDir, plan.outputDir);
    for (const relative of plan.files.keys()) {
      writtenFiles.push(path.join(plan.outputDir, relative));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    try {
      rmdirSync(tmpParent);
    } catch {
      // Not empty or already gone — either is fine.
    }
  }

  let id: string | undefined;
  if (workspace !== undefined) {
    id = recordId ?? newTemplateRecordId(clock);
    appendTemplateRecord(workspace, {
      schemaVersion: '1.0.0',
      recordId: id,
      type: 'template-scaffold',
      createdAt: nowIso(clock),
      result: 'ok',
      templateId: plan.templateId,
      kind: plan.kind,
      outputPath: path.relative(workspace.rootDir, plan.outputDir).split(path.sep).join('/'),
    });
  }

  return { plan, writtenFiles, recordId: id };
}
