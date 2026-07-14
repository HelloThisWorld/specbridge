/**
 * Fake Antigravity CLI for process-level integration tests.
 *
 * Invoked as `node fake-antigravity.mjs <args>`. The scenario comes from the
 * FAKE_ANTIGRAVITY_SCENARIO environment variable; every invocation can be
 * recorded to FAKE_ANTIGRAVITY_LOG so tests can prove the adapter only ever
 * runs `--version` and `--help`. Fully offline; no network, no model.
 *
 * IMPORTANT: any invocation other than --version/--help HANGS, simulating an
 * interactive TUI taking over — the adapter must never reach that path.
 */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_ANTIGRAVITY_SCENARIO ?? 'interactive-only';

if (process.env.FAKE_ANTIGRAVITY_LOG) {
  appendFileSync(process.env.FAKE_ANTIGRAVITY_LOG, `${JSON.stringify({ argv: args })}\n`, 'utf8');
}

/** Block forever (until the parent kills us). */
function sleepForever() {
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}

if (args.includes('--version')) {
  if (scenario === 'interactive-hang') {
    // The build ignores --version and enters its interactive session.
    process.stderr.write('launching antigravity interactive session...\n');
    await sleepForever();
  }
  process.stdout.write('antigravity 0.3.1 (fake)\n');
  process.exit(0);
}

if (args.includes('--help')) {
  if (scenario === 'no-help') {
    process.stderr.write('unknown flag: --help\n');
    process.exit(64);
  }
  const lines = ['Antigravity (fake)', '', 'Usage: agy [options]', '', 'Options:'];
  lines.push('  --version                     Print version');
  if (scenario === 'headless-claimed' || scenario === 'documented-structured') {
    lines.push('  --prompt                      Run one prompt without the interactive session');
  }
  if (scenario === 'documented-structured') {
    lines.push('  --output-format <format>      Output format: text | json');
    lines.push('  --list-sessions               List saved sessions');
    lines.push('  --resume <session-id>         Resume a saved session');
  }
  if (scenario === 'interactive-only' || scenario === 'headless-claimed') {
    lines.push('');
    lines.push('Run agy without arguments to start the interactive TUI session.');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

// Anything else: the interactive TUI would take over the terminal. The fake
// hangs so any accidental automation attempt fails tests via timeout.
process.stderr.write('fake-antigravity: starting interactive TUI...\n');
await sleepForever();
