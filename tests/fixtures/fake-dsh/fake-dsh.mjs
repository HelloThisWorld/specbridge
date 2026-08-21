/**
 * Fake DeepSeek Harness SDK runtime for process-level integration tests.
 *
 * Spoken to by the REAL `@deepseek-ai/dsh-sdk-client` over stdio
 * newline-delimited JSON-RPC — the same wire the real `dsh-jsonrpc-agent`
 * runtime speaks: requests `initialize` / `session/prompt` / `shutdown`,
 * notifications `session.event` / `session.status` / `subagent.*`, and
 * session-log event envelopes {type, seq, time, data}. Fully offline: no
 * network, no model, no credentials.
 *
 * Configured via the profile command (executable = process.execPath,
 * args = [this file]) and environment:
 *
 *   FAKE_DSH_SCENARIO       success (default) | success-noedit | false-claim |
 *                           malformed-result | prose-wrapped | reasoning |
 *                           compaction | subagent | crash-mid-run | hang |
 *                           no-exit | wrong-identity | init-error | init-hang |
 *                           rpc-auth-error | rpc-rate-limit |
 *                           agentic-repair | agentic-explore | no-progress
 *   FAKE_DSH_EXTRA_EDIT_PATH  second file the agentic scenarios touch
 *                           (default src/fake-dsh-helper.txt)
 *   FAKE_DSH_PROMPT_LOG     when set, the received prompt is appended here
 *                           (prompt-shape assertions; never a credential)
 *   FAKE_DSH_SESSIONS_DIR   when set, session logs persist across processes
 *                           (<dir>/<sessionId>.json holds the next seq) —
 *                           the "runtime-managed persistence" emulation
 *   FAKE_DSH_EDIT_PATH      workspace-relative file the agent edits
 *                           (default src/fake-dsh-change.txt)
 *   FAKE_DSH_LOG            append-only JSONL log for argv/env assertions
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const scenario = process.env.FAKE_DSH_SCENARIO ?? 'success';
const sessionsDir = process.env.FAKE_DSH_SESSIONS_DIR;
const editPath = process.env.FAKE_DSH_EDIT_PATH ?? path.join('src', 'fake-dsh-change.txt');
const extraEditPath = process.env.FAKE_DSH_EXTRA_EDIT_PATH ?? path.join('src', 'fake-dsh-helper.txt');

function log(record) {
  const file = process.env.FAKE_DSH_LOG;
  if (file === undefined) return;
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

log({
  event: 'spawn',
  scenario,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  // NAMES only — the test asserts the allowlist boundary, never values.
  envNames: Object.keys(process.env).sort(),
});

// ---------------------------------------------------------------------------
// Newline-delimited JSON-RPC over stdio (mirrors the official transport).
// ---------------------------------------------------------------------------

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
}
const respond = (id, result) => send({ id, result });
const respondError = (id, code, message) => send({ id, error: { code, message } });
const notify = (method, params) => send({ method, params });

// ---------------------------------------------------------------------------
// Session-log emulation (seq continuity is what resume verification tests).
// ---------------------------------------------------------------------------

function sessionStatePath(sessionId) {
  return path.join(sessionsDir, `${sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function loadNextSeq(sessionId) {
  if (sessionsDir === undefined) return 0;
  const file = sessionStatePath(sessionId);
  if (!existsSync(file)) return 0;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return typeof state.nextSeq === 'number' ? state.nextSeq : 0;
  } catch {
    return 0;
  }
}

function saveNextSeq(sessionId, nextSeq) {
  if (sessionsDir === undefined) return;
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(sessionStatePath(sessionId), `${JSON.stringify({ nextSeq })}\n`, 'utf8');
}

let clock = Date.parse('2026-08-21T00:00:00.000Z');
let messageCounter = 0;

function makeEmitter(sessionId, startSeq) {
  let seq = startSeq;
  return {
    event(type, data, extra = {}) {
      notify('session.event', {
        sessionId,
        event: { type, seq: seq++, time: (clock += 1000), data, ...extra },
      });
    },
    get seq() {
      return seq;
    },
  };
}

function assistantReport(emit, report, { reasoning, turn } = {}) {
  const content = [];
  if (reasoning !== undefined) content.push({ type: 'reasoning', text: reasoning });
  content.push({ type: 'text', text: typeof report === 'string' ? report : JSON.stringify(report) });
  emit.event(
    'assistant/message',
    {
      turn,
      step: 1,
      message: {
        id: `m-${++messageCounter}`,
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'fake', model: 'fake-model' },
      },
      usage: { inputTokens: 1200, outputTokens: 180, cacheReadTokens: 300, reasoningTokens: reasoning !== undefined ? 64 : 0 },
    },
    { surfaceOp: 'append' },
  );
}

function performEdit(resumed) {
  const target = path.join(process.cwd(), editPath);
  mkdirSync(path.dirname(target), { recursive: true });
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : '';
  writeFileSync(target, `${previous}fake dsh implementation${resumed ? ' (resumed)' : ''}\n`, 'utf8');
}

function performExtraEdit(text) {
  const target = path.join(process.cwd(), extraEditPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${text}\n`, 'utf8');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runScenario(sessionId, messageId) {
  const startSeq = loadNextSeq(sessionId);
  const resumed = startSeq > 0;
  const emit = makeEmitter(sessionId, startSeq);
  const turn = resumed ? 2 : 1;
  const finish = (outcome = 'completed', reason = { kind: 'completed' }) => {
    emit.event('turn/end', { turn, reason });
    saveNextSeq(sessionId, emit.seq);
    notify('session.status', { sessionId, status: 'idle' });
    log({ event: 'run-finished', sessionId, scenario, outcome, nextSeq: emit.seq });
  };

  notify('session.status', { sessionId, status: 'running' });
  emit.event('agent/inbox/spliced', { inserted: [{ id: messageId }] });
  emit.event('turn/start', { turn });

  const report = {
    schemaVersion: '1.0.0',
    outcome: 'completed',
    summary: resumed ? 'Continued the task on the restored session.' : 'Implemented the task.',
    changedFiles: [editPath.replaceAll('\\', '/')],
    commandsReported: ['node --version'],
    testsReported: [{ name: 'fake-suite', status: 'passed' }],
    remainingRisks: [],
    blockingQuestions: [],
    recommendedNextActions: [],
  };

  switch (scenario) {
    case 'success':
    case 'resume':
    case 'reasoning':
    case 'compaction':
    case 'subagent': {
      if (scenario === 'resume') {
        // Yield before any agentic work: a client that rejects the resume
        // (seq-continuity guard) closes the runtime during this window, so
        // no work ever happens on wrong context — mirroring the latency any
        // real model turn would have.
        await sleep(250);
      }
      emit.event('tool/call', { turn, step: 1, callId: 'c-1', name: 'fs.apply_patch', arguments: JSON.stringify({ path: editPath }) });
      performEdit(resumed);
      emit.event(
        'tool/result',
        {
          turn,
          step: 1,
          message: {
            id: `m-${++messageCounter}`,
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'c-1', content: [{ type: 'text', text: 'edited' }] }],
            source: { kind: 'tool', callId: 'c-1' },
          },
        },
        { surfaceOp: 'append' },
      );
      emit.event('command/run', { turn, command: 'node --version' });
      emit.event('command/done', { turn, command: 'node --version', exitCode: 0 });
      if (scenario === 'reasoning') {
        emit.event('assistant/chunk', {
          turn,
          step: 1,
          chunk: { type: 'reasoning-delta', text: 'SECRET-REASONING-DELTA-DO-NOT-PERSIST' },
        });
      }
      if (scenario === 'compaction') {
        emit.event('compaction/start', { budget: 4096 });
        emit.event('compaction/summary', { summaryChars: 240 });
        emit.event(
          'compaction/end',
          { prunedEvents: 6 },
        );
      }
      if (scenario === 'subagent') {
        notify('subagent.started', { parentSessionId: sessionId, childSessionId: `${sessionId}-child` });
        const child = makeEmitter(`${sessionId}-child`, 0);
        child.event('turn/start', { turn: 1 });
        child.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
        notify('subagent.finished', {
          provider: 'local',
          agentId: `${sessionId}-child`,
          parentSessionId: sessionId,
          childSessionId: `${sessionId}-child`,
          status: 'ok',
          stopReason: 'completed',
        });
      }
      assistantReport(emit, report, {
        turn,
        reasoning: scenario === 'reasoning' ? 'SECRET-REASONING-DO-NOT-PERSIST: plan the edit' : 'brief private plan',
      });
      finish();
      return;
    }
    case 'agentic-explore':
    case 'agentic-repair': {
      // A real bounded agentic loop: read the repository, edit two files,
      // run the project's tests, SEE a failure, repair, re-run, report.
      // This is the shape vNext.4 exists to support — and every claim it
      // makes is still only a claim until SpecBridge verifies.
      emit.event('tool/call', { turn, step: 1, callId: 'c-1', name: 'fs.glob', arguments: JSON.stringify({ pattern: 'src/**' }) });
      emit.event('tool/result', {
        turn,
        step: 1,
        message: {
          id: `m-${++messageCounter}`,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c-1', content: [{ type: 'text', text: 'src/' }] }],
          source: { kind: 'tool', callId: 'c-1' },
        },
      }, { surfaceOp: 'append' });
      emit.event('tool/call', { turn, step: 2, callId: 'c-2', name: 'fs.read', arguments: JSON.stringify({ path: editPath }) });
      emit.event('tool/call', { turn, step: 3, callId: 'c-3', name: 'fs.apply_patch', arguments: JSON.stringify({ path: editPath }) });
      performEdit(resumed);
      emit.event('tool/call', { turn, step: 4, callId: 'c-4', name: 'fs.apply_patch', arguments: JSON.stringify({ path: extraEditPath }) });
      performExtraEdit('first attempt (incomplete)');
      emit.event('command/run', { turn, command: 'npm test' });
      emit.event('command/done', { turn, command: 'npm test', exitCode: 1 });
      // The agent reads its own failure and repairs — inside ONE SpecBridge
      // attempt. The attempt-level retry policy is not its to decide.
      emit.event('tool/call', { turn, step: 5, callId: 'c-5', name: 'fs.apply_patch', arguments: JSON.stringify({ path: extraEditPath }) });
      performExtraEdit('repaired helper implementation');
      emit.event('command/run', { turn, command: 'npm test' });
      emit.event('command/done', { turn, command: 'npm test', exitCode: 0 });
      assistantReport(
        emit,
        {
          ...report,
          summary: 'Explored the repository, implemented across two files, repaired a failing test.',
          changedFiles: [editPath.replaceAll('\\', '/'), extraEditPath.replaceAll('\\', '/')],
          commandsReported: ['npm test'],
          testsReported: [{ name: 'npm test', status: 'passed' }],
        },
        { turn },
      );
      finish();
      return;
    }
    case 'no-progress': {
      // The runtime works perfectly and the MODEL does not: it looks, it
      // thinks, it changes nothing, and it claims success. Local
      // intelligence insufficiency — the case that must eventually escalate
      // to the strong lane rather than loop for free forever.
      emit.event('tool/call', { turn, step: 1, callId: 'c-1', name: 'fs.read', arguments: JSON.stringify({ path: editPath }) });
      emit.event('command/run', { turn, command: 'npm test' });
      emit.event('command/done', { turn, command: 'npm test', exitCode: 1 });
      assistantReport(
        emit,
        { ...report, summary: 'I believe the task is already satisfied.', changedFiles: [], testsReported: [] },
        { turn },
      );
      finish();
      return;
    }
    case 'success-noedit': {
      assistantReport(emit, { ...report, outcome: 'no-change', summary: 'Nothing to change.', changedFiles: [] }, { turn });
      finish('no-change');
      return;
    }
    case 'false-claim': {
      // Claims a completed edit WITHOUT touching the repository: the
      // SpecBridge evidence pipeline must refuse to complete the task.
      emit.event('command/run', { turn, command: 'echo pretend' });
      emit.event('command/done', { turn, command: 'echo pretend', exitCode: 0 });
      assistantReport(emit, report, { turn });
      finish();
      return;
    }
    case 'malformed-result': {
      assistantReport(emit, '{"outcome": "completed", "summary": "unterminated', { turn });
      finish();
      return;
    }
    case 'prose-wrapped': {
      assistantReport(emit, `All done! Here is the report:\n${JSON.stringify(report)}\nHope that helps!`, { turn });
      finish();
      return;
    }
    case 'rpc-auth-error':
    case 'rpc-rate-limit':
      // Handled at the request layer; never reaches here.
      finish('failed', { kind: 'error', error: { message: 'unreachable', code: 'UNREACHABLE' } });
      return;
    case 'crash-mid-run': {
      emit.event('tool/call', { turn, step: 1, callId: 'c-1', name: 'fs.apply_patch', arguments: '{}' });
      process.stderr.write('fake-dsh: simulated runtime crash\n');
      process.exit(17);
      return;
    }
    case 'hang':
    case 'no-exit': {
      // Never idle: the SpecBridge watchdog must close the runtime.
      // ('no-exit' additionally ignores the stdin-EOF quiesce, forcing the
      // SDK teardown ladder to escalate to forced termination.)
      log({ event: 'hanging', sessionId });
      return;
    }
    default: {
      assistantReport(emit, report, { turn });
      finish();
    }
  }
}

// ---------------------------------------------------------------------------
// Request handling.
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    handleFrame(frame);
  }
});

process.stdin.on('end', () => {
  if (scenario === 'no-exit') {
    // Ignore the cooperative stdin-EOF quiesce: the SDK ladder must
    // escalate to forced termination, and cleanup must still be bounded.
    log({ event: 'ignoring-eof' });
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
});

function handleFrame(frame) {
  const { id, method, params } = frame;
  if (typeof method !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) return;
  log({ event: 'request', method, params: method === 'session/prompt' ? { sessionId: params?.sessionId } : params });
  switch (method) {
    case 'initialize': {
      if (scenario === 'init-hang') return;
      if (scenario === 'init-error') {
        respondError(id, -32000, 'fake runtime failed to compose its plugin graph');
        return;
      }
      respond(id, {
        serverInfo: {
          name: scenario === 'wrong-identity' ? 'some-other-agent-runtime' : 'deepseek-harness-sdk-runtime',
          version: '0.1.1-rc.1-fake',
        },
      });
      return;
    }
    case 'session/prompt': {
      if (scenario === 'rpc-auth-error') {
        respondError(id, -32001, 'unauthorized: the provider API key is invalid');
        return;
      }
      if (scenario === 'rpc-rate-limit') {
        respondError(id, -32029, 'rate limit exceeded (429): too many requests');
        return;
      }
      const sessionId = params?.sessionId ?? 'session-unknown';
      const promptLog = process.env.FAKE_DSH_PROMPT_LOG;
      if (promptLog !== undefined) {
        const blocks = params?.contentBlocks;
        const text = Array.isArray(blocks)
          ? blocks.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
          : JSON.stringify(params ?? {});
        appendFileSync(promptLog, `${JSON.stringify({ sessionId, prompt: text })}\n`, 'utf8');
      }
      const messageId = `msg-${++messageCounter}`;
      respond(id, { messageId });
      setImmediate(() => {
        void runScenario(sessionId, messageId);
      });
      return;
    }
    case 'shutdown': {
      respond(id, {});
      return;
    }
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
}
