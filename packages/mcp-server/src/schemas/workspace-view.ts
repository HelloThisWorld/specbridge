import { discoverSpecs, listSteeringFiles } from '@specbridge/compat-kiro';
import { readAgentConfig } from '@specbridge/core';
import { captureGitSnapshot } from '@specbridge/evidence';
import type { ServerContext } from '../context.js';
import type { DiagnosticView } from './common.js';
import { toDiagnosticViews } from './common.js';

/**
 * Workspace detection view shared by the workspace_detect tool and the
 * specbridge://workspace resource, so both always report the same facts.
 */

export interface WorkspaceDetection {
  found: boolean;
  projectRoot: string;
  workspaceRoot?: string;
  kiroPresent: boolean;
  steeringCount: number;
  specCount: number;
  sidecarPresent: boolean;
  configStatus: 'absent-defaults' | 'valid' | 'invalid';
  git: {
    repository: boolean;
    clean?: boolean;
    branch?: string;
    head?: string;
    dirtyPaths?: number;
  };
  diagnostics: DiagnosticView[];
  suggestedNextSteps: string[];
}

export async function buildWorkspaceDetection(context: ServerContext): Promise<WorkspaceDetection> {
  const workspace = context.tryWorkspace();
  if (workspace === undefined) {
    return {
      found: false,
      projectRoot: context.projectRoot,
      kiroPresent: false,
      steeringCount: 0,
      specCount: 0,
      sidecarPresent: false,
      configStatus: 'absent-defaults',
      git: { repository: false },
      diagnostics: [],
      suggestedNextSteps: [
        'Open a project containing .kiro, or create a spec with the spec_create tool.',
      ],
    };
  }

  const steering = listSteeringFiles(workspace);
  const specs = discoverSpecs(workspace);
  const configRead = readAgentConfig(workspace);
  const configStatus = !configRead.exists
    ? ('absent-defaults' as const)
    : configRead.config !== undefined
      ? ('valid' as const)
      : ('invalid' as const);
  const snapshot = await captureGitSnapshot(workspace.rootDir, { clock: context.clock });
  const diagnostics = [...steering.flatMap((info) => info.diagnostics), ...configRead.diagnostics];

  const suggestedNextSteps: string[] = [];
  if (specs.length === 0) {
    suggestedNextSteps.push('Create a first spec with spec_create.');
  } else {
    suggestedNextSteps.push('Inspect specs with spec_list, then spec_status for details.');
  }
  if (configStatus === 'invalid') {
    suggestedNextSteps.push(
      'Fix .specbridge/config.json; execution tools refuse an invalid configuration.',
    );
  }
  if (!snapshot.gitAvailable) {
    suggestedNextSteps.push('Initialize a Git repository; interactive task execution requires one.');
  }

  return {
    found: true,
    projectRoot: context.projectRoot,
    workspaceRoot: workspace.rootDir === context.projectRoot ? '.' : workspace.rootDir,
    kiroPresent: true,
    steeringCount: steering.length,
    specCount: specs.length,
    sidecarPresent: workspace.sidecarExists,
    configStatus,
    git: {
      repository: snapshot.gitAvailable,
      ...(snapshot.gitAvailable
        ? {
            clean: snapshot.clean,
            ...(snapshot.branch !== undefined ? { branch: snapshot.branch } : {}),
            ...(snapshot.head !== undefined ? { head: snapshot.head } : {}),
            dirtyPaths: snapshot.entries.length,
          }
        : {}),
    },
    diagnostics: toDiagnosticViews(workspace, diagnostics),
    suggestedNextSteps,
  };
}

export function workspaceDetectionText(detection: WorkspaceDetection): string {
  if (!detection.found) {
    return (
      `No .kiro directory found in ${detection.projectRoot} or any parent directory. ` +
      'Create a first spec with spec_create to initialize .kiro/specs/.'
    );
  }
  return [
    `Workspace found at ${detection.workspaceRoot ?? '.'} (project root: ${detection.projectRoot}).`,
    `Steering documents: ${detection.steeringCount}; specs: ${detection.specCount}.`,
    `.specbridge sidecar: ${detection.sidecarPresent ? 'present' : 'absent'}; configuration: ${detection.configStatus}.`,
    detection.git.repository
      ? `Git: ${detection.git.branch ?? '(detached)'}${detection.git.clean === true ? ', clean' : `, ${detection.git.dirtyPaths ?? 0} dirty path(s)`}.`
      : 'Git: not a usable repository.',
  ].join('\n');
}
