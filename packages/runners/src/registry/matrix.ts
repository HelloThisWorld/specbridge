import type { RegisteredRunnerProfile } from '../registry.js';
import type { RunnerCategory, RunnerSupportLevel } from '../contracts/capabilities.js';
import { profileModel, profileOperations, profileTransport } from './runner-selection.js';

/**
 * The authoritative runner capability matrix (v0.6.1).
 *
 * Generated from registered runner metadata (declared capabilities and
 * adapter-declared support levels) — the SAME source feeds the CLI
 * (`runner matrix`), the MCP `runner_matrix` tool, the README, and the
 * documentation. There is deliberately no second matrix implementation.
 */

export interface RunnerMatrixRow {
  profile: string;
  implementation: string;
  category: RunnerCategory;
  /** Adapter-declared support level (detection may downgrade at run time). */
  support: RunnerSupportLevel;
  enabled: boolean;
  author: boolean;
  refine: boolean;
  execute: boolean;
  resume: boolean;
  local: boolean;
}

/** Build matrix rows from registered profiles, in registration order. */
export function runnerMatrixRows(profiles: RegisteredRunnerProfile[]): RunnerMatrixRow[] {
  return profiles.map((profile) => {
    const operations = new Set(profileOperations(profile));
    return {
      profile: profile.name,
      implementation: profile.runner.name,
      category: profile.runner.category,
      support: profile.runner.declaredSupportLevel ?? 'production',
      enabled: profile.config.enabled !== false,
      author: operations.has('stage-generation'),
      refine: operations.has('stage-refinement'),
      execute: operations.has('task-execution'),
      resume: operations.has('task-resume'),
      local: profileTransport(profile.config).localExecution,
    };
  });
}

/** Markdown capability matrix — the same source feeds docs and README. */
export function renderRunnerMatrixMarkdown(rows: RunnerMatrixRow[]): string {
  const lines = [
    '| Profile | Support | Author | Refine | Execute | Resume | Local |',
    '|---------|---------|--------|--------|---------|--------|-------|',
  ];
  for (const row of rows) {
    const yn = (value: boolean): string => (value ? 'yes' : 'no');
    lines.push(
      `| ${row.profile} | ${row.support} | ${yn(row.author)} | ${yn(row.refine)} | ${yn(row.execute)} | ${yn(row.resume)} | ${yn(row.local)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One profile summary used by `runner list` and the MCP `runner_list` tool. */
export interface RunnerProfileSummary {
  profile: string;
  implementation: string;
  category: RunnerCategory;
  supportLevel: RunnerSupportLevel;
  enabled: boolean;
  model: string | null;
  networkBacked: boolean;
  localExecution: boolean;
  supportedOperations: string[];
}

export function runnerProfileSummary(profile: RegisteredRunnerProfile): RunnerProfileSummary {
  const transport = profileTransport(profile.config);
  return {
    profile: profile.name,
    implementation: profile.runner.name,
    category: profile.runner.category,
    supportLevel: profile.runner.declaredSupportLevel ?? 'production',
    enabled: profile.config.enabled !== false,
    model: profileModel(profile.config),
    networkBacked: transport.networkBacked,
    localExecution: transport.localExecution,
    supportedOperations: profileOperations(profile),
  };
}

/**
 * Redacted profile configuration for displays. Profiles never store
 * credentials (rejected by the schema); this is defense in depth for
 * passthrough fields.
 */
export function redactedRunnerProfileConfig(
  profile: RegisteredRunnerProfile,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile.config as Record<string, unknown>)) {
    redacted[key] = /key|token|secret|password|credential/i.test(key) ? '<redacted>' : value;
  }
  return redacted;
}
