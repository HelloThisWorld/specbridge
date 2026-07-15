import type { TemplateErrorCode } from './errors.js';

/**
 * Validation categories reported by `template validate`. Every issue found
 * during pack loading, manifest parsing, rendering checks, or layout checks
 * is tagged with exactly one category.
 */
export const TEMPLATE_VALIDATION_CATEGORIES = [
  'manifest',
  'compatibility',
  'paths',
  'files',
  'variables',
  'rendering',
  'kiro-layout',
  'limits',
  'documentation',
] as const;

export type TemplateValidationCategory = (typeof TEMPLATE_VALIDATION_CATEGORIES)[number];

export interface TemplateValidationIssue {
  /** Stable SBT code identifying the failure class. */
  code: TemplateErrorCode;
  category: TemplateValidationCategory;
  severity: 'error' | 'warning';
  message: string;
  /** Pack-relative file the issue refers to, when applicable. */
  file?: string;
}

/** Size and count limits for template packs. All limits are tested. */
export const TEMPLATE_PACK_LIMITS = {
  /** Maximum number of files in a pack (manifest and README included). */
  maxPackFiles: 20,
  /** Maximum size of specbridge-template.json in bytes. */
  maxManifestBytes: 256 * 1024,
  /** Maximum size of a single template file in bytes. */
  maxTemplateFileBytes: 1024 * 1024,
  /** Maximum total pack size in bytes. */
  maxTotalPackBytes: 5 * 1024 * 1024,
  /** Maximum size of one rendered document in bytes. */
  maxRenderedFileBytes: 1024 * 1024,
  /** Maximum length of a supplied variable value in characters. */
  maxVariableValueLength: 100_000,
} as const;
