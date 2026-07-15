import { TemplateError } from './errors.js';
import { TEMPLATE_PACK_LIMITS } from './types.js';

/**
 * The restricted template renderer.
 *
 * Supported syntax: `{{variableName}}` — direct scalar substitution only.
 * There are no expressions, helpers, conditionals, loops, includes, file or
 * environment access, and no second rendering pass: substituted values are
 * inserted verbatim and NEVER rescanned, so a value containing
 * `{{dangerous}}` stays literal text in the output.
 *
 * Any `{{…}}` occurrence in a template file must resolve; a leftover or
 * malformed placeholder is an error (SBT016), never silently emitted.
 */

/** Placeholder occurrences: {{name}} with optional inner whitespace rejected. */
const PLACEHOLDER_PATTERN = /\{\{([^{}\r\n]*)\}\}/g;
const VALID_PLACEHOLDER_NAME = /^[a-z][a-zA-Z0-9]*$/;

export interface RenderedTemplateFile {
  /** Target file name inside the spec directory, e.g. `requirements.md`. */
  target: string;
  content: string;
}

/**
 * Render one template file in a single pass.
 *
 * @param sourceLabel pack-relative source path, used in error messages.
 * @param text template file content.
 * @param values fully resolved variable values (already validated/coerced).
 */
export function renderTemplateText(
  sourceLabel: string,
  text: string,
  values: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [];
  let lastIndex = 0;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    const inner = match[1] ?? '';
    if (!VALID_PLACEHOLDER_NAME.test(inner)) {
      throw new TemplateError(
        'SBT016',
        `${sourceLabel} contains a malformed placeholder "${truncatePlaceholder(match[0])}".`,
        'Placeholders must be exactly {{variableName}} with a name matching [a-z][a-zA-Z0-9]*. ' +
          'Literal double braces are not supported in template files.',
        { source: sourceLabel },
      );
    }
    const value = values.get(inner);
    if (value === undefined) {
      throw new TemplateError(
        'SBT016',
        `${sourceLabel} references "{{${inner}}}", which is not a declared or built-in variable.`,
        'Declare the variable in the manifest "variables" array, or remove the placeholder.',
        { source: sourceLabel, variable: inner },
      );
    }
    // Insert verbatim — one pass only. The value is plain text by contract
    // and is never re-scanned for placeholders.
    parts.push(value);
  }
  parts.push(text.slice(lastIndex));
  const rendered = parts.join('');

  const renderedBytes = Buffer.byteLength(rendered, 'utf8');
  if (renderedBytes > TEMPLATE_PACK_LIMITS.maxRenderedFileBytes) {
    throw new TemplateError(
      'SBT018',
      `Rendering ${sourceLabel} produced ${renderedBytes} bytes ` +
        `(limit ${TEMPLATE_PACK_LIMITS.maxRenderedFileBytes}).`,
      'Shorten the template or the supplied variable values.',
      { source: sourceLabel, bytes: renderedBytes },
    );
  }
  return rendered;
}

function truncatePlaceholder(raw: string): string {
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

/**
 * List the placeholder names used by a template file, in order of first use.
 * Used by validation to check every placeholder is resolvable and to report
 * which variables a template consumes.
 */
export function collectPlaceholders(text: string): {
  names: string[];
  malformed: string[];
} {
  const names: string[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
    const inner = match[1] ?? '';
    if (!VALID_PLACEHOLDER_NAME.test(inner)) {
      malformed.push(truncatePlaceholder(match[0]));
      continue;
    }
    if (!seen.has(inner)) {
      seen.add(inner);
      names.push(inner);
    }
  }
  return { names, malformed };
}
