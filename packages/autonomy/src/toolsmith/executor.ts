import type { ToolsmithCapability } from '@specbridge/core';
import { runSafeProcess } from '@specbridge/runners';
import { AutonomyError } from '../errors.js';
import type { ToolInstallScope } from '../vocabulary.js';
import type { ToolsmithExecutor } from './service.js';

/**
 * The process-backed Toolsmith executor.
 *
 * Every capability maps to a FIXED argv shape with exactly one variable
 * position, and that position is the already-brokered target. There is no
 * path by which a capability request becomes an arbitrary command: no shell,
 * no string interpolation into an executable, no user-supplied flags. That
 * constraint is what makes "the agent installs what it needs" a bounded
 * statement rather than an open one.
 *
 * The mapping is intentionally conservative about what it will attempt. A
 * capability with no safe fixed shape (PROJECT_LOCAL_TOOLCHAIN, whose
 * installation differs per language and per platform) is refused here rather
 * than guessed at, and the refusal names what a person would do instead. A
 * wrong guess about how to install a JDK at 03:00 is worse than an honest
 * "this one needs you".
 */

export interface ProcessExecutorOptions {
  /** Directory the commands run in. Always the project, never the home dir. */
  cwd: string;
  /** Package manager the project declares, when it declares one. */
  packageManager?: string | undefined;
}

const PACKAGE_MANAGER_INSTALL_ARGV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pnpm: ['install', '--frozen-lockfile=false'],
  npm: ['install'],
  yarn: ['install'],
  bun: ['install'],
});

const PACKAGE_MANAGER_ADD_ARGV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pnpm: ['add', '-D'],
  npm: ['install', '--save-dev'],
  yarn: ['add', '--dev'],
  bun: ['add', '--dev'],
});

export function createProcessToolsmithExecutor(
  options: ProcessExecutorOptions,
): ToolsmithExecutor {
  return {
    label: 'process',
    async apply(input) {
      const { executable, argv } = resolveCommand(input.capability, input.target, input.scope, options);
      const result = await runSafeProcess({
        executable,
        argv: [...argv],
        cwd: options.cwd,
        timeoutMs: input.timeoutMs,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 512 * 1024,
      });
      if (result.status !== 'ok') {
        throw new AutonomyError(
          'SBA012',
          `${executable} ${argv[0] ?? ''} failed (${result.status}) provisioning ${input.target}.`,
          {
            remediation: [
              (result.stderr || result.stdout || '').split('\n').slice(0, 3).join(' ').slice(0, 400),
            ].filter((line) => line.length > 0),
            retryable: result.status === 'timeout',
          },
        );
      }
      return {
        outcome: `${executable} ${argv.join(' ')} succeeded`.slice(0, 4_000),
        bytes: null,
        createdPaths: [],
      };
    },
  };
}

function resolveCommand(
  capability: ToolsmithCapability,
  target: string,
  scope: ToolInstallScope,
  options: ProcessExecutorOptions,
): { executable: string; argv: readonly string[] } {
  switch (capability) {
    case 'PACKAGE_MANAGER_INSTALL': {
      const manager = requireManager(options);
      return {
        executable: manager,
        argv: PACKAGE_MANAGER_INSTALL_ARGV[manager] ?? ['install'],
      };
    }
    case 'PROJECT_DEPENDENCY': {
      const manager = requireManager(options);
      return {
        executable: manager,
        argv: [...(PACKAGE_MANAGER_ADD_ARGV[manager] ?? ['install']), target],
      };
    }
    case 'BROWSER_RUNTIME': {
      // Playwright installs its browsers into a cache it owns; `--with-deps`
      // is deliberately NOT passed, because that path installs system
      // packages and needs administrator rights, which is an authority
      // question rather than an engineering one.
      return { executable: 'npx', argv: ['--yes', 'playwright', 'install', target] };
    }
    case 'CONTAINER_IMAGE': {
      return { executable: 'docker', argv: ['pull', target] };
    }
    case 'CONTAINER_LIFECYCLE': {
      // Lifecycle belongs to the environment service, which owns readiness,
      // health, and teardown. Routing it through the Toolsmith would create
      // a second place that starts containers and only one place that stops
      // them.
      throw new AutonomyError(
        'SBA012',
        'Container lifecycle is owned by the environment service, not by the Toolsmith executor.',
        { remediation: ['Provision an EnvironmentInstance instead of requesting a raw container.'] },
      );
    }
    case 'PROJECT_LOCAL_TOOLCHAIN': {
      throw new AutonomyError(
        'SBA012',
        `Installing "${target}" as a project-local toolchain has no single safe command shape.`,
        {
          remediation: [
            'Commit a build wrapper (gradlew, mvnw) so the project provisions its own toolchain.',
            'Or install the toolchain once, before the unattended run.',
          ],
        },
      );
    }
    case 'USER_LOCAL_CLI': {
      throw new AutonomyError(
        'SBA012',
        `Installing "${target}" into a user prefix (${scope}) has no safe fixed command shape.`,
        { remediation: ['Prefer a project-local dev dependency or a container image.'] },
      );
    }
    default: {
      throw new AutonomyError(
        'SBA012',
        `The capability ${capability} is not executable through the process executor.`,
        { remediation: ['Apply it through the service that owns it.'] },
      );
    }
  }
}

function requireManager(options: ProcessExecutorOptions): string {
  const manager = options.packageManager;
  if (manager === undefined || !(manager in PACKAGE_MANAGER_INSTALL_ARGV)) {
    throw new AutonomyError(
      'SBA012',
      manager === undefined
        ? 'The project declares no package manager, so SpecBridge will not guess one.'
        : `Package manager "${manager}" has no known safe install shape.`,
      {
        remediation: [
          'Set "packageManager" in package.json, or commit the lockfile of the manager you use.',
        ],
      },
    );
  }
  return manager;
}
