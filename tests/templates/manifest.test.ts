import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_ERROR_CODES,
  parseTemplateManifest,
  parseTemplateReference,
  semverSatisfies,
  validateSemverRange,
  validateTemplateId,
} from '@specbridge/templates';
import { featureManifest, bugfixManifest } from '../helpers-templates';

function manifestText(manifest: Record<string, unknown>): string {
  return JSON.stringify(manifest, null, 2);
}

function errorsOf(manifest: Record<string, unknown>): string[] {
  return parseTemplateManifest(manifestText(manifest))
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.code}:${issue.message}`);
}

describe('template ID validation', () => {
  it('accepts documented valid IDs', () => {
    for (const id of ['rest-api', 'database-migration', 'bugfix-regression', 'cli-tool-v2']) {
      expect(validateTemplateId(id).valid, id).toBe(true);
    }
  });

  it('rejects documented invalid IDs', () => {
    for (const id of [
      'REST-API',
      'rest_api',
      '../rest-api',
      'rest/api',
      '-rest-api',
      'rest-api-',
      'rest--api',
      '',
      'rest api',
      'a'.repeat(65),
      'rest\0api',
    ]) {
      expect(validateTemplateId(id).valid, JSON.stringify(id)).toBe(false);
    }
  });
});

describe('template references', () => {
  it('parses qualified and unqualified references', () => {
    expect(parseTemplateReference('rest-api')).toEqual({ source: undefined, id: 'rest-api' });
    expect(parseTemplateReference('builtin:rest-api')).toEqual({ source: 'builtin', id: 'rest-api' });
    expect(parseTemplateReference('project:rest-api')).toEqual({ source: 'project', id: 'rest-api' });
  });

  it('rejects unknown sources and invalid ids', () => {
    expect(parseTemplateReference('npm:rest-api')).toBeUndefined();
    expect(parseTemplateReference('builtin:REST')).toBeUndefined();
    expect(parseTemplateReference('builtin:../x')).toBeUndefined();
  });
});

describe('semver ranges', () => {
  it('validates supported comparator syntax only', () => {
    expect(validateSemverRange('>=0.7.0 <1.0.0').valid).toBe(true);
    expect(validateSemverRange('=1.2.3').valid).toBe(true);
    expect(validateSemverRange('^1.0.0').valid).toBe(false);
    expect(validateSemverRange('*').valid).toBe(false);
    expect(validateSemverRange('').valid).toBe(false);
  });

  it('evaluates ranges deterministically', () => {
    expect(semverSatisfies('0.7.0', '>=0.7.0 <1.0.0')).toBe(true);
    expect(semverSatisfies('0.9.9', '>=0.7.0 <1.0.0')).toBe(true);
    expect(semverSatisfies('1.0.0', '>=0.7.0 <1.0.0')).toBe(false);
    expect(semverSatisfies('0.6.1', '>=0.7.0 <1.0.0')).toBe(false);
    expect(semverSatisfies('2.0.0', '2.0.0')).toBe(true);
  });
});

describe('template manifest schema', () => {
  it('accepts a valid feature manifest', () => {
    const result = parseTemplateManifest(manifestText(featureManifest()));
    expect(result.manifest).toBeDefined();
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('accepts a valid bugfix manifest', () => {
    const result = parseTemplateManifest(manifestText(bugfixManifest()));
    expect(result.manifest?.kind).toBe('bugfix');
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('rejects invalid JSON with SBT004', () => {
    const result = parseTemplateManifest('{ not json');
    expect(result.issues[0]?.code).toBe('SBT004');
  });

  it('rejects an unsupported major schemaVersion with SBT005', () => {
    const result = parseTemplateManifest(manifestText(featureManifest({ schemaVersion: '2.0.0' })));
    expect(result.issues[0]?.code).toBe('SBT005');
  });

  it('rejects unknown top-level fields (strict policy)', () => {
    expect(errorsOf(featureManifest({ lifecycleScripts: { install: 'evil.sh' } })).join(' ')).toContain('SBT004');
  });

  it('rejects invalid IDs with SBT003', () => {
    expect(errorsOf(featureManifest({ id: 'Bad_ID' })).join(' ')).toContain('SBT003');
  });

  it('rejects non-semver versions', () => {
    expect(errorsOf(featureManifest({ version: 'one' })).length).toBeGreaterThan(0);
  });

  it('rejects unknown kinds and modes', () => {
    expect(errorsOf(featureManifest({ kind: 'epic' })).length).toBeGreaterThan(0);
    expect(errorsOf(featureManifest({ supportedModes: ['vibes'] })).length).toBeGreaterThan(0);
    expect(errorsOf(featureManifest({ defaultMode: 'design-first' })).join(' ')).toContain('defaultMode');
  });

  it('rejects duplicate target files with SBT012', () => {
    const manifest = featureManifest();
    const files = manifest['files'] as Array<Record<string, unknown>>;
    files[1] = { ...files[0], source: 'files/design.md.template' } as Record<string, unknown>;
    const codes = errorsOf(manifest).join(' ');
    expect(codes).toContain('SBT012');
  });

  it('rejects targets outside the Kiro layout with SBT011', () => {
    const manifest = featureManifest();
    (manifest['files'] as Array<Record<string, unknown>>)[0] = {
      source: 'files/evil.md.template',
      target: 'evil.md',
      stage: 'requirements',
      required: true,
    };
    expect(errorsOf(manifest).join(' ')).toContain('SBT011');
  });

  it('requires the full file set for the kind', () => {
    const manifest = featureManifest();
    (manifest['files'] as Array<Record<string, unknown>>).pop();
    expect(errorsOf(manifest).join(' ')).toContain('tasks.md');
  });

  it('rejects bugfix targets in a feature manifest', () => {
    const manifest = featureManifest();
    (manifest['files'] as Array<Record<string, unknown>>)[0] = {
      source: 'files/bugfix.md.template',
      target: 'bugfix.md',
      stage: 'bugfix',
      required: true,
    };
    expect(errorsOf(manifest).join(' ')).toContain('SBT011');
  });

  it('rejects traversal and absolute source paths with SBT008', () => {
    for (const source of ['files/../../evil.template', '/etc/passwd', 'C:/evil.template']) {
      const manifest = featureManifest();
      (manifest['files'] as Array<Record<string, unknown>>)[0] = {
        source,
        target: 'requirements.md',
        stage: 'requirements',
        required: true,
      };
      const codes = errorsOf(manifest).join(' ');
      expect(codes.includes('SBT008') || codes.includes('SBT007'), source).toBe(true);
    }
  });

  it('rejects variables shadowing built-ins', () => {
    const manifest = featureManifest({
      variables: [{ name: 'specName', description: 'shadow attempt', type: 'string', required: false }],
    });
    expect(errorsOf(manifest).join(' ')).toContain('built-in');
  });

  it('rejects invalid variable names and duplicate variables', () => {
    expect(
      errorsOf(
        featureManifest({
          variables: [{ name: 'Bad Name', description: 'bad', type: 'string', required: false }],
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(
        featureManifest({
          variables: [
            { name: 'actor', description: 'one', type: 'string', required: false },
            { name: 'actor', description: 'two', type: 'string', required: false },
          ],
        }),
      ).join(' '),
    ).toContain('twice');
  });

  it('requires values for enum variables and rejects values elsewhere', () => {
    expect(
      errorsOf(
        featureManifest({ variables: [{ name: 'level', description: 'level', type: 'enum', required: false }] }),
      ).join(' '),
    ).toContain('values');
    expect(
      errorsOf(
        featureManifest({
          variables: [{ name: 'actor', description: 'actor', type: 'string', required: false, values: ['a'] }],
        }),
      ).join(' '),
    ).toContain('enum');
  });

  it('rejects unsafe regular expression patterns', () => {
    for (const pattern of ['(a+)+$', 'a\\1', '('.repeat(3)]) {
      const manifest = featureManifest({
        variables: [{ name: 'actor', description: 'actor', type: 'string', required: false, pattern }],
      });
      expect(errorsOf(manifest).length, pattern).toBeGreaterThan(0);
    }
  });

  it('validates compatibility ranges and kiro layout', () => {
    expect(
      errorsOf(featureManifest({ compatibility: { specbridge: '^1.0.0', kiroLayout: '1' } })).join(' '),
    ).toContain('SBT004');
    expect(
      errorsOf(featureManifest({ compatibility: { specbridge: '>=0.7.0 <1.0.0', kiroLayout: '9' } })).join(' '),
    ).toContain('SBT006');
  });

  it('rejects a required variable that also declares a default', () => {
    const manifest = featureManifest({
      variables: [{ name: 'actor', description: 'actor', type: 'string', required: true, default: 'user' }],
    });
    expect(errorsOf(manifest).join(' ')).toContain('required and also has a default');
  });

  it('is deterministic: identical input produces identical issues', () => {
    const bad = featureManifest({ id: 'Bad_ID', kind: 'epic' });
    expect(errorsOf(bad)).toEqual(errorsOf(bad));
  });
});

describe('template error catalog', () => {
  it('defines all 25 stable codes', () => {
    expect(Object.keys(TEMPLATE_ERROR_CODES)).toHaveLength(25);
    expect(TEMPLATE_ERROR_CODES.SBT001).toBe('template not found');
    expect(TEMPLATE_ERROR_CODES.SBT025).toBe('template operation failed');
  });
});
