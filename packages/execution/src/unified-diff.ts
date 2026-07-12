/**
 * Minimal unified diff (LCS-based) for showing refinement changes.
 * No dependency, deterministic, line-oriented. Documents here are small
 * spec files, so the O(n·m) LCS table is fine.
 */

interface DiffOp {
  kind: 'equal' | 'delete' | 'insert';
  line: string;
  /** 0-based indices into the old/new arrays (whichever applies). */
  oldIndex?: number;
  newIndex?: number;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  // lcs[i][j] = LCS length of oldLines[i..] and newLines[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as number[];
    const nextRow = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        oldLines[i] === newLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'equal', line: oldLines[i] as string, oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'delete', line: oldLines[i] as string, oldIndex: i });
      i += 1;
    } else {
      ops.push({ kind: 'insert', line: newLines[j] as string, newIndex: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'delete', line: oldLines[i] as string, oldIndex: i });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'insert', line: newLines[j] as string, newIndex: j });
    j += 1;
  }
  return ops;
}

/** Render a unified diff with the given context radius. Empty string = no changes. */
export function unifiedDiff(
  oldText: string,
  newText: string,
  options: { oldLabel?: string; newLabel?: string; context?: number } = {},
): string {
  const context = options.context ?? 3;
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  if (!ops.some((op) => op.kind !== 'equal')) return '';

  // Group ops into hunks separated by > 2*context equal lines.
  interface Hunk {
    ops: DiffOp[];
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
  }
  const hunks: Hunk[] = [];
  let current: DiffOp[] = [];
  let equalRun: DiffOp[] = [];
  let sawChange = false;

  const flush = (): void => {
    if (!sawChange || current.length === 0) {
      current = [];
      equalRun = [];
      sawChange = false;
      return;
    }
    const first = current[0] as DiffOp;
    const oldStart = first.oldIndex ?? first.newIndex ?? 0;
    const newStart = first.newIndex ?? first.oldIndex ?? 0;
    hunks.push({
      ops: current,
      oldStart,
      newStart,
      oldCount: current.filter((op) => op.kind !== 'insert').length,
      newCount: current.filter((op) => op.kind !== 'delete').length,
    });
    current = [];
    equalRun = [];
    sawChange = false;
  };

  for (const op of ops) {
    if (op.kind === 'equal') {
      equalRun.push(op);
      if (sawChange && equalRun.length > context * 2) {
        current.push(...equalRun.slice(0, context));
        flush();
        equalRun = equalRun.slice(-context);
      }
      continue;
    }
    if (!sawChange) {
      current.push(...equalRun.slice(-context));
      equalRun = [];
      sawChange = true;
    } else {
      current.push(...equalRun);
      equalRun = [];
    }
    current.push(op);
  }
  if (sawChange) {
    current.push(...equalRun.slice(0, context));
    flush();
  }

  const lines: string[] = [
    `--- ${options.oldLabel ?? 'a'}`,
    `+++ ${options.newLabel ?? 'b'}`,
  ];
  for (const hunk of hunks) {
    lines.push(
      `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`,
    );
    for (const op of hunk.ops) {
      const prefix = op.kind === 'equal' ? ' ' : op.kind === 'delete' ? '-' : '+';
      lines.push(`${prefix}${op.line}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
