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
  if (scenario !== 'no-structured-output') flags.push('--json-schema <file>  constrain final output');
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
  if (scenario === 'structured-result') emitEnvelope({ structured_result: report });
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
if (scenario === 'structured-result') emitEnvelope({ structured_result: report });
else emitEnvelope({ result: JSON.stringify(report) });
process.exit(0);
