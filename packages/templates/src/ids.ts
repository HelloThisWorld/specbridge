/**
 * Template ID and reference validation.
 *
 * Template IDs are deliberately strict so they are always safe as directory
 * names on every supported platform and can never smuggle path segments:
 * lowercase ASCII letters and digits, single hyphens between runs, starting
 * with a letter. No underscores, slashes, dots, spaces, or repeated hyphens.
 */

export const MAX_TEMPLATE_ID_LENGTH = 64;

const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface TemplateIdCheck {
  valid: boolean;
  problems: string[];
}

export function validateTemplateId(id: string): TemplateIdCheck {
  const problems: string[] = [];
  if (id.length === 0) {
    problems.push('ID must not be empty.');
    return { valid: false, problems };
  }
  if (id.includes('\0')) {
    problems.push('ID must not contain null bytes.');
    return { valid: false, problems };
  }
  if (id.length > MAX_TEMPLATE_ID_LENGTH) {
    problems.push(`ID must be at most ${MAX_TEMPLATE_ID_LENGTH} characters (got ${id.length}).`);
  }
  if (/[A-Z]/.test(id)) {
    problems.push('ID must use lowercase letters only.');
  }
  if (/_/.test(id)) {
    problems.push('ID must use hyphens, not underscores.');
  }
  if (/[\\/]/.test(id) || id.includes('..')) {
    problems.push('ID must not contain path separators or "..".');
  }
  if (/\s/.test(id)) {
    problems.push('ID must not contain spaces.');
  }
  if (id.startsWith('-') || id.endsWith('-')) {
    problems.push('ID must not start or end with a hyphen.');
  }
  if (id.includes('--')) {
    problems.push('ID must not contain repeated hyphens.');
  }
  if (problems.length === 0 && !TEMPLATE_ID_PATTERN.test(id)) {
    problems.push(
      'ID must start with a lowercase letter and contain only lowercase letters, digits, and single hyphens.',
    );
  }
  return { valid: problems.length === 0, problems };
}

/** Template sources supported in v0.7.0. There is no remote source. */
export const TEMPLATE_SOURCES = ['builtin', 'project'] as const;
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];

export interface TemplateReference {
  /** Explicit source, or undefined for an unqualified reference. */
  source: TemplateSource | undefined;
  id: string;
}

export function formatTemplateReference(source: TemplateSource, id: string): string {
  return `${source}:${id}`;
}

/**
 * Parse `builtin:rest-api`, `project:rest-api`, or a bare `rest-api`.
 * Returns undefined when the shape is not a template reference at all
 * (empty, unknown source prefix, or invalid ID) — callers raise the
 * appropriate SBT error with context.
 */
export function parseTemplateReference(raw: string): TemplateReference | undefined {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) {
    return validateTemplateId(trimmed).valid ? { source: undefined, id: trimmed } : undefined;
  }
  const source = trimmed.slice(0, colon);
  const id = trimmed.slice(colon + 1);
  if (source !== 'builtin' && source !== 'project') {
    return undefined;
  }
  return validateTemplateId(id).valid ? { source, id } : undefined;
}
