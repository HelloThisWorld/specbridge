import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Project-root resolution for one server process.
 *
 * Resolution order:
 *   1. explicit `--project-root`
 *   2. `SPECBRIDGE_PROJECT_ROOT`
 *   3. `CLAUDE_PROJECT_DIR` (set by Claude Code for plugin MCP servers)
 *   4. the current working directory
 *
 * The resolved root is canonicalized (symlinks resolved), must exist, and
 * must be a directory. One server process serves exactly one project root:
 * no tool argument can ever move the server to a different project after
 * startup. Workspace discovery (walking up to find `.kiro`) happens later
 * through the shared `@specbridge/core` logic and is itself pinned after
 * the first successful resolution.
 */

export interface ProjectRootResolution {
  ok: true;
  /** Canonical absolute path. */
  projectRoot: string;
  /** Which input decided the root (for diagnostics). */
  source: 'flag' | 'SPECBRIDGE_PROJECT_ROOT' | 'CLAUDE_PROJECT_DIR' | 'cwd';
}

export interface ProjectRootFailure {
  ok: false;
  message: string;
  remediation: string[];
}

export interface ResolveProjectRootOptions {
  /** Explicit `--project-root` value, if given. */
  flagValue?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export function resolveProjectRoot(
  options: ResolveProjectRootOptions = {},
): ProjectRootResolution | ProjectRootFailure {
  const env = options.env ?? process.env;
  const candidates: { value: string; source: ProjectRootResolution['source'] }[] = [];
  if (options.flagValue !== undefined) candidates.push({ value: options.flagValue, source: 'flag' });
  const fromEnv = env['SPECBRIDGE_PROJECT_ROOT'];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    candidates.push({ value: fromEnv, source: 'SPECBRIDGE_PROJECT_ROOT' });
  }
  const fromClaude = env['CLAUDE_PROJECT_DIR'];
  if (fromClaude !== undefined && fromClaude.length > 0) {
    candidates.push({ value: fromClaude, source: 'CLAUDE_PROJECT_DIR' });
  }
  candidates.push({ value: options.cwd ?? process.cwd(), source: 'cwd' });

  const selected = candidates[0];
  if (selected === undefined) {
    return {
      ok: false,
      message: 'No project root candidate is available.',
      remediation: ['Pass --project-root <path> or start the server inside the project directory.'],
    };
  }

  return validateProjectRoot(selected.value, selected.source, options.cwd ?? process.cwd());
}

function validateProjectRoot(
  value: string,
  source: ProjectRootResolution['source'],
  cwd: string,
): ProjectRootResolution | ProjectRootFailure {
  if (value.includes('\0')) {
    return {
      ok: false,
      message: 'The project root contains a null byte and was rejected.',
      remediation: ['Pass a plain filesystem path as --project-root.'],
    };
  }

  const resolved = path.resolve(cwd, value);
  let canonical: string;
  try {
    // realpath canonicalizes symlinks so every later containment check
    // compares real paths; a dangling link or missing directory fails here.
    canonical = realpathSync(resolved);
  } catch {
    return {
      ok: false,
      message: `The project root does not exist: ${resolved} (from ${source}).`,
      remediation: [
        'Pass an existing directory as --project-root,',
        'or start the server from inside the project.',
      ],
    };
  }

  let stats;
  try {
    stats = statSync(canonical);
  } catch {
    return {
      ok: false,
      message: `The project root is not readable: ${canonical}.`,
      remediation: ['Check directory permissions.'],
    };
  }
  if (!stats.isDirectory()) {
    return {
      ok: false,
      message: `The project root is not a directory: ${canonical}.`,
      remediation: ['Pass the project directory, not a file, as --project-root.'],
    };
  }

  return { ok: true, projectRoot: canonical, source };
}
