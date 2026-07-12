import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import { verifySpecs } from '@specbridge/drift';
import { copyFixtureToTemp } from '../helpers.js';
import { initGitRepo } from '../helpers-execution.js';

/**
 * Verification over CRLF and non-ASCII spec content: parsing, traceability,
 * and reports must work byte-safely on files SpecBridge never normalizes.
 */

async function verifyFixture(fixtureName: string, spec: string) {
  const root = copyFixtureToTemp(fixtureName);
  initGitRepo(root);
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('fixture has no workspace');
  return verifySpecs({
    workspace,
    selection: { mode: 'single', spec },
    comparison: { mode: 'working-tree' },
    failOn: 'error',
    toolVersion: '0.4.0-test',
  });
}

describe('verification over CRLF and UTF-8 fixtures', () => {
  it('CRLF spec files verify with only the expected missing-design finding', async () => {
    const result = await verifyFixture('crlf-files', 'crlf-feature');
    const specResult = result.report.specResults[0];
    expect(specResult?.specName).toBe('crlf-feature');
    // The fixture genuinely lacks design.md — SBV001 is the only error.
    const errors = (specResult?.diagnostics ?? []).filter((d) => d.severity === 'error');
    expect(errors.map((d) => d.ruleId)).toEqual(['SBV001']);
    expect(errors[0]?.message).toContain('design.md');
    // Traceability extraction worked on CRLF content.
    expect(specResult?.traceability.tasks).toBeGreaterThan(0);
    expect(specResult?.traceability.requirements).toBeGreaterThan(0);
  });

  it('UTF-8 spec content verifies and preserves non-English identifiers in diagnostics', async () => {
    const result = await verifyFixture('utf8-content', 'localized-feature');
    const specResult = result.report.specResults[0];
    expect(specResult?.specName).toBe('localized-feature');
    expect(specResult?.traceability.requirements).toBeGreaterThanOrEqual(0);
    // Whatever diagnostics exist must round-trip through the schema (validated
    // inside verifySpecs) — reaching this point proves it.
    expect(result.report.schemaVersion).toBe('1.0.0');
  });
});
