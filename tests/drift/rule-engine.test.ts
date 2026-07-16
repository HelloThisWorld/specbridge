import { describe, expect, it } from 'vitest';
import {
  compareVerificationDiagnostics,
  sortVerificationDiagnostics,
  verificationDiagnosticSchema,
} from '@specbridge/core';
import type { VerificationDiagnostic } from '@specbridge/core';
import {
  builtInVerificationRules,
  describeDefaultSeverity,
  findRule,
  makeDiagnostic,
  resolveGlobalRuleConfig,
  resolveRuleConfig,
} from '@specbridge/drift';

describe('built-in rule registry', () => {
  const rules = builtInVerificationRules();

  it('contains exactly SBV001–SBV026 in order, with unique stable IDs', () => {
    const ids = rules.map((rule) => rule.id);
    // SBV026 (extension verifier rollup) was added in v0.7.1.
    const expected = Array.from({ length: 26 }, (_, index) => `SBV${String(index + 1).padStart(3, '0')}`);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deterministic across calls', () => {
    const again = builtInVerificationRules();
    expect(again.map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id));
    expect(again.map((rule) => rule.title)).toEqual(rules.map((rule) => rule.title));
  });

  it('heuristic rules never default to error in any mode', () => {
    for (const rule of rules) {
      if (rule.confidence !== 'heuristic') continue;
      expect(rule.defaultSeverity.advisory, rule.id).not.toBe('error');
      expect(rule.defaultSeverity.strict, rule.id).not.toBe('error');
    }
  });

  it('every rule documents its trigger and resolution for verify explain', () => {
    for (const rule of rules) {
      expect(rule.title.length, rule.id).toBeGreaterThan(0);
      expect(rule.triggeredWhen.length, rule.id).toBeGreaterThan(20);
      expect(rule.resolution.length, rule.id).toBeGreaterThan(20);
      expect(describeDefaultSeverity(rule).length).toBeGreaterThan(0);
    }
  });

  it('findRule resolves case-insensitively and rejects unknown ids', () => {
    expect(findRule('sbv005')?.id).toBe('SBV005');
    expect(findRule('SBV999')).toBeUndefined();
  });
});

describe('rule configuration resolution', () => {
  const rule = findRule('SBV005')!; // advisory: warning, strict: error

  it('resolves mode-dependent defaults', () => {
    expect(resolveRuleConfig(rule, { mode: 'advisory', ruleOverrides: {} }).severity).toBe('warning');
    expect(resolveRuleConfig(rule, { mode: 'strict', ruleOverrides: {} }).severity).toBe('error');
  });

  it('applies explicit severity overrides and disabling', () => {
    const overridden = resolveRuleConfig(rule, {
      mode: 'advisory',
      ruleOverrides: { SBV005: { enabled: true, severity: 'error' } },
    });
    expect(overridden.severity).toBe('error');
    expect(overridden.overridden).toBe(true);

    const disabled = resolveRuleConfig(rule, {
      mode: 'strict',
      ruleOverrides: { SBV005: { enabled: false } },
    });
    expect(disabled.enabled).toBe(false);
  });

  it('global rules take the strictest severity and stay enabled unless all disable them', () => {
    const sbv014 = findRule('SBV014')!;
    const strictest = resolveGlobalRuleConfig(sbv014, [
      { mode: 'advisory', ruleOverrides: {} },
      { mode: 'advisory', ruleOverrides: { SBV014: { enabled: true, severity: 'error' } } },
    ]);
    expect(strictest.severity).toBe('error');

    const oneDisables = resolveGlobalRuleConfig(sbv014, [
      { mode: 'advisory', ruleOverrides: { SBV014: { enabled: false } } },
      { mode: 'advisory', ruleOverrides: {} },
    ]);
    expect(oneDisables.enabled).toBe(true);

    const allDisable = resolveGlobalRuleConfig(sbv014, [
      { mode: 'advisory', ruleOverrides: { SBV014: { enabled: false } } },
      { mode: 'strict', ruleOverrides: { SBV014: { enabled: false } } },
    ]);
    expect(allDisable.enabled).toBe(false);
  });
});

describe('diagnostic construction and ordering', () => {
  const rule = findRule('SBV005')!;

  it('makeDiagnostic produces schema-valid diagnostics with source locations', () => {
    const diagnostic = makeDiagnostic({
      rule,
      severity: 'error',
      message: 'src/billing/BillingService.ts is outside the declared impact areas.',
      specName: 'notification-preferences',
      file: { path: 'src/billing/BillingService.ts', line: 12, column: 3 },
      evidence: { declaredImpactAreas: ['src/notifications/**'] },
    });
    expect(() => verificationDiagnosticSchema.parse(diagnostic)).not.toThrow();
    expect(diagnostic.file).toEqual({ path: 'src/billing/BillingService.ts', line: 12, column: 3 });
    expect(diagnostic.remediation).toBe(rule.resolution);
    expect(diagnostic.taskId).toBeNull();
    expect(diagnostic.confidence).toBe('deterministic');
  });

  it('sorts deterministically: severity, rule, file, line, task, message', () => {
    const base = (overrides: Partial<VerificationDiagnostic>): VerificationDiagnostic =>
      verificationDiagnosticSchema.parse({
        schemaVersion: '1.0.0',
        ruleId: 'SBV005',
        title: 't',
        severity: 'warning',
        category: 'impact-area',
        message: 'm',
        remediation: 'r',
        specName: null,
        taskId: null,
        requirementId: null,
        file: null,
        evidence: {},
        confidence: 'deterministic',
        ...overrides,
      });
    const diagnostics = [
      base({ severity: 'info', message: 'z' }),
      base({ severity: 'error', ruleId: 'SBV009' }),
      base({ severity: 'error', ruleId: 'SBV002' }),
      base({ file: { path: 'b.ts', line: 2, column: null } }),
      base({ file: { path: 'b.ts', line: 1, column: null } }),
      base({ file: { path: 'a.ts', line: 9, column: null } }),
    ];
    const sorted = sortVerificationDiagnostics(diagnostics);
    expect(sorted.map((d) => `${d.severity}:${d.ruleId}:${d.file?.path ?? '-'}:${d.file?.line ?? 0}`)).toEqual([
      'error:SBV002:-:0',
      'error:SBV009:-:0',
      'warning:SBV005:a.ts:9',
      'warning:SBV005:b.ts:1',
      'warning:SBV005:b.ts:2',
      'info:SBV005:-:0',
    ]);
    // Stable under re-sort.
    expect(sortVerificationDiagnostics(sorted)).toEqual(sorted);
    expect(compareVerificationDiagnostics(sorted[0]!, sorted[0]!)).toBe(0);
  });
});
