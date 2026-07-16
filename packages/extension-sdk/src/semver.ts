/**
 * Minimal, dependency-free semver support for the extension contract.
 *
 * The SDK is intentionally self-contained, so it carries its own restricted
 * semver implementation instead of importing SpecBridge internals. The
 * supported grammar matches the template system deliberately:
 *
 * - versions are strict `X.Y.Z` (no prereleases, no build metadata)
 * - ranges are space-separated comparators combined with logical AND
 * - comparator operators: `>=`, `<=`, `>`, `<`, `=` (bare version means `=`)
 *
 * `^`, `~`, `||`, and x-ranges are rejected so compatibility declarations stay
 * unambiguous across tools.
 */
export interface SemverTriple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;

export function parseSemver(version: string): SemverTriple | undefined {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    return undefined;
  }
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function compareSemver(a: SemverTriple, b: SemverTriple): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

export interface SemverRangeCheck {
  readonly valid: boolean;
  readonly problem?: string;
}

export function validateSemverRange(range: string): SemverRangeCheck {
  if (range.trim().length === 0) {
    return { valid: false, problem: 'range is empty' };
  }
  if (/[|^~*x]/i.test(range)) {
    return {
      valid: false,
      problem: 'only >=, <=, >, <, and = comparators joined by spaces are supported',
    };
  }
  const comparators = range.trim().split(/\s+/);
  for (const comparator of comparators) {
    const match = COMPARATOR_PATTERN.exec(comparator);
    if (!match || parseSemver(match[2] ?? '') === undefined) {
      return { valid: false, problem: `invalid comparator "${comparator}"` };
    }
  }
  return { valid: true };
}

/** True when `version` satisfies every comparator in `range` (logical AND). */
export function semverSatisfies(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) {
    return false;
  }
  if (!validateSemverRange(range).valid) {
    return false;
  }
  for (const comparator of range.trim().split(/\s+/)) {
    const match = COMPARATOR_PATTERN.exec(comparator);
    if (!match) {
      return false;
    }
    const operator = match[1] ?? '=';
    const bound = parseSemver(match[2] ?? '');
    if (!bound) {
      return false;
    }
    const cmp = compareSemver(parsed, bound);
    const ok =
      (operator === '=' && cmp === 0) ||
      (operator === '>' && cmp > 0) ||
      (operator === '>=' && cmp >= 0) ||
      (operator === '<' && cmp < 0) ||
      (operator === '<=' && cmp <= 0);
    if (!ok) {
      return false;
    }
  }
  return true;
}

/** True when two strict `X.Y.Z` versions share the same major version. */
export function sameMajor(a: string, b: string): boolean {
  const left = parseSemver(a);
  const right = parseSemver(b);
  return left !== undefined && right !== undefined && left.major === right.major;
}
