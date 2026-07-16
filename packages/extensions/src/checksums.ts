import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  extensionIssue,
  type ExtensionValidationIssue,
} from '@specbridge/extension-sdk';
import { EXTENSION_LIMITS } from './limits.js';
import { checkPackageRelativePath } from './paths.js';

/**
 * `checksums.json` — file-level integrity manifest inside every extension
 * package. Checksums prove integrity (the files you extracted are the files
 * that were packaged), not trust or publisher identity.
 */
export const EXTENSION_CHECKSUMS_FILE_NAME = 'checksums.json';

export const extensionChecksumsSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    algorithm: z.literal('sha256'),
    files: z.record(z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();

export type ExtensionChecksums = z.infer<typeof extensionChecksumsSchema>;

export function sha256HexOf(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Compute a checksums document over every file except checksums.json. */
export function computeExtensionChecksums(files: ReadonlyMap<string, Buffer>): ExtensionChecksums {
  const entries: Record<string, string> = {};
  for (const name of [...files.keys()].sort()) {
    if (name === EXTENSION_CHECKSUMS_FILE_NAME) {
      continue;
    }
    const content = files.get(name);
    if (content !== undefined) {
      entries[name] = sha256HexOf(content);
    }
  }
  return { schemaVersion: '1.0.0', algorithm: 'sha256', files: entries };
}

export interface ChecksumsParseResult {
  readonly checksums?: ExtensionChecksums;
  readonly issues: readonly ExtensionValidationIssue[];
}

export function parseExtensionChecksums(text: string): ChecksumsParseResult {
  const issues: ExtensionValidationIssue[] = [];
  if (Buffer.byteLength(text, 'utf8') > EXTENSION_LIMITS.maxChecksumsBytes) {
    issues.push(
      extensionIssue(
        'SBE008',
        'limits',
        'error',
        `checksums.json exceeds ${EXTENSION_LIMITS.maxChecksumsBytes} bytes`,
        EXTENSION_CHECKSUMS_FILE_NAME,
      ),
    );
    return { issues };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    issues.push(
      extensionIssue(
        'SBE008',
        'checksums',
        'error',
        `checksums.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        EXTENSION_CHECKSUMS_FILE_NAME,
      ),
    );
    return { issues };
  }
  const result = extensionChecksumsSchema.safeParse(parsed);
  if (!result.success) {
    for (const zodIssue of result.error.issues.slice(0, 10)) {
      issues.push(
        extensionIssue(
          'SBE008',
          'checksums',
          'error',
          `checksums.json ${zodIssue.path.join('.') || '(root)'}: ${zodIssue.message}`,
          EXTENSION_CHECKSUMS_FILE_NAME,
        ),
      );
    }
    return { issues };
  }
  for (const declaredPath of Object.keys(result.data.files)) {
    const problem = checkPackageRelativePath(declaredPath);
    if (problem !== undefined) {
      issues.push(
        extensionIssue('SBE008', 'checksums', 'error', `checksums.json entry "${declaredPath}": ${problem}`),
      );
    }
  }
  if (issues.length > 0) {
    return { issues };
  }
  return { checksums: result.data, issues };
}

/**
 * Verify that the checksums document and the package files agree exactly:
 * every runtime file is declared, no declared file is missing, and every
 * hash matches the exact file bytes.
 */
export function verifyExtensionChecksums(
  checksums: ExtensionChecksums,
  files: ReadonlyMap<string, Buffer>,
): ExtensionValidationIssue[] {
  const issues: ExtensionValidationIssue[] = [];
  const declared = new Set(Object.keys(checksums.files));

  for (const [name, content] of files) {
    if (name === EXTENSION_CHECKSUMS_FILE_NAME) {
      continue;
    }
    const expected = checksums.files[name];
    if (expected === undefined) {
      issues.push(
        extensionIssue(
          'SBE008',
          'checksums',
          'error',
          `file "${name}" is present but not declared in checksums.json`,
          name,
        ),
      );
      continue;
    }
    declared.delete(name);
    const actual = sha256HexOf(content);
    if (actual !== expected) {
      issues.push(
        extensionIssue(
          'SBE009',
          'checksums',
          'error',
          `file "${name}" does not match its declared sha256 (expected ${expected}, got ${actual})`,
          name,
        ),
      );
    }
  }

  for (const missing of declared) {
    issues.push(
      extensionIssue(
        'SBE009',
        'checksums',
        'error',
        `checksums.json declares "${missing}" but the file is missing from the package`,
        missing,
      ),
    );
  }

  return issues;
}
