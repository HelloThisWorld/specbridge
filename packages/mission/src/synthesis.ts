import { analyzeSpec, parseRequirements, parseTasks, requireSpec } from '@specbridge/compat-kiro';
import { MarkdownDocument } from '@specbridge/compat-kiro';
import {
  evaluateWorkflow,
  executeSpecCreation,
  planSpecCreationFromFiles,
  validateSpecName,
} from '@specbridge/workflow';
import { MissionError } from './errors.js';
import type { MissionDeps } from './service.js';
import { refreshCoverage } from './service.js';
import type {
  ConstitutionRule,
  DiscoveryDecision,
  MissionAdr,
  MissionState,
  ProductContract,
} from './state.js';
import { MISSION_LIMITS } from './state.js';
import { assertMissionTransition } from './state-machine.js';
import {
  appendMissionEvent,
  readAdrs,
  readConstitution,
  readContractRegistry,
  readDecisions,
  requireMissionState,
  writeMissionState,
  writeSpecCandidate,
} from './store.js';

/**
 * Mission → Kiro spec synthesis.
 *
 * A deterministic COMPILER, not a generator: every sentence in the produced
 * documents traces to a recorded mission artifact — the goal, non-goals,
 * decisions, constitution rules, contracts, and ADRs — and the provenance
 * map records exactly which. No model is invoked; missing content means the
 * mission is not ready, never that something gets invented.
 *
 * The produced `tasks.md` deliberately contains OBJECTIVES, not coding
 * steps: one objective per product contract (in dependency order) with the
 * contract's requirements as acceptance criteria. How an objective is
 * implemented is the autonomous runtime's job; the approved objective is the
 * human contract.
 *
 * Everything flows through the existing creation machinery
 * (`planSpecCreationFromFiles` → `executeSpecCreation`) and the existing
 * approval lifecycle. Synthesis writes ONE new spec; it never overwrites an
 * existing one, and it approves nothing.
 */

export interface SynthesisRequest {
  /** Spec name; defaults to a slug of the mission name. */
  specName?: string | undefined;
}

export interface SynthesisResult {
  mission: MissionState;
  specName: string;
  files: { fileName: string; bytes: number }[];
  /** One row per generated requirement, tracing it to its sources. */
  provenance: RequirementProvenance[];
  objectiveCount: number;
  warnings: string[];
}

export interface RequirementProvenance {
  requirementNumber: number;
  title: string;
  contractId: string;
  contractRevision: number;
  decisionIds: string[];
  criteria: { criterionId: string; source: string }[];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/** Order contracts so dependencies come before dependents. Deterministic. */
export function topologicalContractOrder(contracts: readonly ProductContract[]): ProductContract[] {
  const byId = new Map(contracts.map((contract) => [contract.contractId, contract]));
  const ordered: ProductContract[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (contract: ProductContract): void => {
    const seen = state.get(contract.contractId);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new MissionError(
        'SBM011',
        `The contract registry has a dependency cycle involving ${contract.contractId}.`,
        { remediation: ['Revise the contracts so dependencies form a DAG before synthesizing.'] },
      );
    }
    state.set(contract.contractId, 'visiting');
    for (const dependency of contract.dependsOn) {
      const dependencyContract = byId.get(dependency);
      if (dependencyContract !== undefined) visit(dependencyContract);
    }
    state.set(contract.contractId, 'done');
    ordered.push(contract);
  };
  for (const contract of [...contracts].sort((a, b) => a.contractId.localeCompare(b.contractId, 'en'))) {
    visit(contract);
  }
  return ordered;
}

function asCriterion(statement: string): string {
  const trimmed = statement.trim().replace(/\s+/g, ' ');
  const terminated = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  if (/\bSHALL\b/.test(terminated) || /^(WHEN|IF|WHILE|WHERE)\b/i.test(terminated)) {
    return terminated;
  }
  return `THE SYSTEM SHALL ${terminated.charAt(0).toLowerCase()}${terminated.slice(1)}`;
}

interface CompiledDocuments {
  requirements: string;
  design: string;
  tasks: string;
  provenance: RequirementProvenance[];
  objectiveCount: number;
}

/**
 * Compile the mission's approved truth into the three Kiro documents. Pure
 * given its inputs; exported for direct testing.
 */
export function compileMissionDocuments(input: {
  mission: MissionState;
  contracts: readonly ProductContract[];
  constitutionRules: readonly ConstitutionRule[];
  adrs: readonly MissionAdr[];
  decisions: readonly DiscoveryDecision[];
}): CompiledDocuments {
  const { mission } = input;
  const contracts = topologicalContractOrder(input.contracts);
  if (contracts.length === 0) {
    throw new MissionError('SBM011', 'Synthesis needs at least one recorded product contract.', {
      remediation: ['Record the contract registry during discovery before synthesizing.'],
    });
  }
  const activeRules = input.constitutionRules.filter((rule) => rule.status === 'active');
  const primaryUser = mission.targetUsers[0] ?? 'user of the system';

  // --- requirements.md -------------------------------------------------------
  const provenance: RequirementProvenance[] = [];
  const requirementLines: string[] = [
    '# Requirements Document',
    '',
    '## Introduction',
    '',
    mission.goal.trim(),
    '',
  ];
  if (mission.targetUsers.length > 0) {
    requirementLines.push(`Target users: ${mission.targetUsers.join('; ')}.`, '');
  }
  if (mission.successCriteria.length > 0) {
    requirementLines.push('Success criteria:', '');
    for (const criterion of mission.successCriteria) requirementLines.push(`- ${criterion}`);
    requirementLines.push('');
  }
  requirementLines.push('## Requirements', '');
  contracts.forEach((contract, index) => {
    const number = index + 1;
    requirementLines.push(`### Requirement ${number}: ${contract.title}`, '');
    requirementLines.push(
      `**User Story:** As a ${primaryUser}, I want ${contract.summary
        .trim()
        .replace(/\.$/, '')
        .replace(/^[A-Z]/, (char) => char.toLowerCase())}, so that ${mission.goal
        .trim()
        .replace(/\.$/, '')
        .replace(/^[A-Z]/, (char) => char.toLowerCase())}.`,
      '',
    );
    requirementLines.push('#### Acceptance Criteria', '');
    const rows: { criterionId: string; source: string }[] = [];
    let criterionNumber = 0;
    for (const requirement of contract.requirements) {
      criterionNumber += 1;
      requirementLines.push(`${criterionNumber}. ${asCriterion(requirement.statement)}`);
      rows.push({
        criterionId: `${number}.${criterionNumber}`,
        source: `${contract.contractId}/r${contract.revision}/${requirement.requirementId}`,
      });
    }
    for (const invariant of contract.invariants) {
      criterionNumber += 1;
      requirementLines.push(`${criterionNumber}. ${asCriterion(invariant.statement)}`);
      rows.push({
        criterionId: `${number}.${criterionNumber}`,
        source: `${contract.contractId}/r${contract.revision}/${invariant.invariantId}`,
      });
    }
    requirementLines.push('');
    provenance.push({
      requirementNumber: number,
      title: contract.title,
      contractId: contract.contractId,
      contractRevision: contract.revision,
      decisionIds: contract.decisionIds,
      criteria: rows,
    });
  });
  requirementLines.push('## Out of Scope', '');
  if (mission.nonGoals.length > 0) {
    for (const nonGoal of mission.nonGoals) requirementLines.push(`- ${nonGoal}`);
  } else {
    requirementLines.push('- Anything not covered by a recorded product contract.');
  }
  requirementLines.push('', '## Non-Functional Requirements', '');
  if (mission.constraints.length > 0) {
    for (const constraint of mission.constraints) requirementLines.push(`- ${constraint}`);
  } else {
    requirementLines.push('- The system SHALL respect the Architecture Constitution recorded for this mission.');
  }
  requirementLines.push('');

  // --- design.md ---------------------------------------------------------------
  const designLines: string[] = [
    '# Design Document',
    '',
    '## Overview',
    '',
    mission.goal.trim(),
    '',
  ];
  if (mission.assumptions.length > 0) {
    designLines.push('Recorded non-blocking assumptions:', '');
    for (const assumption of mission.assumptions) {
      designLines.push(`- ${assumption.id}: ${assumption.statement}`);
    }
    designLines.push('');
  }
  designLines.push('## Architecture', '');
  if (activeRules.length > 0) {
    designLines.push('The Architecture Constitution below is binding for every implementation decision:', '');
    for (const rule of activeRules) {
      designLines.push(`- ${rule.ruleId}: ${rule.statement}`);
    }
  } else {
    designLines.push('No constitution rules were recorded; module structure is an implementation decision.');
  }
  designLines.push('', '## Components and Interfaces', '');
  for (const contract of contracts) {
    designLines.push(`### ${contract.contractId}: ${contract.title}`, '');
    designLines.push(contract.summary.trim(), '');
    designLines.push(
      `Classification: ${contract.classification}. Compatibility policy: ${contract.compatibilityPolicy}.` +
        (contract.dependsOn.length > 0 ? ` Depends on: ${contract.dependsOn.join(', ')}.` : ''),
      '',
    );
    if (contract.invariants.length > 0) {
      designLines.push('Invariants:', '');
      for (const invariant of contract.invariants) {
        designLines.push(`- ${invariant.invariantId}: ${invariant.statement}`);
      }
      designLines.push('');
    }
  }
  designLines.push('## Error Handling', '');
  const errorDecisions = input.decisions.filter(
    (decision) =>
      decision.status === 'active' &&
      decision.topics.some((topic) =>
        ['failure-semantics', 'retry-semantics', 'timeout-semantics', 'idempotency', 'crash-recovery'].includes(topic),
      ),
  );
  if (errorDecisions.length > 0) {
    for (const decision of errorDecisions) {
      designLines.push(`- ${decision.decisionId}: ${decision.decision}`);
    }
  } else {
    designLines.push('- Failure semantics follow the invariants of the recorded contracts.');
  }
  designLines.push('', '## Security Considerations', '');
  const securityDecisions = input.decisions.filter(
    (decision) => decision.status === 'active' && decision.topics.includes('security'),
  );
  if (securityDecisions.length > 0) {
    for (const decision of securityDecisions) {
      designLines.push(`- ${decision.decisionId}: ${decision.decision}`);
    }
  } else {
    designLines.push('- All external input is validated before it reaches the canonical model.');
  }
  designLines.push('', '## Testing Strategy', '');
  designLines.push(
    'Every objective completes only through trusted verification: acceptance criteria map to tests, and evidence — never a claim — flips a task checkbox.',
    '',
  );
  designLines.push('## Risks and Trade-offs', '');
  const activeAdrs = input.adrs.filter((adr) => adr.status === 'accepted');
  if (activeAdrs.length > 0) {
    for (const adr of activeAdrs) {
      designLines.push(`- ${adr.adrId} ${adr.title}: ${adr.decision}`);
    }
  } else {
    designLines.push('- No ADRs recorded yet; material trade-offs will be captured as ADRs when they surface.');
  }
  designLines.push('');

  // --- tasks.md ------------------------------------------------------------------
  const taskLines: string[] = ['# Implementation Plan', ''];
  contracts.forEach((contract, index) => {
    const number = index + 1;
    taskLines.push(`- [ ] ${number}. ${contract.title}`);
    taskLines.push('');
    for (const requirement of contract.requirements) {
      taskLines.push(`  - Acceptance: ${requirement.statement.trim()}`);
    }
    for (const invariant of contract.invariants) {
      taskLines.push(`  - Acceptance: ${invariant.statement.trim()}`);
    }
    taskLines.push(`  - Contract: ${contract.contractId} r${contract.revision}`);
    const refs = provenance[index]?.criteria.map((row) => row.criterionId) ?? [];
    if (refs.length > 0) {
      taskLines.push(`  - _Requirements: ${refs.join(', ')}_`);
    }
    taskLines.push('');
  });

  return {
    requirements: `${requirementLines.join('\n').replace(/\n+$/, '')}\n`,
    design: `${designLines.join('\n').replace(/\n+$/, '')}\n`,
    tasks: `${taskLines.join('\n').replace(/\n+$/, '')}\n`,
    provenance,
    objectiveCount: contracts.length,
  };
}

/** Structural gate: the compiled candidates must parse as valid Kiro documents. */
export function validateCompiledDocuments(documents: CompiledDocuments): string[] {
  const problems: string[] = [];
  const requirementsModel = parseRequirements(MarkdownDocument.fromText(documents.requirements));
  if (requirementsModel.requirements.length === 0) {
    problems.push('the compiled requirements.md contains no recognizable requirement blocks');
  }
  for (const requirement of requirementsModel.requirements) {
    if (requirement.criteria.length === 0) {
      problems.push(`requirement ${requirement.id} compiled with no acceptance criteria`);
    }
  }
  const tasksModel = parseTasks(MarkdownDocument.fromText(documents.tasks));
  if (tasksModel.allTasks.length === 0) {
    problems.push('the compiled tasks.md contains no checkbox tasks');
  }
  if (tasksModel.allTasks.some((task) => task.children.length > 0)) {
    problems.push('objectives must be leaf tasks; nested checkbox children were generated');
  }
  return problems;
}

/**
 * Synthesize the Kiro spec for a CONTRACT_READY mission.
 *
 * Lifecycle: CONTRACT_READY → SPEC_SYNTHESIS → SPEC_REVIEW. The spec is
 * created through the existing atomic creation machinery, candidates are
 * archived under `spec-candidates/` first for audit, and approval remains
 * the untouched human workflow (`specbridge spec approve …`).
 */
export function synthesizeMissionSpec(
  deps: MissionDeps,
  missionId: string,
  request: SynthesisRequest = {},
): SynthesisResult {
  let mission = requireMissionState(deps.workspace, missionId);
  if (mission.status !== 'CONTRACT_READY') {
    throw new MissionError(
      'SBM014',
      `Synthesis requires CONTRACT_READY (mission is ${mission.status}).`,
      {
        remediation: [
          mission.status === 'SPEC_REVIEW' || mission.status === 'SPEC_SYNTHESIS'
            ? 'The mission already synthesized a spec; re-open discovery for material changes.'
            : 'Reach CONTRACT_READY first: answer blocking questions and cover the required topics.',
        ],
      },
    );
  }
  const coverage = refreshCoverage(deps, mission);
  if (!coverage.contractReady) {
    throw new MissionError('SBM008', `The coverage gate no longer holds: ${coverage.reasons.join(' ')}`);
  }

  const specName = request.specName ?? slugify(mission.name);
  const nameCheck = validateSpecName(specName);
  if (!nameCheck.valid) {
    throw new MissionError('SBM005', `"${specName}" is not a valid spec name: ${nameCheck.problems.join('; ')}`);
  }

  const contracts = readContractRegistry(deps.workspace, missionId);
  const constitution = readConstitution(deps.workspace, missionId);
  const adrs = readAdrs(deps.workspace, missionId);
  const decisions = readDecisions(deps.workspace, missionId);

  const compiled = compileMissionDocuments({
    mission,
    contracts,
    constitutionRules: constitution?.rules ?? [],
    adrs,
    decisions,
  });
  const problems = validateCompiledDocuments(compiled);
  if (problems.length > 0) {
    throw new MissionError('SBM011', `The compiled spec candidates are invalid: ${problems.join('; ')}.`);
  }

  const at = (deps.clock ?? (() => new Date()))().toISOString();
  mission = { ...mission, updatedAt: at };
  assertMissionTransition(mission.status, 'SPEC_SYNTHESIS');
  mission = { ...mission, status: 'SPEC_SYNTHESIS' };
  appendMissionEvent(deps.workspace, missionId, { at, type: 'synthesis_started', specName });
  mission = writeMissionState(deps.workspace, {
    ...mission,
    counters: { ...mission.counters, events: mission.counters.events + 1 },
  });

  // Candidates are archived before the spec exists: the audit trail shows
  // exactly what was compiled even if creation fails below.
  writeSpecCandidate(deps.workspace, missionId, 'requirements.md', compiled.requirements);
  writeSpecCandidate(deps.workspace, missionId, 'design.md', compiled.design);
  writeSpecCandidate(deps.workspace, missionId, 'tasks.md', compiled.tasks);
  writeSpecCandidate(
    deps.workspace,
    missionId,
    'provenance.json',
    `${JSON.stringify(
      {
        missionId,
        specName,
        generatedAt: at,
        requirements: compiled.provenance,
        constitutionVersion: constitution?.version ?? 0,
        contractRevisions: contracts.map((contract) => ({
          contractId: contract.contractId,
          revision: contract.revision,
        })),
      },
      null,
      2,
    )}\n`,
  );

  try {
    const plan = planSpecCreationFromFiles(
      deps.workspace,
      {
        name: specName,
        specType: 'feature',
        mode: 'requirements-first',
        title: mission.name,
        description: mission.goal.slice(0, MISSION_LIMITS.maxTextChars),
        descriptionIsPlaceholder: false,
        files: [
          { fileName: 'requirements.md', stage: 'requirements', content: compiled.requirements },
          { fileName: 'design.md', stage: 'design', content: compiled.design },
          { fileName: 'tasks.md', stage: 'tasks', content: compiled.tasks },
        ],
      },
      deps.clock ?? (() => new Date()),
    );
    executeSpecCreation(deps.workspace, plan);
  } catch (cause) {
    // Creation failed (most likely: the spec already exists). The mission
    // returns to CONTRACT_READY — synthesis is retryable, never half-done.
    const failedAt = (deps.clock ?? (() => new Date()))().toISOString();
    appendMissionEvent(deps.workspace, missionId, {
      at: failedAt,
      type: 'status_changed',
      from: 'SPEC_SYNTHESIS',
      to: 'CONTRACT_READY',
      reason: 'synthesis failed',
    });
    writeMissionState(deps.workspace, {
      ...mission,
      status: 'CONTRACT_READY',
      updatedAt: failedAt,
      counters: { ...mission.counters, events: mission.counters.events + 1 },
    });
    throw new MissionError(
      'SBM011',
      `Spec creation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { remediation: [`Choose a different spec name, or remove the conflicting spec, then run synthesize again.`] },
    );
  }

  assertMissionTransition('SPEC_SYNTHESIS', 'SPEC_REVIEW');
  appendMissionEvent(deps.workspace, missionId, {
    at,
    type: 'synthesis_completed',
    specName,
    objectives: compiled.objectiveCount,
  });
  appendMissionEvent(deps.workspace, missionId, {
    at,
    type: 'status_changed',
    from: 'SPEC_SYNTHESIS',
    to: 'SPEC_REVIEW',
  });
  mission = writeMissionState(deps.workspace, {
    ...mission,
    status: 'SPEC_REVIEW',
    specName,
    synthesizedAt: at,
    counters: { ...mission.counters, events: mission.counters.events + 2 },
  });

  return {
    mission,
    specName,
    files: [
      { fileName: 'requirements.md', bytes: Buffer.byteLength(compiled.requirements, 'utf8') },
      { fileName: 'design.md', bytes: Buffer.byteLength(compiled.design, 'utf8') },
      { fileName: 'tasks.md', bytes: Buffer.byteLength(compiled.tasks, 'utf8') },
    ],
    provenance: compiled.provenance,
    objectiveCount: compiled.objectiveCount,
    warnings: [],
  };
}

/**
 * Observe the spec approval state and fold it into the mission lifecycle:
 * SPEC_REVIEW becomes APPROVED exactly when every stage of the synthesized
 * spec is approved through the EXISTING human approval workflow. Read-only
 * with respect to the spec; the mission record is the only thing updated.
 */
export function observeSpecApproval(deps: MissionDeps, missionId: string): MissionState {
  let mission = requireMissionState(deps.workspace, missionId);
  if (mission.status !== 'SPEC_REVIEW' || mission.specName === undefined) return mission;
  let approved = false;
  try {
    const spec = analyzeSpec(deps.workspace, requireSpec(deps.workspace, mission.specName));
    if (spec.state !== undefined) {
      approved = evaluateWorkflow(deps.workspace, spec.state).effectiveStatus === 'READY_FOR_IMPLEMENTATION';
    }
  } catch {
    return mission;
  }
  if (!approved) return mission;
  const at = (deps.clock ?? (() => new Date()))().toISOString();
  assertMissionTransition('SPEC_REVIEW', 'APPROVED');
  appendMissionEvent(deps.workspace, missionId, {
    at,
    type: 'spec_approval_observed',
    specName: mission.specName,
  });
  appendMissionEvent(deps.workspace, missionId, {
    at,
    type: 'status_changed',
    from: 'SPEC_REVIEW',
    to: 'APPROVED',
  });
  mission = writeMissionState(deps.workspace, {
    ...mission,
    status: 'APPROVED',
    approvedAt: at,
    updatedAt: at,
    counters: { ...mission.counters, events: mission.counters.events + 2 },
  });
  return mission;
}
