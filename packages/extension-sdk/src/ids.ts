/**
 * Extension ID validation.
 *
 * Extension IDs double as directory names inside the local extension store,
 * as registry keys, and as the namespace prefix for diagnostic rule IDs, so
 * the grammar is deliberately restrictive: lowercase ASCII letters and digits
 * separated by single hyphens, starting with a letter.
 */
export const MAX_EXTENSION_ID_LENGTH = 64;

export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface ExtensionIdCheck {
  readonly valid: boolean;
  readonly problems: readonly string[];
}

export function validateExtensionId(id: string): ExtensionIdCheck {
  const problems: string[] = [];
  if (id.length === 0) {
    problems.push('ID is empty');
    return { valid: false, problems };
  }
  if (id.length > MAX_EXTENSION_ID_LENGTH) {
    problems.push(`ID exceeds ${MAX_EXTENSION_ID_LENGTH} characters`);
  }
  if (id.includes('\u0000')) {
    problems.push('ID contains a null byte');
  }
  if (/\s/u.test(id)) {
    problems.push('ID must not contain whitespace');
  }
  if (id.includes('_')) {
    problems.push('ID must not contain underscores');
  }
  if (id.includes('/') || id.includes('\\')) {
    problems.push('ID must not contain path separators');
  }
  if (id.includes('..')) {
    problems.push('ID must not contain ".."');
  }
  if (!EXTENSION_ID_PATTERN.test(id)) {
    problems.push(
      'ID must use lowercase letters and digits separated by single hyphens, ' +
        'start with a letter, and must not start or end with a hyphen',
    );
  }
  return { valid: problems.length === 0, problems };
}
