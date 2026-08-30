import path from 'node:path';
import { autonomyPolicyFingerprint, sha256Hex } from '@specbridge/core';
import type { AutonomyPolicy, WorkspaceInfo } from '@specbridge/core';
import {
  readAdrs,
  readConstitution,
  readContractRegistry,
  readDecisions,
  requireMissionState,
} from '@specbridge/mission';
import type { MissionState, ProductContract } from '@specbridge/mission';
import { AutonomyError } from '../errors.js';
import type { AutonomyDeps } from '../deps.js';
import { autonomyPolicyOf, hostOf, newRecordId, nowIso } from '../deps.js';
import {
  assertAutonomyId,
  autonomyPath,
  listJsonRecords,
  readJsonRecord,
  writeImmutableRecord,
  writeJsonRecord,
} from '../store.js';
import type {
  MissionSeal,
  SealBinding,
  SealCompleteness,
  SealedAcceptanceCriterion,
  SealedContractRef,
} from './state.js';
import { SEAL_LIMITS, SEAL_SCHEMA_VERSION, missionSealSchema, sealBindingSchema } from './state.js';
import { REQUIRED_SEAL_AUTHORITY_KINDS, isFinalSealStatus } from '../vocabulary.js';
import type { SealedAuthorityKind } from '../vocabulary.js';

/**
 * The MissionSeal service.
 *
 * Compiling a seal is DETERMINISTIC: it reads mission records and rewrites
 * none of them. That is the property that lets human authority flow from
 * canonical product truth into derived artifacts without a second approval
 * round — the seal adds no information, so there is nothing new to approve.
 * If compilation ever needed a model, this would become a proposal and the
 * human would be right to re-read it.
 *
 * Sealing itself is the one operation here that requires a person, and it is
 * a status transition with a recorded channel, never something inferred from
 * a mission reaching a state.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function sealsDir(workspace: WorkspaceInfo): string {
  return autonomyPath(workspace, 'seals');
}

export function sealFile(workspace: WorkspaceInfo, sealId: string): string {
  assertAutonomyId('seal', sealId);
  return autonomyPath(workspace, 'seals', `${sealId}.json`);
}

export function bindingFile(workspace: WorkspaceInfo, jobId: string): string {
  assertAutonomyId('job', jobId);
  return autonomyPath(workspace, 'bindings', `${jobId}.json`);
}

// ---------------------------------------------------------------------------
// Acceptance-criterion compilation
// ---------------------------------------------------------------------------

/**
 * Structural screens that decide which qualification phases a criterion
 * implies.
 *
 * These are deliberately coarse keyword screens over text the HUMAN wrote,
 * evaluated once at seal time and then frozen into the seal. Two properties
 * matter more than precision: they cannot be influenced by anything an agent
 * produces later, and they only ever ADD a qualification phase. A criterion
 * that mentions a browser gets a browser scenario; one that does not simply
 * closes on other evidence. There is no screen that can REMOVE a phase.
 */
const SYSTEM_SCENARIO_PATTERNS: readonly RegExp[] = [
  /\b(end[- ]to[- ]end|e2e|system test|integration)\b/i,
  /\b(docker|compose|container|kafka|rabbitmq|postgres|postgresql|mysql|redis|broker|database)\b/i,
  /\b(restart|crash|failover|reconnect|replay|redrive)\b/i,
  /\b(across (?:services|processes)|multi[- ]service|distributed)\b/i,
  /\b(persist(?:ed|ence)?|durable|survives?)\b/i,
];

const BROWSER_SCENARIO_PATTERNS: readonly RegExp[] = [
  /\b(browser|ui|user interface|dashboard|page|screen|frontend|front[- ]end)\b/i,
  /\b(click|navigat\w*|render\w*|responsive|viewport|modal|form)\b/i,
  /\b(usable|visual|layout|displays?)\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Compile the mission's success criteria and contract requirements into
 * sealed acceptance criteria.
 *
 * Mission `successCriteria` are the product-level statements; contract
 * requirements are the per-contract promises. Both close, and both are
 * carried with provenance so the closure ledger can point at the exact
 * mission record behind every item it audits.
 */
export function compileAcceptanceCriteria(
  mission: MissionState,
  /**
   * Present so the signature says what this compiles FROM, and so a future
   * revision that derives criteria from contract text is an implementation
   * change rather than a call-site change. Today only the mission's own
   * success criteria are compiled: contract requirements are already sealed
   * individually and are audited as their own closure entries.
   */
  _contracts: readonly ProductContract[],
): SealedAcceptanceCriterion[] {
  const out: SealedAcceptanceCriterion[] = [];
  mission.successCriteria.slice(0, SEAL_LIMITS.maxCriteria).forEach((statement, index) => {
    out.push({
      criterionId: `AC-${String(index + 1).padStart(3, '0')}`,
      statement: statement.slice(0, SEAL_LIMITS.maxTextChars),
      contractIds: [],
      decisionIds: [],
      impliesSystemScenario: matchesAny(statement, SYSTEM_SCENARIO_PATTERNS),
      impliesBrowserScenario: matchesAny(statement, BROWSER_SCENARIO_PATTERNS),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Authority digest
// ---------------------------------------------------------------------------

/**
 * Hash over exactly the authority a seal carries.
 *
 * Timestamps, ids, and status are excluded so the digest answers "is this
 * the same authorization?" rather than "is this the same file?". Re-drafting
 * an unchanged mission produces the same digest, which is what makes a
 * redundant re-seal recognisable instead of quietly doubling the record.
 */
export function computeAuthorityDigest(
  seal: Pick<
    MissionSeal,
    | 'goal'
    | 'nonGoals'
    | 'decisionIds'
    | 'constitutionRuleIds'
    | 'adrIds'
    | 'contracts'
    | 'acceptanceCriteria'
    | 'resourcePolicy'
    | 'delegatedAuthority'
  >,
): string {
  const canonical = {
    goal: seal.goal,
    nonGoals: [...seal.nonGoals],
    decisionIds: [...seal.decisionIds].sort(),
    constitutionRuleIds: [...seal.constitutionRuleIds].sort(),
    adrIds: [...seal.adrIds].sort(),
    contracts: seal.contracts
      .map((contract) => ({
        contractId: contract.contractId,
        revision: contract.revision,
        requirementIds: [...contract.requirementIds].sort(),
        invariantIds: [...contract.invariantIds].sort(),
      }))
      .sort((a, b) => a.contractId.localeCompare(b.contractId)),
    acceptanceCriteria: seal.acceptanceCriteria
      .map((criterion) => ({
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        impliesSystemScenario: criterion.impliesSystemScenario,
        impliesBrowserScenario: criterion.impliesBrowserScenario,
      }))
      .sort((a, b) => a.criterionId.localeCompare(b.criterionId)),
    resourcePolicy: seal.resourcePolicy,
    delegatedAuthority: {
      mode: seal.delegatedAuthority.mode,
      humanGate: seal.delegatedAuthority.humanGate,
      policyFingerprint: seal.delegatedAuthority.policyFingerprint,
    },
  };
  return sha256Hex(JSON.stringify(canonical)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export interface DraftSealRequest {
  missionId: string;
  /** Explicit id (deterministic tests); generated otherwise. */
  sealId?: string | undefined;
  /** The seal this one supersedes, when re-sealing. */
  supersedes?: string | undefined;
  /** Monetary ceiling the human authorizes for this seal. */
  maxApiSpendUsd?: number | null | undefined;
  maxWallClockMs?: number | null | undefined;
  allowedLanes?: readonly ('LOCAL' | 'SUBSCRIPTION' | 'API')[] | undefined;
}

/**
 * Compile a DRAFT seal from durable mission state.
 *
 * Reads only; writes exactly one new file. The mission is not transitioned,
 * because drafting a seal is not a mission event — a human may draft, look
 * at the completeness report, answer a question, and draft again.
 */
export function draftSeal(deps: AutonomyDeps, request: DraftSealRequest): MissionSeal {
  const mission = requireMissionState(deps.workspace, request.missionId);
  const policy = autonomyPolicyOf(deps);
  const contracts = readContractRegistry(deps.workspace, request.missionId);
  const constitution = readConstitution(deps.workspace, request.missionId);
  const adrs = readAdrs(deps.workspace, request.missionId);
  const decisions = readDecisions(deps.workspace, request.missionId).filter(
    (decision) => decision.status === 'active',
  );

  const contractRefs: SealedContractRef[] = contracts
    .filter((contract) => contract.status !== 'superseded')
    .slice(0, SEAL_LIMITS.maxContractRefs)
    .map((contract) => ({
      contractId: contract.contractId,
      revision: contract.revision,
      title: contract.title.slice(0, SEAL_LIMITS.maxShortTextChars),
      classification: contract.classification,
      compatibilityPolicy: contract.compatibilityPolicy,
      requirementIds: contract.requirements.map((requirement) => requirement.requirementId),
      invariantIds: contract.invariants.map((invariant) => invariant.invariantId),
    }));

  const acceptanceCriteria = compileAcceptanceCriteria(mission, contracts);

  const base = {
    goal: mission.goal.slice(0, SEAL_LIMITS.maxTextChars),
    nonGoals: mission.nonGoals.slice(0, SEAL_LIMITS.maxListItems),
    decisionIds: decisions.map((decision) => decision.decisionId).slice(0, SEAL_LIMITS.maxListItems),
    constitutionRuleIds: (constitution?.rules ?? [])
      .filter((rule) => rule.status === 'active')
      .map((rule) => rule.ruleId)
      .slice(0, SEAL_LIMITS.maxListItems),
    adrIds: adrs.map((adr) => adr.adrId).slice(0, SEAL_LIMITS.maxListItems),
    contracts: contractRefs,
    acceptanceCriteria,
    resourcePolicy: {
      maxApiSpendUsd: request.maxApiSpendUsd ?? null,
      maxWallClockMs: request.maxWallClockMs ?? null,
      allowedLanes: [...(request.allowedLanes ?? ['LOCAL'])],
    },
    delegatedAuthority: {
      mode: policy.mode,
      humanGate: policy.humanGate,
      policyFingerprint: autonomyPolicyFingerprint(policy),
      decisions: { ...policy.decisions } as Record<string, string>,
      recovery: { ...policy.recovery } as Record<string, string>,
      toolsmithCapabilities: [...policy.toolsmith.capabilities],
    },
  };

  const sealId = request.sealId ?? newRecordId(deps, 'seal');
  const seal = missionSealSchema.parse({
    schemaVersion: SEAL_SCHEMA_VERSION,
    sealId,
    missionId: mission.missionId,
    ...(mission.specName !== undefined ? { specName: mission.specName } : {}),
    status: 'DRAFT',
    createdAt: nowIso(deps),
    ...(request.supersedes !== undefined ? { supersedes: request.supersedes } : {}),
    ...base,
    presentAuthorityKinds: presentAuthorityKinds(base),
    authorityDigest: computeAuthorityDigest(base as Parameters<typeof computeAuthorityDigest>[0]),
  });

  writeImmutableRecord(sealFile(deps.workspace, sealId), seal, 'seal');
  return seal;
}

function presentAuthorityKinds(base: {
  goal: string;
  nonGoals: readonly string[];
  decisionIds: readonly string[];
  constitutionRuleIds: readonly string[];
  adrIds: readonly string[];
  contracts: readonly SealedContractRef[];
  acceptanceCriteria: readonly SealedAcceptanceCriterion[];
  resourcePolicy: { allowedLanes: readonly string[] };
  delegatedAuthority: { policyFingerprint: string };
}): SealedAuthorityKind[] {
  const kinds: SealedAuthorityKind[] = [];
  if (base.goal.trim().length > 0) kinds.push('GOAL');
  if (base.nonGoals.length > 0) kinds.push('NON_GOALS');
  if (base.decisionIds.length > 0) kinds.push('DECISIONS');
  if (base.constitutionRuleIds.length > 0) kinds.push('CONSTITUTION');
  if (base.adrIds.length > 0) kinds.push('ADRS');
  if (base.contracts.length > 0) kinds.push('CONTRACTS');
  if (base.contracts.some((contract) => contract.requirementIds.length > 0)) {
    kinds.push('REQUIREMENTS');
  }
  if (base.acceptanceCriteria.length > 0) kinds.push('ACCEPTANCE_CRITERIA');
  if (base.resourcePolicy.allowedLanes.length > 0) kinds.push('RESOURCE_POLICY');
  if (base.delegatedAuthority.policyFingerprint.length > 0) kinds.push('AUTONOMY_POLICY');
  return kinds;
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/**
 * Structural completeness of a seal for UNATTENDED execution.
 *
 * Every gap here is something a human can fix in ten minutes in the evening,
 * which is exactly why preflight checks it before they go to bed rather than
 * the runtime discovering it at 02:40.
 */
export function assessSealCompleteness(seal: MissionSeal): SealCompleteness {
  const present = new Set(seal.presentAuthorityKinds);
  const missing: string[] = [];
  const gaps: string[] = [];
  for (const kind of REQUIRED_SEAL_AUTHORITY_KINDS) {
    if (present.has(kind)) continue;
    missing.push(kind);
    gaps.push(gapExplanation(kind));
  }
  if (seal.contracts.length > 0 && seal.acceptanceCriteria.length === 0) {
    if (!missing.includes('ACCEPTANCE_CRITERIA')) {
      missing.push('ACCEPTANCE_CRITERIA');
      gaps.push(gapExplanation('ACCEPTANCE_CRITERIA'));
    }
  }
  return {
    complete: missing.length === 0,
    present: [...present],
    missing,
    gaps,
  };
}

function gapExplanation(kind: SealedAuthorityKind): string {
  switch (kind) {
    case 'GOAL':
      return 'The mission has no goal statement. Record the product direction before sealing.';
    case 'CONTRACTS':
      return (
        'No active product contract exists. Compile the mission contract set ' +
        '(`specbridge mission contracts`) so closure has something to audit.'
      );
    case 'REQUIREMENTS':
      return (
        'No contract carries requirements. A seal whose contracts hold no requirements ' +
        'can be "closed" without proving anything.'
      );
    case 'ACCEPTANCE_CRITERIA':
      return (
        'The mission records no success criteria. Without them the runtime cannot tell ' +
        'whether the product is finished, only whether the task list is.'
      );
    case 'AUTONOMY_POLICY':
      return 'No autonomy policy is resolved. Run `specbridge autonomy setup` before sealing.';
    default:
      return `The seal is missing ${kind}.`;
  }
}

// ---------------------------------------------------------------------------
// Sealing, superseding, revoking
// ---------------------------------------------------------------------------

export interface SealMissionRequest {
  sealId: string;
  /** The channel the human authorization arrived through. Audit only. */
  via?: string | undefined;
}

/**
 * Authorize a draft seal.
 *
 * This is the human gate of vNext.10, and the only one an ordinary
 * successful overnight run passes through. The service refuses an incomplete
 * seal rather than warning about it: a seal that cannot support unattended
 * execution should never become the thing an unattended run cites as its
 * authority.
 */
export function sealMission(deps: AutonomyDeps, request: SealMissionRequest): MissionSeal {
  const existing = requireSeal(deps.workspace, request.sealId);
  if (existing.status === 'SEALED') return existing;
  if (isFinalSealStatus(existing.status)) {
    throw new AutonomyError(
      'SBA004',
      `Seal ${existing.sealId} is ${existing.status} and cannot be authorized.`,
      {
        remediation: ['Draft a new seal from the current mission state and authorize that one.'],
        details: { sealId: existing.sealId, status: existing.status },
      },
    );
  }
  const completeness = assessSealCompleteness(existing);
  if (!completeness.complete) {
    throw new AutonomyError(
      'SBA005',
      `Seal ${existing.sealId} is missing authority required for unattended execution: ` +
        `${completeness.missing.join(', ')}.`,
      { remediation: [...completeness.gaps], details: { missing: [...completeness.missing] } },
    );
  }
  const sealed = missionSealSchema.parse({
    ...existing,
    status: 'SEALED',
    sealedAt: nowIso(deps),
    sealedVia: (request.via ?? hostOf(deps)).slice(0, SEAL_LIMITS.maxShortTextChars),
  });
  // A status transition is the ONE mutation a seal record accepts; the
  // authority content it covers is unchanged and the digest still matches.
  writeJsonRecord(sealFile(deps.workspace, existing.sealId), sealed);
  if (existing.supersedes !== undefined) {
    markSuperseded(deps, existing.supersedes, existing.sealId);
  }
  return sealed;
}

function markSuperseded(deps: AutonomyDeps, sealId: string, bySealId: string): void {
  const previous = readSeal(deps.workspace, sealId);
  if (previous === undefined || previous.status === 'SUPERSEDED') return;
  writeJsonRecord(
    sealFile(deps.workspace, sealId),
    missionSealSchema.parse({ ...previous, status: 'SUPERSEDED', supersededBy: bySealId }),
  );
}

export function revokeSeal(deps: AutonomyDeps, sealId: string, reason: string): MissionSeal {
  const seal = requireSeal(deps.workspace, sealId);
  const revoked = missionSealSchema.parse({
    ...seal,
    status: 'REVOKED',
    revokedAt: nowIso(deps),
    revokedReason: reason.slice(0, SEAL_LIMITS.maxTextChars),
  });
  writeJsonRecord(sealFile(deps.workspace, sealId), revoked);
  return revoked;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readSeal(workspace: WorkspaceInfo, sealId: string): MissionSeal | undefined {
  return readJsonRecord(sealFile(workspace, sealId), (raw) => missionSealSchema.parse(raw));
}

export function requireSeal(workspace: WorkspaceInfo, sealId: string): MissionSeal {
  const seal = readSeal(workspace, sealId);
  if (seal === undefined) {
    throw new AutonomyError('SBA002', `No mission seal "${sealId}" exists in this workspace.`, {
      remediation: ['List seals with `specbridge autonomy seals`.'],
      details: { sealId },
    });
  }
  return seal;
}

export function listSeals(workspace: WorkspaceInfo, missionId?: string): MissionSeal[] {
  const seals = listJsonRecords(sealsDir(workspace), (raw) => missionSealSchema.parse(raw));
  const filtered = missionId === undefined ? seals : seals.filter((s) => s.missionId === missionId);
  return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The newest SEALED seal for a mission, or undefined.
 *
 * "Newest" is by `sealedAt`, not by file order: a seal drafted earlier but
 * authorized later is the operative one, because authorization is the event
 * that grants authority.
 */
export function latestExecutableSeal(
  workspace: WorkspaceInfo,
  missionId: string,
): MissionSeal | undefined {
  const sealed = listSeals(workspace, missionId).filter((seal) => seal.status === 'SEALED');
  if (sealed.length === 0) return undefined;
  return sealed.reduce((best, candidate) =>
    (candidate.sealedAt ?? candidate.createdAt) > (best.sealedAt ?? best.createdAt) ? candidate : best,
  );
}

// ---------------------------------------------------------------------------
// Executability
// ---------------------------------------------------------------------------

export interface SealExecutability {
  executable: boolean;
  /** Vocabulary reason, or undefined when executable. */
  reason?: 'SEAL_NOT_EXECUTABLE' | 'AUTONOMY_POLICY_DRIFT' | 'NO_SEAL_BOUND';
  detail?: string;
}

/**
 * Whether a seal may govern execution RIGHT NOW under the live policy.
 *
 * Policy drift is not a warning. If the human sealed under one delegation
 * and the configuration now grants a wider one, executing under the wider
 * one would be the runtime giving itself authority — quietly, and exactly
 * when nobody is watching. The seal has to be re-authorized instead.
 *
 * A NARROWER live policy is also drift and also refuses, for the mirror
 * reason: a job that believed it could provision containers and now cannot
 * would fail halfway through in a way nobody predicted. Re-sealing is cheap;
 * discovering it at 04:00 is not.
 */
export function assessSealExecutability(
  seal: MissionSeal | undefined,
  policy: AutonomyPolicy,
): SealExecutability {
  if (seal === undefined) {
    return { executable: false, reason: 'NO_SEAL_BOUND', detail: 'No seal is bound to this job.' };
  }
  if (seal.status !== 'SEALED') {
    return {
      executable: false,
      reason: 'SEAL_NOT_EXECUTABLE',
      detail: `The seal is ${seal.status}; only a SEALED authorization may govern execution.`,
    };
  }
  const live = autonomyPolicyFingerprint(policy);
  if (live !== seal.delegatedAuthority.policyFingerprint) {
    return {
      executable: false,
      reason: 'AUTONOMY_POLICY_DRIFT',
      detail:
        'The autonomy policy changed since this intent was sealed. Delegated authority is ' +
        'whatever the human authorized, not whatever the configuration currently says.',
    };
  }
  return { executable: true };
}

/** Throwing form, for call sites that must not proceed on a stale grant. */
export function requireExecutableSeal(seal: MissionSeal | undefined, policy: AutonomyPolicy): MissionSeal {
  const assessment = assessSealExecutability(seal, policy);
  if (assessment.executable && seal !== undefined) return seal;
  const code = assessment.reason === 'AUTONOMY_POLICY_DRIFT' ? 'SBA006' : 'SBA004';
  throw new AutonomyError(code, assessment.detail ?? 'The mission seal is not executable.', {
    remediation: [
      'Re-draft and re-authorize the seal: `specbridge autonomy seal <mission> --confirm`.',
    ],
    details: { reason: assessment.reason ?? 'UNKNOWN' },
  });
}

// ---------------------------------------------------------------------------
// Job binding
// ---------------------------------------------------------------------------

export function bindSealToJob(
  deps: AutonomyDeps,
  jobId: string,
  sealId: string,
  options: { runtimeIdentity?: SealBinding['runtimeIdentity'] | undefined } = {},
): SealBinding {
  const seal = requireSeal(deps.workspace, sealId);
  requireExecutableSeal(seal, autonomyPolicyOf(deps));
  const binding = sealBindingSchema.parse({
    schemaVersion: SEAL_SCHEMA_VERSION,
    jobId,
    sealId,
    missionId: seal.missionId,
    boundAt: nowIso(deps),
    boundPolicyFingerprint: seal.delegatedAuthority.policyFingerprint,
    runtimeIdentity: options.runtimeIdentity ?? null,
  });
  writeJsonRecord(bindingFile(deps.workspace, jobId), binding);
  return binding;
}

export function readSealBinding(workspace: WorkspaceInfo, jobId: string): SealBinding | undefined {
  return readJsonRecord(bindingFile(workspace, jobId), (raw) => sealBindingSchema.parse(raw));
}

/** The seal governing one job, or undefined when the job is not sealed. */
export function readJobSeal(workspace: WorkspaceInfo, jobId: string): MissionSeal | undefined {
  const binding = readSealBinding(workspace, jobId);
  if (binding === undefined) return undefined;
  return readSeal(workspace, binding.sealId);
}

export function bindingsDir(workspace: WorkspaceInfo): string {
  return autonomyPath(workspace, 'bindings');
}

export function listSealBindings(workspace: WorkspaceInfo): SealBinding[] {
  return listJsonRecords(bindingsDir(workspace), (raw) => sealBindingSchema.parse(raw));
}

/** Relative display path of a seal, for reports that cite where truth lives. */
export function sealDisplayPath(sealId: string): string {
  return path.posix.join('.specbridge', 'autonomy', 'seals', `${sealId}.json`);
}
