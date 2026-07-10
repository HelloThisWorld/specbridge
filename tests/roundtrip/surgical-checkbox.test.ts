import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocument,
  applyCheckboxState,
  findTask,
  parseTasks,
  writeDocumentAtomic,
} from '@specbridge/compat-kiro';
import { copyFixtureToTemp } from '../helpers.js';

/** Return the indexes of lines that differ between two buffers, split on LF. */
function diffLines(before: Buffer, after: Buffer): number[] {
  const beforeLines = before.toString('latin1').split('\n');
  const afterLines = after.toString('latin1').split('\n');
  expect(afterLines.length).toBe(beforeLines.length);
  const changed: number[] = [];
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (beforeLines[i] !== afterLines[i]) changed.push(i);
  }
  return changed;
}

describe('surgical checkbox updates', () => {
  it('changes exactly one character on exactly one line (LF file)', () => {
    const tempRoot = copyFixtureToTemp('standard-feature');
    const file = path.join(tempRoot, '.kiro', 'specs', 'user-authentication', 'tasks.md');
    const before = readFileSync(file);

    const document = MarkdownDocument.load(file);
    const task = findTask(parseTasks(document), '2.2')!;
    expect(task.state).toBe('open');

    const result = applyCheckboxState(document, task.line, 'done');
    expect(result.changed).toBe(true);
    writeDocumentAtomic(document, file, { workspaceRoot: tempRoot });

    const after = readFileSync(file);
    expect(after.length).toBe(before.length);

    const changedLines = diffLines(before, after);
    expect(changedLines).toEqual([task.line]);

    const beforeLine = before.toString('utf8').split('\n')[task.line]!;
    const afterLine = after.toString('utf8').split('\n')[task.line]!;
    expect(beforeLine).toContain('[ ]');
    expect(afterLine).toBe(beforeLine.replace('[ ]', '[x]'));

    // Everything before and after the changed line is byte-identical.
    const changeStart = before.toString('utf8').split('\n').slice(0, task.line).join('\n').length;
    expect(before.subarray(0, changeStart).equals(after.subarray(0, changeStart))).toBe(true);

    // And the file still parses with the new state.
    const reparsed = parseTasks(MarkdownDocument.load(file));
    expect(findTask(reparsed, '2.2')!.state).toBe('done');
  });

  it('preserves CRLF endings, BOM, and missing final newline when toggling', () => {
    const tempRoot = copyFixtureToTemp('crlf-files');
    const file = path.join(tempRoot, '.kiro', 'specs', 'crlf-feature', 'tasks.md');
    const before = readFileSync(file);
    expect(before.toString('utf8')).toContain('\r\n');
    expect(before.toString('utf8').endsWith('\n')).toBe(false);

    const document = MarkdownDocument.load(file);
    const task = findTask(parseTasks(document), '2')!;
    applyCheckboxState(document, task.line, 'done');
    writeDocumentAtomic(document, file, { workspaceRoot: tempRoot });

    const after = readFileSync(file);
    const expected = Buffer.from(
      before.toString('utf8').replace('- [ ] 2. Toggle me', '- [x] 2. Toggle me'),
      'utf8',
    );
    expect(after.equals(expected)).toBe(true);
    expect(after.toString('utf8').endsWith('\n')).toBe(false);
    expect(after.toString('utf8').split('\r\n').length).toBe(
      before.toString('utf8').split('\r\n').length,
    );
  });

  it('supports open → in-progress → done → open transitions', () => {
    const document = MarkdownDocument.fromText('- [ ] 1. cycle me\n');
    applyCheckboxState(document, 0, 'in-progress');
    expect(document.serialize()).toBe('- [-] 1. cycle me\n');
    applyCheckboxState(document, 0, 'done');
    expect(document.serialize()).toBe('- [x] 1. cycle me\n');
    applyCheckboxState(document, 0, 'open');
    expect(document.serialize()).toBe('- [ ] 1. cycle me\n');
  });

  it('is a no-op when the state already matches', () => {
    const document = MarkdownDocument.fromText('- [x] 1. done already\n');
    expect(applyCheckboxState(document, 0, 'done').changed).toBe(false);
    expect(document.serialize()).toBe('- [x] 1. done already\n');
  });

  it('refuses to edit non-checkbox lines', () => {
    const document = MarkdownDocument.fromText('# heading\n- [ ] 1. task\n');
    expect(() => applyCheckboxState(document, 0, 'done')).toThrowError(/not a task checkbox/);
  });
});
