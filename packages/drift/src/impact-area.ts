import picomatch from 'picomatch';
import type { ChangedFile } from './git-diff.js';

/**
 * Declared impact areas: glob patterns from sidecar metadata describing where
 * a spec's implementation is allowed to land. Changes outside every declared
 * area are drift candidates.
 */

export interface ImpactAreaResult {
  areas: string[];
  matched: ChangedFile[];
  outside: ChangedFile[];
}

function toPosix(filePath: string): string {
  return filePath.split('\\').join('/');
}

export function evaluateImpactAreas(
  changedFiles: ChangedFile[],
  declaredAreas: string[],
): ImpactAreaResult {
  if (declaredAreas.length === 0) {
    // No declaration means no constraint — nothing is "outside".
    return { areas: [], matched: [...changedFiles], outside: [] };
  }
  const matchers = declaredAreas.map((area) => picomatch(toPosix(area), { dot: true }));
  const matched: ChangedFile[] = [];
  const outside: ChangedFile[] = [];
  for (const change of changedFiles) {
    const candidate = toPosix(change.path);
    if (matchers.some((isMatch) => isMatch(candidate))) matched.push(change);
    else outside.push(change);
  }
  return { areas: [...declaredAreas], matched, outside };
}
