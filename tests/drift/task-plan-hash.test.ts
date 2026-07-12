import { describe, expect, it } from 'vitest';
import { MarkdownDocument, normalizedTaskPlanText, taskFingerprint, taskPlanHash } from '@specbridge/compat-kiro';

/**
 * Hash semantics v2: the plan hash ignores exactly one thing — recognized
 * checkbox state characters. Everything else is byte-significant.
 */

const PLAN = `# Implementation Plan

- [ ] 1. First task
  - _Requirements: 1.1_
- [ ] 2. Parent task
  - [ ] 2.1 Child task
    - _Requirements: 1.2_
- [ ]* 3. Optional task
`;

function hashOf(text: string): string {
  return taskPlanHash(MarkdownDocument.fromText(text));
}

describe('normalized task-plan hashing (semantics v2)', () => {
  it('checkbox-only progress keeps the plan hash stable', () => {
    const progressed = PLAN.replace('- [ ] 1.', '- [x] 1.').replace('- [ ] 2.1', '- [x] 2.1');
    expect(hashOf(progressed)).toBe(hashOf(PLAN));
  });

  it('in-progress and uppercase states normalize like done', () => {
    expect(hashOf(PLAN.replace('- [ ] 1.', '- [-] 1.'))).toBe(hashOf(PLAN));
    expect(hashOf(PLAN.replace('- [ ] 1.', '- [X] 1.'))).toBe(hashOf(PLAN));
    expect(hashOf(PLAN.replace('- [ ] 1.', '- [~] 1.'))).toBe(hashOf(PLAN));
  });

  it('task text changes invalidate the plan hash', () => {
    expect(hashOf(PLAN.replace('First task', 'First task renamed'))).not.toBe(hashOf(PLAN));
  });

  it('task ID changes invalidate the plan hash', () => {
    expect(hashOf(PLAN.replace('2.1 Child task', '2.9 Child task'))).not.toBe(hashOf(PLAN));
  });

  it('hierarchy (indentation) changes invalidate the plan hash', () => {
    expect(hashOf(PLAN.replace('  - [ ] 2.1', '- [ ] 2.1'))).not.toBe(hashOf(PLAN));
  });

  it('requirement reference changes invalidate the plan hash', () => {
    expect(hashOf(PLAN.replace('_Requirements: 1.1_', '_Requirements: 1.2_'))).not.toBe(hashOf(PLAN));
  });

  it('adding or removing tasks invalidates the plan hash', () => {
    expect(hashOf(`${PLAN}- [ ] 4. New task\n`)).not.toBe(hashOf(PLAN));
  });

  it('unknown checkbox state characters are content, not progress', () => {
    expect(hashOf(PLAN.replace('- [ ] 1.', '- [?] 1.'))).not.toBe(hashOf(PLAN));
  });

  it('checkbox-looking lines inside code fences are never normalized', () => {
    const fenced = `${PLAN}\n\`\`\`md\n- [ ] example inside a fence\n\`\`\`\n`;
    const fencedChecked = fenced.replace('- [ ] example inside a fence', '- [x] example inside a fence');
    expect(hashOf(fencedChecked)).not.toBe(hashOf(fenced));
  });

  it('line-ending and BOM changes stay byte-significant', () => {
    const crlf = PLAN.split('\n').join('\r\n');
    expect(hashOf(crlf)).not.toBe(hashOf(PLAN));
    const withBom = String.fromCharCode(0xfeff) + PLAN;
    expect(hashOf(withBom)).not.toBe(hashOf(PLAN));
  });

  it('normalizedTaskPlanText only rewrites the state character', () => {
    const progressed = PLAN.replace('- [ ] 1.', '- [x] 1.');
    expect(normalizedTaskPlanText(MarkdownDocument.fromText(progressed))).toBe(
      normalizedTaskPlanText(MarkdownDocument.fromText(PLAN)),
    );
    expect(normalizedTaskPlanText(MarkdownDocument.fromText(PLAN))).toBe(PLAN);
  });
});

describe('task fingerprints', () => {
  it('are stable across checkbox progress and change with identity', () => {
    const base = { id: '2.1', title: 'Child task', requirementRefs: ['1.2'] };
    expect(taskFingerprint(base)).toBe(taskFingerprint({ ...base }));
    expect(taskFingerprint({ ...base, title: 'Renamed' })).not.toBe(taskFingerprint(base));
    expect(taskFingerprint({ ...base, id: '2.2' })).not.toBe(taskFingerprint(base));
    expect(taskFingerprint({ ...base, requirementRefs: ['1.1'] })).not.toBe(taskFingerprint(base));
  });
});
