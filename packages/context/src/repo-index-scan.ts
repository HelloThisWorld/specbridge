import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  RepositoryFileKind,
  RepositoryIndexEntry,
  RepositorySkipReason,
} from './repo-index-state.js';
import { REPOSITORY_INDEX_LIMITS } from './repo-index-state.js';

/**
 * Deterministic workspace scanning for the repository context index.
 *
 * Everything here is a pure function of bytes on disk plus the configured
 * boundaries: same repository, same options, same entries in the same order.
 * That determinism is what makes `ContextSelectionPlan` reproducible, which
 * in turn is what makes retrieval reviewable instead of merely plausible.
 *
 * The scan never leaves the workspace, never follows symlinks out of it, and
 * never reads a path the boundary rules exclude. Those rules run BEFORE any
 * read, so an excluded file is not "filtered from the results" — it is never
 * opened, which is the only version of that guarantee worth having.
 */

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

/**
 * Directories never indexed, whatever `.gitignore` says.
 *
 * Two groups, for two different reasons. Build output and dependency caches
 * are derived bulk that would drown genuine source in the ranking. `.git`,
 * `.kiro`, and `.specbridge` are excluded because they are not working
 * source at all: SpecBridge's own state and the approved spec documents
 * reach a worker through the CANONICAL path (pinned contract, durable
 * checkpoint), and indexing them would let approved intent arrive a second
 * time as a probabilistically retrieved artifact.
 */
export const ALWAYS_IGNORED_DIRECTORIES: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  '.kiro',
  '.specbridge',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode-test',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.venv',
  'venv',
  'target',
  'Pods',
  'DerivedData',
];

/** Extensions whose bytes are not text and are never read. */
export const BINARY_EXTENSIONS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns', '.webp', '.avif', '.tif', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.class',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib', '.obj', '.bin', '.wasm', '.pyc', '.pyo',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  '.db', '.sqlite', '.sqlite3', '.mdb', '.pack', '.idx', '.node', '.dmg', '.iso', '.img',
];

/**
 * Path shapes that are credential-shaped and are NEVER indexed, read, or
 * ranked — not even to decide they are irrelevant.
 *
 * This is a boundary, not a heuristic ranking penalty, and it is stated as a
 * non-claim in the docs: it is a deterministic path filter, and it is not a
 * secret SCANNER. It cannot find a key pasted into an ordinary source file.
 * What it does guarantee is that context selection never turns a file whose
 * PATH advertises credentials into remote prompt content — which is exactly
 * the class of accident an automatic retriever would otherwise introduce.
 */
export const CREDENTIAL_SHAPED_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  // A credential-bearing DATA file: `credentials.json`, `db-secrets.yaml`,
  // `foo-service-credentials.json`. Deliberately scoped to data extensions
  // (and extensionless files) so that ordinary source ABOUT secrets — a
  // `secret-store.ts`, a `credentials-form.tsx` — stays retrievable. The
  // boundary is meant to stop credential FILES reaching a remote prompt, not
  // to make the word unsearchable.
  /(^|\/)[\w-]*(?:credential|secret|passwd|password)s?[\w-]*\.(?:json|ya?ml|txt|ini|cfg|conf|env|properties|toml|xml|csv)$/i,
  /(^|\/)[\w-]*(?:credential|secret|passwd|password)s?[\w-]*$/i,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk)$/i,
  /(^|\/)service[-_]?account.*\.json$/i,
];

/** Generated/lock artifacts that are text but carry no retrieval value. */
export const IGNORED_FILENAMES: readonly string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  '.DS_Store',
];

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)tests?(\/|$)/i,
  /(^|\/)__tests__(\/|$)/i,
  /(^|\/)spec(\/|$)/i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rb)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /Test[s]?\.(java|cs|kt)$/,
];

const CONFIG_FILENAME_PATTERNS: readonly RegExp[] = [
  /^(package|tsconfig[^/]*|jsconfig|pyproject|setup|Cargo|go|composer|Gemfile|pom)\.(json|toml|cfg|mod|xml)$/i,
  /\.(config|conf|rc)\.[cm]?[jt]s$/i,
  /^\.[a-z0-9_-]+rc(\.[a-z]+)?$/i,
  /^(Dockerfile|Makefile|Justfile)$/i,
  /\.(ya?ml|ini|toml|properties)$/i,
];

const DOC_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.rst', '.adoc', '.txt'];
const DATA_EXTENSIONS: readonly string[] = ['.json', '.csv', '.tsv', '.xml', '.ndjson', '.jsonl'];

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.scala': 'scala',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.sh': 'shell', '.bash': 'shell', '.ps1': 'powershell', '.sql': 'sql',
  '.css': 'css', '.scss': 'css', '.less': 'css', '.html': 'html', '.vue': 'vue', '.svelte': 'svelte',
  '.md': 'markdown', '.mdx': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml', '.xml': 'xml', '.proto': 'protobuf', '.graphql': 'graphql', '.gql': 'graphql',
});

export function languageOf(relativePath: string): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? (extension === '' ? 'none' : extension.slice(1));
}

export function isBinaryPath(relativePath: string): boolean {
  return BINARY_EXTENSIONS.includes(path.posix.extname(relativePath).toLowerCase());
}

export function isCredentialShapedPath(relativePath: string): boolean {
  return CREDENTIAL_SHAPED_PATTERNS.some((pattern) => pattern.test(relativePath));
}

export function isTestPath(relativePath: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

export function classifyFileKind(relativePath: string): RepositoryFileKind {
  if (isTestPath(relativePath)) return 'test';
  const base = path.posix.basename(relativePath);
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (DOC_EXTENSIONS.includes(extension)) return 'doc';
  if (CONFIG_FILENAME_PATTERNS.some((pattern) => pattern.test(base))) return 'config';
  if (DATA_EXTENSIONS.includes(extension)) return 'data';
  if (LANGUAGE_BY_EXTENSION[extension] !== undefined) return 'source';
  return 'other';
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

interface IgnoreRule {
  /** Compiled matcher over a workspace-relative POSIX path. */
  pattern: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

export interface IgnoreScope {
  /** Directory (workspace-relative, '' at the root) the rules apply under. */
  base: string;
  rules: IgnoreRule[];
}

/**
 * Compile ONE `.gitignore` line into a matcher.
 *
 * A deliberately bounded subset of the gitignore language: comments, blank
 * lines, negation, directory-only markers, anchoring, `*`, `?`, `**`, and
 * character classes. It is documented as a subset rather than presented as
 * a compatible implementation — over-claiming here would mean silently
 * indexing something the operator believed was excluded.
 */
function compileIgnoreLine(line: string, base: string): IgnoreRule | undefined {
  let body = line.trim();
  if (body === '' || body.startsWith('#')) return undefined;
  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);
  const directoryOnly = body.endsWith('/');
  if (directoryOnly) body = body.slice(0, -1);
  if (body === '') return undefined;

  const anchored = body.startsWith('/') || body.slice(0, -1).includes('/');
  if (body.startsWith('/')) body = body.slice(1);

  let source = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    if (character === '*') {
      if (body[index + 1] === '*') {
        // `**` spans separators; `**/` also matches zero directories.
        if (body[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    if (character === '[') {
      const close = body.indexOf(']', index + 1);
      if (close !== -1) {
        source += body.slice(index, close + 1);
        index = close;
        continue;
      }
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const prefix = base === '' ? '' : `${base}/`;
  const head = anchored ? `^${escapeLiteral(prefix)}` : `^${escapeLiteral(prefix)}(?:.*/)?`;
  return {
    pattern: new RegExp(`${head}${source}(?:/.*)?$`),
    negated,
    directoryOnly,
  };
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Read and compile one directory's `.gitignore`, when it has one. */
export function readIgnoreScope(rootDir: string, base: string): IgnoreScope | undefined {
  const file = path.join(rootDir, base, '.gitignore');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const rules: IgnoreRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = compileIgnoreLine(line, base);
    if (rule !== undefined) rules.push(rule);
  }
  return rules.length === 0 ? undefined : { base, rules };
}

/**
 * Whether the accumulated ignore scopes exclude a path.
 *
 * Later rules win over earlier ones, exactly like Git, so a negation in a
 * nested `.gitignore` can re-include something an ancestor excluded.
 */
export function isIgnoredByScopes(
  relativePath: string,
  isDirectory: boolean,
  scopes: readonly IgnoreScope[],
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    for (const rule of scope.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (!rule.pattern.test(relativePath)) continue;
      ignored = !rule.negated;
    }
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Symbol and import extraction
// ---------------------------------------------------------------------------

const TS_SYMBOL_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
];
const TS_EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/gm;
const TS_IMPORT_PATTERNS: readonly RegExp[] = [
  /^\s*import\s[^'"]*['"]([^'"]+)['"]/gm,
  /^\s*export\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm,
];

const PY_SYMBOL_PATTERN = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/gm;
const PY_IMPORT_PATTERNS: readonly RegExp[] = [
  /^\s*from\s+([.\w]+)\s+import\s/gm,
  /^\s*import\s+([.\w]+)/gm,
];

const GO_SYMBOL_PATTERN = /^\s*(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm;
const GO_IMPORT_PATTERN = /^\s*(?:import\s+)?_?\s*"([^"]+)"/gm;

const JVM_SYMBOL_PATTERN =
  /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|sealed\s+|abstract\s+|final\s+|static\s+|open\s+|data\s+)*(?:class|interface|record|enum|object|struct)\s+([A-Za-z_][\w]*)/gm;
const JVM_IMPORT_PATTERN = /^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)/gm;

const RUST_SYMBOL_PATTERN =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][\w]*)/gm;
const RUST_IMPORT_PATTERN = /^\s*use\s+([\w:]+)/gm;

function collect(text: string, pattern: RegExp, limit: number): string[] {
  const found: string[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null && found.length < limit) {
    const value = match[1]?.trim();
    if (value !== undefined && value.length > 0 && value.length <= 200) found.push(value);
    match = pattern.exec(text);
  }
  return found;
}

/**
 * Conservative symbol/import extraction.
 *
 * Pattern-based by design. A full parser per language would be a compiler
 * project with its own dependency surface and its own failure modes, and the
 * ranking signals below degrade gracefully: an entry with no symbols still
 * ranks on path, token, module, and change evidence. What matters is that a
 * WRONG symbol is never invented — every value here is a literal substring
 * of the file.
 */
export function extractSignals(
  relativePath: string,
  text: string,
): { symbols: string[]; imports: string[] } {
  const language = languageOf(relativePath);
  const symbolLimit = REPOSITORY_INDEX_LIMITS.maxSymbolsPerEntry;
  const importLimit = REPOSITORY_INDEX_LIMITS.maxImportsPerEntry;
  const symbols = new Set<string>();
  const imports = new Set<string>();

  const add = (target: Set<string>, values: readonly string[], limit: number): void => {
    for (const value of values) {
      if (target.size >= limit) return;
      target.add(value);
    }
  };

  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'vue':
    case 'svelte': {
      for (const pattern of TS_SYMBOL_PATTERNS) add(symbols, collect(text, pattern, symbolLimit), symbolLimit);
      for (const group of collect(text, TS_EXPORT_LIST, symbolLimit)) {
        add(
          symbols,
          group
            .split(',')
            .map((entry) => (entry.split(/\sas\s/).pop() ?? entry).trim())
            .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry)),
          symbolLimit,
        );
      }
      for (const pattern of TS_IMPORT_PATTERNS) add(imports, collect(text, pattern, importLimit), importLimit);
      break;
    }
    case 'python': {
      add(symbols, collect(text, PY_SYMBOL_PATTERN, symbolLimit), symbolLimit);
      for (const pattern of PY_IMPORT_PATTERNS) add(imports, collect(text, pattern, importLimit), importLimit);
      break;
    }
    case 'go': {
      add(symbols, collect(text, GO_SYMBOL_PATTERN, symbolLimit), symbolLimit);
      add(imports, collect(text, GO_IMPORT_PATTERN, importLimit), importLimit);
      break;
    }
    case 'java':
    case 'kotlin':
    case 'csharp':
    case 'scala': {
      add(symbols, collect(text, JVM_SYMBOL_PATTERN, symbolLimit), symbolLimit);
      add(imports, collect(text, JVM_IMPORT_PATTERN, importLimit), importLimit);
      break;
    }
    case 'rust': {
      add(symbols, collect(text, RUST_SYMBOL_PATTERN, symbolLimit), symbolLimit);
      add(imports, collect(text, RUST_IMPORT_PATTERN, importLimit), importLimit);
      break;
    }
    default:
      break;
  }
  return { symbols: [...symbols], imports: [...imports] };
}

// ---------------------------------------------------------------------------
// Path derivations
// ---------------------------------------------------------------------------

/** Lowercased path tokens used by deterministic ranking. */
export function pathTokens(relativePath: string): string[] {
  const withoutExtension = relativePath.replace(/\.[A-Za-z0-9]+$/, '');
  const rawTokens = withoutExtension
    .split(/[/\\._-]+/)
    .flatMap((segment) => segment.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length >= 2 && segment.length <= 64);
  return [...new Set(rawTokens)].slice(0, REPOSITORY_INDEX_LIMITS.maxTokensPerEntry);
}

/**
 * Owning module directory for a path.
 *
 * The nearest ancestor that looks like a package boundary (`packages/x`,
 * `src` under one, an `apps/x`), falling back to the parent directory. It is
 * a proximity signal, not a build-graph fact.
 */
export function moduleOf(relativePath: string): string {
  const segments = relativePath.split('/');
  segments.pop();
  if (segments.length === 0) return '';
  for (const marker of ['packages', 'apps', 'services', 'libs', 'modules']) {
    const at = segments.indexOf(marker);
    if (at !== -1 && segments.length > at + 1) return segments.slice(0, at + 2).join('/');
  }
  const srcAt = segments.indexOf('src');
  if (srcAt > 0) return segments.slice(0, srcAt).join('/');
  return segments.join('/');
}

/** Basename with test markers and extension removed ('foo.test.ts' → 'foo'). */
export function testStem(relativePath: string): string {
  return path.posix
    .basename(relativePath)
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/\.(test|spec)$/i, '')
    .replace(/^test_/i, '')
    .replace(/_test$/i, '')
    .replace(/Tests?$/, '');
}

/**
 * Resolve a relative import specifier against the importing file, matching
 * the candidate paths actually present in the repository.
 *
 * Bare specifiers ('zod', '@scope/pkg') resolve to nothing on purpose: a
 * dependency is not a repository artifact, and pretending otherwise would
 * put node_modules paths into ranking.
 */
export function resolveImportPath(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  if (base.startsWith('..')) return undefined;
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}.go`,
    `${base}/index.ts`,
    `${base}/index.js`,
    `${base}/mod.rs`,
  ];
  return candidates.find((candidate) => known.has(candidate));
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Absolute workspace root. Nothing outside it is ever read. */
  rootDir: string;
  /** Additional workspace-relative path prefixes to exclude entirely. */
  protectedPaths?: readonly string[] | undefined;
  /** Honour `.gitignore` files encountered during the walk (default true). */
  respectGitignore?: boolean | undefined;
  /** Ceiling on indexed entries (default REPOSITORY_INDEX_LIMITS.maxEntries). */
  maxEntries?: number | undefined;
  /** Files above this many bytes are skipped unread. */
  maxFileBytes?: number | undefined;
  /** ISO timestamp stamped on every produced entry. */
  indexedAt: string;
  /**
   * Previously indexed entries by path. When a walked file's size AND mtime
   * both match the known entry, the entry is reused without a re-read — a
   * PERFORMANCE shortcut over bytes already hashed once, identical to the
   * one the untargeted refresh applies. This is what makes an
   * additions-discovering walk cost a traversal rather than a full rebuild.
   */
  reuse?: ReadonlyMap<string, RepositoryIndexEntry> | undefined;
}

export interface ScanResult {
  entries: RepositoryIndexEntry[];
  skipped: { path: string; reason: RepositorySkipReason }[];
  skippedCounts: Record<string, number>;
  truncated: boolean;
}

function isProtected(relativePath: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((prefix) => {
    const normalized = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === '') return false;
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  });
}

/**
 * Build one index entry from a file that has already passed every boundary
 * check. Returns undefined when the bytes turn out to be binary after all
 * (a NUL byte in the first block), which is the one thing an extension
 * cannot tell us.
 */
export function buildEntry(
  rootDir: string,
  relativePath: string,
  indexedAt: string,
): RepositoryIndexEntry | undefined {
  const absolute = path.join(rootDir, relativePath);
  let bytes: Buffer;
  let mtimeMs: number;
  try {
    const stat = statSync(absolute);
    mtimeMs = stat.mtimeMs;
    bytes = readFileSync(absolute);
  } catch {
    return undefined;
  }
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString('utf8');
  const signals = extractSignals(relativePath, text);
  const kind = classifyFileKind(relativePath);
  return {
    path: relativePath,
    kind,
    language: languageOf(relativePath),
    module: moduleOf(relativePath),
    sizeBytes: bytes.byteLength,
    lineCount: text.length === 0 ? 0 : text.split('\n').length,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs,
    symbols: signals.symbols,
    imports: signals.imports,
    importPaths: [],
    tokens: pathTokens(relativePath),
    testTargets: [],
    indexedAt,
  };
}

/**
 * Walk the workspace and produce entries in deterministic order.
 *
 * Directory entries are sorted before recursion, so the emitted order is a
 * function of the tree and not of filesystem enumeration order — two runs on
 * the same repository produce byte-identical output.
 */
export function scanWorkspace(options: ScanOptions): ScanResult {
  const rootDir = path.resolve(options.rootDir);
  const protectedPaths = options.protectedPaths ?? [];
  const respectGitignore = options.respectGitignore !== false;
  const maxEntries = options.maxEntries ?? REPOSITORY_INDEX_LIMITS.maxEntries;
  const maxFileBytes = options.maxFileBytes ?? REPOSITORY_INDEX_LIMITS.maxFileBytes;

  const entries: RepositoryIndexEntry[] = [];
  const skipped: { path: string; reason: RepositorySkipReason }[] = [];
  const skippedCounts: Record<string, number> = {};
  let truncated = false;

  const note = (relativePath: string, reason: RepositorySkipReason): void => {
    skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1;
    if (skipped.length < REPOSITORY_INDEX_LIMITS.maxSkippedRecorded) {
      skipped.push({ path: relativePath, reason });
    }
  };

  const walk = (relativeDir: string, scopes: readonly IgnoreScope[]): void => {
    if (truncated) return;
    const absoluteDir = path.join(rootDir, relativeDir);
    let dirents;
    try {
      dirents = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      note(relativeDir === '' ? '.' : relativeDir, 'unreadable');
      return;
    }
    const localScope = respectGitignore ? readIgnoreScope(rootDir, relativeDir) : undefined;
    const activeScopes = localScope === undefined ? scopes : [...scopes, localScope];

    const sorted = [...dirents].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const dirent of sorted) {
      if (truncated) return;
      const relativePath = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (relativePath.length > REPOSITORY_INDEX_LIMITS.maxPathChars) {
        note(relativePath.slice(0, REPOSITORY_INDEX_LIMITS.maxPathChars), 'unreadable');
        continue;
      }
      // Symlinks are never followed: a link can point outside the workspace,
      // and an index that resolved one would describe bytes the boundary
      // rules were never applied to.
      if (dirent.isSymbolicLink()) continue;

      if (dirent.isDirectory()) {
        if (ALWAYS_IGNORED_DIRECTORIES.includes(dirent.name)) {
          note(relativePath, 'ignored-directory');
          continue;
        }
        if (isProtected(relativePath, protectedPaths)) {
          note(relativePath, 'protected-path');
          continue;
        }
        if (respectGitignore && isIgnoredByScopes(relativePath, true, activeScopes)) {
          note(relativePath, 'gitignored');
          continue;
        }
        walk(relativePath, activeScopes);
        continue;
      }
      if (!dirent.isFile()) continue;

      if (IGNORED_FILENAMES.includes(dirent.name)) {
        note(relativePath, 'ignored-directory');
        continue;
      }
      if (isCredentialShapedPath(relativePath)) {
        note(relativePath, 'credential-shaped');
        continue;
      }
      if (isProtected(relativePath, protectedPaths)) {
        note(relativePath, 'protected-path');
        continue;
      }
      if (isBinaryPath(relativePath)) {
        note(relativePath, 'binary');
        continue;
      }
      if (respectGitignore && isIgnoredByScopes(relativePath, false, activeScopes)) {
        note(relativePath, 'gitignored');
        continue;
      }
      let size: number;
      let mtimeMs: number;
      try {
        const stat = statSync(path.join(rootDir, relativePath));
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        note(relativePath, 'unreadable');
        continue;
      }
      if (size > maxFileBytes) {
        note(relativePath, 'too-large');
        continue;
      }
      if (entries.length >= maxEntries) {
        note(relativePath, 'entry-limit');
        truncated = true;
        return;
      }
      const known = options.reuse?.get(relativePath);
      if (known !== undefined && known.sizeBytes === size && known.mtimeMs === mtimeMs) {
        entries.push(known);
        continue;
      }
      const entry = buildEntry(rootDir, relativePath, options.indexedAt);
      if (entry === undefined) {
        note(relativePath, 'binary');
        continue;
      }
      entries.push(entry);
    }
  };

  walk('', []);
  return { entries, skipped, skippedCounts, truncated };
}

/**
 * Second pass: resolve import edges and test/source pairings now that the
 * complete path set is known.
 *
 * Deliberately separate from the walk. Resolution needs the whole index to
 * distinguish "this import points at a repository file" from "this import
 * points at a dependency", and a single-pass guess would produce edges to
 * paths that do not exist.
 */
export function linkEntries(entries: readonly RepositoryIndexEntry[]): RepositoryIndexEntry[] {
  const known = new Set(entries.map((entry) => entry.path));
  const sourcesByStem = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind === 'test') continue;
    const stem = testStem(entry.path).toLowerCase();
    if (stem === '') continue;
    const bucket = sourcesByStem.get(stem);
    if (bucket === undefined) sourcesByStem.set(stem, [entry.path]);
    else if (bucket.length < REPOSITORY_INDEX_LIMITS.maxImportsPerEntry) bucket.push(entry.path);
  }

  return entries.map((entry) => {
    const importPaths: string[] = [];
    for (const specifier of entry.imports) {
      const resolved = resolveImportPath(entry.path, specifier, known);
      if (resolved !== undefined && !importPaths.includes(resolved)) importPaths.push(resolved);
    }
    let testTargets: string[] = [];
    if (entry.kind === 'test') {
      const stem = testStem(entry.path).toLowerCase();
      const byName = stem === '' ? [] : (sourcesByStem.get(stem) ?? []);
      // Import edges are stronger evidence than a name match, so they lead.
      testTargets = [...new Set([...importPaths, ...byName])].slice(
        0,
        REPOSITORY_INDEX_LIMITS.maxImportsPerEntry,
      );
    }
    return { ...entry, importPaths, testTargets };
  });
}
