import { describe, expect, it } from 'vitest';
import {
  MarkdownDocument,
  buildRequirementCatalog,
  canonicalRequirementRef,
  extractPathReferences,
  extractTaskRequirementReferences,
  isLikelyNonRequirementTask,
  mentionsTests,
  parseRequirements,
  parseTasks,
  taskMentionsTests,
} from '@specbridge/compat-kiro';

describe('canonicalRequirementRef', () => {
  it('normalizes the documented identifier shapes', () => {
    expect(canonicalRequirementRef('R1')).toBe('1');
    expect(canonicalRequirementRef('r1.1')).toBe('1.1');
    expect(canonicalRequirementRef('REQ-001')).toBe('1');
    expect(canonicalRequirementRef('Requirement 1')).toBe('1');
    expect(canonicalRequirementRef('AC-1')).toBe('1');
    expect(canonicalRequirementRef('AC1.2')).toBe('1.2');
    expect(canonicalRequirementRef('1.1')).toBe('1.1');
    expect(canonicalRequirementRef('2-3')).toBe('2.3');
    expect(canonicalRequirementRef('REQ-010.02')).toBe('10.2');
  });

  it('rejects non-identifier text', () => {
    expect(canonicalRequirementRef('TBD')).toBeUndefined();
    expect(canonicalRequirementRef('see above')).toBeUndefined();
    expect(canonicalRequirementRef('')).toBeUndefined();
    expect(canonicalRequirementRef('R')).toBeUndefined();
  });
});

const REQUIREMENTS = `# Requirements Document

## Requirements

### Requirement 1: Persist settings

**User Story:** As a user, I want settings saved, so that they survive restarts.

#### Acceptance Criteria

1. WHEN the user saves THEN the system SHALL persist it.
2. AC-9: IF persistence fails THEN the system SHALL be tested for rollback.

### REQ-002: Export data

The export path must be covered by integration tests.

1. The system exports settings as JSON.
`;

describe('buildRequirementCatalog', () => {
  const document = MarkdownDocument.fromText(REQUIREMENTS, 'requirements.md');
  const model = parseRequirements(document);
  const catalog = buildRequirementCatalog(model, document);

  it('extracts requirement IDs from the tolerant parser', () => {
    const requirement = catalog.byCanonical.get('1');
    expect(requirement?.kind).toBe('requirement');
    expect(requirement?.displayId).toBe('1');
    expect(requirement?.line).toBeGreaterThan(0);
  });

  it('extracts acceptance criterion IDs with source lines', () => {
    const criterion = catalog.byCanonical.get('1.1');
    expect(criterion?.kind).toBe('criterion');
    expect(criterion?.requirementCanonical).toBe('1');
    const documentLine = document.lineAt(criterion?.line ?? 0).text;
    expect(documentLine).toContain('WHEN the user saves');
  });

  it('recognizes supplemental REQ-### headings the parser does not treat as requirements', () => {
    const supplemental = catalog.byCanonical.get('2');
    expect(supplemental?.method).toBe('id-heading');
    expect(supplemental?.displayId).toBe('REQ-002');
    expect(catalog.byCanonical.get('2.1')?.kind).toBe('criterion');
  });

  it('records explicit AC markers as deterministic aliases', () => {
    const alias = catalog.byCanonical.get('9');
    expect(alias?.method).toBe('explicit-ac-marker');
    expect(alias?.requirementCanonical).toBe('1');
  });

  it('detects test-required language heuristically', () => {
    expect(catalog.byCanonical.get('1.2')?.testRequired).toBe(true);
    expect(catalog.byCanonical.get('1.1')?.testRequired).toBe(false);
    expect(catalog.byCanonical.get('2')?.testRequired).toBe(true);
    expect(mentionsTests('the latest value')).toBe(false);
  });
});

const TASKS = `# Implementation Plan

- [ ] 1. Build the store
  - _Requirements: 1.1, 1.2_
- [ ] 2. Wire the API [R1]
  - Requirements: REQ-002
- [ ] 3. Polish integration — supports 1.2
  - Implements REQ-001
- [ ] 4. Write unit tests for the store
- [ ] 5. Update documentation and changelog
`;

describe('extractTaskRequirementReferences', () => {
  const document = MarkdownDocument.fromText(TASKS, 'tasks.md');
  const model = parseTasks(document);
  const references = extractTaskRequirementReferences(document, model);

  it('extracts the documented underscore form with line numbers', () => {
    const refs = references.filter((ref) => ref.taskId === '1');
    expect(refs.map((ref) => ref.canonical).sort()).toEqual(['1.1', '1.2']);
    expect(refs[0]?.method).toBe('underscore-refs');
    expect(refs[0]?.confidence).toBe('deterministic');
    expect(document.lineAt(refs[0]?.line ?? 0).text).toContain('_Requirements:');
  });

  it('extracts bracket references and bare Requirements: lines', () => {
    const refs = references.filter((ref) => ref.taskId === '2');
    const methods = new Set(refs.map((ref) => ref.method));
    expect(methods.has('bracket-ref')).toBe(true);
    expect(methods.has('refs-line')).toBe(true);
    expect(refs.some((ref) => ref.canonical === '1')).toBe(true);
    expect(refs.some((ref) => ref.canonical === '2')).toBe(true);
  });

  it('extracts keyword references as heuristic', () => {
    const refs = references.filter((ref) => ref.taskId === '3');
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) expect(ref.confidence).toBe('heuristic');
    expect(refs.map((ref) => ref.canonical).sort()).toEqual(['1', '1.2']);
  });

  it('leaves unlinked tasks without references', () => {
    expect(references.filter((ref) => ref.taskId === '4')).toHaveLength(0);
  });

  it('detects test language on tasks and excludes chore-like tasks', () => {
    const testTask = model.allTasks.find((task) => task.id === '4');
    const choreTask = model.allTasks.find((task) => task.id === '5');
    expect(taskMentionsTests(document, model, testTask!)).toBe(true);
    expect(taskMentionsTests(document, model, choreTask!)).toBe(false);
    expect(isLikelyNonRequirementTask(choreTask!)).toBe(true);
    expect(isLikelyNonRequirementTask(testTask!)).toBe(false);
  });
});

describe('extractPathReferences', () => {
  const DESIGN = `# Design

The store lives in \`src/settings/store.ts\` and is covered by
[the test plan](docs/testing.md). Windows authors sometimes write
\`src\\settings\\windows.ts\`. Impact spans \`src/settings/**\`.

Not paths: \`npm install\`, \`foo(bar)\`, [site](https://example.com),
\`config.json\`, \`../outside/escape.ts\`, [anchor](#section).
`;
  const references = extractPathReferences(MarkdownDocument.fromText(DESIGN, 'design.md'));
  const paths = references.map((ref) => ref.path);

  it('extracts backtick paths and markdown links with lines and methods', () => {
    expect(paths).toContain('src/settings/store.ts');
    expect(paths).toContain('docs/testing.md');
    const link = references.find((ref) => ref.path === 'docs/testing.md');
    expect(link?.method).toBe('markdown-link');
    const backtick = references.find((ref) => ref.path === 'src/settings/store.ts');
    expect(backtick?.method).toBe('backtick-path');
    expect(backtick?.confidence).toBe('deterministic');
  });

  it('normalizes Windows separators', () => {
    expect(paths).toContain('src/settings/windows.ts');
  });

  it('marks glob patterns without treating them as files', () => {
    const glob = references.find((ref) => ref.path === 'src/settings/**');
    expect(glob?.isGlob).toBe(true);
  });

  it('rejects URLs, code tokens, bare filenames, anchors, and traversal', () => {
    expect(paths).not.toContain('npm install');
    expect(paths.some((p) => p.includes('example.com'))).toBe(false);
    expect(paths).not.toContain('config.json');
    expect(paths.some((p) => p.includes('..'))).toBe(false);
  });
});

describe('non-English content', () => {
  it('preserves and extracts UTF-8 identifiers and titles', () => {
    const document = MarkdownDocument.fromText(
      `# Anforderungen

### Requirement 1: Einstellungen dauerhaft speichern

#### Acceptance Criteria

1. WENN gespeichert wird, DANN SHALL das System den Wert persistieren.
`,
      'requirements.md',
    );
    const catalog = buildRequirementCatalog(parseRequirements(document), document);
    expect(catalog.byCanonical.get('1')?.title).toBe('Einstellungen dauerhaft speichern');
    expect(catalog.byCanonical.get('1.1')).toBeDefined();
  });
});
