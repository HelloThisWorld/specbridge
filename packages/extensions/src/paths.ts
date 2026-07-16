/**
 * Package-relative path safety shared by checksums, archive extraction, and
 * directory loading. Every path stored inside an extension package must be a
 * normalized forward-slash relative path with conservative characters.
 */
export const PACKAGE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MAX_PACKAGE_PATH_LENGTH = 400;

/** Returns a problem description, or undefined when the path is safe. */
export function checkPackageRelativePath(relativePath: string): string | undefined {
  if (relativePath.length === 0) {
    return 'path is empty';
  }
  if (relativePath.length > MAX_PACKAGE_PATH_LENGTH) {
    return `path exceeds ${MAX_PACKAGE_PATH_LENGTH} characters`;
  }
  if (relativePath.includes('\u0000')) {
    return 'path contains a null byte';
  }
  if (relativePath.includes('\\')) {
    return 'path contains a backslash (use forward slashes)';
  }
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    return 'path is absolute';
  }
  for (const segment of relativePath.split('/')) {
    if (segment === '' ) {
      return 'path contains an empty segment';
    }
    if (segment === '.' || segment === '..') {
      return 'path contains a traversal segment';
    }
    if (!PACKAGE_PATH_SEGMENT_PATTERN.test(segment)) {
      return `path segment "${segment}" contains unsupported characters`;
    }
  }
  return undefined;
}

/** Directories that must never appear inside an extension package. */
export const FORBIDDEN_PACKAGE_DIRECTORIES = [
  'node_modules',
  '.git',
  '.kiro',
  '.specbridge',
  '.pnpm-store',
  '.npm',
] as const;

/** File suffixes that must never appear inside an extension package. */
export const FORBIDDEN_PACKAGE_FILE_SUFFIXES = [
  '.map',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.pem',
  '.key',
] as const;

/** Exact file names that must never appear inside an extension package. */
export const FORBIDDEN_PACKAGE_FILE_NAMES = ['.env', '.npmrc', '.netrc', 'id_rsa'] as const;

/** Returns a problem description when the path names a forbidden file. */
export function checkForbiddenPackagePath(relativePath: string): string | undefined {
  const segments = relativePath.split('/');
  for (const segment of segments) {
    for (const forbidden of FORBIDDEN_PACKAGE_DIRECTORIES) {
      if (segment === forbidden) {
        return `"${forbidden}" directories are not allowed in extension packages`;
      }
    }
  }
  const fileName = segments[segments.length - 1] ?? '';
  for (const forbidden of FORBIDDEN_PACKAGE_FILE_NAMES) {
    if (fileName === forbidden) {
      return `"${forbidden}" files are not allowed in extension packages`;
    }
  }
  const lower = fileName.toLowerCase();
  for (const suffix of FORBIDDEN_PACKAGE_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return `"${suffix}" files are not allowed in extension packages`;
    }
  }
  return undefined;
}
