/**
 * Spec name validation.
 *
 * Spec names become directory names under `.kiro/specs/`, so they are the
 * one user input that could escape the workspace. Validation is strict and
 * every rejection explains itself.
 */

export interface SpecNameValidation {
  valid: boolean;
  /** Human-readable reasons the name was rejected (empty when valid). */
  problems: string[];
}

const VALID_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 100;

/**
 * Windows reserved device names. A directory named `con` cannot be created
 * (or worse, behaves strangely) on Windows, and specs must stay portable.
 */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function validateSpecName(name: string): SpecNameValidation {
  const problems: string[] = [];

  if (name.length === 0) {
    return { valid: false, problems: ['Spec names must not be empty.'] };
  }
  if (name.includes('/') || name.includes('\\')) {
    problems.push('Spec names must not contain path separators ("/" or "\\").');
  }
  if (name === '..' || name === '.' || name.includes('..')) {
    problems.push('Spec names must not contain "..".');
  }
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('/') || name.startsWith('\\')) {
    problems.push('Spec names must be plain names, not absolute paths.');
  }
  if (/\s/.test(name)) {
    problems.push('Spec names must not contain spaces; use hyphens instead.');
  }
  if (name.includes('_')) {
    problems.push('Spec names must not contain underscores; use hyphens instead.');
  }
  if (/[A-Z]/.test(name)) {
    problems.push('Spec names must be lowercase.');
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    problems.push('Spec names must not start or end with a hyphen.');
  }
  if (name.includes('--')) {
    problems.push('Spec names must not contain consecutive hyphens.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    problems.push(`Spec names must be at most ${MAX_NAME_LENGTH} characters long.`);
  }
  if (WINDOWS_RESERVED.has(name.toLowerCase())) {
    problems.push(`"${name}" is a reserved device name on Windows and cannot be used.`);
  }

  // Catch anything the specific checks above did not explain (e.g. emoji).
  if (problems.length === 0 && !VALID_NAME.test(name)) {
    problems.push(
      'Spec names may only use lowercase letters, digits, and single hyphens between words (e.g. "notification-preferences").',
    );
  }

  return { valid: problems.length === 0, problems };
}

/** Derive a human-readable default title from a valid spec name. */
export function titleFromSpecName(name: string): string {
  return name
    .split('-')
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
