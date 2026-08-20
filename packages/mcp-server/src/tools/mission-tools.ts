import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkspaceInfo } from '@specbridge/core';
import type { MissionDeps } from '@specbridge/mission';
import {
  DISCOVERY_TOPICS,
  IRREVERSIBLE_SURFACES,
  MATERIALITY_LEVELS,
  MISSION_PROVENANCE_KINDS,
  TURN_KINDS,
  TURN_SPEAKERS,
  answerQuestion,
  beginMission,
  createContractChangeRequest,
  describeMission,
  listMissions,
  markContractReady,
  observeSpecApproval,
  readAdrs,
  readCcrs,
  readConstitution,
  readContract,
  readContractRegistry,
  readCoverage,
  readDecisions,
  readFacts,
  readQuestions,
  readTurns,
  recordAssessment,
  recordTurn,
  requireMissionState,
  synthesizeMissionSpec,
} from '@specbridge/mission';
import type { ServerContext } from '../context.js';
import { registerDefinedTool } from './helpers.js';

/**
 * Mission Discovery tools — the `/specbridge:discover` surface.
 *
 * The interactive Claude session TALKS to the user and PROPOSES structure;
 * these tools GOVERN what gets recorded: provenance-checked decisions,
 * materiality-screened questions, versioned artifacts, deterministic
 * coverage. Deliberately absent, and asserted by tests:
 *   - no tool approves a spec stage
 *   - no tool decides a contract change request (that path is CLI-only)
 *   - no tool moves a mission to APPROVED (only observed human approvals do)
 */

function missionDeps(context: ServerContext, workspace: WorkspaceInfo): MissionDeps {
  return {
    workspace,
    clock: context.clock,
    idFactory: context.idFactory,
    host: 'mcp',
  };
}

const missionIdArg = z.string().min(1).max(64).describe('Mission id (m-…) from mission_begin or mission_status');

const missionSummaryShape = {
  missionId: z.string(),
  name: z.string(),
  status: z.string(),
  specName: z.string().optional(),
  openQuestions: z.number().int(),
  decisions: z.number().int(),
  contracts: z.number().int(),
  contractReady: z.boolean().optional(),
};

function summarize(context: ServerContext, workspace: WorkspaceInfo, missionId: string) {
  const mission = requireMissionState(workspace, missionId);
  const coverage = readCoverage(workspace, missionId);
  return {
    missionId: mission.missionId,
    name: mission.name,
    status: mission.status,
    ...(mission.specName !== undefined ? { specName: mission.specName } : {}),
    openQuestions: mission.counters.openQuestions,
    decisions: mission.counters.decisions,
    contracts: mission.counters.contracts,
    ...(coverage !== undefined ? { contractReady: coverage.contractReady } : {}),
  };
}

// ---------------------------------------------------------------------------
// mission_begin / mission_status / mission_read
// ---------------------------------------------------------------------------

export function registerMissionBeginTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_begin',
    title: 'Begin a mission',
    description:
      'Begin Mission Discovery from a high-level product direction. Creates the durable mission record ' +
      'under .specbridge/missions/. Discovery itself is a conversation: record every material visible ' +
      'exchange with mission_record_turn and its structured meaning with mission_assess.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      name: z.string().min(1).max(120).describe('Short mission name (also the default spec name)'),
      goal: z.string().min(1).max(4000).describe("The user's product direction, verbatim"),
    },
    outputSchema: { mission: z.object(missionSummaryShape) },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const mission = beginMission(missionDeps(context, workspace), { name: args.name, goal: args.goal });
      return {
        text: `Mission ${mission.missionId} (${mission.name}) created in status ${mission.status}. Record the user's direction as the first turn.`,
        structured: { mission: summarize(context, workspace, mission.missionId) },
      };
    },
  });
}

export function registerMissionStatusTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_status',
    title: 'List missions',
    description: 'List missions (newest first) with lifecycle status, counters, and readiness. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
    outputSchema: { missions: z.array(z.object(missionSummaryShape)) },
    handler: async () => {
      const workspace = context.requireWorkspace();
      const listed = listMissions(workspace);
      const missions = listed.missions.slice(0, 50).map((mission) => summarize(context, workspace, mission.missionId));
      return {
        text:
          missions.length === 0
            ? 'No missions exist. Begin one with mission_begin.'
            : missions.map((mission) => `- ${mission.missionId} ${mission.status} (${mission.name})`).join('\n'),
        structured: { missions },
      };
    },
  });
}

export function registerMissionReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_read',
    title: 'Read one mission',
    description:
      'Read one mission in depth. `view` selects the record family: overview (default), facts, decisions, ' +
      'questions, conversation, coverage, constitution, adrs, or ccrs. Bounded; read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      missionId: missionIdArg,
      view: z
        .enum(['overview', 'facts', 'decisions', 'questions', 'conversation', 'coverage', 'constitution', 'adrs', 'ccrs'])
        .optional()
        .describe('Which record family to read (default overview)'),
      limit: z.number().int().min(1).max(200).optional().describe('Bounded page size for list views'),
    },
    outputSchema: {
      mission: z.object(missionSummaryShape),
      view: z.string(),
      records: z.array(z.record(z.unknown())),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const deps = missionDeps(context, workspace);
      observeSpecApproval(deps, args.missionId);
      const view = args.view ?? 'overview';
      const limit = args.limit ?? 50;
      let records: Record<string, unknown>[] = [];
      switch (view) {
        case 'overview': {
          const overview = describeMission(deps, args.missionId);
          records = [
            {
              goal: overview.mission.goal,
              nonGoals: overview.mission.nonGoals,
              targetUsers: overview.mission.targetUsers,
              constraints: overview.mission.constraints,
              successCriteria: overview.mission.successCriteria,
              assumptions: overview.mission.assumptions,
              constitutionVersion: overview.constitutionVersion,
              activeConstitutionRules: overview.activeConstitutionRules,
              contractCount: overview.contractCount,
              adrCount: overview.adrCount,
              blockingQuestions: overview.blockingQuestions,
              openCcrs: overview.openCcrs,
            },
          ];
          break;
        }
        case 'facts':
          records = readFacts(workspace, args.missionId).slice(-limit);
          break;
        case 'decisions':
          records = readDecisions(workspace, args.missionId).slice(-limit);
          break;
        case 'questions':
          records = readQuestions(workspace, args.missionId).slice(-limit);
          break;
        case 'conversation':
          records = readTurns(workspace, args.missionId, { limit }).turns;
          break;
        case 'coverage': {
          const coverage = readCoverage(workspace, args.missionId);
          records = coverage !== undefined ? [coverage] : [];
          break;
        }
        case 'constitution': {
          const constitution = readConstitution(workspace, args.missionId);
          records = constitution !== undefined ? [constitution] : [];
          break;
        }
        case 'adrs':
          records = readAdrs(workspace, args.missionId).slice(-limit);
          break;
        case 'ccrs':
          records = readCcrs(workspace, args.missionId).slice(-limit);
          break;
      }
      return {
        text: `${view}: ${records.length} record(s).`,
        structured: { mission: summarize(context, workspace, args.missionId), view, records },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// mission_record_turn / mission_assess
// ---------------------------------------------------------------------------

export function registerMissionRecordTurnTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_record_turn',
    title: 'Record a visible discovery turn',
    description:
      'Persist one USER-VISIBLE discovery exchange verbatim: what the user said, or what the agent visibly ' +
      'asked, interpreted, or presented. Turns are the provenance roots every decision traces back to. ' +
      'Never record hidden reasoning — only what both sides could see.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      missionId: missionIdArg,
      speaker: z.enum(TURN_SPEAKERS).describe('Who produced the visible text'),
      kind: z.enum(TURN_KINDS).describe('What kind of exchange this is'),
      text: z.string().min(1).max(8000).describe('The visible text, verbatim'),
      inReplyTo: z.string().max(64).optional().describe('Turn id this replies to'),
      refs: z.array(z.string().max(64)).max(30).optional().describe('Record ids this turn addresses'),
    },
    outputSchema: { turnId: z.string(), missionStatus: z.string() },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const result = recordTurn(missionDeps(context, workspace), args.missionId, {
        speaker: args.speaker,
        kind: args.kind,
        text: args.text,
        inReplyTo: args.inReplyTo,
        refs: args.refs,
      });
      return {
        text: `Recorded ${result.turn.turnId} (${args.speaker} ${args.kind}). Mission is ${result.mission.status}.`,
        structured: { turnId: result.turn.turnId, missionStatus: result.mission.status },
      };
    },
  });
}

const factInput = z.object({
  statement: z.string().min(1).max(4000),
  provenance: z.enum(MISSION_PROVENANCE_KINDS),
  sourceTurnId: z.string().max(64).optional(),
  topics: z.array(z.enum(DISCOVERY_TOPICS)).max(10).optional(),
  supersedesFactId: z.string().max(64).optional(),
});

const questionInput = z.object({
  question: z.string().min(1).max(4000),
  whyItMatters: z.string().min(1).max(4000),
  topics: z.array(z.enum(DISCOVERY_TOPICS)).max(10).optional(),
  affectedSurfaces: z.array(z.enum(IRREVERSIBLE_SURFACES)).max(10).optional(),
  materiality: z.enum(MATERIALITY_LEVELS).optional(),
  options: z.array(z.string().max(2000)).max(10).optional(),
  sourceTurnId: z.string().max(64).optional(),
});

const decisionInput = z.object({
  decision: z.string().min(1).max(4000),
  rationale: z.string().max(4000).optional(),
  provenance: z.enum(MISSION_PROVENANCE_KINDS),
  sourceTurnId: z.string().max(64).optional(),
  questionId: z.string().max(64).optional(),
  topics: z.array(z.enum(DISCOVERY_TOPICS)).max(10).optional(),
  marksNotApplicable: z.array(z.enum(DISCOVERY_TOPICS)).max(10).optional(),
  supersedesDecisionId: z.string().max(64).optional(),
});

const constitutionRuleInput = z.object({
  statement: z.string().min(1).max(4000),
  rationale: z.string().max(4000).optional(),
  decisionIds: z.array(z.string().max(64)).min(1).max(30),
  affectedContractIds: z.array(z.string().max(64)).max(30).optional(),
  guardPatterns: z.array(z.string().min(1).max(200)).max(10).optional(),
  supersedesRuleId: z.string().max(64).optional(),
});

const adrInput = z.object({
  title: z.string().min(1).max(512),
  context: z.string().min(1).max(4000),
  decision: z.string().min(1).max(4000),
  alternatives: z.array(z.string().max(4000)).max(20).optional(),
  rationale: z.string().min(1).max(4000),
  consequences: z.array(z.string().max(4000)).max(20).optional(),
  revisitConditions: z.array(z.string().max(4000)).max(20).optional(),
  decisionIds: z.array(z.string().max(64)).max(30).optional(),
  turnIds: z.array(z.string().max(64)).max(30).optional(),
  supersedesAdrId: z.string().max(64).optional(),
});

const contractInput = z.object({
  title: z.string().min(1).max(512),
  summary: z.string().min(1).max(4000),
  classification: z.enum(['public', 'internal']),
  compatibilityPolicy: z.enum(['frozen', 'additive-only', 'evolving', 'internal']),
  dependsOn: z.array(z.string().max(64)).max(30).optional(),
  requirements: z
    .array(z.object({ statement: z.string().min(1).max(4000), decisionIds: z.array(z.string().max(64)).max(30).optional() }))
    .min(1)
    .max(60),
  invariants: z
    .array(
      z.object({
        statement: z.string().min(1).max(4000),
        constitutionRuleIds: z.array(z.string().max(64)).max(30).optional(),
        guardPatterns: z.array(z.string().min(1).max(200)).max(10).optional(),
      }),
    )
    .max(60)
    .optional(),
  decisionIds: z.array(z.string().max(64)).min(1).max(30),
  turnIds: z.array(z.string().max(64)).max(30).optional(),
});

export function registerMissionAssessTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_assess',
    title: 'Record a structured discovery assessment',
    description:
      'Submit the STRUCTURED meaning of the discovery conversation: facts, questions, decisions, ' +
      'constitution rules, ADRs, contracts, and mission field updates. SpecBridge governs every record: ' +
      'decisions need safe provenance (a user-provenance decision must cite a USER turn), question ' +
      'materiality passes the deterministic irreversibility screen (it can only be RAISED), durable ' +
      'artifacts must trace to recorded decisions, and coverage recomputes deterministically. ' +
      'Blocking questions prevent CONTRACT_READY; implementation-detail questions never do.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      missionId: missionIdArg,
      facts: z.array(factInput).max(20).optional(),
      questions: z.array(questionInput).max(20).optional(),
      decisions: z.array(decisionInput).max(20).optional(),
      constitutionRules: z.array(constitutionRuleInput).max(10).optional(),
      adrs: z.array(adrInput).max(10).optional(),
      contracts: z.array(contractInput).max(10).optional(),
      missionUpdates: z
        .object({
          nonGoals: z.array(z.string().max(4000)).max(50).optional(),
          targetUsers: z.array(z.string().max(4000)).max(50).optional(),
          constraints: z.array(z.string().max(4000)).max(50).optional(),
          successCriteria: z.array(z.string().max(4000)).max(50).optional(),
          assumptions: z
            .array(
              z.object({
                statement: z.string().min(1).max(4000),
                topics: z.array(z.enum(DISCOVERY_TOPICS)).max(10).optional(),
                questionId: z.string().max(64).optional(),
              }),
            )
            .max(50)
            .optional(),
        })
        .optional(),
    },
    outputSchema: {
      missionStatus: z.string(),
      contractReady: z.boolean(),
      factIds: z.array(z.string()),
      questionIds: z.array(z.string()),
      decisionIds: z.array(z.string()),
      constitutionRuleIds: z.array(z.string()),
      adrIds: z.array(z.string()),
      contractIds: z.array(z.string()),
      materialityRaised: z.array(
        z.object({ questionId: z.string(), from: z.string(), to: z.string() }),
      ),
      blockingQuestionIds: z.array(z.string()),
      unresolvedRequiredTopics: z.array(z.string()),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const result = recordAssessment(missionDeps(context, workspace), args.missionId, {
        facts: args.facts,
        questions: args.questions,
        decisions: args.decisions,
        constitutionRules: args.constitutionRules,
        adrs: args.adrs,
        contracts: args.contracts,
        missionUpdates: args.missionUpdates,
      });
      const raised = result.materialityRaised
        .map((entry) => `${entry.questionId} raised ${entry.from} → ${entry.to}`)
        .join('; ');
      return {
        text:
          `Recorded ${result.factIds.length} fact(s), ${result.questionIds.length} question(s), ` +
          `${result.decisionIds.length} decision(s), ${result.constitutionRuleIds.length} rule(s), ` +
          `${result.adrIds.length} ADR(s), ${result.contractIds.length} contract(s). ` +
          `Mission is ${result.mission.status}; contract-ready: ${result.coverage.contractReady}.` +
          (raised.length > 0 ? ` Materiality screen: ${raised}.` : ''),
        structured: {
          missionStatus: result.mission.status,
          contractReady: result.coverage.contractReady,
          factIds: result.factIds,
          questionIds: result.questionIds,
          decisionIds: result.decisionIds,
          constitutionRuleIds: result.constitutionRuleIds,
          adrIds: result.adrIds,
          contractIds: result.contractIds,
          materialityRaised: result.materialityRaised,
          blockingQuestionIds: result.coverage.blockingQuestionIds,
          unresolvedRequiredTopics: result.coverage.unresolvedRequiredTopics,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// mission_questions / mission_answer / mission_synthesize
// ---------------------------------------------------------------------------

export function registerMissionQuestionsTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_questions',
    title: 'Open discovery questions',
    description:
      'The open questions with materiality and why each matters. Blocking questions gate CONTRACT_READY. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { missionId: missionIdArg },
    outputSchema: {
      questions: z.array(
        z.object({
          questionId: z.string(),
          question: z.string(),
          whyItMatters: z.string(),
          materiality: z.string(),
          topics: z.array(z.string()),
          options: z.array(z.string()),
        }),
      ),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      requireMissionState(workspace, args.missionId);
      const questions = readQuestions(workspace, args.missionId)
        .filter((question) => question.status === 'open')
        .map((question) => ({
          questionId: question.questionId,
          question: question.question,
          whyItMatters: question.whyItMatters,
          materiality: question.materiality,
          topics: [...question.topics],
          options: [...question.options],
        }));
      return {
        text:
          questions.length === 0
            ? 'No open questions.'
            : questions.map((question) => `- ${question.questionId} [${question.materiality}] ${question.question}`).join('\n'),
        structured: { questions },
      };
    },
  });
}

export function registerMissionAnswerTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_answer',
    title: 'Record the user’s answer to a question',
    description:
      "Record the USER'S answer to one open discovery question: an answering user turn plus a " +
      'known-from-user decision bound to it. Relay their words; never answer on their behalf.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      missionId: missionIdArg,
      questionId: z.string().min(1).max(64),
      answer: z.string().min(1).max(4000).describe("The user's answer, verbatim"),
      marksNotApplicable: z.array(z.enum(DISCOVERY_TOPICS)).max(10).optional(),
    },
    outputSchema: {
      decisionId: z.string(),
      missionStatus: z.string(),
      contractReady: z.boolean(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const result = answerQuestion(missionDeps(context, workspace), args.missionId, {
        questionId: args.questionId,
        answer: args.answer,
        marksNotApplicable: args.marksNotApplicable,
      });
      return {
        text: `Recorded ${result.decision.decisionId}. Mission is ${result.mission.status}; contract-ready: ${result.coverage.contractReady}.`,
        structured: {
          decisionId: result.decision.decisionId,
          missionStatus: result.mission.status,
          contractReady: result.coverage.contractReady,
        },
      };
    },
  });
}

export function registerMissionSynthesizeTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'mission_synthesize',
    title: 'Synthesize the Kiro spec',
    description:
      'Move a coverage-complete mission to CONTRACT_READY and compile its contract set into Kiro spec ' +
      'candidates: requirements.md, design.md, and OBJECTIVE-oriented tasks.md — through the existing ' +
      'creation machinery. Approval stays entirely human (`specbridge spec approve …`); nothing here or ' +
      'anywhere on MCP can approve a stage. Fails closed when blocking questions or required topics remain.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      missionId: missionIdArg,
      specName: z.string().max(64).optional().describe('Spec name (default: the mission name)'),
    },
    outputSchema: {
      specName: z.string(),
      objectiveCount: z.number().int(),
      files: z.array(z.object({ fileName: z.string(), bytes: z.number().int() })),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const deps = missionDeps(context, workspace);
      markContractReady(deps, args.missionId);
      const result = synthesizeMissionSpec(deps, args.missionId, { specName: args.specName });
      return {
        text:
          `Synthesized spec "${result.specName}" with ${result.objectiveCount} objective(s). ` +
          `The user approves it with: specbridge spec approve ${result.specName} --stage requirements|design|tasks.`,
        structured: {
          specName: result.specName,
          objectiveCount: result.objectiveCount,
          files: result.files,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// contract_list / contract_read / contract_change_request
// ---------------------------------------------------------------------------

export function registerContractListTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'contract_list',
    title: 'List product contracts',
    description:
      'The mission’s product contract registry (current revisions) plus the Architecture Constitution. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { missionId: missionIdArg },
    outputSchema: {
      constitutionVersion: z.number().int(),
      rules: z.array(z.object({ ruleId: z.string(), statement: z.string(), status: z.string() })),
      contracts: z.array(
        z.object({
          contractId: z.string(),
          revision: z.number().int(),
          title: z.string(),
          classification: z.string(),
          compatibilityPolicy: z.string(),
        }),
      ),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      requireMissionState(workspace, args.missionId);
      const constitution = readConstitution(workspace, args.missionId);
      const contracts = readContractRegistry(workspace, args.missionId).map((contract) => ({
        contractId: contract.contractId,
        revision: contract.revision,
        title: contract.title,
        classification: contract.classification,
        compatibilityPolicy: contract.compatibilityPolicy,
      }));
      return {
        text:
          contracts.map((contract) => `- ${contract.contractId} r${contract.revision} ${contract.title}`).join('\n') ||
          'No contracts recorded.',
        structured: {
          constitutionVersion: constitution?.version ?? 0,
          rules: (constitution?.rules ?? []).map((rule) => ({
            ruleId: rule.ruleId,
            statement: rule.statement,
            status: rule.status,
          })),
          contracts,
        },
      };
    },
  });
}

export function registerContractReadTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'contract_read',
    title: 'Read one product contract',
    description: 'One contract in depth: requirements, invariants, dependencies, provenance, revision lineage. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      missionId: missionIdArg,
      contractId: z.string().min(1).max(64),
      revision: z.number().int().min(1).optional().describe('A specific revision (default: current)'),
    },
    outputSchema: { contract: z.record(z.unknown()) },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      requireMissionState(workspace, args.missionId);
      const contract = readContract(workspace, args.missionId, args.contractId, args.revision);
      if (contract === undefined) {
        return {
          text: `Contract ${args.contractId}${args.revision !== undefined ? ` r${args.revision}` : ''} does not exist.`,
          structured: { contract: {} },
        };
      }
      return {
        text: `${contract.contractId} r${contract.revision}: ${contract.title} — ${contract.requirements.length} requirement(s), ${contract.invariants.length} invariant(s).`,
        structured: { contract: contract as unknown as Record<string, unknown> },
      };
    },
  });
}

export function registerContractChangeRequestTool(server: McpServer, context: ServerContext): void {
  registerDefinedTool(server, context, {
    name: 'contract_change_request',
    title: 'Create a contract change request',
    description:
      'Create a durable ContractChangeRequest against a product contract. Anyone may RAISE one; only the ' +
      'human decides it (CLI: `specbridge mission ccr <id> <ccrId> --approve|--reject`). A material request ' +
      '(public contract, frozen/additive policy, or irreversible surface) lands NEEDS_HUMAN and stops ' +
      'affected execution. This tool can never approve anything.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      missionId: missionIdArg,
      contractId: z.string().min(1).max(64),
      problem: z.string().min(1).max(4000).describe('What the current contract cannot express'),
      proposal: z.string().min(1).max(4000).describe('The proposed change'),
      affected: z.array(z.string().max(2000)).max(30).optional().describe('Areas the change would touch'),
    },
    outputSchema: {
      ccrId: z.string(),
      status: z.string(),
      material: z.boolean(),
    },
    handler: async (args) => {
      const workspace = context.requireWorkspace();
      const result = createContractChangeRequest(missionDeps(context, workspace), args.missionId, {
        contractId: args.contractId,
        problem: args.problem,
        proposal: args.proposal,
        affected: args.affected,
        raisedBy: 'mcp',
      });
      return {
        text:
          `${result.ccr.ccrId} created (${result.ccr.status}). ` +
          (result.material
            ? 'It is material: the human decides it with `specbridge mission ccr … --approve|--reject`.'
            : 'It is recorded for the next contract review.'),
        structured: { ccrId: result.ccr.ccrId, status: result.ccr.status, material: result.material },
      };
    },
  });
}
