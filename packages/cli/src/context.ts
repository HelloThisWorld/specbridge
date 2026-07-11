import path from 'node:path';
import type { Command } from 'commander';
import type { WorkspaceInfo } from '@specbridge/core';
import { CLI_BIN, requireWorkspace, resolveWorkspace } from '@specbridge/core';
import { dim } from '@specbridge/reporting';

/** IO abstraction so tests can run the CLI fully in-process. */
export interface CliIo {
  cwd: string;
  /** Write a line (newline appended). */
  out: (line: string) => void;
  /** Write exact text (no newline appended). */
  outRaw: (text: string) => void;
  err: (line: string) => void;
  /** Clock used for every timestamp a command records (injectable in tests). */
  now: () => Date;
}

export function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    outRaw: (text) => process.stdout.write(text),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
  };
}

/**
 * Mutable per-invocation state shared by all commands.
 * Exit-code contract: 0 = success, 1 = findings/quality-gate failure,
 * 2 = invalid usage, unknown resource, or runtime error.
 */
export class CliRuntime {
  readonly io: CliIo;
  exitCode = 0;
  private cwdOverride: string | undefined;

  constructor(io: CliIo) {
    this.io = io;
  }

  get cwd(): string {
    return this.cwdOverride ?? this.io.cwd;
  }

  setCwdOverride(dir: string): void {
    this.cwdOverride = path.resolve(this.io.cwd, dir);
  }

  workspace(): WorkspaceInfo {
    return requireWorkspace(this.cwd);
  }

  tryWorkspace(): WorkspaceInfo | undefined {
    return resolveWorkspace(this.cwd);
  }

  now(): Date {
    return this.io.now();
  }

  out(line = ''): void {
    this.io.out(line);
  }

  outRaw(text: string): void {
    this.io.outRaw(text);
  }

  err(line: string): void {
    this.io.err(line);
  }
}

/** Workspace-relative path with forward slashes, for readable output. */
export function relPath(workspace: WorkspaceInfo, target: string): string {
  const relative = path.relative(workspace.rootDir, target);
  return (relative === '' ? '.' : relative).split(path.sep).join('/');
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

/**
 * Register a documented-but-not-yet-implemented command. It shows up in
 * help marked "(planned)" and exits with code 2 and an honest message.
 * No planned command ever pretends to have done work.
 */
export function registerPlannedCommand(
  parent: Command,
  runtime: CliRuntime,
  options: {
    name: string;
    args?: string;
    summary: string;
    phase: string;
    workaround?: string;
  },
): void {
  const command = parent
    .command(`${options.name}${options.args !== undefined ? ` ${options.args}` : ''}`)
    .description(`(planned) ${options.summary}`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(true);

  command.action(() => {
    runtime.err(
      `"${CLI_BIN} ${fullCommandPath(command)}" is not implemented yet. It is planned for ${options.phase}.`,
    );
    if (options.workaround !== undefined) {
      runtime.err(dim(`In the meantime: ${options.workaround}`));
    }
    runtime.err(dim('Roadmap: docs/roadmap.md — nothing in SpecBridge pretends to work before it does.'));
    runtime.exitCode = 2;
  });
}

function fullCommandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current !== null && current.name() !== CLI_BIN) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(' ');
}
