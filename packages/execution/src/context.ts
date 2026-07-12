import path from 'node:path';
import type { SpecAnalysis, TasksModel } from '@specbridge/compat-kiro';
import { listSteeringFiles, loadSteeringDocument } from '@specbridge/compat-kiro';
import type { StageName, WorkspaceInfo } from '@specbridge/core';
import type { WorkflowEvaluation } from '@specbridge/workflow';
import type { GitSnapshot } from '@specbridge/evidence';
import type { SpecDocumentSection, SteeringSection } from './prompts.js';

/**
 * Bounded context assembly for runner prompts.
 *
 * The prompt carries steering plus the relevant spec documents — never the
 * whole repository. The runner inspects source files itself through its
 * restricted read-only tools.
 */

/** Steering documents with `inclusion: always` (the default trio and friends). */
export function steeringSections(workspace: WorkspaceInfo): SteeringSection[] {
  const sections: SteeringSection[] = [];
  for (const info of listSteeringFiles(workspace)) {
    if (info.inclusion !== 'always' && info.inclusion !== 'unknown') continue;
    try {
      const document = loadSteeringDocument(workspace, info.name);
      sections.push({ name: info.fileName, body: document.body });
    } catch {
      // Unreadable steering is reported elsewhere (doctor); skip it here.
    }
  }
  return sections;
}

/** Spec documents for the prompt, marking which ones are effectively approved. */
export function specDocumentSections(
  spec: SpecAnalysis,
  evaluation: WorkflowEvaluation | undefined,
  stages: StageName[],
): SpecDocumentSection[] {
  const sections: SpecDocumentSection[] = [];
  for (const stage of stages) {
    const document = spec.documents[stage as keyof SpecAnalysis['documents']];
    if (document === undefined) continue;
    const approved =
      evaluation?.stages.find((s) => s.stage === stage)?.effective === 'approved';
    sections.push({
      stage,
      fileName: `${stage}.md`,
      approved,
      content: document.bodyText(),
    });
  }
  return sections;
}

/** Render the full task hierarchy with the selected task marked. */
export function renderTaskHierarchy(model: TasksModel, selectedTaskId: string): string {
  const lines: string[] = [];
  const walk = (tasks: TasksModel['tasks'], depth: number): void => {
    for (const task of tasks) {
      const marker = task.id === selectedTaskId ? '>>> ' : '';
      const box = task.state === 'done' ? '[x]' : task.state === 'in-progress' ? '[-]' : '[ ]';
      lines.push(`${'  '.repeat(depth)}- ${box} ${marker}${task.number ?? task.id}. ${task.title}${marker !== '' ? ' <<<' : ''}`);
      walk(task.children, depth + 1);
    }
  };
  walk(model.tasks, 0);
  return lines.join('\n');
}

/** Compact, data-only repository facts for the prompt. */
export function repositoryObservations(workspaceRoot: string, snapshot: GitSnapshot): string[] {
  const observations = [
    `Repository root: ${workspaceRoot}`,
    snapshot.head !== undefined ? `HEAD: ${snapshot.head}` : 'HEAD: (no commits yet)',
    snapshot.branch !== undefined
      ? `Branch: ${snapshot.branch}`
      : snapshot.detached
        ? 'Branch: (detached HEAD)'
        : 'Branch: (unknown)',
    snapshot.clean
      ? 'Working tree: clean'
      : `Working tree: ${snapshot.entries.length} path(s) already modified before this run`,
  ];
  return observations;
}

export function workspaceRootNote(workspace: WorkspaceInfo): string {
  return `Repository root (your working directory): ${path.resolve(workspace.rootDir)}`;
}
