import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '@specbridge/drift';
import { evaluateImpactAreas } from '@specbridge/drift';

const changed: ChangedFile[] = [
  { path: 'src/notifications/preferences.ts', status: 'added' },
  { path: 'tests/notifications/preferences.test.ts', status: 'added' },
  { path: 'src/billing/invoice.ts', status: 'modified' },
];

describe('impact areas', () => {
  it('splits changes into matched and outside', () => {
    const result = evaluateImpactAreas(changed, [
      'src/notifications/**',
      'tests/notifications/**',
    ]);
    expect(result.matched.map((c) => c.path)).toEqual([
      'src/notifications/preferences.ts',
      'tests/notifications/preferences.test.ts',
    ]);
    expect(result.outside.map((c) => c.path)).toEqual(['src/billing/invoice.ts']);
  });

  it('treats no declared areas as no constraint', () => {
    const result = evaluateImpactAreas(changed, []);
    expect(result.outside).toEqual([]);
    expect(result.matched).toHaveLength(3);
  });

  it('normalizes Windows-style separators before matching', () => {
    const result = evaluateImpactAreas(
      [{ path: 'src\\notifications\\x.ts', status: 'modified' }],
      ['src/notifications/**'],
    );
    expect(result.outside).toEqual([]);
  });

  it('matches dotfiles', () => {
    const result = evaluateImpactAreas(
      [{ path: '.github/workflows/ci.yml', status: 'modified' }],
      ['.github/**'],
    );
    expect(result.outside).toEqual([]);
  });
});
