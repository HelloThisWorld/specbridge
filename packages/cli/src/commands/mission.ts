import type { Command } from 'commander';
import { CLI_BIN } from '@specbridge/core';
import type { MissionDeps, MissionState } from '@specbridge/mission';
import {
  abandonMission,
  answerQuestion,
  beginMission,
  decideContractChangeRequest,
  describeMission,
  listMissions,
  markContractReady,
  observeSpecApproval,
  readAdrs,
  readCcrs,
  readConstitution,
  readContractRegistry,
  readCoverage,
  readDecisions,
  readMissionEvents,
  readQuestions,
  reopenDiscovery,
  requireMissionState,
  synthesizeMissionSpec,
} from '@specbridge/mission';
import {
  blockedLine,
  createJsonReport,
  dim,
  failLine,
  infoLine,
  okLine,
  reportTitle,
  sectionTitle,
  serializeJsonReport,
  warnLine,
} from '@specbridge/reporting';
import type { CliRuntime } from '../context.js';
import { VERSION } from '../version.js';

/**
 * `specbridge mission …` — Mission Discovery.
 *
 * Every command is a thin adapter over @specbridge/mission: the CLI formats
 * and relays; the package owns lifecycle, validation, coverage, materiality,
 * and synthesis. The interactive discovery CONVERSATION itself lives in the
 * Claude Code plugin (`/specbridge:discover`) over MCP; this surface serves
 * inspection, the recorded human decisions (answer, ccr approval), and
 * synthesis.
 *
 * `mission ccr --approve|--reject` is deliberately CLI-only: it is the
 * human-authorized contract-change path, and no MCP tool exposes it.
 */

function jsonOut(runtime: CliRuntime, schema: string, data: Record<string, unknown>): void {
  runtime.outRaw(serializeJsonReport(createJsonReport(schema, `${CLI_BIN} ${VERSION}`, data)));
}

function missionDeps(runtime: CliRuntime): MissionDeps {
  return { workspace: runtime.workspace(), clock: () => runtime.now(), host: 'cli' };
}

function statusLine(mission: MissionState): string {
  const label = `${mission.missionId}  ${mission.status}  ${mission.name}`;
  if (mission.status === 'APPROVED') return okLine(label);
  if (mission.status === 'ABANDONED') return failLine(label);
  if (mission.status === 'NEEDS_DECISION') return blockedLine(label);
  return infoLine(label);
}

function missionSummary(mission: MissionState): Record<string, unknown> {
  return {
    missionId: mission.missionId,
    name: mission.name,
    status: mission.status,
    specName: mission.specName ?? null,
    turns: mission.counters.turns,
    facts: mission.counters.facts,
    openQuestions: mission.counters.openQuestions,
    decisions: mission.counters.decisions,
    contracts: mission.counters.contracts,
    adrs: mission.counters.adrs,
    ccrs: mission.counters.ccrs,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

export function registerMissionCommands(program: Command, runtime: CliRuntime): void {
  const mission = program
    .command('mission')
    .description('Mission Discovery: product-direction discovery, contracts, ADRs, and spec synthesis');

  // ---------------------------------------------------------------------------
  // begin
  // ---------------------------------------------------------------------------
  mission
    .command('begin')
    .description('Begin a mission from a high-level product direction')
    .argument('<name>', 'short mission name (also the default spec name)')
    .requiredOption('--goal <text>', 'the product direction, in one or two sentences')
    .option('--json', 'output a machine-readable JSON report')
    .action((name: string, options: { goal: string; json?: boolean }) => {
      const created = beginMission(missionDeps(runtime), { name, goal: options.goal });
      if (options.json === true) {
        jsonOut(runtime, 'mission-begin', { mission: missionSummary(created) });
        return;
      }
      runtime.out(okLine(`Mission ${created.missionId} (${created.name}) created.`));
      runtime.out(dim(`  Discover with the plugin: /specbridge:discover ${created.missionId}`));
      runtime.out(dim(`  Inspect any time: ${CLI_BIN} mission show ${created.missionId}`));
    });

  // ---------------------------------------------------------------------------
  // status (list) / show
  // ---------------------------------------------------------------------------
  mission
    .command('status')
    .description('List missions with lifecycle status and counters')
    .option('--json', 'output a machine-readable JSON report')
    .action((options: { json?: boolean }) => {
      const listed = listMissions(runtime.workspace());
      if (options.json === true) {
        jsonOut(runtime, 'mission-status', {
          missions: listed.missions.map(missionSummary),
          diagnostics: listed.diagnostics,
        });
        return;
      }
      runtime.out(reportTitle('Missions'));
      if (listed.missions.length === 0) {
        runtime.out(dim(`  none — begin one with \`${CLI_BIN} mission begin <name> --goal "…"\``));
        return;
      }
      for (const entry of listed.missions) runtime.out(`  ${statusLine(entry)}`);
      for (const diagnostic of listed.diagnostics) runtime.out(warnLine(diagnostic.message));
    });

  mission
    .command('show')
    .description('One mission in depth: status, coverage, open questions, artifacts')
    .argument('<missionId>')
    .option('--json', 'output a machine-readable JSON report')
    .action((missionId: string, options: { json?: boolean }) => {
      const deps = missionDeps(runtime);
      observeSpecApproval(deps, missionId);
      const overview = describeMission(deps, missionId);
      if (options.json === true) {
        jsonOut(runtime, 'mission-show', {
          mission: missionSummary(overview.mission),
          goal: overview.mission.goal,
          nonGoals: overview.mission.nonGoals,
          assumptions: overview.mission.assumptions,
          coverage: overview.coverage,
          openQuestions: overview.openQuestions,
          constitutionVersion: overview.constitutionVersion,
          activeConstitutionRules: overview.activeConstitutionRules,
          contractCount: overview.contractCount,
          adrCount: overview.adrCount,
          openCcrs: overview.openCcrs,
        });
        return;
      }
      runtime.out(reportTitle(`Mission ${missionId}`));
      runtime.out(`  ${statusLine(overview.mission)}`);
      runtime.out(`  Goal: ${overview.mission.goal}`);
      if (overview.mission.specName !== undefined) {
        runtime.out(`  Spec: ${overview.mission.specName}`);
      }
      runtime.out(
        `  ${overview.activeConstitutionRules} constitution rule(s), ${overview.contractCount} contract(s), ` +
          `${overview.adrCount} ADR(s), ${overview.activeDecisionCount} active decision(s)`,
      );
      if (overview.coverage !== undefined && !overview.coverage.contractReady) {
        runtime.out(sectionTitle('Not contract-ready'));
        for (const reason of overview.coverage.reasons) runtime.out(warnLine(reason));
      }
      if (overview.openQuestions.length > 0) {
        runtime.out(sectionTitle('Open questions'));
        for (const question of overview.openQuestions) {
          const line = `${question.questionId} [${question.materiality}] ${question.question}`;
          runtime.out(question.materiality === 'blocking' ? blockedLine(line) : infoLine(line));
        }
        runtime.out(dim(`  Answer with: ${CLI_BIN} mission answer ${missionId} <questionId> <answer…>`));
      }
      if (overview.openCcrs.length > 0) {
        runtime.out(sectionTitle('Open contract change requests'));
        for (const ccr of overview.openCcrs) {
          runtime.out(blockedLine(`${ccr.ccrId} [${ccr.status}] ${ccr.contractId}: ${ccr.problem}`));
        }
        runtime.out(dim(`  Decide with: ${CLI_BIN} mission ccr ${missionId} <ccrId> --approve|--reject`));
      }
    });

  // ---------------------------------------------------------------------------
  // events / coverage
  // ---------------------------------------------------------------------------
  mission
    .command('events')
    .description('Append-only mission history, newest last')
    .argument('<missionId>')
    .option('--limit <n>', 'events to show', '30')
    .option('--json', 'output a machine-readable JSON report')
    .action((missionId: string, options: { limit: string; json?: boolean }) => {
      requireMissionState(runtime.workspace(), missionId);
      const page = readMissionEvents(runtime.workspace(), missionId, {
        limit: Number.parseInt(options.limit, 10) || 30,
      });
      if (options.json === true) {
        jsonOut(runtime, 'mission-events', { events: page.events, total: page.total, truncated: page.truncated });
        return;
      }
      runtime.out(reportTitle(`Mission events (${page.events.length} of ${page.total})`));
      for (const event of page.events) {
        runtime.out(`  ${dim(event.at)}  ${event.type}`);
      }
    });

  mission
    .command('coverage')
    .description('Deterministic discovery coverage: topics, gaps, and the CONTRACT_READY gate')
    .argument('<missionId>')
    .option('--json', 'output a machine-readable JSON report')
    .action((missionId: string, options: { json?: boolean }) => {
      requireMissionState(runtime.workspace(), missionId);
      const coverage = readCoverage(runtime.workspace(), missionId);
      if (options.json === true) {
        jsonOut(runtime, 'mission-coverage', { coverage: coverage ?? null });
        return;
      }
      if (coverage === undefined) {
        runtime.out(warnLine('No coverage snapshot exists yet; record discovery first.'));
        return;
      }
      runtime.out(reportTitle('Discovery coverage'));
      runtime.out(coverage.contractReady ? okLine('CONTRACT_READY gate: satisfied') : blockedLine('CONTRACT_READY gate: not satisfied'));
      for (const reason of coverage.reasons) runtime.out(dim(`  ${reason}`));
      runtime.out(sectionTitle('Topics'));
      for (const topic of coverage.topics) {
        if (topic.status === 'unknown' && !topic.required) continue;
        const label = `${topic.topicId}: ${topic.status}${topic.required ? ' (required)' : ''}`;
        runtime.out(topic.blocking ? blockedLine(label) : topic.status === 'resolved' || topic.status === 'not-applicable' ? okLine(label) : infoLine(label));
      }
    });

  // ---------------------------------------------------------------------------
  // answer / contract-ready / synthesize
  // ---------------------------------------------------------------------------
  mission
    .command('answer')
    .description('Answer an open discovery question (recorded as a user decision with provenance)')
    .argument('<missionId>')
    .argument('<questionId>')
    .argument('<answer...>')
    .action((missionId: string, questionId: string, answerWords: string[]) => {
      const result = answerQuestion(missionDeps(runtime), missionId, {
        questionId,
        answer: answerWords.join(' '),
      });
      runtime.out(okLine(`Recorded ${result.decision.decisionId} answering ${questionId}.`));
      runtime.out(
        result.coverage.contractReady
          ? okLine('The coverage gate is satisfied; the mission can reach CONTRACT_READY.')
          : dim(`  ${result.coverage.blockingQuestionIds.length} blocking question(s) remain.`),
      );
    });

  mission
    .command('contract-ready')
    .description('Move the mission to CONTRACT_READY (the deterministic coverage gate decides)')
    .argument('<missionId>')
    .action((missionId: string) => {
      const { mission: state } = markContractReady(missionDeps(runtime), missionId);
      runtime.out(okLine(`Mission ${state.missionId} is CONTRACT_READY.`));
      runtime.out(dim(`  Synthesize the spec with: ${CLI_BIN} mission synthesize ${missionId}`));
    });

  mission
    .command('synthesize')
    .description('Compile the contract set into Kiro spec candidates (requirements, design, objective tasks)')
    .argument('<missionId>')
    .option('--spec-name <name>', 'spec name (default: the mission name)')
    .option('--json', 'output a machine-readable JSON report')
    .action((missionId: string, options: { specName?: string; json?: boolean }) => {
      const result = synthesizeMissionSpec(missionDeps(runtime), missionId, {
        specName: options.specName,
      });
      if (options.json === true) {
        jsonOut(runtime, 'mission-synthesize', {
          specName: result.specName,
          objectiveCount: result.objectiveCount,
          files: result.files,
          provenance: result.provenance,
        });
        return;
      }
      runtime.out(okLine(`Synthesized spec "${result.specName}" with ${result.objectiveCount} objective(s).`));
      for (const file of result.files) runtime.out(dim(`  ${file.fileName} (${file.bytes} bytes)`));
      runtime.out(infoLine('Approval stays human:'));
      for (const stage of ['requirements', 'design', 'tasks']) {
        runtime.out(dim(`  ${CLI_BIN} spec approve ${result.specName} --stage ${stage}`));
      }
    });

  // ---------------------------------------------------------------------------
  // contracts / adr / ccr
  // ---------------------------------------------------------------------------
  mission
    .command('contracts')
    .description('The mission’s product contract registry (current revisions)')
    .argument('<missionId>')
    .option('--json', 'output a machine-readable JSON report')
    .action((missionId: string, options: { json?: boolean }) => {
      requireMissionState(runtime.workspace(), missionId);
      const registry = readContractRegistry(runtime.workspace(), missionId);
      const constitution = readConstitution(runtime.workspace(), missionId);
      if (options.json === true) {
        jsonOut(runtime, 'mission-contracts', { constitution: constitution ?? null, contracts: registry });
        return;
      }
      runtime.out(reportTitle('Architecture Constitution'));
      for (const rule of constitution?.rules ?? []) {
        if (rule.status !== 'active') continue;
        runtime.out(`  ${okLine(`${rule.ruleId} ${rule.statement}`)}`);
      }
      runtime.out(sectionTitle('Contract registry'));
      for (const contract of registry) {
        runtime.out(infoLine(`${contract.contractId} r${contract.revision} [${contract.classification}/${contract.compatibilityPolicy}] ${contract.title}`));
        for (const requirement of contract.requirements) {
          runtime.out(dim(`    ${requirement.requirementId}: ${requirement.statement}`));
        }
        for (const invariant of contract.invariants) {
          runtime.out(dim(`    ${invariant.invariantId} (invariant): ${invariant.statement}`));
        }
      }
    });

  mission
    .command('adr')
    .description('Architecture Decision Records (effective status derived, history immutable)')
    .argument('<missionId>')
    .argument('[adrId]')
    .option('--json', 'output a machine-readable JSON report')
    .action((missionId: string, adrId: string | undefined, options: { json?: boolean }) => {
      requireMissionState(runtime.workspace(), missionId);
      const adrs = readAdrs(runtime.workspace(), missionId).filter(
        (adr) => adrId === undefined || adr.adrId === adrId,
      );
      if (options.json === true) {
        jsonOut(runtime, 'mission-adr', { adrs });
        return;
      }
      for (const adr of adrs) {
        runtime.out(reportTitle(`${adr.adrId} ${adr.title} (${adr.status})`));
        runtime.out(`  Context: ${adr.context}`);
        runtime.out(`  Decision: ${adr.decision}`);
        runtime.out(`  Rationale: ${adr.rationale}`);
        if (adr.supersedes !== undefined) runtime.out(dim(`  Supersedes ${adr.supersedes}`));
      }
      if (adrs.length === 0) runtime.out(dim('  no ADRs recorded'));
    });

  mission
    .command('ccr')
    .description('Contract change requests: list, show, and record the HUMAN decision')
    .argument('<missionId>')
    .argument('[ccrId]')
    .option('--approve', 'approve the request and create the next contract revision (human decision)')
    .option('--reject', 'reject the request (human decision)')
    .option('--note <text>', 'decision note recorded with the human decision')
    .option('--json', 'output a machine-readable JSON report')
    .action(
      (
        missionId: string,
        ccrId: string | undefined,
        options: { approve?: boolean; reject?: boolean; note?: string; json?: boolean },
      ) => {
        const workspace = runtime.workspace();
        requireMissionState(workspace, missionId);
        if (options.approve === true || options.reject === true) {
          if (ccrId === undefined) {
            runtime.out(failLine('Deciding a change request needs its id.'));
            runtime.exitCode = 2;
            return;
          }
          const result = decideContractChangeRequest(missionDeps(runtime), missionId, {
            ccrId,
            decision: options.approve === true ? 'approved' : 'rejected',
            note: options.note,
          });
          if (result.ccr.status === 'APPROVED') {
            runtime.out(okLine(`${ccrId} approved; ${result.contract?.contractId} is now revision ${result.contract?.revision}.`));
            runtime.out(warnLine('Projections built against the previous revision are now stale; affected work replans on resume.'));
          } else {
            runtime.out(okLine(`${ccrId} rejected.`));
          }
          return;
        }
        const ccrs = readCcrs(workspace, missionId).filter((ccr) => ccrId === undefined || ccr.ccrId === ccrId);
        if (options.json === true) {
          jsonOut(runtime, 'mission-ccr', { ccrs });
          return;
        }
        for (const ccr of ccrs) {
          const line = `${ccr.ccrId} [${ccr.status}] ${ccr.contractId} r${ccr.contractRevision} — ${ccr.problem}`;
          runtime.out(ccr.status === 'NEEDS_HUMAN' || ccr.status === 'PROPOSED' ? blockedLine(line) : infoLine(line));
          runtime.out(dim(`    proposal: ${ccr.proposal}`));
          runtime.out(dim(`    raised by ${ccr.raisedBy}${ccr.originJobId !== undefined ? ` (job ${ccr.originJobId}, unit ${ccr.originWorkUnitId ?? '?'})` : ''}`));
        }
        if (ccrs.length === 0) runtime.out(dim('  no contract change requests'));
      },
    );

  // ---------------------------------------------------------------------------
  // reopen / abandon / decisions
  // ---------------------------------------------------------------------------
  mission
    .command('decisions')
    .description('Recorded discovery decisions with provenance')
    .argument('<missionId>')
    .option('--json', 'output a machine-readable JSON report')
    .action((missionId: string, options: { json?: boolean }) => {
      requireMissionState(runtime.workspace(), missionId);
      const decisions = readDecisions(runtime.workspace(), missionId);
      const questions = readQuestions(runtime.workspace(), missionId);
      if (options.json === true) {
        jsonOut(runtime, 'mission-decisions', { decisions, questions });
        return;
      }
      for (const decision of decisions) {
        const line = `${decision.decisionId} [${decision.status}] ${decision.decision}`;
        runtime.out(decision.status === 'active' ? okLine(line) : dim(line));
        runtime.out(dim(`    provenance: ${decision.provenance}${decision.sourceTurnId !== undefined ? ` (turn ${decision.sourceTurnId})` : ''}`));
      }
      if (decisions.length === 0) runtime.out(dim('  no decisions recorded'));
    });

  mission
    .command('reopen')
    .description('Reopen discovery after synthesis or approval (a material change surfaced)')
    .argument('<missionId>')
    .requiredOption('--reason <text>')
    .action((missionId: string, options: { reason: string }) => {
      const state = reopenDiscovery(missionDeps(runtime), missionId, options.reason);
      runtime.out(okLine(`Mission ${state.missionId} is ${state.status}.`));
    });

  mission
    .command('abandon')
    .description('Abandon a mission (final; the record stays readable)')
    .argument('<missionId>')
    .requiredOption('--reason <text>')
    .action((missionId: string, options: { reason: string }) => {
      const state = abandonMission(missionDeps(runtime), missionId, options.reason);
      runtime.out(okLine(`Mission ${state.missionId} is ${state.status}.`));
    });
}
