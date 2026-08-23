import path from 'node:path';
import type { AutonomyPolicy, ToolsmithCapability } from '@specbridge/core';
import type { ToolsmithDenialReason, ToolInstallScope } from '../vocabulary.js';

/**
 * The Toolsmith capability broker.
 *
 * Pure: a request, a policy, and a workspace boundary in; a decision out. No
 * filesystem, no process, no clock. Everything that could go wrong with
 * "let the agent install what it needs" is decided here, where a test can
 * enumerate it.
 *
 * The scope preference order is the interesting part, and it is a policy
 * rather than a convenience:
 *
 *   PROJECT_LOCAL  ->  PORTABLE  ->  CONTAINERIZED  ->  USER_LOCAL
 *
 * with no machine-global option at all. A tool that genuinely needs
 * administrator rights is not an engineering problem the runtime can solve;
 * it is a question for a person, and it leaves through the authority
 * firewall rather than through this broker. When a request asks for
 * something admin-shaped, the broker denies it AND names the portable route,
 * because "install Docker Desktop" and "pull a container image" are wildly
 * different asks that people conflate.
 */

export interface BrokerRequest {
  capability: ToolsmithCapability;
  /** Workspace-relative path, package name, or image reference. */
  target: string;
  scope: ToolInstallScope;
  purpose: string;
  /** Bytes the action expects to fetch, when it can estimate. */
  estimatedBytes?: number | null | undefined;
}

export interface BrokerContext {
  policy: AutonomyPolicy;
  /** Absolute workspace root; every PROJECT_LOCAL target must be inside it. */
  workspaceRoot: string;
  /** Protected path globs from execution policy. */
  protectedPaths: readonly string[];
  /** Grants already issued for this job. */
  grantsUsed: number;
}

export type BrokerDecision =
  | { granted: true; scope: ToolInstallScope; note?: string | undefined }
  | {
      granted: false;
      reason: ToolsmithDenialReason;
      detail: string;
      /** A route that WOULD be granted, when one exists. */
      suggestedAlternative?: string | undefined;
    };

/**
 * Targets that would grant AUTHORITY rather than provide a tool.
 *
 * The list is short and specific on purpose: these are the exact files and
 * fields that decide what SpecBridge may do. A request to write any of them
 * is denied whatever capability it claims and whatever reason it gives,
 * because there is no legitimate engineering need that requires an agent to
 * edit its own permissions.
 */
const AUTHORITY_TARGETS: readonly RegExp[] = [
  /(^|[\\/])\.specbridge[\\/]config\.json$/i,
  /(^|[\\/])\.specbridge[\\/]autonomy[\\/]/i,
  /(^|[\\/])\.claude[\\/]settings(\.local)?\.json$/i,
  /(^|[\\/])\.kiro[\\/]/i,
];

/** Capability classes that write into the workspace and must stay inside it. */
const WORKSPACE_SCOPED: readonly ToolsmithCapability[] = [
  'PROJECT_LOCAL_SCRIPT',
  'PROJECT_DEPENDENCY',
  'PROJECT_LOCAL_TOOLCHAIN',
  'CODE_GENERATION',
];

/**
 * Capability classes whose canonical scope is fixed by what they ARE.
 *
 * A container image is containerized; a project script is project-local.
 * Recording the expectation lets the broker correct a mismatched request
 * rather than granting something in the wrong place, which is how a
 * "project-local" install quietly lands in a user profile.
 */
const CANONICAL_SCOPE: Readonly<Partial<Record<ToolsmithCapability, ToolInstallScope>>> =
  Object.freeze({
    PROJECT_LOCAL_SCRIPT: 'PROJECT_LOCAL',
    PROJECT_DEPENDENCY: 'PROJECT_LOCAL',
    PACKAGE_MANAGER_INSTALL: 'PROJECT_LOCAL',
    CODE_GENERATION: 'PROJECT_LOCAL',
    PROJECT_LOCAL_TOOLCHAIN: 'PROJECT_LOCAL',
    CONTAINER_IMAGE: 'CONTAINERIZED',
    CONTAINER_LIFECYCLE: 'CONTAINERIZED',
    USER_LOCAL_CLI: 'USER_LOCAL',
    BROWSER_RUNTIME: 'USER_LOCAL',
  });

export function decideToolsmithRequest(
  request: BrokerRequest,
  context: BrokerContext,
): BrokerDecision {
  const policy = context.policy.toolsmith;

  if (!policy.enabled) {
    return {
      granted: false,
      reason: 'TOOLSMITH_DISABLED',
      detail:
        'The Toolsmith is disabled by autonomy policy, so a missing tool stops the run instead ' +
        'of being provisioned.',
      suggestedAlternative: 'Enable autonomy.toolsmith and grant the capability classes you allow.',
    };
  }

  if (!policy.capabilities.includes(request.capability)) {
    return {
      granted: false,
      reason: 'CAPABILITY_NOT_ENABLED',
      detail: `The capability class ${request.capability} is not granted by the autonomy policy.`,
      suggestedAlternative: `Add ${request.capability} to autonomy.toolsmith.capabilities.`,
    };
  }

  if (context.grantsUsed >= policy.maxGrantsPerJob) {
    return {
      granted: false,
      reason: 'GRANT_BUDGET_EXHAUSTED',
      detail: `All ${policy.maxGrantsPerJob} Toolsmith grants for this job are used.`,
    };
  }

  // Authority-shaped targets, before anything else: a request to edit the
  // policy is refused even when the capability that carries it is granted.
  if (AUTHORITY_TARGETS.some((pattern) => pattern.test(request.target))) {
    return {
      granted: false,
      reason: 'WOULD_CREATE_AUTHORITY',
      detail:
        `"${request.target}" is control-plane state, not project tooling. Agents may create ` +
        'tools; they may never create authority.',
    };
  }

  if (
    request.estimatedBytes !== null &&
    request.estimatedBytes !== undefined &&
    request.estimatedBytes > policy.maxDownloadBytes
  ) {
    return {
      granted: false,
      reason: 'DOWNLOAD_TOO_LARGE',
      detail:
        `${request.estimatedBytes} bytes exceeds the ${policy.maxDownloadBytes}-byte ceiling ` +
        'for one Toolsmith action.',
    };
  }

  const canonical = CANONICAL_SCOPE[request.capability] ?? request.scope;

  if (WORKSPACE_SCOPED.includes(request.capability)) {
    const boundary = assertInsideWorkspaceBoundary(request.target, context);
    if (boundary !== undefined) return boundary;
  }

  if (request.scope === 'USER_LOCAL' && canonical !== 'USER_LOCAL') {
    return {
      granted: false,
      reason: 'PORTABLE_ALTERNATIVE_REQUIRED',
      detail:
        `${request.capability} belongs in the project, not in a user profile. A tool that ` +
        'lives outside the workspace outlives the job that created it.',
      suggestedAlternative: `Request the same capability with scope ${canonical}.`,
    };
  }

  if (request.capability === 'CONTAINER_IMAGE') {
    const registry = registryOf(request.target);
    const allowed = policy.allowedImageRegistries;
    if (allowed.length > 0 && (registry === null || !allowed.includes(registry))) {
      return {
        granted: false,
        reason: 'REGISTRY_NOT_ALLOWED',
        detail: `Image registry "${registry ?? 'implicit default'}" is not in the allowed list.`,
        suggestedAlternative: `Allowed registries: ${allowed.join(', ')}.`,
      };
    }
  }

  if (request.capability === 'USER_LOCAL_CLI' && looksAdminScoped(request.target)) {
    return {
      granted: false,
      reason: 'REQUIRES_ADMIN_PRIVILEGE',
      detail:
        `"${request.target}" resolves to a system location. SpecBridge never installs into a ` +
        'system prefix, and a tool that genuinely needs one is a question for a person.',
      suggestedAlternative:
        'Use a project-local install, a portable archive, or a container image instead.',
    };
  }

  return {
    granted: true,
    scope: canonical,
    ...(canonical !== request.scope
      ? { note: `scope narrowed from ${request.scope} to ${canonical}` }
      : {}),
  };
}

function assertInsideWorkspaceBoundary(
  target: string,
  context: BrokerContext,
): BrokerDecision | undefined {
  if (path.isAbsolute(target)) {
    const resolved = path.resolve(target);
    const root = path.resolve(context.workspaceRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return {
        granted: false,
        reason: 'TARGET_OUTSIDE_WORKSPACE',
        detail: `"${target}" is outside the workspace. Project tooling lives in the project.`,
      };
    }
    return matchesProtected(path.relative(root, resolved), context);
  }
  const normalized = path.normalize(target).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized === '..') {
    return {
      granted: false,
      reason: 'TARGET_OUTSIDE_WORKSPACE',
      detail: `"${target}" escapes the workspace root.`,
    };
  }
  return matchesProtected(normalized, context);
}

function matchesProtected(relative: string, context: BrokerContext): BrokerDecision | undefined {
  const normalized = relative.replace(/\\/g, '/');
  for (const pattern of context.protectedPaths) {
    if (globMatches(pattern, normalized)) {
      return {
        granted: false,
        reason: 'TARGET_PROTECTED_PATH',
        detail: `"${relative}" is a protected path (${pattern}).`,
      };
    }
  }
  return undefined;
}

/** Characters that must be escaped when copied into a generated regex. */
const ESCAPE_IN_PATTERN = /[.+^${}()|[\]\\/]/;

/**
 * The small glob subset protected paths actually use: `*`, `**`, and `?`.
 *
 * Implemented here rather than pulled in, because the broker must be pure
 * and because the semantics have to match the protected-path check the
 * execution layer already performs. A near-miss would be worse than no check
 * at all: it would grant something the writer would then refuse, halfway
 * through, at 03:00.
 */
function globMatches(pattern: string, value: string): boolean {
  // Translated by scanning rather than by chained `replace` calls. A chain
  // has to smuggle `**` past the later passes through a placeholder
  // character, and any placeholder is a character some real pattern might
  // contain. Scanning once has no placeholder and no such hazard.
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` matches any number of leading segments, including none.
        index += pattern[index + 2] === '/' ? 2 : 1;
        source += '(?:.*/)?';
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += ESCAPE_IN_PATTERN.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`).test(value);
}

function registryOf(image: string): string | null {
  const first = image.split('/')[0] ?? '';
  return first.includes('.') || first.includes(':') ? first : null;
}

function looksAdminScoped(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.startsWith('/usr/') ||
    normalized.startsWith('/opt/') ||
    normalized.startsWith('/etc/') ||
    normalized.startsWith('/bin/') ||
    normalized.startsWith('/sbin/') ||
    /^[a-z]:\/(program files|windows)/.test(normalized)
  );
}

/**
 * The scope the broker would prefer for a capability, in one call.
 *
 * Exported so a caller can ASK before requesting, which produces a granted
 * request instead of a denial-and-retry. Cheap politeness that keeps the
 * ledger readable.
 */
export function preferredScopeFor(capability: ToolsmithCapability): ToolInstallScope {
  return CANONICAL_SCOPE[capability] ?? 'PROJECT_LOCAL';
}
