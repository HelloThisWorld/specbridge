import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertInsideWorkspace,
  repositoryName,
  sha256,
  stableId,
  workspaceRelative,
  writeFileAtomic,
} from '@specbridge/core';
import type {
  CurrentSystemSnapshot,
  EvidenceReference,
  ProjectType,
} from '@specbridge/core';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.specbridge',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  'vendor',
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.sql': 'SQL',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.md': 'Markdown',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.json': 'JSON',
};

const FRAMEWORK_PACKAGES: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  svelte: 'Svelte',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  hono: 'Hono',
  django: 'Django',
  flask: 'Flask',
  prisma: 'Prisma',
  drizzle: 'Drizzle',
  vitest: 'Vitest',
  jest: 'Jest',
  playwright: 'Playwright',
};

export interface RepositoryFileFact {
  path: string;
  language: string | null;
  bytes: number;
  hash: string;
  imports: string[];
  exports: string[];
  tokens: string[];
  isTest: boolean;
  isConfiguration: boolean;
}

export interface RepositoryIndex {
  schemaVersion: 'specbridge.repository-index.v2';
  repositoryRoot: string;
  baselineCommit: string | null;
  indexedAt: string;
  files: RepositoryFileFact[];
}

export interface BootstrapResult {
  snapshot: CurrentSystemSnapshot;
  index: RepositoryIndex;
  snapshotPath: string;
  indexPath: string;
}

export interface BootstrapOptions {
  rootDir: string;
  now?: Date;
  maxFiles?: number;
  maxFileBytes?: number;
}

interface ManifestObservation {
  path: string;
  name: string | null;
  description: string | null;
  dependencies: Record<string, string>;
  exports: string[];
  serviceLike: boolean;
}

function git(rootDir: string, args: string[]): string | null {
  const result = spawnSync(
    'git',
    ['-c', `safe.directory=${rootDir.replaceAll('\\', '/')}`, ...args],
    { cwd: rootDir, encoding: 'utf8', windowsHide: true },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function readBoundedText(file: string, maxBytes: number): string | null {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  if (size > maxBytes) return null;
  const buffer = readFileSync(file);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_.@/-]+/)
        .filter((token) => token.length >= 3)
        .slice(0, 256),
    ),
  ].sort();
}

function inspectSourceFile(
  rootDir: string,
  absolute: string,
  maxFileBytes: number,
): RepositoryFileFact {
  const relative = workspaceRelative(rootDir, absolute);
  const extension = path.extname(relative).toLowerCase();
  const bytes = statSync(absolute).size;
  const content = readBoundedText(absolute, maxFileBytes);
  const imports =
    content === null
      ? []
      : [
          ...content.matchAll(
            /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g,
          ),
        ]
          .map((match) => match[1])
          .filter((value): value is string => value !== undefined);
  const exports =
    content === null
      ? []
      : [...content.matchAll(/export\s+(?:default\s+)?(?:class|function|interface|type|const|let|var)\s+([A-Za-z0-9_$]+)/g)]
          .map((match) => match[1])
          .filter((value): value is string => value !== undefined);
  return {
    path: relative,
    language: LANGUAGE_BY_EXTENSION[extension] ?? null,
    bytes,
    hash: sha256(content ?? `${relative}:${bytes}`),
    imports: [...new Set(imports)].sort(),
    exports: [...new Set(exports)].sort(),
    tokens: tokenize(`${relative} ${exports.join(' ')} ${imports.join(' ')}`),
    isTest: /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(relative),
    isConfiguration:
      /(^|\/)(package\.json|tsconfig[^/]*\.json|.*\.config\.[^/]+|Dockerfile|docker-compose[^/]*|\.github\/)/i.test(
        relative,
      ),
  };
}

function walkFiles(rootDir: string, maxFiles: number, maxFileBytes: number): {
  facts: RepositoryFileFact[];
  truncated: boolean;
} {
  const facts: RepositoryFileFact[] = [];
  const queue = [rootDir];
  let truncated = false;
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const absolute = assertInsideWorkspace(rootDir, path.join(directory, entry.name));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (facts.length >= maxFiles) {
        truncated = true;
        break;
      }
      facts.push(inspectSourceFile(rootDir, absolute, maxFileBytes));
    }
    if (truncated) break;
  }
  return { facts: facts.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}

function readManifests(rootDir: string, facts: RepositoryFileFact[]): ManifestObservation[] {
  const manifests: ManifestObservation[] = [];
  for (const fact of facts.filter((entry) => path.basename(entry.path) === 'package.json')) {
    try {
      const parsed = JSON.parse(
        readFileSync(assertInsideWorkspace(rootDir, fact.path), 'utf8'),
      ) as Record<string, unknown>;
      const dependencyMaps = [
        parsed['dependencies'],
        parsed['devDependencies'],
        parsed['peerDependencies'],
      ].filter(
        (value): value is Record<string, string> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      );
      const dependencies = Object.assign({}, ...dependencyMaps) as Record<string, string>;
      const exportsValue = parsed['exports'];
      const packageExports =
        typeof exportsValue === 'string'
          ? [exportsValue]
          : typeof exportsValue === 'object' && exportsValue !== null
            ? Object.keys(exportsValue)
            : [];
      const scripts =
        typeof parsed['scripts'] === 'object' && parsed['scripts'] !== null
          ? (parsed['scripts'] as Record<string, unknown>)
          : {};
      manifests.push({
        path: fact.path,
        name: typeof parsed['name'] === 'string' ? parsed['name'] : null,
        description: typeof parsed['description'] === 'string' ? parsed['description'] : null,
        dependencies,
        exports: packageExports,
        serviceLike:
          Object.hasOwn(scripts, 'start') ||
          Object.hasOwn(scripts, 'dev') ||
          typeof parsed['bin'] === 'string' ||
          (typeof parsed['bin'] === 'object' && parsed['bin'] !== null),
      });
    } catch {
      // Invalid manifests are captured as uncertainty, not allowed to abort the snapshot.
    }
  }
  return manifests.sort((a, b) => a.path.localeCompare(b.path));
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value !== undefined && value.length > 0))].sort();
}

function matchingPaths(facts: RepositoryFileFact[], pattern: RegExp): string[] {
  return facts.filter((fact) => pattern.test(fact.path)).map((fact) => fact.path).slice(0, 100);
}

function evidence(
  now: string,
  classification: EvidenceReference['classification'],
  pathValue: string | null,
  detail: string,
): EvidenceReference {
  return {
    id: stableId('EV', classification, pathValue ?? '', detail),
    classification,
    path: pathValue,
    detail,
    observedAt: now,
  };
}

function classifyProject(facts: RepositoryFileFact[]): ProjectType {
  const sourceFiles = facts.filter(
    (fact) =>
      fact.language !== null &&
      !fact.isTest &&
      !fact.isConfiguration &&
      fact.language !== 'Markdown',
  );
  if (sourceFiles.length === 0) return 'GREENFIELD';
  if (sourceFiles.length < 5) return 'PARTIAL';
  return 'BROWNFIELD';
}

export function bootstrapRepository(options: BootstrapOptions): BootstrapResult {
  const rootDir = path.resolve(options.rootDir);
  const now = (options.now ?? new Date()).toISOString();
  const maxFiles = options.maxFiles ?? 10_000;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  const { facts, truncated } = walkFiles(rootDir, maxFiles, maxFileBytes);
  const manifests = readManifests(rootDir, facts);
  const commit = git(rootDir, ['rev-parse', 'HEAD']);
  const dirtyOutput = git(rootDir, ['status', '--porcelain']);
  const languages: Record<string, number> = {};
  for (const fact of facts) {
    if (fact.language !== null) languages[fact.language] = (languages[fact.language] ?? 0) + 1;
  }
  const allDependencies = Object.assign({}, ...manifests.map((manifest) => manifest.dependencies)) as Record<
    string,
    string
  >;
  const frameworkNames = Object.entries(FRAMEWORK_PACKAGES)
    .filter(([dependency]) => Object.hasOwn(allDependencies, dependency))
    .map(([, framework]) => framework);
  const topLevelModules = facts
    .map((fact) => fact.path.split('/')[0])
    .filter((value): value is string => value !== undefined && !value.startsWith('.'));
  const readme = facts.find((fact) => fact.path.toLowerCase() === 'readme.md');
  const readmeText =
    readme === undefined
      ? null
      : readBoundedText(assertInsideWorkspace(rootDir, readme.path), maxFileBytes);
  const readmeHeading = readmeText?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const todoCount = facts.reduce((total, fact) => {
    const content = readBoundedText(assertInsideWorkspace(rootDir, fact.path), maxFileBytes);
    return total + (content?.match(/\b(?:TODO|FIXME)\b/g)?.length ?? 0);
  }, 0);
  const authPaths = matchingPaths(facts, /auth|oauth|session|identity|login/i);
  const authorizationPaths = matchingPaths(facts, /rbac|permission|policy|authorize|role/i);
  const storagePaths = matchingPaths(facts, /database|storage|repository|prisma|migration|schema\.sql/i);
  const messagingPaths = matchingPaths(facts, /queue|event|message|kafka|rabbit|nats/i);
  const deploymentPaths = matchingPaths(
    facts,
    /(^|\/)(Dockerfile|docker-compose|k8s|kubernetes|helm|terraform|pulumi|\.github\/workflows)/i,
  );
  const frontendPaths = matchingPaths(facts, /(^|\/)(pages|app|components|frontend|web|ui)(\/|$)/i);
  const testPaths = facts.filter((fact) => fact.isTest).map((fact) => fact.path).slice(0, 200);
  const configurationPaths = facts
    .filter((fact) => fact.isConfiguration)
    .map((fact) => fact.path)
    .slice(0, 200);
  const publicApis = unique([
    ...manifests.flatMap((manifest) =>
      manifest.exports.map((entry) => `${manifest.name ?? manifest.path}:${entry}`),
    ),
    ...facts
      .filter((fact) => /(^|\/)index\.[cm]?[jt]sx?$/.test(fact.path))
      .flatMap((fact) => fact.exports.map((name) => `${fact.path}#${name}`)),
  ]).slice(0, 300);
  const domainModels = unique(
    facts.flatMap((fact) =>
      fact.exports
        .filter((name) => /(Model|Entity|Aggregate|Record|Schema|State|Session)$/i.test(name))
        .map((name) => `${fact.path}#${name}`),
    ),
  ).slice(0, 200);
  const observedEvidence: EvidenceReference[] = [
    ...manifests.map((manifest) =>
      evidence(now, 'OBSERVED_IMPLEMENTATION', manifest.path, `Package manifest ${manifest.name ?? '(unnamed)'}`),
    ),
    ...testPaths.slice(0, 30).map((file) =>
      evidence(now, 'OBSERVED_IMPLEMENTATION', file, 'Automated test evidence'),
    ),
  ];
  if (readme !== undefined) {
    observedEvidence.push(
      evidence(now, 'DOCUMENTED_ARCHITECTURE', readme.path, readmeHeading ?? 'Repository README'),
    );
  }
  const snapshot: CurrentSystemSnapshot = {
    schemaVersion: 'specbridge.snapshot.v2',
    identity: {
      root: rootDir,
      name: repositoryName(rootDir),
      commit,
      contentFingerprint: sha256(
        facts.map((fact) => `${fact.path}\u0000${fact.hash}`).join('\u0001'),
      ),
      dirty: dirtyOutput === null ? null : dirtyOutput.length > 0,
      capturedAt: now,
    },
    projectType: classifyProject(facts),
    languages,
    frameworks: unique(frameworkNames),
    modules: unique(topLevelModules),
    services: unique(
      manifests
        .filter((manifest) => manifest.serviceLike)
        .map((manifest) => manifest.name ?? path.dirname(manifest.path)),
    ),
    publicApis,
    domainModels,
    storage: storagePaths,
    messaging: messagingPaths,
    authentication: authPaths,
    authorization: authorizationPaths,
    frontend: frontendPaths,
    deployment: deploymentPaths,
    tests: testPaths,
    integrations: matchingPaths(facts, /(^|\/)integrations?(\/|$)|connector|adapter/i),
    configuration: configurationPaths,
    architecturalPatterns: unique([
      manifests.length > 1 ? 'monorepo' : null,
      messagingPaths.length > 0 ? 'event-or-message-driven components observed' : null,
      publicApis.length > 0 ? 'explicit package or module boundaries observed' : null,
    ]),
    importantConstraints: unique([
      Object.hasOwn(allDependencies, 'typescript') || languages['TypeScript'] !== undefined
        ? 'TypeScript is part of the current implementation.'
        : null,
      existsSync(path.join(rootDir, 'pnpm-lock.yaml')) ? 'pnpm lockfile is authoritative.' : null,
    ]),
    knownProductBehavior: unique([
      ...manifests.map((manifest) => manifest.description),
      readmeHeading,
    ]),
    technicalDebt: todoCount > 0 ? [`${todoCount} TODO/FIXME markers observed.`] : [],
    uncertainties: unique([
      commit === null ? 'Git baseline could not be resolved.' : null,
      truncated ? `Repository scan stopped at ${maxFiles} files.` : null,
      testPaths.length === 0 ? 'No automated tests were discovered.' : null,
      manifests.length === 0 ? 'No package manifest was discovered.' : null,
    ]),
    evidence: observedEvidence,
    indexedFiles: facts.length,
    truncated,
  };
  const index: RepositoryIndex = {
    schemaVersion: 'specbridge.repository-index.v2',
    repositoryRoot: rootDir,
    baselineCommit: commit,
    indexedAt: now,
    files: facts,
  };
  const repositoryDir = assertInsideWorkspace(rootDir, path.join('.specbridge', 'repository'));
  mkdirSync(repositoryDir, { recursive: true });
  const snapshotPath = path.join(repositoryDir, 'current-system.json');
  const indexPath = path.join(repositoryDir, 'index.json');
  writeFileAtomic(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return { snapshot, index, snapshotPath, indexPath };
}
