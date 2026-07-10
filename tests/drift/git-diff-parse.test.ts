import { describe, expect, it } from 'vitest';
import { parseNameStatus } from '@specbridge/drift';

describe('git diff --name-status parsing', () => {
  it('parses adds, modifications, deletes, renames, and copies', () => {
    const output = [
      'M\tsrc/auth/service.ts',
      'A\tsrc/auth/lockout.ts',
      'D\tsrc/legacy/session.ts',
      'R100\tsrc/old-name.ts\tsrc/new-name.ts',
      'C75\tsrc/base.ts\tsrc/copy.ts',
      'T\tsymlink-changed',
      '',
    ].join('\n');
    expect(parseNameStatus(output)).toEqual([
      { path: 'src/auth/service.ts', status: 'modified' },
      { path: 'src/auth/lockout.ts', status: 'added' },
      { path: 'src/legacy/session.ts', status: 'deleted' },
      { path: 'src/new-name.ts', status: 'renamed', oldPath: 'src/old-name.ts' },
      { path: 'src/copy.ts', status: 'copied', oldPath: 'src/base.ts' },
      { path: 'symlink-changed', status: 'type-changed' },
    ]);
  });

  it('handles empty output and CRLF line endings', () => {
    expect(parseNameStatus('')).toEqual([]);
    expect(parseNameStatus('M\ta.ts\r\nA\tb.ts\r\n')).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
    ]);
  });
});
