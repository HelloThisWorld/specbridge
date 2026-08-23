/**
 * Fake Claude Code CLI for process-level integration tests.
 *
 * Invoked as `node fake-claude.mjs <args>` (configured via
 * runners.claude-code.command = process.execPath, commandArgs = [this file]).
 * The scenario comes from the FAKE_CLAUDE_SCENARIO environment variable
 * (inherited by the child process); every invocation can be recorded to
 * FAKE_CLAUDE_LOG for argv assertions. Fully offline, no network, no model.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv: args })}\n`, 'utf8');
}

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

/** Block forever (until the parent kills us) via a never-resolving await. */
function sleepForever() {
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}

// ---------------------------------------------------------------------------
// version / help / auth probes
// ---------------------------------------------------------------------------

if (args.includes('--version') && !args.includes('-p') && !args.includes('--print')) {
  if (scenario === 'version-timeout') await sleepForever();
  process.stdout.write('9.9.9 (Fake Claude Code)\n');
  process.exit(0);
}

if (args.includes('--help')) {
  const flags = [
    '-p, --print                    non-interactive print mode',
    '--output-format <format>       text | json | stream-json',
    '--max-turns <n>                maximum agent turns',
    '--permission-mode <mode>       default | acceptEdits | plan',
    '--allowedTools <tools>         restrict tools',
    '--model <model>                model override',
    '--effort <effort>              reasoning effort',
    '--max-budget-usd <usd>         budget limit',
    '--setting-sources <sources>    configuration sources',
  ];
  if (scenario !== 'no-structured-output')
    flags.push('--json-schema <schema>  JSON Schema for structured output validation');
  if (scenario !== 'no-resume') {
    flags.push('--session-id <uuid>   session id');
    flags.push('--resume <uuid>       resume a session');
  }
  if (scenario === 'missing-required-capability') {
    // Simulate an old CLI without tool restrictions.
    const index = flags.findIndex((line) => line.includes('--allowedTools'));
    flags.splice(index, 1);
  }
  process.stdout.write(
    `Usage: claude [options] [prompt]\n\nOptions:\n  ${flags.join('\n  ')}\n\nCommands:\n  auth   manage authentication\n`,
  );
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  if (scenario === 'unauthenticated') {
    process.stderr.write('Not authenticated. Run claude auth login.\n');
    process.exit(1);
  }
  // Deliberately includes a secret-looking value: SpecBridge must summarize
  // auth status, never echo this output.
  process.stdout.write('Authenticated as fake-user\ntoken: oauth-FAKE-SECRET-VALUE-12345\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// print-mode execution
// ---------------------------------------------------------------------------

if (!args.includes('-p') && !args.includes('--print')) {
  process.stderr.write(`fake-claude: unsupported invocation: ${args.join(' ')}\n`);
  process.exit(64);
}

const stdin = readFileSync(0, 'utf8');
const sessionId = argValue('--resume') ?? argValue('--session-id') ?? 'fake-session-0000';
const resumed = args.includes('--resume');

function emitEnvelope(fields) {
  process.stdout.write(`${JSON.stringify({ type: 'result', session_id: sessionId, ...fields })}\n`);
}

function stageMarkdownFor(stage) {
  if (scenario === 'stage-invalid') {
    return '# Requirements Document\n\nAs a <role>, I want <capability>, so that <benefit>.\n';
  }
  switch (stage) {
    case 'requirements':
      return [
        '# Requirements Document',
        '',
        '## Introduction',
        '',
        'Requirements produced by the fake Claude CLI for tests.',
        '',
        '## Requirements',
        '',
        '### Requirement 1: Persist settings',
        '',
        '**User Story:** As a user, I want settings saved, so that they survive restarts.',
        '',
        '#### Acceptance Criteria',
        '',
        '1. WHEN the user saves a setting, THE SYSTEM SHALL persist it before confirming success.',
        '2. IF the persistence layer is unavailable, THEN THE SYSTEM SHALL report an error and keep the previous value.',
        '',
        '## Out of Scope',
        '',
        '- Cross-device synchronization is excluded.',
        '',
        '## Non-Functional Requirements',
        '',
        '- Saving SHALL complete within 200 ms on the reference environment.',
        '',
      ].join('\n');
    case 'design':
      return [
        '# Design Document',
        '',
        '## Overview',
        '',
        'Fake design overview.',
        '',
        '## Architecture',
        '',
        'A settings store module behind the service interface.',
        '',
        '## Components and Interfaces',
        '',
        '- Settings store with read and write operations.',
        '',
        '## Error Handling',
        '',
        'Typed errors; previous value preserved.',
        '',
        '## Security Considerations',
        '',
        'Input validation before persistence.',
        '',
        '## Testing Strategy',
        '',
        'Unit and integration tests.',
        '',
        '## Risks and Trade-offs',
        '',
        '- File-backed store favors simplicity.',
        '',
      ].join('\n');
    default:
      return `# ${stage}\n\nFake content.\n`;
  }
}

const stageMatch = /Stage to produce: (\w+)/.exec(stdin);
const roleMatch = /SpecBridge orchestration role: (\w+)/.exec(stdin);

// Mirror the real CLI contract: --json-schema takes the schema itself. A
// filesystem path (the historical SpecBridge defect) fails here exactly as
// Claude Code fails, with the diagnostic on stderr and no stdout envelope.
const schemaArg = argValue('--json-schema');
if (schemaArg !== undefined) {
  try {
    JSON.parse(schemaArg);
  } catch (error) {
    process.stderr.write(`Error: --json-schema is not valid JSON: ${error.message}
`);
    process.exit(1);
  }
}

if (scenario === 'exec-timeout') await sleepForever();

if (scenario === 'malformed') {
  process.stdout.write('this is { not json at all\n');
  process.exit(0);
}

if (scenario === 'nonzero-exit') {
  process.stderr.write('fake-claude: simulated internal failure\n');
  process.exit(3);
}

if (scenario === 'permission-denied') {
  emitEnvelope({ subtype: 'error_permission_denied', is_error: true });
  process.exit(1);
}

// The huge-output scenarios must deliver their bytes DETERMINISTICALLY:
// process.stdout.write queues asynchronously and process.exit discards the
// queue, so on some platforms the child could exit having flushed less than
// the parent's limit. Blocking writeSync either delivers everything or hits
// EPIPE when the parent stops reading at its limit — both deterministic.
function writeBlocking(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
}

if (scenario === 'huge-stdout') {
  try {
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 400; i += 1) writeBlocking(1, chunk);
    writeBlocking(1, `${JSON.stringify({ type: 'result', session_id: sessionId, result: '{}' })}\n`);
  } catch {
    process.exit(1); // EPIPE: the parent enforced its output limit
  }
  process.exit(0);
}

if (scenario === 'huge-stderr') {
  try {
    const chunk = 'e'.repeat(64 * 1024);
    for (let i = 0; i < 100; i += 1) writeBlocking(2, chunk);
    writeBlocking(1, `${JSON.stringify({ type: 'result', session_id: sessionId, result: '{}' })}\n`);
  } catch {
    process.exit(1); // EPIPE: the parent enforced its output limit
  }
  process.exit(0);
}

if (scenario === 'error-envelope') {
  emitEnvelope({ subtype: 'error_max_turns', is_error: true });
  process.exit(0);
}

if (roleMatch !== null && roleMatch[1] === 'BUILDER') {
  // Objective builder: writes into the CURRENT WORKING DIRECTORY (the
  // isolated worktree) and returns a structured BUILDER claim. Scenarios:
  //   builder-conflict  adds a nextState field (trips the contract guard)
  //   builder-ccr       reports a missing-nack contract change request
  //   builder-blocked   returns BLOCKED with a question, writes nothing
  //   builder-noop      claims completion but changes nothing
  //   (default)         writes into the first declared expected area
  const areaMatch = /Expected source areas: ([^\n]+)/.exec(stdin);
  const area = areaMatch?.[1]?.split(',')[0]?.trim() ?? 'src';
  const unitMatch = /Work unit: ([^\n]+)/.exec(stdin);
  const unitTitle = unitMatch?.[1]?.trim() ?? 'work unit';
  const isInvestigation = /\nKind: investigation\n/.test(stdin);
  const builderReport = {
    outcome: 'CANDIDATE_COMPLETE',
    summary: `Implemented ${unitTitle}.`,
    changedFiles: [],
    assumptionsDiscovered: [],
    contractChangeRequests: [],
    knownLimitations: [],
    blockingQuestions: [],
  };
  if (isInvestigation) {
    builderReport.summary = `Investigated ${unitTitle}.`;
    builderReport.report = `Findings for ${unitTitle}: the broker supports the required at-least-once semantics; nack requires a requeue policy.`;
    emitEnvelope({ result: JSON.stringify(builderReport) });
    process.exit(0);
  }
  if (scenario === 'builder-blocked') {
    builderReport.outcome = 'BLOCKED';
    builderReport.summary = 'The contracts do not say how duplicates are keyed.';
    builderReport.blockingQuestions = ['Which field is the idempotency key of an action result?'];
  } else if (scenario !== 'builder-noop') {
    const target = path.join(process.cwd(), area, 'implementation.js');
    mkdirSync(path.dirname(target), { recursive: true });
    const conflictLine = scenario === 'builder-conflict' ? '  nextState: "shipped", // action decides the transition\n' : '';
    writeFileSync(
      target,
      `// fake builder implementation of ${unitTitle}\nmodule.exports = {\n  actionId: "a-1",\n${conflictLine}};\n`,
      'utf8',
    );
    builderReport.changedFiles = [`${area}/implementation.js`];
    if (scenario === 'builder-ccr') {
      const contractMatch = /Contract (CTR-\d+)/.exec(stdin);
      builderReport.contractChangeRequests = [
        {
          contractId: contractMatch?.[1] ?? 'CTR-001',
          problem: 'The current contract cannot represent negative acknowledgement.',
          proposal: 'Add nack(message, requeuePolicy) to the transport SPI.',
        },
      ];
    }
  }
  emitEnvelope({ result: JSON.stringify(builderReport) });
  process.exit(0);
}

if (roleMatch !== null) {
  // v1.2 orchestration reasoning role (read-only tools, structured output).
  const role = roleMatch[1];
  if (scenario === 'role-invalid') {
    emitEnvelope({ result: 'I would suggest planning carefully!' });
    process.exit(0);
  }
  const ROLE_RESPONSES = {
    CLASSIFIER: { complexity: 'HIGH', reasons: ['architecture-sensitive work'] },
    PLANNER: {
      decision: 'PLAN',
      goal: 'Implement the approved task with architectural care.',
      steps: [
        { id: '1', action: 'Study the existing architecture and constraints.' },
        { id: '2', action: 'Implement the change behind the existing interfaces.' },
        { id: '3', action: 'Add tests covering the acceptance criteria.' },
      ],
      testStrategy: 'Unit plus integration tests.',
      verificationStrategy: 'Run the configured trusted verification commands.',
      assumptions: [],
      risks: [],
      requiresEscalation: false,
    },
    CRITIC: { verdict: 'ACCEPT', reasons: ['plan is sound'] },
    DIAGNOSER: {
      category: 'IMPLEMENTATION_DEFECT',
      rootCause: 'Deep-dive: the failure originates in the save path.',
      planValidity: 'VALID',
      recommendedAction: 'REPAIR',
      evidence: ['failing verifier output'],
    },
    REPLANNER: {
      decision: 'REVISED_PLAN',
      reason: 'The prior strategy conflicted with the observed architecture.',
      goal: 'Implement via the existing extension point instead.',
      steps: [{ id: '1', action: 'Use the existing extension point.' }],
      assumptions: [],
      impactsApprovedIntent: false,
    },
    DECOMPOSER:
      scenario === 'objective-investigations' || scenario === 'aggregator-conflict'
        ? {
            decision: 'WORK_GRAPH',
            reason: 'Two broker investigations feed one transport implementation.',
            units: [
              {
                id: 'kafka',
                kind: 'investigation',
                title: 'Kafka semantics investigation',
                goal: 'Investigate whether Kafka supports the required delivery semantics.',
                dependsOn: [],
                expectedArtifacts: ['report'],
                relevantContractIds: [],
                expectedAreas: [],
              },
              {
                id: 'rabbit',
                kind: 'investigation',
                title: 'RabbitMQ semantics investigation',
                goal: 'Investigate whether RabbitMQ supports the required delivery semantics.',
                dependsOn: [],
                expectedArtifacts: ['report'],
                relevantContractIds: [],
                expectedAreas: [],
              },
              {
                id: 'transport',
                kind: 'build',
                title: 'Transport implementation',
                goal: 'Implement the transport seam informed by the investigations.',
                dependsOn: ['kafka', 'rabbit'],
                expectedArtifacts: ['src/transport/implementation.js'],
                relevantContractIds: [],
                expectedAreas: ['src/transport'],
              },
            ],
          }
        : scenario === 'objective-multi'
        ? {
            decision: 'WORK_GRAPH',
            reason: 'The protocol and the transport are independently buildable.',
            units: [
              {
                id: 'envelope',
                kind: 'build',
                title: 'Canonical message envelope',
                goal: 'Implement the canonical message envelope.',
                dependsOn: [],
                expectedArtifacts: ['src/envelope/implementation.js'],
                relevantContractIds: [],
                expectedAreas: ['src/envelope'],
              },
              {
                id: 'transport',
                kind: 'build',
                title: 'Transport adapter seam',
                goal: 'Implement the transport adapter seam.',
                dependsOn: [],
                expectedArtifacts: ['src/transport/implementation.js'],
                relevantContractIds: [],
                expectedAreas: ['src/transport'],
              },
              {
                id: 'integrate',
                kind: 'integration',
                title: 'Integration',
                goal: 'Integrate the verified candidates.',
                dependsOn: ['envelope', 'transport'],
                expectedArtifacts: [],
                relevantContractIds: [],
                expectedAreas: [],
              },
            ],
          }
        : {
            decision: 'SINGLE_UNIT',
            reason: 'The objective is cohesive enough to implement as one unit.',
            units: [],
          },
    EVALUATOR:
      scenario === 'evaluator-fail'
        ? {
            verdict: 'FAIL',
            reasons: ['the candidate does not satisfy requirement R1'],
            evidenceRefs: ['R1'],
            affectedContractIds: [],
          }
        : scenario === 'evaluator-needs-decision'
          ? {
              verdict: 'NEEDS_DECISION',
              reasons: ['the approved truth leaves the retention window open'],
              evidenceRefs: [],
              affectedContractIds: [],
              decisionKind: 'product-behavior-change',
            }
          : { verdict: 'PASS', reasons: ['the candidate satisfies the projected contracts'], evidenceRefs: [], affectedContractIds: [] },
    AGGREGATOR:
      scenario === 'aggregator-conflict'
        ? {
            synthesis: 'The investigations disagree about redelivery ownership.',
            findings: [
              { sourceWorkUnitId: 'wu-1', finding: 'Kafka: the engine must own redelivery.' },
              { sourceWorkUnitId: 'wu-2', finding: 'RabbitMQ: the broker owns redelivery.' },
            ],
            contractChangeSuggestions: [],
            conflictsDetected: [
              {
                contractId: 'CTR-001',
                claims: [
                  { sourceWorkUnitId: 'wu-1', claim: 'The engine must own redelivery.' },
                  { sourceWorkUnitId: 'wu-2', claim: 'The broker owns redelivery.' },
                ],
              },
            ],
          }
        : {
            synthesis: 'Both investigations agree on an at-least-once transport with idempotent completion.',
            findings: [{ sourceWorkUnitId: 'wu-1', finding: 'Kafka supports the required semantics natively.' }],
            contractChangeSuggestions: [],
            conflictsDetected: [],
          },
  };
  const roleReport = ROLE_RESPONSES[role] ?? ROLE_RESPONSES.PLANNER;
  if (scenario === 'structured-output') emitEnvelope({ structured_output: roleReport });
  else if (scenario === 'structured-result') emitEnvelope({ structured_result: roleReport });
  else emitEnvelope({ result: JSON.stringify(roleReport) });
  process.exit(0);
}

if (stageMatch !== null) {
  // Stage generation request.
  const stage = stageMatch[1];
  const report = {
    schemaVersion: '1.0.0',
    stage,
    markdown: stageMarkdownFor(stage),
    summary: `Fake ${stage} generation.`,
    assumptions: [],
    openQuestions: [],
    referencedFiles: scenario === 'escape-paths' ? ['../outside.txt', '/etc/passwd', 'src/ok.txt'] : [],
  };
  if (scenario === 'structured-output') emitEnvelope({ structured_output: report });
  else if (scenario === 'structured-result') emitEnvelope({ structured_result: report });
  else emitEnvelope({ result: JSON.stringify(report) });
  process.exit(0);
}

// Task execution request.
const taskMatch = />>> IMPLEMENT THIS TASK ONLY: ([^\s]+)\./.exec(stdin);
const taskId = taskMatch?.[1] ?? 'unknown';

let changedFiles = [];
if (scenario === 'write-file' || scenario === 'resume-ok' || scenario === 'success') {
  const target = path.join(process.cwd(), 'src', 'fake-claude-change.txt');
  let previous = '';
  try {
    previous = readFileSync(target, 'utf8');
  } catch {
    previous = '';
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${previous}fake implementation of ${taskId}${resumed ? ' (resumed)' : ''}\n`, 'utf8');
  changedFiles = ['src/fake-claude-change.txt'];
}
if (scenario === 'protected-write') {
  writeFileSync(path.join(process.cwd(), '.kiro', 'fake-rogue.txt'), 'rogue\n', 'utf8');
  changedFiles = ['.kiro/fake-rogue.txt'];
}

const report = {
  schemaVersion: '1.0.0',
  outcome: scenario === 'reports-blocked' ? 'blocked' : 'completed',
  summary: `Fake execution of task ${taskId}${resumed ? ' (resumed session)' : ''}.`,
  changedFiles,
  commandsReported: [],
  testsReported: [],
  remainingRisks: [],
  blockingQuestions: scenario === 'reports-blocked' ? ['What storage backend?'] : [],
  recommendedNextActions: [],
};
if (scenario === 'structured-output') emitEnvelope({ structured_output: report });
else if (scenario === 'structured-result') emitEnvelope({ structured_result: report });
else emitEnvelope({ result: JSON.stringify(report) });
process.exit(0);
