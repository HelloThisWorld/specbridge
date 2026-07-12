/**
 * @specbridge/drift — deterministic spec-to-code drift verification.
 *
 * v0.4 ships the full verification stack under `verification/`: comparison
 * resolution, spec policies, the rule engine with the stable SBV001–SBV025
 * rules, affected-spec resolution, trusted-command orchestration, and
 * schema-validated report assembly. No function here requires an LLM, and
 * verification never writes to `.kiro`, approval state, or evidence.
 *
 * The v0.1 primitives (git-diff, impact-area, coverage, drift-report) remain
 * exported unchanged for library consumers.
 */

export * from './git-diff.js';
export * from './evidence.js';
export * from './impact-area.js';
export * from './requirement-coverage.js';
export * from './task-coverage.js';
export * from './drift-report.js';

export * from './verification/policy.js';
export * from './verification/comparison.js';
export * from './verification/context.js';
export * from './verification/commands.js';
export * from './verification/rule-engine.js';
export * from './verification/rules.js';
export * from './verification/affected.js';
export * from './verification/verify.js';
