/**
 * Drift report assembly. Findings come from the deterministic coverage and
 * impact-area checks; no LLM is involved anywhere in this package.
 *
 * Exit-code contract (used by CI quality gates):
 *   0 = passed, 1 = drift / quality-gate failure, 2 = invalid configuration
 *   or runtime error (thrown, not encoded in the report).
 */

export type DriftSeverity = 'pass' | 'info' | 'warn' | 'fail';

export interface DriftFinding {
  category:
    | 'task-evidence'
    | 'test-evidence'
    | 'impact-area'
    | 'requirement-coverage'
    | 'task-linking'
    | 'required-files'
    | 'checkbox-state'
    | 'verification-command';
  severity: DriftSeverity;
  message: string;
  related?: {
    file?: string;
    taskId?: string;
    requirementId?: string;
  };
}

export interface DriftReport {
  specName: string;
  findings: DriftFinding[];
  summary: { pass: number; info: number; warn: number; fail: number };
  result: 'passed' | 'failed';
}

export function buildDriftReport(specName: string, findings: DriftFinding[]): DriftReport {
  const summary = { pass: 0, info: 0, warn: 0, fail: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return {
    specName,
    findings,
    summary,
    result: summary.fail > 0 ? 'failed' : 'passed',
  };
}

export function driftExitCode(report: DriftReport): 0 | 1 {
  return report.result === 'passed' ? 0 : 1;
}
