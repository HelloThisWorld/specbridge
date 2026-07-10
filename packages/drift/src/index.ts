/**
 * @specbridge/drift — deterministic spec-to-code drift primitives.
 *
 * v0.1 status: this package ships the pure building blocks (git diff
 * parsing, impact areas, requirement/task coverage, report assembly) with
 * full test coverage. The `specbridge spec verify` CLI command that wires
 * them to live repositories lands in a later phase — see docs/roadmap.md.
 * No function here requires an LLM.
 */

export * from './git-diff.js';
export * from './evidence.js';
export * from './impact-area.js';
export * from './requirement-coverage.js';
export * from './task-coverage.js';
export * from './drift-report.js';
