import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@specbridge/core';
import {
  BUILT_IN_PROTECTED_PATHS,
  compilePathMatchers,
  readVerificationPolicy,
  resolveEffectivePolicy,
  validateGlobPattern,
  verificationPolicySchema,
} from '@specbridge/drift';
import { copyFixtureToTemp } from '../helpers.js';

const SPEC = 'settings-persistence';

function setup(): { root: string; workspace: NonNullable<ReturnType<typeof resolveWorkspace>> } {
  const root = copyFixtureToTemp('v03-ready-feature');
  const workspace = resolveWorkspace(root);
  if (workspace === undefined) throw new Error('no workspace');
  return { root, workspace };
}

function writePolicy(root: string, content: string): void {
  const dir = path.join(root, '.specbridge', 'policies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${SPEC}.json`), content, 'utf8');
}

describe('glob pattern validation', () => {
  it('accepts repository-relative globs', () => {
    expect(validateGlobPattern('src/**')).toBeUndefined();
    expect(validateGlobPattern('tests/unit/*.test.ts')).toBeUndefined();
  });

  it('rejects absolute paths, traversal, null bytes, backslashes, and empty patterns', () => {
    expect(validateGlobPattern('/etc/**')?.reason).toContain('absolute');
    expect(validateGlobPattern('C:/temp/**')?.reason).toContain('absolute');
    expect(validateGlobPattern('../outside/**')?.reason).toContain('".."');
    expect(validateGlobPattern('src/../../x')?.reason).toContain('".."');
    expect(validateGlobPattern('src\\windows\\**')?.reason).toContain('backslash');
    expect(validateGlobPattern('bad\0null')?.reason).toContain('null byte');
    expect(validateGlobPattern('')?.reason).toContain('empty');
  });
});

describe('policy schema and loader', () => {
  it('parses a valid policy with defaults', () => {
    const parsed = verificationPolicySchema.parse({ specName: SPEC });
    expect(parsed.mode).toBe('advisory');
    expect(parsed.impactAreas).toEqual([]);
    expect(parsed.rules).toEqual({});
  });

  it('rejects invalid rule keys, severities, and glob patterns', () => {
    expect(
      verificationPolicySchema.safeParse({ specName: SPEC, rules: { NOTARULE: {} } }).success,
    ).toBe(false);
    expect(
      verificationPolicySchema.safeParse({
        specName: SPEC,
        rules: { SBV005: { severity: 'fatal' } },
      }).success,
    ).toBe(false);
    expect(
      verificationPolicySchema.safeParse({ specName: SPEC, impactAreas: ['../escape/**'] }).success,
    ).toBe(false);
  });

  it('fail-closed: invalid JSON and shape yield diagnostics, never a policy', () => {
    const { root, workspace } = setup();
    writePolicy(root, '{ not json');
    const invalidJson = readVerificationPolicy(workspace, SPEC);
    expect(invalidJson.policy).toBeUndefined();
    expect(invalidJson.diagnostics[0]?.code).toBe('POLICY_INVALID_JSON');

    writePolicy(root, JSON.stringify({ specName: SPEC, mode: 'draconian' }));
    const invalidShape = readVerificationPolicy(workspace, SPEC);
    expect(invalidShape.policy).toBeUndefined();
    expect(invalidShape.diagnostics[0]?.code).toBe('POLICY_INVALID_SHAPE');

    writePolicy(root, JSON.stringify({ specName: 'other-name' }));
    const mismatch = readVerificationPolicy(workspace, SPEC);
    expect(mismatch.policy).toBeUndefined();
    expect(mismatch.diagnostics[0]?.code).toBe('POLICY_NAME_MISMATCH');
  });
});

describe('effective policy precedence', () => {
  it('uses secure defaults when no policy exists', () => {
    const { workspace } = setup();
    const effective = resolveEffectivePolicy(workspace, SPEC);
    expect(effective.mode).toBe('advisory');
    expect(effective.policyExists).toBe(false);
    for (const pattern of BUILT_IN_PROTECTED_PATHS) {
      expect(effective.protectedPaths).toContain(pattern);
    }
  });

  it('merges global protected paths and per-spec additions on top of built-ins', () => {
    const { root, workspace } = setup();
    writePolicy(
      root,
      JSON.stringify({ specName: SPEC, protectedPaths: ['infra/terraform/**'] }),
    );
    const effective = resolveEffectivePolicy(workspace, SPEC, {
      globalProtectedPaths: ['generated'],
    });
    expect(effective.protectedPaths).toContain('.git/**');
    expect(effective.protectedPaths).toContain('generated/**');
    expect(effective.protectedPaths).toContain('infra/terraform/**');
  });

  it('.git/** protection cannot be removed by any layer', () => {
    const { root, workspace } = setup();
    writePolicy(root, JSON.stringify({ specName: SPEC, protectedPaths: [] }));
    const effective = resolveEffectivePolicy(workspace, SPEC);
    expect(effective.protectedPaths).toContain('.git/**');
  });

  it('--strict tightens the stored mode but never loosens it', () => {
    const { root, workspace } = setup();
    writePolicy(root, JSON.stringify({ specName: SPEC, mode: 'advisory' }));
    const tightened = resolveEffectivePolicy(workspace, SPEC, { strict: true });
    expect(tightened.mode).toBe('strict');
    expect(tightened.strictFromCli).toBe(true);

    writePolicy(root, JSON.stringify({ specName: SPEC, mode: 'strict' }));
    const unchanged = resolveEffectivePolicy(workspace, SPEC, { strict: false });
    expect(unchanged.mode).toBe('strict');
  });
});

describe('compilePathMatchers', () => {
  it('matches repo-relative paths, normalizing Windows separators', () => {
    const matcher = compilePathMatchers(['src/settings/**', 'tests/**']);
    expect(matcher('src/settings/store.ts')).toEqual(['src/settings/**']);
    expect(matcher('src\\settings\\store.ts')).toEqual(['src/settings/**']);
    expect(matcher('src/billing/invoice.ts')).toEqual([]);
    expect(matcher('.kiro/specs/x/requirements.md')).toEqual([]);
  });

  it('matches dotfiles (protected paths depend on it)', () => {
    const matcher = compilePathMatchers(['.kiro/**', '.specbridge/config.json']);
    expect(matcher('.kiro/specs/a/tasks.md')).toEqual(['.kiro/**']);
    expect(matcher('.specbridge/config.json')).toEqual(['.specbridge/config.json']);
  });
});
