import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  computePermissionHash,
  EXTENSION_MANIFEST_FILE_NAME,
  extensionIssue,
  isExecutableKind,
  MAX_TEMPLATE_PROVIDER_PACKS,
  parseExtensionManifest,
  semverSatisfies,
  TEMPLATE_PROVIDER_TEMPLATES_DIR,
  validateExtensionId,
  type ExtensionManifest,
  type ExtensionValidationIssue,
} from '@specbridge/extension-sdk';
import { loadTemplatePack, SPECBRIDGE_VERSION } from '@specbridge/templates';
import {
  EXTENSION_CHECKSUMS_FILE_NAME,
  parseExtensionChecksums,
  sha256HexOf,
  verifyExtensionChecksums,
} from './checksums.js';
import { ExtensionError } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { checkForbiddenPackagePath, checkPackageRelativePath } from './paths.js';

/**
 * Loading and validating extension packages.
 *
 * A "package" here is an in-memory file map — produced either by reading a
 * local directory (symlinks rejected, limits enforced before content is
 * loaded) or by the guarded archive extractor. Validation never executes any
 * package content and never runs lifecycle scripts.
 */
export interface ExtensionPackageValidation {
  readonly manifest?: ExtensionManifest;
  /** SHA-256 of the exact manifest bytes. */
  readonly manifestSha256?: string;
  /** Deterministic permission hash bound to id, version, manifest, permissions. */
  readonly permissionHash?: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly issues: readonly ExtensionValidationIssue[];
  readonly valid: boolean;
}

/** Lifecycle script names that must never appear in a bundled package.json. */
const FORBIDDEN_LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'preuninstall',
  'postuninstall',
] as const;

/**
 * Read an extension package directory into memory. Throws `ExtensionError`
 * for symlinks, traversal, forbidden directories, and limit violations — a
 * hostile directory fails before any content is loaded.
 */
export function readExtensionPackageDirectory(dir: string): Map<string, Buffer> {
  const rootStat = lstatSync(dir, { throwIfNoEntry: false });
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new ExtensionError(
      'SBE008',
      `"${dir}" is not a readable directory.`,
      'Point the command at an extension package directory or archive.',
    );
  }
  if (rootStat.isSymbolicLink()) {
    throw new ExtensionError(
      'SBE011',
      `"${dir}" is a symbolic link.`,
      'Extension packages must be plain directories; copy the real files instead.',
    );
  }

  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  const walk = (currentDir: string, relativePrefix: string, depth: number): void => {
    if (depth > EXTENSION_LIMITS.maxPackageDepth) {
      throw new ExtensionError(
        'SBE008',
        `directory nesting exceeds ${EXTENSION_LIMITS.maxPackageDepth} levels at "${relativePrefix}".`,
        'Flatten the package layout.',
      );
    }
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = relativePrefix === '' ? entry.name : `${relativePrefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new ExtensionError(
          'SBE011',
          `package entry "${relativePath}" is a symbolic link.`,
          'Extension packages must not contain symlinks; copy the real files instead.',
        );
      }
      const pathProblem = checkPackageRelativePath(relativePath);
      if (pathProblem !== undefined) {
        throw new ExtensionError(
          'SBE008',
          `package entry "${relativePath}": ${pathProblem}.`,
          'Rename the file to a safe relative path.',
        );
      }
      if (entry.isDirectory()) {
        const forbidden = checkForbiddenPackagePath(`${relativePath}/x`);
        if (forbidden !== undefined) {
          throw new ExtensionError(
            'SBE010',
            `package directory "${relativePath}" is forbidden: ${forbidden}.`,
            'Remove the directory before validating or packaging.',
          );
        }
        walk(path.join(currentDir, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new ExtensionError(
          'SBE008',
          `package entry "${relativePath}" is not a regular file.`,
          'Extension packages may only contain plain files and directories.',
        );
      }
      if (files.size >= EXTENSION_LIMITS.maxArchiveFileCount) {
        throw new ExtensionError(
          'SBE008',
          `package contains more than ${EXTENSION_LIMITS.maxArchiveFileCount} files.`,
          'Reduce the package contents.',
        );
      }
      const content = readFileSync(path.join(currentDir, entry.name));
      totalBytes += content.length;
      if (totalBytes > EXTENSION_LIMITS.maxExtractedTotalBytes) {
        throw new ExtensionError(
          'SBE008',
          `package exceeds the ${EXTENSION_LIMITS.maxExtractedTotalBytes} byte total size limit.`,
          'Reduce the package contents.',
        );
      }
      files.set(relativePath, content);
    }
  };

  walk(dir, '', 1);
  return files;
}

function decodeUtf8Strict(name: string, content: Buffer): string | undefined {
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content) || text.includes('\u0000')) {
    return undefined;
  }
  return text;
}

/**
 * Validate an in-memory extension package. Never throws and never executes
 * anything: all findings accumulate as issues.
 */
export function loadExtensionPackage(
  files: ReadonlyMap<string, Buffer>,
  options: { specbridgeVersion?: string } = {},
): ExtensionPackageValidation {
  const issues: ExtensionValidationIssue[] = [];
  const specbridgeVersion = options.specbridgeVersion ?? SPECBRIDGE_VERSION;

  for (const name of files.keys()) {
    const pathProblem = checkPackageRelativePath(name);
    if (pathProblem !== undefined) {
      issues.push(extensionIssue('SBE008', 'paths', 'error', `file "${name}": ${pathProblem}`, name));
      continue;
    }
    const forbidden = checkForbiddenPackagePath(name);
    if (forbidden !== undefined) {
      issues.push(extensionIssue('SBE010', 'files', 'error', `file "${name}": ${forbidden}`, name));
    }
  }

  const manifestBytes = files.get(EXTENSION_MANIFEST_FILE_NAME);
  if (manifestBytes === undefined) {
    issues.push(
      extensionIssue(
        'SBE004',
        'manifest',
        'error',
        `package has no ${EXTENSION_MANIFEST_FILE_NAME} at its root`,
      ),
    );
    return { files, issues, valid: false };
  }
  const manifestText = decodeUtf8Strict(EXTENSION_MANIFEST_FILE_NAME, manifestBytes);
  if (manifestText === undefined) {
    issues.push(
      extensionIssue(
        'SBE004',
        'manifest',
        'error',
        `${EXTENSION_MANIFEST_FILE_NAME} is not valid UTF-8`,
        EXTENSION_MANIFEST_FILE_NAME,
      ),
    );
    return { files, issues, valid: false };
  }

  const parsed = parseExtensionManifest(manifestText);
  issues.push(...parsed.issues);
  const manifest = parsed.manifest;
  if (manifest === undefined) {
    return { files, issues, valid: false };
  }

  const manifestSha256 = sha256HexOf(manifestBytes);
  const permissionHash = computePermissionHash({
    extensionId: manifest.id,
    extensionVersion: manifest.version,
    manifestSha256,
    permissions: manifest.permissions,
  });

  if (!semverSatisfies(specbridgeVersion, manifest.compatibility.specbridge)) {
    issues.push(
      extensionIssue(
        'SBE006',
        'compatibility',
        'error',
        `extension requires SpecBridge ${manifest.compatibility.specbridge}, ` +
          `but this is SpecBridge ${specbridgeVersion}`,
      ),
    );
  }

  if (files.get('README.md') === undefined) {
    issues.push(extensionIssue('SBE008', 'documentation', 'error', 'package has no README.md'));
  }
  if (files.get('LICENSE') === undefined) {
    issues.push(extensionIssue('SBE008', 'documentation', 'error', 'package has no LICENSE file'));
  }

  const checksumsBytes = files.get(EXTENSION_CHECKSUMS_FILE_NAME);
  if (checksumsBytes === undefined) {
    issues.push(
      extensionIssue(
        'SBE009',
        'checksums',
        'error',
        `package has no ${EXTENSION_CHECKSUMS_FILE_NAME}; every runtime file must be declared`,
      ),
    );
  } else {
    const checksumsText = decodeUtf8Strict(EXTENSION_CHECKSUMS_FILE_NAME, checksumsBytes);
    if (checksumsText === undefined) {
      issues.push(
        extensionIssue(
          'SBE008',
          'checksums',
          'error',
          `${EXTENSION_CHECKSUMS_FILE_NAME} is not valid UTF-8`,
          EXTENSION_CHECKSUMS_FILE_NAME,
        ),
      );
    } else {
      const checksumsResult = parseExtensionChecksums(checksumsText);
      issues.push(...checksumsResult.issues);
      if (checksumsResult.checksums !== undefined) {
        issues.push(...verifyExtensionChecksums(checksumsResult.checksums, files));
      }
    }
  }

  if (isExecutableKind(manifest.kind) && manifest.entrypoint !== undefined) {
    if (files.get(manifest.entrypoint) === undefined) {
      issues.push(
        extensionIssue(
          'SBE012',
          'paths',
          'error',
          `declared entrypoint "${manifest.entrypoint}" does not exist in the package`,
          manifest.entrypoint,
        ),
      );
    }
  }

  const packageJsonBytes = files.get('package.json');
  if (packageJsonBytes !== undefined) {
    const packageJsonText = decodeUtf8Strict('package.json', packageJsonBytes);
    if (packageJsonText !== undefined) {
      try {
        const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, unknown> };
        const scripts = packageJson.scripts ?? {};
        for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
          if (typeof scripts === 'object' && scripts !== null && script in scripts) {
            issues.push(
              extensionIssue(
                'SBE010',
                'files',
                'error',
                `package.json declares the "${script}" lifecycle script; SpecBridge never runs ` +
                  'lifecycle scripts and packages must not rely on them',
                'package.json',
              ),
            );
          }
        }
      } catch {
        issues.push(
          extensionIssue('SBE008', 'files', 'error', 'package.json is not valid JSON', 'package.json'),
        );
      }
    }
  }

  if (manifest.kind === 'template-provider') {
    issues.push(...validateTemplateProviderPacks(manifest, files, specbridgeVersion));
  }

  const valid = !issues.some((issue) => issue.severity === 'error');
  return valid
    ? { manifest, manifestSha256, permissionHash, files, issues, valid }
    : { manifest, manifestSha256, permissionHash, files, issues, valid };
}

function validateTemplateProviderPacks(
  manifest: ExtensionManifest,
  files: ReadonlyMap<string, Buffer>,
  specbridgeVersion: string,
): ExtensionValidationIssue[] {
  const issues: ExtensionValidationIssue[] = [];
  const prefix = `${TEMPLATE_PROVIDER_TEMPLATES_DIR}/`;
  const packs = new Map<string, Map<string, string>>();

  for (const [name, content] of files) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const rest = name.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) {
      issues.push(
        extensionIssue(
          'SBE008',
          'files',
          'error',
          `"${name}" must live inside templates/<template-id>/`,
          name,
        ),
      );
      continue;
    }
    const packId = rest.slice(0, slash);
    const packRelative = rest.slice(slash + 1);
    const idCheck = validateExtensionId(packId);
    if (!idCheck.valid) {
      issues.push(
        extensionIssue(
          'SBE008',
          'files',
          'error',
          `template pack directory "${packId}" is not a valid template ID`,
          name,
        ),
      );
      continue;
    }
    const text = decodeUtf8Strict(name, content);
    if (text === undefined) {
      issues.push(
        extensionIssue('SBE008', 'files', 'error', `template file "${name}" is not valid UTF-8`, name),
      );
      continue;
    }
    const pack = packs.get(packId) ?? new Map<string, string>();
    pack.set(packRelative, text);
    packs.set(packId, pack);
  }

  if (packs.size === 0) {
    issues.push(
      extensionIssue(
        'SBE008',
        'files',
        'error',
        `template-provider packages must contain at least one template pack under ${prefix}<template-id>/`,
      ),
    );
    return issues;
  }
  if (packs.size > MAX_TEMPLATE_PROVIDER_PACKS) {
    issues.push(
      extensionIssue(
        'SBE008',
        'limits',
        'error',
        `template-provider packages may contribute at most ${MAX_TEMPLATE_PROVIDER_PACKS} template packs`,
      ),
    );
    return issues;
  }

  for (const [packId, packFiles] of packs) {
    const loaded = loadTemplatePack(
      { origin: `extension:${manifest.id}/${packId}`, files: packFiles },
      { requireReadme: true, specbridgeVersion },
    );
    if (loaded.manifest !== undefined && loaded.manifest.id !== packId) {
      issues.push(
        extensionIssue(
          'SBE008',
          'files',
          'error',
          `template pack directory "${packId}" contains a manifest with id "${loaded.manifest.id}"`,
        ),
      );
    }
    for (const templateIssue of loaded.issues) {
      if (templateIssue.severity !== 'error') {
        continue;
      }
      issues.push(
        extensionIssue(
          'SBE008',
          'files',
          'error',
          `template pack "${packId}": ${templateIssue.code} ${templateIssue.message}`,
        ),
      );
    }
  }

  return issues;
}
