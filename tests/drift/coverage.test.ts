import { describe, expect, it } from 'vitest';
import { MarkdownDocument, parseRequirements, parseTasks } from '@specbridge/compat-kiro';
import type { TaskEvidence } from '@specbridge/drift';
import {
  assessRequirementCoverage,
  assessTaskCoverage,
  buildDriftReport,
  driftExitCode,
} from '@specbridge/drift';
import { fixturePath } from '../helpers.js';

describe('requirement coverage (deterministic)', () => {
  it('reports full coverage for the standard fixture', () => {
    const requirements = parseRequirements(
      MarkdownDocument.load(
        fixturePath('standard-feature', '.kiro', 'specs', 'user-authentication', 'requirements.md'),
      ),
    );
    const tasks = parseTasks(
      MarkdownDocument.load(
        fixturePath('standard-feature', '.kiro', 'specs', 'user-authentication', 'tasks.md'),
      ),
    );
    const result = assessRequirementCoverage(requirements, tasks);
    expect(result.uncoveredCriterionIds).toEqual([]);
    expect(result.coveredCriterionIds).toEqual(['1.1', '1.2', '1.3', '2.1', '2.2', '2.3']);
  });

  it('finds criteria no task references', () => {
    const requirements = parseRequirements(
      MarkdownDocument.fromText(
        [
          '# R',
          '### Requirement 1',
          '#### Acceptance Criteria',
          '1. WHEN a THEN the system SHALL b',
          '2. WHEN c THEN the system SHALL d',
          '',
        ].join('\n'),
      ),
    );
    const tasks = parseTasks(
      MarkdownDocument.fromText(['- [ ] 1. only covers one', '  - _Requirements: 1.1_', ''].join('\n')),
    );
    const result = assessRequirementCoverage(requirements, tasks);
    expect(result.uncoveredCriterionIds).toEqual(['1.2']);
    expect(result.findings.some((f) => f.severity === 'warn')).toBe(true);
  });

  it('a whole-requirement reference covers all its criteria', () => {
    const requirements = parseRequirements(
      MarkdownDocument.fromText(
        ['# R', '### Requirement 2', '#### Acceptance Criteria', '1. WHEN x THEN the system SHALL y', ''].join('\n'),
      ),
    );
    const tasks = parseTasks(
      MarkdownDocument.fromText(['- [ ] 1. broad task', '  - _Requirements: 2_', ''].join('\n')),
    );
    expect(assessRequirementCoverage(requirements, tasks).uncoveredCriterionIds).toEqual([]);
  });

  it('flags unlinked tasks only when linking is in use', () => {
    const requirements = parseRequirements(MarkdownDocument.fromText('# R\n'));
    const linked = parseTasks(
      MarkdownDocument.fromText(
        ['- [ ] 1. linked', '  - _Requirements: 1.1_', '- [ ] 2. not linked', ''].join('\n'),
      ),
    );
    expect(assessRequirementCoverage(requirements, linked).unlinkedTaskIds).toEqual(['2']);

    const unlinked = parseTasks(
      MarkdownDocument.fromText(['- [ ] 1. a', '- [ ] 2. b', ''].join('\n')),
    );
    expect(assessRequirementCoverage(requirements, unlinked).unlinkedTaskIds).toEqual([]);
  });
});

describe('task coverage against evidence (deterministic)', () => {
  const tasks = parseTasks(
    MarkdownDocument.fromText(
      [
        '- [x] 1. verified work',
        '- [x] 2. recorded but unverified',
        '- [x] 3. no evidence at all',
        '- [ ] 4. open with evidence',
        '- [ ] 5. open, untouched',
        '',
      ].join('\n'),
    ),
  );
  const evidence: TaskEvidence[] = [
    { taskId: '1', status: 'verified', commands: [{ command: 'npm test', exitCode: 0 }] },
    { taskId: '2', status: 'recorded' },
    { taskId: '4', status: 'recorded' },
  ];

  it('buckets tasks into verified / unverified / likely-incomplete / unknown', () => {
    const result = assessTaskCoverage(tasks, evidence);
    const byId = new Map(result.entries.map((e) => [e.taskId, e.assessment]));
    expect(byId.get('1')).toBe('verified');
    expect(byId.get('2')).toBe('implemented-unverified');
    expect(byId.get('3')).toBe('likely-incomplete');
    expect(byId.get('4')).toBe('implemented-unverified');
    expect(byId.get('5')).toBe('unknown');
  });

  it('produces a failing drift report with exit code 1', () => {
    const result = assessTaskCoverage(tasks, evidence);
    const report = buildDriftReport('example', result.findings);
    expect(report.result).toBe('failed');
    expect(report.summary.fail).toBe(1); // task 3: complete without evidence
    expect(driftExitCode(report)).toBe(1);
  });

  it('passes when every completed task has verified evidence', () => {
    const cleanTasks = parseTasks(MarkdownDocument.fromText('- [x] 1. done\n- [ ] 2. open\n'));
    const result = assessTaskCoverage(cleanTasks, [{ taskId: '1', status: 'verified' }]);
    const report = buildDriftReport('example', result.findings);
    expect(report.result).toBe('passed');
    expect(driftExitCode(report)).toBe(0);
  });
});
