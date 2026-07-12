import { Command, CommanderError } from 'commander';
import { CLI_BIN, PRODUCT_NAME, isSpecBridgeError } from '@specbridge/core';
import { dim } from '@specbridge/reporting';
import type { CliIo } from './context.js';
import { CliRuntime, defaultIo } from './context.js';
import { VERSION } from './version.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerSteeringListCommand } from './commands/steering-list.js';
import { registerSteeringShowCommand } from './commands/steering-show.js';
import { registerSpecListCommand } from './commands/spec-list.js';
import { registerSpecShowCommand } from './commands/spec-show.js';
import { registerSpecContextCommand } from './commands/spec-context.js';
import { registerSpecNewCommand } from './commands/spec-new.js';
import { registerSpecAnalyzeCommand } from './commands/spec-analyze.js';
import { registerSpecApproveCommand } from './commands/spec-approve.js';
import { registerSpecStatusCommand } from './commands/spec-status.js';
import { registerSpecSyncCommand } from './commands/spec-sync.js';
import { registerSpecRunCommand } from './commands/spec-run.js';
import { registerSpecVerifyCommand } from './commands/spec-verify.js';
import { registerSpecAffectedCommand } from './commands/spec-affected.js';
import { registerSpecPolicyCommand } from './commands/spec-policy.js';
import { registerVerifyRuleCommands } from './commands/verify-rules.js';
import { registerSpecExportCommand } from './commands/spec-export.js';
import { registerSpecGenerateCommand } from './commands/spec-generate.js';
import { registerSpecRefineCommand } from './commands/spec-refine.js';
import { registerSpecAcceptTaskCommand } from './commands/spec-accept-task.js';
import { registerRunnerCommands } from './commands/runner.js';
import { registerRunCommands } from './commands/run.js';
import { registerCompatCheckCommand } from './commands/compat-check.js';

function buildProgram(runtime: CliRuntime): Command {
  const program = new Command();
  program
    .name(CLI_BIN)
    .description(
      `${PRODUCT_NAME} — an open, model-agnostic spec runtime for existing Kiro projects.\n` +
        'Your .kiro directory stays the source of truth: no conversion, no duplicated specs, no lock-in.',
    )
    .version(VERSION, '-V, --version', 'print the version')
    .option('-C, --cwd <dir>', 'run as if started from <dir>')
    .addHelpText(
      'after',
      `
Quick start (inside a project containing .kiro/):
  ${CLI_BIN} doctor                     check the workspace, read-only
  ${CLI_BIN} spec list                  list existing specs
  ${CLI_BIN} spec context <name>        build agent-ready context
  ${CLI_BIN} compat check               prove byte-identical round trips

Commands marked "(planned)" are documented on the roadmap and exit with an
honest error; nothing pretends to work before it does.`,
    );

  program.hook('preAction', () => {
    const cwd = program.opts<{ cwd?: string }>().cwd;
    if (cwd !== undefined) runtime.setCwdOverride(cwd);
  });

  registerDoctorCommand(program, runtime);

  const steering = program.command('steering').description('Work with .kiro/steering files');
  registerSteeringListCommand(steering, runtime);
  registerSteeringShowCommand(steering, runtime);

  const spec = program.command('spec').description('Work with .kiro/specs');
  registerSpecListCommand(spec, runtime);
  registerSpecShowCommand(spec, runtime);
  registerSpecContextCommand(spec, runtime);
  registerSpecNewCommand(spec, runtime);
  registerSpecAnalyzeCommand(spec, runtime);
  registerSpecApproveCommand(spec, runtime);
  registerSpecStatusCommand(spec, runtime);
  registerSpecGenerateCommand(spec, runtime);
  registerSpecRefineCommand(spec, runtime);
  registerSpecRunCommand(spec, runtime);
  registerSpecAcceptTaskCommand(spec, runtime);
  registerSpecSyncCommand(spec, runtime);
  registerSpecVerifyCommand(spec, runtime);
  registerSpecAffectedCommand(spec, runtime);
  registerSpecPolicyCommand(spec, runtime);
  registerSpecExportCommand(spec, runtime);

  registerVerifyRuleCommands(program, runtime);
  registerRunnerCommands(program, runtime);
  registerRunCommands(program, runtime);
  registerCompatCheckCommand(program, runtime);

  return program;
}

/**
 * Run the CLI against `argv` (user arguments only, no node/script prefix).
 * Returns the process exit code instead of exiting, so tests can run the
 * whole CLI in-process. Exit codes: 0 success, 1 findings, 2 error.
 */
export async function runCli(argv: string[], ioOverrides?: Partial<CliIo>): Promise<number> {
  const io: CliIo = { ...defaultIo(), ...ioOverrides };
  const runtime = new CliRuntime(io);
  const program = buildProgram(runtime);

  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => io.outRaw(text),
    writeErr: (text) => io.outRaw(text),
  });
  for (const command of walkCommands(program)) {
    command.exitOverride();
    command.configureOutput({
      writeOut: (text) => io.outRaw(text),
      writeErr: (text) => io.outRaw(text),
    });
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return runtime.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are successful exits.
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        return 0;
      }
      if (error.code === 'commander.help') {
        return error.exitCode === 0 ? 0 : 2;
      }
      // Usage errors (unknown command, missing argument, ...) — commander
      // already printed the message through configureOutput.
      return 2;
    }
    if (isSpecBridgeError(error)) {
      io.err(`Error: ${error.message}`);
      if (error.code === 'WORKSPACE_NOT_FOUND') {
        io.err(dim(`Hint: run "${CLI_BIN} doctor" for a full workspace report.`));
      }
      return 2;
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.err(`Unexpected error: ${message}`);
    return 2;
  }
}

function* walkCommands(command: Command): Generator<Command> {
  for (const child of command.commands) {
    yield child;
    yield* walkCommands(child);
  }
}
