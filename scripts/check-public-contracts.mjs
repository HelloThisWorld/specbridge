#!/usr/bin/env node
/**
 * Public-contract snapshot generation and drift check (v1.0.0).
 *
 * Usage:
 *   node scripts/check-public-contracts.mjs            # (re)generate contracts/*.json
 *   node scripts/check-public-contracts.mjs --check    # fail when snapshots drift (CI)
 *
 * Snapshots freeze the STABLE public surface: CLI command tree and options,
 * exit codes, JSON report envelope IDs, persisted schema versions,
 * verification rule IDs, runner contract vocabulary, template and extension
 * contracts, MCP tool/resource/prompt names, Claude Code Skill names, and
 * GitHub Action inputs/outputs. Private implementation details are not
 * snapshotted.
 *
 * A drift failure means a stable contract changed. If the change is
 * intentional: regenerate the snapshots, review the diff, and add a
 * CHANGELOG entry describing the contract change (see
 * docs/stability/versioning-policy.md for what is allowed in 1.x).
 *
 * Requires a build (`pnpm build`): values are read from each package's dist
 * so the snapshot reflects what actually ships.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = path.join(ROOT, 'contracts');
const CHECK = process.argv.includes('--check');

function fail(message) {
  console.error(`check-public-contracts: ${message}`);
  process.exit(1);
}

async function importDist(pkg) {
  const distPath = path.join(ROOT, 'packages', pkg, 'dist', 'index.js');
  if (!existsSync(distPath)) {
    fail(`packages/${pkg}/dist/index.js is missing — run "pnpm build" first.`);
  }
  return import(pathToFileURL(distPath).href);
}

/** Stable stringify: sorted object keys at every level, 2-space indent. */
function stableStringify(value) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted(v[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// CLI command tree — walked through the built CLI's --help output so the
// snapshot reflects the shipped surface, not internal structure.
// ---------------------------------------------------------------------------

const CLI_ENTRY = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');

function cliHelp(commandPath) {
  try {
    return execFileSync(process.execPath, [CLI_ENTRY, ...commandPath, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (cause) {
    fail(
      `"specbridge ${commandPath.join(' ')} --help" failed — ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

function parseHelp(text) {
  const lines = text.split(/\r?\n/);
  const commands = [];
  const options = [];
  let section = null;
  for (const line of lines) {
    if (/^Commands:/.test(line)) { section = 'commands'; continue; }
    if (/^Options:/.test(line)) { section = 'options'; continue; }
    if (/^\S/.test(line) && line.trim() !== '') { section = null; continue; }
    // Entries sit at exactly two spaces of indent; deeper indentation is a
    // wrapped description continuation and must never be parsed as an entry.
    const entry = /^ {2}(?! )(\S.*)$/.exec(line);
    if (entry === null) continue;
    if (section === 'commands') {
      const match = /^([a-z][a-z0-9-]*)/.exec(entry[1]);
      if (match && match[1] !== 'help') commands.push(match[1]);
    } else if (section === 'options' && entry[1].startsWith('-')) {
      for (const long of entry[1].match(/--[a-z][a-z0-9-]*/g) ?? []) {
        if (!options.includes(long)) options.push(long);
      }
    }
  }
  return { commands: [...new Set(commands)], options: options.sort() };
}

function walkCli(commandPath = []) {
  const parsed = parseHelp(cliHelp(commandPath));
  const node = { options: parsed.options };
  if (parsed.commands.length > 0) {
    node.subcommands = {};
    for (const name of parsed.commands.sort()) {
      node.subcommands[name] = walkCli([...commandPath, name]);
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Source-derived values
// ---------------------------------------------------------------------------

function reportIdsFromCliSource() {
  const ids = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts')) {
        for (const match of readFileSync(p, 'utf8').matchAll(/createJsonReport\(\s*'([^']+)'/g)) {
          ids.add(match[1]);
        }
      }
    }
  };
  walk(path.join(ROOT, 'packages', 'cli', 'src'));
  return [...ids].sort();
}

function actionInterface() {
  const raw = readFileSync(path.join(ROOT, 'integrations', 'github-action', 'action.yml'), 'utf8');
  const section = (name) => {
    const match = new RegExp(`^${name}:\\r?\\n((?:(?:  .*|\\s*)\\r?\\n?)*)`, 'm').exec(raw);
    if (!match) return [];
    const keys = [];
    for (const line of match[1].split(/\r?\n/)) {
      const key = /^ {2}([a-z][a-z0-9-]*):/.exec(line);
      if (key) keys.push(key[1]);
      else if (/^[a-z]/i.test(line)) break;
    }
    return keys.sort();
  };
  return { inputs: section('inputs'), outputs: section('outputs') };
}

function skillNames() {
  const skillsDir = path.join(ROOT, 'integrations', 'claude-code-plugin', 'specbridge', 'skills');
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

async function buildSnapshots() {
  const core = await importDist('core');
  const drift = await importDist('drift');
  const runners = await importDist('runners');
  const templates = await importDist('templates');
  const extensionSdk = await importDist('extension-sdk');
  const extensions = await importDist('extensions');
  const registry = await importDist('registry');
  const evidence = await importDist('evidence');
  const execution = await importDist('execution');
  const orchestration = await importDist('orchestration');
  const mission = await importDist('mission');
  const autonomy = await importDist('autonomy');
  const mcp = await importDist('mcp-server');
  const context = await importDist('context');
  const intake = await importDist('intake');

  const snapshots = {
    'cli-commands.json': {
      bin: 'specbridge',
      tree: walkCli(),
    },
    'exit-codes.json': core.EXIT_CODES,
    'report-ids.json': { jsonReportIds: reportIdsFromCliSource() },
    'schema-versions.json': {
      specState: core.SPEC_STATE_SCHEMA_VERSION,
      runnerConfig: core.RUNNER_CONFIG_SCHEMA_VERSION,
      agentConfigV1: core.AGENT_CONFIG_SCHEMA_VERSION,
      runnerOutput: core.RUNNER_OUTPUT_SCHEMA_VERSION,
      verificationReport: core.VERIFICATION_REPORT_SCHEMA_VERSION,
      verificationDiagnostic: core.VERIFICATION_DIAGNOSTIC_SCHEMA_VERSION,
      migrationPlan: core.MIGRATION_PLAN_SCHEMA_VERSION,
      recoveryPlan: core.RECOVERY_PLAN_SCHEMA_VERSION,
      verificationPolicy: drift.VERIFICATION_POLICY_SCHEMA_VERSION,
      evidence: evidence.EVIDENCE_SCHEMA_VERSION,
      gitSnapshot: evidence.GIT_SNAPSHOT_SCHEMA_VERSION,
      runRecord: execution.RUN_RECORD_SCHEMA_VERSION,
      attemptRecord: execution.ATTEMPT_RECORD_SCHEMA_VERSION,
      interactiveLock: execution.INTERACTIVE_LOCK_SCHEMA_VERSION,
      orchestrationState: orchestration.ORCHESTRATION_STATE_SCHEMA_VERSION,
      executionPlan: orchestration.EXECUTION_PLAN_SCHEMA_VERSION,
      orchestrationCheckpoint: orchestration.ORCHESTRATION_CHECKPOINT_SCHEMA_VERSION,
      templateManifest: templates.TEMPLATE_MANIFEST_SCHEMA_VERSION,
      templateRecord: templates.TEMPLATE_RECORD_SCHEMA_VERSION,
      extensionState: extensions.EXTENSION_STATE_SCHEMA_VERSION,
      extensionManifest: extensionSdk.EXTENSION_MANIFEST_SCHEMA_VERSION,
      extensionChecksums: extensionSdk.EXTENSION_CHECKSUMS_SCHEMA_VERSION,
      extensionProtocol: extensionSdk.EXTENSION_PROTOCOL_VERSION,
      registries: registry.REGISTRIES_SCHEMA_VERSION,
      registryIndex: registry.REGISTRY_INDEX_SCHEMA_VERSION,
      registryCache: registry.REGISTRY_CACHE_SCHEMA_VERSION,
      // v1.2 job families (persisted under .specbridge/jobs/).
      jobState: orchestration.JOB_STATE_SCHEMA_VERSION,
      jobGraph: orchestration.JOB_GRAPH_SCHEMA_VERSION,
      jobCheckpoint: orchestration.JOB_CHECKPOINT_SCHEMA_VERSION,
      // Objective-runtime families (persisted under .specbridge/jobs/<id>/objectives/).
      workGraph: orchestration.WORK_GRAPH_SCHEMA_VERSION,
      contextProjection: orchestration.CONTEXT_PROJECTION_SCHEMA_VERSION,
      candidateArtifact: orchestration.CANDIDATE_ARTIFACT_SCHEMA_VERSION,
      evaluationRecord: orchestration.EVALUATION_RECORD_SCHEMA_VERSION,
      contractConflict: orchestration.CONTRACT_CONFLICT_SCHEMA_VERSION,
      objectiveWorker: orchestration.OBJECTIVE_WORKER_SCHEMA_VERSION,
      // Mission families (persisted under .specbridge/missions/).
      missionState: mission.MISSION_STATE_SCHEMA_VERSION,
      missionCoverage: mission.MISSION_COVERAGE_SCHEMA_VERSION,
      missionConstitution: mission.MISSION_CONSTITUTION_SCHEMA_VERSION,
      missionAdr: mission.MISSION_ADR_SCHEMA_VERSION,
      missionContract: mission.MISSION_CONTRACT_SCHEMA_VERSION,
      missionCcr: mission.MISSION_CCR_SCHEMA_VERSION,
      missionCheckpoint: mission.MISSION_CHECKPOINT_SCHEMA_VERSION,
      // Overnight autonomous runtime families (vNext.10; persisted under
      // .specbridge/autonomy/).
      missionSeal: autonomy.SEAL_SCHEMA_VERSION,
      supervisorState: autonomy.SUPERVISOR_SCHEMA_VERSION,
      overnightPreflight: autonomy.PREFLIGHT_SCHEMA_VERSION,
      toolsmithRecord: autonomy.TOOLSMITH_SCHEMA_VERSION,
      environmentRecord: autonomy.ENVIRONMENT_SCHEMA_VERSION,
      browserScenario: autonomy.BROWSER_SCHEMA_VERSION,
      uxCritique: autonomy.CRITIC_SCHEMA_VERSION,
      closureLedger: autonomy.CLOSURE_SCHEMA_VERSION,
      systemScenario: autonomy.SYSTEM_SCENARIO_SCHEMA_VERSION,
      reproducibilityRun: autonomy.REPRODUCIBILITY_SCHEMA_VERSION,
      controlPlaneRepair: autonomy.REPAIR_SCHEMA_VERSION,
      autonomyTelemetry: autonomy.TELEMETRY_SCHEMA_VERSION,
      zeroTouchCertification: autonomy.CERTIFICATION_SCHEMA_VERSION,
      // Zero-Touch Spec Intake families (vNext.10.1; persisted under
      // .specbridge/intake/).
      specIntakeState: intake.INTAKE_STATE_SCHEMA_VERSION,
      specIntakeSource: intake.INTAKE_SOURCE_SCHEMA_VERSION,
      specIntakeGrounding: intake.INTAKE_GROUNDING_SCHEMA_VERSION,
      specIntakeDelta: intake.INTAKE_DELTA_SCHEMA_VERSION,
      specIntakeApproval: intake.INTAKE_APPROVAL_SCHEMA_VERSION,
      specIntakeLifecycle: intake.INTAKE_LIFECYCLE_SCHEMA_VERSION,
      specIntakeTelemetry: intake.INTAKE_TELEMETRY_SCHEMA_VERSION,
      productBaseline: intake.PRODUCT_BASELINE_SCHEMA_VERSION,
      // Survival-runtime families (vNext.1; persisted under .specbridge/jobs/<id>/).
      taskAttempt: orchestration.TASK_ATTEMPT_SCHEMA_VERSION,
      taskCheckpoint: orchestration.TASK_CHECKPOINT_SCHEMA_VERSION,
      contextPackage: context.CONTEXT_PACKAGE_SCHEMA_VERSION,
      runnerContextCapabilities: runners.RUNNER_CONTEXT_CAPABILITIES_SCHEMA_VERSION,
      // Quota-scheduler families (vNext.2).
      quotaSnapshot: orchestration.QUOTA_SNAPSHOT_SCHEMA_VERSION,
      schedulingDecision: orchestration.SCHEDULING_DECISION_SCHEMA_VERSION,
      // API gap-bridge families (vNext.5).
      apiBudget: orchestration.API_BUDGET_SCHEMA_VERSION,
      apiSpendApproval: orchestration.API_SPEND_APPROVAL_SCHEMA_VERSION,
      // Reliability families (vNext.6).
      evaluationResult: orchestration.EVALUATION_RESULT_SCHEMA_VERSION,
      taskReliability: orchestration.TASK_RELIABILITY_SCHEMA_VERSION,
      // Context-efficiency families (vNext.7).
      contextSelectionPlan: context.CONTEXT_SELECTION_PLAN_SCHEMA_VERSION,
      contextMetrics: context.CONTEXT_METRICS_SCHEMA_VERSION,
      repositoryIndex: context.REPOSITORY_INDEX_SCHEMA_VERSION,
      // Adaptive families (vNext.8; derived and rebuildable, versioned so a
      // schema bump is a visible contract change rather than a silent
      // cache rebuild).
      adaptiveProfileCache: orchestration.ADAPTIVE_PROFILE_SCHEMA_VERSION,
      adaptiveCalibration: orchestration.ADAPTIVE_CALIBRATION_SCHEMA_VERSION,
      // Qualification families (vNext.9; persisted under
      // .specbridge/qualification/).
      dogfoodRun: orchestration.DOGFOOD_RUN_SCHEMA_VERSION,
      qualificationReport: orchestration.QUALIFICATION_REPORT_SCHEMA_VERSION,
      // Optional Research Layer (vNext.10.2 Phase 2; .specbridge/research/).
      researchRecord: orchestration.RESEARCH_RECORD_SCHEMA_VERSION,
      researchTelemetry: orchestration.RESEARCH_TELEMETRY_SCHEMA_VERSION,
    },
    'verification-rules.json': {
      idPattern: 'SBV\\d{3}',
      ruleIds: drift
        .builtInVerificationRules()
        .map((rule) => rule.id)
        .sort(),
    },
    'runner-contract.json': {
      operations: [...runners.RUNNER_OPERATIONS].sort(),
      capabilityKeys: [...runners.RUNNER_CAPABILITY_KEYS].sort(),
      categories: [...runners.RUNNER_CATEGORIES].sort(),
      supportLevels: [...runners.RUNNER_SUPPORT_LEVELS].sort(),
      errorCodes: [...runners.RUNNER_ERROR_CODES].sort(),
      runnerKinds: [...core.AGENT_RUNNER_KINDS].sort(),
      // vNext.4: how a harness profile may attest where its compute runs.
      computeLocalityAttestations: [
        ...core.DEEPSEEK_HARNESS_COMPUTE_LOCALITY_ATTESTATIONS,
      ].sort(),
      executionOutcomes: [...core.EXECUTION_OUTCOMES].sort(),
      evidenceStatuses: [...core.EVIDENCE_STATUS_VALUES].sort(),
    },
    'template-contract.json': {
      manifestFileName: templates.TEMPLATE_MANIFEST_FILE_NAME,
      recordTypes: [...templates.TEMPLATE_RECORD_TYPES].sort(),
      builtinTemplateIds: templates.BUILTIN_TEMPLATE_PACKS.map((pack) => pack.id).sort(),
    },
    'extension-contract.json': {
      manifestFileName: extensionSdk.EXTENSION_MANIFEST_FILE_NAME,
      kinds: [...extensionSdk.EXTENSION_KINDS].sort(),
      protocolMethods: [...extensionSdk.EXTENSION_PROTOCOL_METHODS].sort(),
      permissionFlags: [...extensionSdk.EXTENSION_PERMISSION_FLAGS].sort(),
      archiveSuffix: extensions.EXTENSION_ARCHIVE_SUFFIX,
    },
    // v1.1 governed orchestration vocabulary. Every value is stable within
    // 1.x: members may be appended, never renamed or removed.
    'orchestration-contract.json': {
      phases: [...orchestration.ORCHESTRATION_PHASES].sort(),
      finalPhases: [...orchestration.FINAL_ORCHESTRATION_PHASES].sort(),
      intentOutcomes: [...orchestration.INTENT_OUTCOMES].sort(),
      provenanceKinds: [...orchestration.PROVENANCE_KINDS].sort(),
      actionCategories: [...orchestration.ACTION_CATEGORIES].sort(),
      observationResults: [...orchestration.OBSERVATION_RESULTS].sort(),
      failureCategories: [...orchestration.FAILURE_CATEGORIES].sort(),
      nextStepDirectives: [...orchestration.NEXT_STEP_DIRECTIVES].sort(),
      planStalenessReasons: [...orchestration.PLAN_STALENESS_REASONS].sort(),
      planChangeMateriality: [...orchestration.PLAN_CHANGE_MATERIALITY].sort(),
      eventTypes: [...orchestration.ORCHESTRATION_EVENT_TYPES].sort(),
      enforcementLevels: [...orchestration.ENFORCEMENT_LEVELS].sort(),
      planReviewModes: [...core.PLAN_REVIEW_MODES].sort(),
      errorCodes: Object.keys(orchestration.SBO_CODES).sort(),
      // Objective-runtime vocabulary (additive within 1.x).
      agentRoles: [...orchestration.AGENT_ROLES].sort(),
      jobEventTypes: [...orchestration.JOB_EVENT_TYPES].sort(),
      jobStatuses: [...orchestration.JOB_STATUSES].sort(),
      operationalJobStatuses: [...orchestration.OPERATIONAL_JOB_STATUSES].sort(),
      humanAttentionJobStatuses: [...orchestration.HUMAN_ATTENTION_JOB_STATUSES].sort(),
      workUnitStatuses: [...orchestration.WORK_UNIT_STATUSES].sort(),
      workUnitKinds: [...orchestration.WORK_UNIT_KINDS].sort(),
      evaluationVerdicts: [...orchestration.EVALUATION_VERDICTS].sort(),
      evaluationLayers: [...orchestration.EVALUATION_LAYERS].sort(),
      // Survival-runtime vocabulary (vNext.1; additive within 1.x).
      taskAttemptStatuses: [...orchestration.TASK_ATTEMPT_STATUSES].sort(),
      taskCheckpointReasons: [...orchestration.TASK_CHECKPOINT_REASONS].sort(),
      // Quota-scheduler vocabulary (vNext.2; additive within 1.x).
      executionLanes: [...orchestration.EXECUTION_LANES].sort(),
      laneDecisions: [...orchestration.LANE_DECISIONS].sort(),
      localSuitabilityClasses: [...orchestration.LOCAL_SUITABILITY_CLASSES].sort(),
      schedulerModes: [...orchestration.SCHEDULER_MODES].sort(),
      quotaWindows: [...orchestration.QUOTA_WINDOWS].sort(),
      quotaTelemetryFreshness: [...orchestration.QUOTA_TELEMETRY_FRESHNESS].sort(),
      schedulingReasonCodes: [...orchestration.SCHEDULING_REASON_CODES].sort(),
      // Local agentic runtime vocabulary (vNext.4; additive within 1.x).
      localExecutionModes: [...core.LOCAL_EXECUTION_MODES].sort(),
      localExecutionStrategies: [...core.LOCAL_EXECUTION_STRATEGIES].sort(),
      localExecutionShapes: [...orchestration.LOCAL_EXECUTION_SHAPES].sort(),
      localExecutionModeReasons: [...orchestration.LOCAL_EXECUTION_MODE_REASONS].sort(),
      computeLocalities: [...core.COMPUTE_LOCALITIES].sort(),
      // API gap-bridge vocabulary (vNext.5; additive within 1.x).
      apiSpendModes: [...core.API_SPEND_MODES].sort(),
      subscriptionGapReasons: [...orchestration.SUBSCRIPTION_GAP_REASONS].sort(),
      gapForecastConfidence: [...orchestration.GAP_FORECAST_CONFIDENCE].sort(),
      delaySensitivities: [...orchestration.DELAY_SENSITIVITIES].sort(),
      apiCostSources: [...orchestration.API_COST_SOURCES].sort(),
      apiBudgetReservationStates: [...orchestration.API_BUDGET_RESERVATION_STATES].sort(),
      apiApprovalStatuses: [...orchestration.API_APPROVAL_STATUSES].sort(),
      // vNext.6 reliability, evaluation and recovery.
      evaluationStatuses: [...orchestration.EVALUATION_STATUSES].sort(),
      evaluationCheckLevels: [...orchestration.EVALUATION_CHECK_LEVELS].sort(),
      evaluationCheckOutcomes: [...orchestration.EVALUATION_CHECK_OUTCOMES].sort(),
      acceptanceCriterionCheckKinds: [...orchestration.ACCEPTANCE_CRITERION_CHECK_KINDS].sort(),
      failureSources: [...orchestration.FAILURE_SOURCES].sort(),
      failureScopes: [...orchestration.FAILURE_SCOPES].sort(),
      failureRecoverabilities: [...orchestration.FAILURE_RECOVERABILITIES].sort(),
      assessmentBases: [...orchestration.ASSESSMENT_BASES].sort(),
      executionHealthStates: [...orchestration.EXECUTION_HEALTH_STATES].sort(),
      runawaySignals: [...orchestration.RUNAWAY_SIGNALS].sort(),
      recoveryActions: [...orchestration.RECOVERY_ACTIONS].sort(),
      recoveryReasonCodes: [...orchestration.RECOVERY_REASON_CODES].sort(),
      recoveryStrategyDimensions: [...orchestration.RECOVERY_STRATEGY_DIMENSIONS].sort(),
      // vNext.10.2 Phase 2 optional research vocabulary.
      researchDepths: [...orchestration.RESEARCH_DEPTHS].sort(),
      researchGateDecisions: [...orchestration.RESEARCH_GATE_DECISIONS].sort(),
      researchFindingKinds: [...orchestration.RESEARCH_FINDING_KINDS].sort(),
      researchRecordStatuses: [...orchestration.RESEARCH_RECORD_STATUSES].sort(),
      researchFailureClassifications: [...orchestration.RESEARCH_FAILURE_CLASSIFICATIONS].sort(),
      researchProviderHealthStatuses: [...orchestration.RESEARCH_PROVIDER_HEALTH_STATUSES].sort(),
      // vNext.8 adaptive compute scheduler. Additive within 1.x on the same
      // terms as everything above: members may be appended, never renamed or
      // removed, so persisted adaptive decisions and derived profiles stay
      // readable across upgrades.
      adaptiveSchedulerModes: [...core.ADAPTIVE_SCHEDULER_MODES].sort(),
      adaptiveOutcomeLabels: [...orchestration.ADAPTIVE_OUTCOME_LABELS].sort(),
      predictionConfidenceLevels: [...orchestration.PREDICTION_CONFIDENCE_LEVELS].sort(),
      profileFallbackLevels: [...orchestration.PROFILE_FALLBACK_LEVELS].sort(),
      runtimeIdentityMatches: [...orchestration.RUNTIME_IDENTITY_MATCHES].sort(),
      adaptiveVetoCodes: [...orchestration.ADAPTIVE_VETO_CODES].sort(),
      adaptiveFallbackReasons: [...orchestration.ADAPTIVE_FALLBACK_REASONS].sort(),
      adaptiveDriftSignals: [...orchestration.ADAPTIVE_DRIFT_SIGNALS].sort(),
      repositorySizeClasses: [...orchestration.REPOSITORY_SIZE_CLASSES].sort(),
      contextSizeClasses: [...orchestration.CONTEXT_SIZE_CLASSES].sort(),
      verificationStrengths: [...orchestration.VERIFICATION_STRENGTHS].sort(),
      // vNext.9 dogfood & release qualification. Additive within 1.x on the
      // same terms. The scenario IDs are frozen deliberately: removing one,
      // or weakening its requirement, is a release-gate change and must show
      // up here as a contract diff rather than as a quiet edit.
      qualificationProfiles: [...orchestration.QUALIFICATION_PROFILES].sort(),
      qualificationAreas: [...orchestration.QUALIFICATION_AREAS].sort(),
      scenarioExecutionKinds: [...orchestration.SCENARIO_EXECUTION_KINDS].sort(),
      scenarioResultStatuses: [...orchestration.SCENARIO_RESULT_STATUSES].sort(),
      scenarioRequirements: [...orchestration.SCENARIO_REQUIREMENTS].sort(),
      faultClasses: [...orchestration.FAULT_CLASSES].sort(),
      faultBoundaries: [...orchestration.FAULT_BOUNDARIES].sort(),
      faultTriggerModes: [...orchestration.FAULT_TRIGGER_MODES].sort(),
      qualificationResources: [...orchestration.QUALIFICATION_RESOURCES].sort(),
      resourceAttributions: [...orchestration.RESOURCE_ATTRIBUTIONS].sort(),
      humanInterventionKinds: [...orchestration.HUMAN_INTERVENTION_KINDS].sort(),
      releaseBlockerClasses: [...orchestration.RELEASE_BLOCKER_CLASSES].sort(),
      zeroToleranceConditions: [...orchestration.ZERO_TOLERANCE_CONDITIONS].sort(),
      limitationClasses: [...orchestration.LIMITATION_CLASSES].sort(),
      releaseVerdicts: [...orchestration.RELEASE_VERDICTS].sort(),
      dogfoodRunStatuses: [...orchestration.DOGFOOD_RUN_STATUSES].sort(),
      dogfoodTargetKinds: [...orchestration.DOGFOOD_TARGET_KINDS].sort(),
      stateInvariantIds: [...orchestration.STATE_INVARIANT_IDS].sort(),
      invariantAuditPhases: [...orchestration.INVARIANT_AUDIT_PHASES].sort(),
      defectSources: [...orchestration.DEFECT_SOURCES].sort(),
      qualificationScenarioIds: orchestration.QUALIFICATION_SCENARIOS.map(
        (scenario) => scenario.id,
      ).sort(),
      qualificationArtifacts: Object.values(orchestration.QUALIFICATION_ARTIFACTS).sort(),
    },
    // Context-lifecycle vocabulary (vNext.1). Every value is stable within
    // 1.x: members may be appended, never renamed or removed.
    'context-contract.json': {
      layers: [...context.CONTEXT_LAYERS].sort(),
      protectedLayers: [...context.PROTECTED_CONTEXT_LAYERS].sort(),
      healthLevels: [...context.CONTEXT_HEALTH_LEVELS].sort(),
      compactionLevels: [...context.COMPACTION_LEVELS].sort(),
      nativeCompactionModes: [...context.NATIVE_COMPACTION_MODES].sort(),
      // Context-efficiency vocabulary (vNext.7). Additive within 1.x on the
      // same terms as everything above: members may be appended, never
      // renamed or removed, so persisted selection plans and metrics stay
      // readable across upgrades.
      strategies: [...context.CONTEXT_STRATEGIES].sort(),
      shapes: [...context.CONTEXT_SHAPES].sort(),
      freshnessKinds: [...context.CONTEXT_FRESHNESS_KINDS].sort(),
      authorityLevels: [...context.CONTEXT_AUTHORITY_LEVELS].sort(),
      originKinds: [...context.CONTEXT_ORIGIN_KINDS].sort(),
      selectionReasons: [...context.CONTEXT_SELECTION_REASONS].sort(),
      mandatorySelectionReasons: [...context.MANDATORY_SELECTION_REASONS].sort(),
      exclusionReasons: [...context.CONTEXT_EXCLUSION_REASONS].sort(),
      expansionLevels: [...context.CONTEXT_EXPANSION_LEVELS].sort(),
      compressionMethods: [...context.CONTEXT_COMPRESSION_METHODS].sort(),
      insufficiencySignals: [...context.CONTEXT_INSUFFICIENCY_SIGNALS].sort(),
      retrievalRoles: [...context.RETRIEVAL_ROLES].sort(),
      repositoryFileKinds: [...context.REPOSITORY_FILE_KINDS].sort(),
      repositorySkipReasons: [...context.REPOSITORY_SKIP_REASONS].sort(),
      stalenessReasons: [...context.STALENESS_REASONS].sort(),
      expansionRefusalReasons: [...context.EXPANSION_REFUSAL_REASONS].sort(),
    },
    // Mission Discovery vocabulary. Every value is stable within 1.x:
    // members may be appended, never renamed or removed.
    'mission-contract.json': {
      missionStatuses: [...mission.MISSION_STATUSES].sort(),
      turnSpeakers: [...mission.TURN_SPEAKERS].sort(),
      turnKinds: [...mission.TURN_KINDS].sort(),
      provenanceKinds: [...mission.MISSION_PROVENANCE_KINDS].sort(),
      discoveryTopics: [...mission.DISCOVERY_TOPICS].sort(),
      requiredTopics: [...mission.REQUIRED_TOPICS].sort(),
      topicStatuses: [...mission.TOPIC_STATUSES].sort(),
      materialityLevels: [...mission.MATERIALITY_LEVELS].sort(),
      irreversibleSurfaces: [...mission.IRREVERSIBLE_SURFACES].sort(),
      contractClassifications: [...mission.CONTRACT_CLASSIFICATIONS].sort(),
      compatibilityPolicies: [...mission.COMPATIBILITY_POLICIES].sort(),
      ccrStatuses: [...mission.CCR_STATUSES].sort(),
      eventTypes: [...mission.MISSION_EVENT_TYPES].sort(),
      errorCodes: Object.keys(mission.SBM_CODES).sort(),
    },
    // Overnight autonomous runtime vocabulary (vNext.10). Every value is
    // stable within 1.x: members may be appended, never renamed or removed.
    // `hardHumanAuthoritySurfaces` and `nonAuthoritySignals` are the two that
    // matter most: the first names what a human always decides, the second
    // names what can NEVER become a human gate, and both are promises rather
    // than implementation details.
    'autonomy-contract.json': {
      autonomyModes: [...core.AUTONOMY_MODES].sort(),
      humanGateModes: [...core.HUMAN_GATE_MODES].sort(),
      delegationSettings: [...core.DELEGATION_SETTINGS].sort(),
      hardHumanAuthoritySurfaces: [...core.HARD_HUMAN_AUTHORITY_SURFACES].sort(),
      toolsmithCapabilities: [...core.TOOLSMITH_CAPABILITIES].sort(),
      criticModes: [...core.CRITIC_MODES].sort(),
      sealStatuses: [...autonomy.SEAL_STATUSES].sort(),
      sealedAuthorityKinds: [...autonomy.SEALED_AUTHORITY_KINDS].sort(),
      requiredSealAuthorityKinds: [...autonomy.REQUIRED_SEAL_AUTHORITY_KINDS].sort(),
      autonomousDecisionSurfaces: [...autonomy.AUTONOMOUS_DECISION_SURFACES].sort(),
      authorityVerdicts: [...autonomy.AUTHORITY_VERDICTS].sort(),
      authorityReasons: [...autonomy.AUTHORITY_REASONS].sort(),
      nonAuthoritySignals: [...autonomy.NON_AUTHORITY_SIGNALS].sort(),
      supervisionStatuses: [...autonomy.SUPERVISION_STATUSES].sort(),
      supervisionActions: [...autonomy.SUPERVISION_ACTIONS].sort(),
      resourceWaitKinds: [...autonomy.RESOURCE_WAIT_KINDS].sort(),
      preflightCapabilities: [...autonomy.PREFLIGHT_CAPABILITIES].sort(),
      preflightOutcomes: [...autonomy.PREFLIGHT_OUTCOMES].sort(),
      preflightVerdicts: [...autonomy.PREFLIGHT_VERDICTS].sort(),
      toolsmithRequestStatuses: [...autonomy.TOOLSMITH_REQUEST_STATUSES].sort(),
      toolsmithDenialReasons: [...autonomy.TOOLSMITH_DENIAL_REASONS].sort(),
      toolInstallScopes: [...autonomy.TOOL_INSTALL_SCOPES].sort(),
      serviceKinds: [...autonomy.SERVICE_KINDS].sort(),
      readinessProbeKinds: [...autonomy.READINESS_PROBE_KINDS].sort(),
      applicationLevelProbes: [...autonomy.APPLICATION_LEVEL_PROBES].sort(),
      environmentStatuses: [...autonomy.ENVIRONMENT_STATUSES].sort(),
      environmentFailureKinds: [...autonomy.ENVIRONMENT_FAILURE_KINDS].sort(),
      browserStepKinds: [...autonomy.BROWSER_STEP_KINDS].sort(),
      browserAssertionSteps: [...autonomy.BROWSER_ASSERTION_STEPS].sort(),
      browserScenarioStatuses: [...autonomy.BROWSER_SCENARIO_STATUSES].sort(),
      browserEvidenceKinds: [...autonomy.BROWSER_EVIDENCE_KINDS].sort(),
      uxFindingKinds: [...autonomy.UX_FINDING_KINDS].sort(),
      uxFindingSeverities: [...autonomy.UX_FINDING_SEVERITIES].sort(),
      uxCritiqueVerdicts: [...autonomy.UX_CRITIQUE_VERDICTS].sort(),
      closureStatuses: [...autonomy.CLOSURE_STATUSES].sort(),
      closingStatuses: [...autonomy.CLOSING_STATUSES].sort(),
      closureEvidenceKinds: [...autonomy.CLOSURE_EVIDENCE_KINDS].sort(),
      closingEvidenceKinds: [...autonomy.CLOSING_EVIDENCE_KINDS].sort(),
      closurePhases: [...autonomy.CLOSURE_PHASES].sort(),
      closureDirectives: [...autonomy.CLOSURE_DIRECTIVES].sort(),
      closureGapKinds: [...autonomy.CLOSURE_GAP_KINDS].sort(),
      controlPlaneDefectKinds: [...autonomy.CONTROL_PLANE_DEFECT_KINDS].sort(),
      controlPlaneRepairStages: [...autonomy.CONTROL_PLANE_REPAIR_STAGES].sort(),
      controlPlaneRepairStatuses: [...autonomy.CONTROL_PLANE_REPAIR_STATUSES].sort(),
      protectedControlPlaneInvariants: [...autonomy.PROTECTED_CONTROL_PLANE_INVARIANTS].sort(),
      autonomyCounters: [...autonomy.AUTONOMY_COUNTERS].sort(),
      autonomyMeasurements: [...autonomy.AUTONOMY_MEASUREMENTS].sort(),
      zeroTouchFaults: [...autonomy.ZERO_TOUCH_FAULTS].sort(),
      zeroTouchExpectations: [...autonomy.ZERO_TOUCH_EXPECTATIONS].sort(),
      zeroTouchOutcomes: [...autonomy.ZERO_TOUCH_OUTCOMES].sort(),
      certificationVerdicts: [...autonomy.CERTIFICATION_VERDICTS].sort(),
      reproducibilityDimensions: [...autonomy.REPRODUCIBILITY_DIMENSIONS].sort(),
      certificationScenarioIds: autonomy.CERTIFICATION_MATRIX.map((s) => s.id).sort(),
      errorCodes: Object.keys(autonomy.SBA_CODES).sort(),
    },
    // Zero-Touch Spec Intake vocabulary (vNext.10.1). Every value is stable
    // within 1.x: members may be appended, never renamed or removed, so a
    // persisted intake, approval, and build ledger stay readable across
    // upgrades. `engineeringQuestionSurfaces` is the one to read twice: it
    // is a NEGATIVE list — the surfaces discovery will never ask a human
    // about — and it is a promise rather than an implementation detail, the
    // same way `nonAuthoritySignals` is.
    'intake-contract.json': {
      intakeStatuses: [...intake.INTAKE_STATUSES].sort(),
      specSourceKinds: [...intake.SPEC_SOURCE_KINDS].sort(),
      sourceChunkKinds: [...intake.SOURCE_CHUNK_KINDS].sort(),
      chunkCoverageStates: [...intake.CHUNK_COVERAGE_STATES].sort(),
      repositoryEvidenceKinds: [...intake.REPOSITORY_EVIDENCE_KINDS].sort(),
      deltaAuthorityClasses: [...intake.DELTA_AUTHORITY_CLASSES].sort(),
      authoritySensitiveDeltaClasses: [...intake.AUTHORITY_SENSITIVE_DELTA_CLASSES].sort(),
      productQuestionKinds: [...intake.PRODUCT_QUESTION_KINDS].sort(),
      questionRefusalReasons: [...intake.QUESTION_REFUSAL_REASONS].sort(),
      engineeringQuestionSurfaces: [...intake.ENGINEERING_QUESTION_SURFACES].sort(),
      approvalModes: [...intake.APPROVAL_MODES].sort(),
      divergenceKinds: [...intake.DIVERGENCE_KINDS].sort(),
      buildLifecycleSteps: [...intake.BUILD_LIFECYCLE_STEPS],
      buildStepStatuses: [...intake.BUILD_STEP_STATUSES].sort(),
      buildOutcomes: [...intake.BUILD_OUTCOMES].sort(),
      eventTypes: [...intake.INTAKE_EVENT_TYPES].sort(),
      errorCodes: Object.keys(intake.SBI_CODES).sort(),
    },
    'mcp-contract.json': {
      serverName: mcp.MCP_SERVER_NAME,
      tools: mcp.TOOL_CATALOG.map((tool) => tool.name).sort(),
      resources: mcp.RESOURCE_CATALOG.map((resource) => resource.uri).sort(),
      prompts: mcp.PROMPT_CATALOG.map((prompt) => prompt.name).sort(),
    },
    'plugin-skills.json': { skills: skillNames() },
    'github-action.json': actionInterface(),
  };
  return snapshots;
}

function diffKeys(expectedRaw, actualRaw) {
  // Line-level summary that is enough to locate the drift in a review.
  const expected = expectedRaw.split('\n');
  const actual = actualRaw.split('\n');
  const notes = [];
  for (const line of actual) {
    if (!expected.includes(line) && line.trim() !== '') notes.push(`+ ${line.trim()}`);
  }
  for (const line of expected) {
    if (!actual.includes(line) && line.trim() !== '') notes.push(`- ${line.trim()}`);
  }
  return notes.slice(0, 20);
}

const snapshots = await buildSnapshots();

if (!CHECK) {
  mkdirSync(CONTRACTS_DIR, { recursive: true });
  for (const [name, value] of Object.entries(snapshots)) {
    writeFileSync(path.join(CONTRACTS_DIR, name), stableStringify(value));
    console.log(`wrote contracts/${name}`);
  }
  console.log(`check-public-contracts: generated ${Object.keys(snapshots).length} snapshot files.`);
  process.exit(0);
}

let drifted = 0;
for (const [name, value] of Object.entries(snapshots)) {
  const file = path.join(CONTRACTS_DIR, name);
  if (!existsSync(file)) {
    console.error(`✗ contracts/${name} is missing — run "pnpm generate:public-contracts".`);
    drifted += 1;
    continue;
  }
  const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const actual = stableStringify(value);
  if (expected !== actual) {
    drifted += 1;
    console.error(`✗ contracts/${name} drifted from the current build:`);
    for (const note of diffKeys(expected, actual)) console.error(`    ${note}`);
  } else {
    console.log(`ok    contracts/${name}`);
  }
}

if (drifted > 0) {
  console.error(
    `\ncheck-public-contracts: ${drifted} snapshot(s) drifted. A stable public contract changed.\n` +
      'If intentional: run "pnpm generate:public-contracts", review the diff against\n' +
      'docs/stability/versioning-policy.md, and add a CHANGELOG entry. Otherwise revert the change.',
  );
  process.exit(1);
}
console.log('check-public-contracts: all snapshots match.');
