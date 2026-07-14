/**
 * Fake Gemini CLI for process-level integration tests.
 *
 * Invoked as `node fake-gemini.mjs <args>` (configured via the gemini profile
 * command: executable = process.execPath, args = [this file]). The scenario
 * comes from the FAKE_GEMINI_SCENARIO environment variable; every headless
 * invocation can be recorded to FAKE_GEMINI_LOG for argv assertions. Fully
 * offline: no network, no model, no credentials.
 *
 * Emits the documented headless output shapes:
 *   --output-format json         one JSON envelope {response, stats}
 *   --output-format stream-json  JSONL events ending in {type:"result"}
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_GEMINI_SCENARIO ?? 'success';

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
// version / help probes
// ---------------------------------------------------------------------------

if (args.includes('--version')) {
  if (scenario === 'version-timeout') await sleepForever();
  process.stdout.write('0.9.9 (fake gemini)\n');
  process.exit(0);
}

if (args.includes('--help')) {
  const lines = ['Gemini CLI (fake)', '', 'Usage: gemini [options]', '', 'Options:'];
  const flag = (text) => lines.push(`  ${text}`);
  flag('--version                      Print version');
  if (scenario !== 'no-headless') {
    flag('-p, --prompt                   Run headless: read the prompt from stdin and print the result');
  }
  if (scenario !== 'no-json') {
    const formats = scenario === 'no-stream-json' ? 'text | json' : 'text | json | stream-json';
    flag(`-o, --output-format <format>   Output format: ${formats}`);
  }
  {
    const modes = [];
    if (scenario !== 'no-plan') modes.push('plan');
    modes.push('default');
    if (scenario !== 'no-auto-edit') modes.push('auto_edit');
    modes.push('yolo');
    flag(`--approval-mode <mode>         Approval mode: ${modes.join(' | ')}`);
  }
  if (scenario !== 'no-sandbox' && scenario !== 'unsafe-edit-policy') {
    flag('-s, --sandbox                  Run tools in a sandbox');
  }
  if (scenario !== 'no-allowed-tools' && scenario !== 'unsafe-edit-policy') {
    flag('--allowed-tools <tools>        Comma-separated list of tools the agent may use');
  }
  if (scenario !== 'no-extensions') {
    flag('-e, --extensions <list>        Extensions to enable ("none" disables all)');
  }
  flag('-m, --model <model>            Model override');
  if (scenario !== 'no-resume') {
    flag('--resume <session-id>          Resume a saved session by its UUID');
    flag('--list-sessions                List saved sessions');
  }
  flag('--yolo                         Auto-approve every action (DANGEROUS)');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

if (args.includes('--list-sessions')) {
  process.stdout.write(
    'aaaaaaaa-1111-2222-3333-444444444444  2026-07-01  settings work\n' +
      'bbbbbbbb-5555-6666-7777-888888888888  2026-07-02  bugfix session\n',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// headless execution
// ---------------------------------------------------------------------------

if (!args.includes('--prompt') && !args.includes('-p')) {
  // Interactive invocation: a real TUI would take over the terminal. The
  // fake hangs so any accidental interactive start fails tests via timeout.
  process.stderr.write('fake-gemini: starting interactive session (no --prompt given)\n');
  await sleepForever();
}

const outputFormat = argValue('--output-format') ?? argValue('-o') ?? 'text';
const approvalMode = argValue('--approval-mode') ?? 'default';
const allowedToolsRaw = argValue('--allowed-tools');
const allowedTools = allowedToolsRaw === undefined ? undefined : allowedToolsRaw.split(',');
const sandboxed = args.includes('--sandbox') || args.includes('-s');
const resumeSessionId = argValue('--resume');
const stdin = readFileSync(0, 'utf8');

if (process.env.FAKE_GEMINI_LOG) {
  appendFileSync(
    process.env.FAKE_GEMINI_LOG,
    `${JSON.stringify({
      argv: args,
      outputFormat,
      approvalMode,
      allowedTools: allowedTools ?? null,
      sandboxed,
      resumeSessionId: resumeSessionId ?? null,
      stdinBytes: Buffer.byteLength(stdin, 'utf8'),
    })}\n`,
    'utf8',
  );
}

if (scenario === 'exec-timeout') await sleepForever();

if (scenario === 'auth-error') {
  process.stderr.write('Error: please sign in — 401 unauthorized. Run gemini and complete the login flow.\n');
  process.exit(1);
}
if (scenario === 'permission-denied') {
  process.stderr.write('Error: tool call rejected: permission denied by approval policy\n');
  process.exit(1);
}
if (scenario === 'quota-exceeded') {
  process.stderr.write('Error: RESOURCE_EXHAUSTED: quota exceeded for this project\n');
  process.exit(1);
}
if (scenario === 'rate-limit') {
  process.stderr.write('Error: 429 too many requests: rate limit reached, slow down\n');
  process.exit(1);
}
if (scenario === 'nonzero-exit') {
  process.stderr.write('fake-gemini: simulated internal failure\n');
  process.exit(3);
}
if (scenario === 'huge-stdout') {
  try {
    const chunk = 'g'.repeat(64 * 1024);
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

if (resumeSessionId !== undefined && scenario === 'resume-missing-session') {
  process.stderr.write(`Error: no saved session with id ${resumeSessionId}\n`);
  process.exit(1);
}

const sessionId =
  scenario === 'resume-session-mismatch'
    ? 'ffffffff-0000-0000-0000-000000000000'
    : (resumeSessionId ?? 'aaaaaaaa-1111-2222-3333-444444444444');

const streaming = outputFormat === 'stream-json';
const events = [];
function emit(event) {
  if (streaming) process.stdout.write(`${JSON.stringify(event)}\n`);
  else events.push(event);
}

let usage = { input_tokens: 900, output_tokens: 210 };

function finish(finalResponse, exitCode = 0) {
  if (streaming) {
    emit({ type: 'usage', ...usage });
    if (finalResponse !== undefined) emit({ type: 'result', response: finalResponse });
  } else if (outputFormat === 'json') {
    if (finalResponse !== undefined) {
      process.stdout.write(
        `${JSON.stringify({ response: finalResponse, stats: { session_id: sessionId, ...usage } })}\n`,
      );
    }
  } else if (finalResponse !== undefined) {
    process.stdout.write(`${finalResponse}\n`);
  }
  process.exit(exitCode);
}

emit({ type: 'session.started', session_id: sessionId });
// Thought event: SpecBridge must never copy this text anywhere.
emit({ type: 'thought', text: 'GEMINI-REASONING-SECRET planning the work step by step' });

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
        'Requirements produced by the fake Gemini CLI for tests.',
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
        'Fake Gemini design overview.',
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
      return `# ${stage}\n\nFake Gemini content.\n`;
  }
}

if (stageMatch !== null) {
  // Authoring request. The fake honors the approval mode it was given: plan
  // means NO file writes (mirrors real approval enforcement). A rogue
  // scenario deliberately violates it to prove SpecBridge catches it.
  if (scenario === 'authoring-rogue-write') {
    // Unique content per invocation so every write is detectable.
    appendFileSync(
      path.join(process.cwd(), 'rogue-authoring-write.txt'),
      `rogue ${process.hrtime.bigint()}\n`,
      'utf8',
    );
  }
  if (scenario === 'malformed') finish('this is { not json at all');
  if (scenario === 'extra-prose') {
    finish(
      `Sure! Here is the document you asked for:\n\n{"schemaVersion":"1.0.0","stage":"${stageMatch[1]}","markdown":"# Doc","summary":"prose-wrapped"}\n\nHope this helps!`,
    );
  }
  if (scenario === 'missing-final') {
    if (streaming) emit({ type: 'usage', ...usage });
    process.exit(0);
  }
  const isCorrection = stdin.includes('previous response was not a valid structured result');
  if (scenario === 'correctable' && !isCorrection) {
    finish('not json on the first attempt');
  }
  const report = {
    schemaVersion: '1.0.0',
    stage: stageMatch[1],
    markdown: stageMarkdownFor(stageMatch[1]),
    summary: `Fake Gemini ${stageMatch[1]} generation${stdin.includes('Refinement instruction') ? ' (refinement)' : ''}.`,
    assumptions: [],
    openQuestions: [],
    referencedFiles: [],
  };
  finish(JSON.stringify(report));
}

// Task execution request.
const taskMatch = />>> IMPLEMENT THIS TASK ONLY: ([^\s]+)\./.exec(stdin);
const taskId = taskMatch?.[1] ?? 'unknown';

// The fake honors the edit boundary the way the real CLI would: edits are
// applied only when auto_edit is active AND an edit tool is permitted (an
// explicit allowlist including an edit tool, or no allowlist with a sandbox).
const editToolPermitted =
  allowedTools === undefined
    ? sandboxed
    : allowedTools.includes('replace') || allowedTools.includes('write_file');
const canWrite = approvalMode === 'auto_edit' && editToolPermitted;

if (scenario === 'shell-attempt') {
  // The agent asks for a shell tool; without YOLO the call is rejected.
  emit({ type: 'tool.started', name: 'run_shell_command', command: 'pnpm test' });
  emit({ type: 'tool.completed', name: 'run_shell_command', status: 'denied' });
}

let changedFiles = [];
if (canWrite && (scenario === 'success' || scenario === 'resume-ok' || scenario === 'claims-untested' || scenario === 'shell-attempt')) {
  const target = path.join(process.cwd(), 'src', 'fake-gemini-change.txt');
  let previous = '';
  try {
    previous = readFileSync(target, 'utf8');
  } catch {
    previous = '';
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${previous}fake gemini implementation of ${taskId}${resumeSessionId !== undefined ? ' (resumed)' : ''}\n`,
    'utf8',
  );
  emit({ type: 'tool.started', name: 'replace', path: 'src/fake-gemini-change.txt' });
  emit({ type: 'tool.completed', name: 'replace', status: 'success' });
  emit({ type: 'file.edited', path: 'src/fake-gemini-change.txt', kind: 'update' });
  changedFiles = ['src/fake-gemini-change.txt'];
}
if (canWrite && scenario === 'protected-write') {
  writeFileSync(path.join(process.cwd(), '.kiro', 'fake-gemini-rogue.txt'), 'rogue\n', 'utf8');
  changedFiles = ['.kiro/fake-gemini-rogue.txt'];
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
  if (streaming) emit({ type: 'usage', ...usage });
  process.exit(0);
}

const report = {
  schemaVersion: '1.0.0',
  outcome: scenario === 'reports-blocked' ? 'blocked' : 'completed',
  summary: `Fake Gemini execution of task ${taskId}${resumeSessionId !== undefined ? ' (resumed session)' : ''}.`,
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
