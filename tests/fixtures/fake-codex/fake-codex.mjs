/**
 * Fake Codex CLI for process-level integration tests.
 *
 * Invoked as `node fake-codex.mjs <args>` (configured via the codex profile
 * command: executable = process.execPath, args = [this file]). The scenario
 * comes from the FAKE_CODEX_SCENARIO environment variable; every invocation
 * can be recorded to FAKE_CODEX_LOG for argv assertions. Fully offline, no
 * network, no model.
 *
 * Emits the documented `codex exec --json` JSONL event stream:
 *   thread.started, turn.started, item.started/completed, turn.completed.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'success';

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

/** Block forever (until the parent kills us). */
function sleepForever() {
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}

function writeBlocking(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
}

// ---------------------------------------------------------------------------
// version / help / login probes
// ---------------------------------------------------------------------------

if (args.includes('--version')) {
  if (scenario === 'version-timeout') await sleepForever();
  process.stdout.write('codex-cli 9.9.9 (fake)\n');
  process.exit(0);
}

const isExec = args[0] === 'exec';

if (args.includes('--help')) {
  if (!isExec) {
    const commands = ['exec       Run Codex non-interactively'];
    if (scenario !== 'no-login-command') commands.push('login      Manage authentication (login status)');
    process.stdout.write(
      `Codex CLI (fake)\n\nUsage: codex [OPTIONS] [COMMAND]\n\nCommands:\n  ${commands.join('\n  ')}\n\nOptions:\n  --version  Print version\n  --help     Print help\n`,
    );
    process.exit(0);
  }
  const flags = [
    '--sandbox <MODE>              read-only | workspace-write | danger-full-access',
    '--model <MODEL>               model override',
    '-m, --cd <DIR>                working directory',
  ];
  if (scenario !== 'incompatible-version') flags.push('--json                        emit JSONL events');
  if (scenario !== 'no-output-schema') {
    flags.push('--output-schema <FILE>        JSON Schema for the final message');
  }
  if (scenario !== 'no-output-last-message') {
    flags.push('--output-last-message <FILE>  write the final agent message to a file');
  }
  if (scenario === 'no-workspace-write') {
    const index = flags.findIndex((line) => line.includes('--sandbox'));
    flags[index] = '--sandbox <MODE>              read-only';
  }
  const commands = scenario === 'no-resume' ? [] : ['resume     Resume a session by id: codex exec resume <SESSION_ID>'];
  process.stdout.write(
    `Run Codex non-interactively (fake)\n\nUsage: codex exec [OPTIONS] [PROMPT]\n\nCommands:\n  ${commands.join('\n  ')}\n\nOptions:\n  ${flags.join('\n  ')}\n`,
  );
  process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
  if (scenario === 'unauthenticated') {
    process.stderr.write('Not logged in. Run codex login.\n');
    process.exit(1);
  }
  // Deliberately includes a secret-looking value: SpecBridge must summarize
  // auth status, never echo this output.
  process.stdout.write('Logged in as fake-user\napi-key: sk-FAKE-CODEX-SECRET-99999\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// exec mode
// ---------------------------------------------------------------------------

if (!isExec) {
  process.stderr.write(`fake-codex: unsupported invocation: ${args.join(' ')}\n`);
  process.exit(64);
}

const resumed = args[1] === 'resume';
const resumeSessionId = resumed ? args[2] : undefined;
const sandbox = argValue('--sandbox') ?? 'read-only';
const outputSchemaPath = argValue('--output-schema');
const lastMessagePath = argValue('--output-last-message');
const stdin = args.includes('-') ? readFileSync(0, 'utf8') : '';

if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    `${JSON.stringify({
      argv: args,
      sandbox,
      stdinBytes: Buffer.byteLength(stdin, 'utf8'),
      outputSchemaExists: outputSchemaPath !== undefined && existsSync(outputSchemaPath),
    })}\n`,
    'utf8',
  );
}

if (resumed && scenario === 'resume-missing-session') {
  process.stderr.write(`session not found: ${resumeSessionId}\n`);
  process.exit(1);
}

const sessionId = resumeSessionId ?? 'fake-thread-0001';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function finish(finalMessage, exitCode = 0) {
  if (finalMessage !== undefined) {
    emit({ type: 'item.completed', item: { id: 'item_msg', type: 'agent_message', text: finalMessage } });
    if (lastMessagePath !== undefined) {
      mkdirSync(path.dirname(lastMessagePath), { recursive: true });
      writeFileSync(lastMessagePath, finalMessage, 'utf8');
    }
  }
  emit({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 250 },
  });
  process.exit(exitCode);
}

if (scenario === 'exec-timeout') await sleepForever();

if (scenario === 'auth-error') {
  process.stderr.write('ERROR: Not logged in (401 unauthorized). Run codex login.\n');
  process.exit(1);
}
if (scenario === 'permission-denied') {
  emit({ type: 'thread.started', thread_id: sessionId });
  process.stderr.write('ERROR: approval denied: permission denied by sandbox policy\n');
  process.exit(1);
}
if (scenario === 'sandbox-unavailable') {
  process.stderr.write('ERROR: sandbox unavailable: landlock is not supported on this system\n');
  process.exit(1);
}
if (scenario === 'quota-exceeded') {
  process.stderr.write('ERROR: insufficient_quota: your usage limit has been reached\n');
  process.exit(1);
}
if (scenario === 'rate-limit') {
  process.stderr.write('ERROR: 429 Too Many Requests: rate limit exceeded\n');
  process.exit(1);
}
if (scenario === 'nonzero-exit') {
  process.stderr.write('fake-codex: simulated internal failure\n');
  process.exit(3);
}
if (scenario === 'huge-stdout') {
  try {
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 400; i += 1) writeBlocking(1, chunk);
  } catch {
    process.exit(1); // EPIPE: the parent enforced its output limit
  }
  process.exit(0);
}
if (scenario === 'huge-stderr') {
  try {
    const chunk = 'e'.repeat(64 * 1024);
    for (let i = 0; i < 100; i += 1) writeBlocking(2, chunk);
  } catch {
    process.exit(1);
  }
  process.exit(0);
}

emit({ type: 'thread.started', thread_id: sessionId });
emit({ type: 'turn.started' });
// Reasoning item: SpecBridge must never copy this text anywhere.
emit({
  type: 'item.completed',
  item: { id: 'item_r', type: 'reasoning', text: 'REASONING-SECRET-DO-NOT-EXPOSE thinking about the task' },
});

const stageMatch = /Stage to produce: (\w+)/.exec(stdin);

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
        'Requirements produced by the fake Codex CLI for tests.',
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
        'Fake Codex design overview.',
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
      return `# ${stage}\n\nFake Codex content.\n`;
  }
}

if (stageMatch !== null) {
  // Authoring request. The fake honors the sandbox it was given: read-only
  // means NO file writes (mirrors real Codex sandbox enforcement). A rogue
  // scenario deliberately violates it to prove SpecBridge catches it.
  if (scenario === 'authoring-rogue-write') {
    writeFileSync(path.join(process.cwd(), 'rogue-authoring-write.txt'), 'rogue\n', 'utf8');
  }
  if (scenario === 'malformed') finish('this is { not json at all');
  if (scenario === 'extra-prose') {
    finish(
      `Here is the result you asked for:\n\n{"schemaVersion":"1.0.0","stage":"${stageMatch[1]}","markdown":"# Doc","summary":"prose-wrapped"}\n\nLet me know if you need more!`,
    );
  }
  if (scenario === 'missing-final') {
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
    process.exit(0);
  }
  const report = {
    schemaVersion: '1.0.0',
    stage: stageMatch[1],
    markdown: stageMarkdownFor(stageMatch[1]),
    summary: `Fake Codex ${stageMatch[1]} generation${stdin.includes('Refinement instruction') ? ' (refinement)' : ''}.`,
    assumptions: [],
    openQuestions: [],
    referencedFiles: scenario === 'escape-paths' ? ['../outside.txt', '/etc/passwd', 'src/ok.txt'] : [],
  };
  finish(JSON.stringify(report));
}

// Task execution request.
const taskMatch = />>> IMPLEMENT THIS TASK ONLY: ([^\s]+)\./.exec(stdin);
const taskId = taskMatch?.[1] ?? 'unknown';

let changedFiles = [];
const canWrite = sandbox === 'workspace-write';
if (canWrite && (scenario === 'success' || scenario === 'resume-ok' || scenario === 'claims-untested')) {
  const target = path.join(process.cwd(), 'src', 'fake-codex-change.txt');
  let previous = '';
  try {
    previous = readFileSync(target, 'utf8');
  } catch {
    previous = '';
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${previous}fake codex implementation of ${taskId}${resumed ? ' (resumed)' : ''}\n`, 'utf8');
  emit({
    type: 'item.started',
    item: { id: 'item_c', type: 'command_execution', command: 'apply_patch src/fake-codex-change.txt', status: 'in_progress' },
  });
  emit({
    type: 'item.completed',
    item: { id: 'item_c', type: 'command_execution', command: 'apply_patch src/fake-codex-change.txt', exit_code: 0, status: 'completed' },
  });
  emit({
    type: 'item.completed',
    item: { id: 'item_f', type: 'file_change', status: 'completed', changes: [{ path: 'src/fake-codex-change.txt', kind: 'update' }] },
  });
  changedFiles = ['src/fake-codex-change.txt'];
}
if (canWrite && scenario === 'protected-write') {
  writeFileSync(path.join(process.cwd(), '.kiro', 'fake-codex-rogue.txt'), 'rogue\n', 'utf8');
  changedFiles = ['.kiro/fake-codex-rogue.txt'];
}
if (canWrite && scenario === 'kiro-tasks-write') {
  const specMatch = /Spec: ([A-Za-z0-9._-]+)/.exec(stdin);
  const tasksPath = path.join(process.cwd(), '.kiro', 'specs', specMatch?.[1] ?? 'unknown', 'tasks.md');
  if (existsSync(tasksPath)) {
    writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8').replace('- [ ]', '- [x]'), 'utf8');
    changedFiles = ['tasks.md'];
  }
}

if (scenario === 'malformed') finish('this is { not json at all');
if (scenario === 'extra-prose') {
  finish(`Done! Here's my report:\n{"schemaVersion":"1.0.0","outcome":"completed","summary":"prose-wrapped"}`);
}
if (scenario === 'missing-final') {
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
  process.exit(0);
}

const report = {
  schemaVersion: '1.0.0',
  outcome: scenario === 'reports-blocked' ? 'blocked' : 'completed',
  summary: `Fake Codex execution of task ${taskId}${resumed ? ' (resumed session)' : ''}.`,
  changedFiles,
  commandsReported: scenario === 'claims-untested' ? ['pnpm test'] : [],
  testsReported:
    scenario === 'claims-untested'
      ? [{ name: 'unit tests (claimed, never executed)', status: 'passed' }]
      : [],
  remainingRisks: [],
  blockingQuestions: scenario === 'reports-blocked' ? ['Which storage backend?'] : [],
  recommendedNextActions: [],
};
finish(JSON.stringify(report));
