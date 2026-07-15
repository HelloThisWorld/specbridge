/**
 * Minimal semantic-version range support for template compatibility checks.
 *
 * Deliberately tiny and dependency-free: a range is one or more
 * space-separated comparators that must ALL hold (logical AND), e.g.
 * `>=0.7.0 <1.0.0`. Supported operators: `>=`, `<=`, `>`, `<`, `=`, and a
 * bare version (equivalent to `=`). No `^`, `~`, `||`, `x`-ranges, or
 * prerelease tags — template packs should state an explicit window.
 */

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/;

export type SemverTriple = [number, number, number];

export function parseSemver(version: string): SemverTriple | undefined {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: SemverTriple, b: SemverTriple): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export interface SemverRangeCheck {
  valid: boolean;
  problem?: string;
}

/** Validate range syntax without evaluating it. */
export function validateSemverRange(range: string): SemverRangeCheck {
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
    return { valid: false, problem: 'range must not be empty' };
  }
  for (const part of parts) {
    if (!COMPARATOR_PATTERN.test(part)) {
      return {
        valid: false,
        problem:
          `unsupported comparator "${part}" — use space-separated comparators like ">=0.7.0 <1.0.0" ` +
          'with operators >=, <=, >, <, or =',
      };
    }
  }
  return { valid: true };
}

/** True when `version` satisfies every comparator in `range`. */
export function semverSatisfies(version: string, range: string): boolean {
  const target = parseSemver(version);
  if (!target) return false;
  const parts = range.trim().split(/\s+/);
  for (const part of parts) {
    const match = COMPARATOR_PATTERN.exec(part);
    if (!match) return false;
    const operator = match[1] ?? '=';
    const bound: SemverTriple = [Number(match[2]), Number(match[3]), Number(match[4])];
    const cmp = compareSemver(target, bound);
    switch (operator) {
      case '>=':
        if (cmp < 0) return false;
        break;
      case '<=':
        if (cmp > 0) return false;
        break;
      case '>':
        if (cmp <= 0) return false;
        break;
      case '<':
        if (cmp >= 0) return false;
        break;
      case '=':
        if (cmp !== 0) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}
