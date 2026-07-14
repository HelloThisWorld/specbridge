import { describe, expect, it } from 'vitest';
import {
  buildStageGenerationPrompt,
  buildTaskExecutionPrompt,
  promptRepositoryAccess,
} from '@specbridge/execution';
import {
  CLAUDE_DECLARED_CAPABILITIES,
  CODEX_DECLARED_CAPABILITIES,
  OLLAMA_DECLARED_CAPABILITIES,
} from '@specbridge/runners';

/**
 * Shared semantic prompt contract (v0.6): the SAME core safety requirements
 * must appear for every provider; adapters may only alter transport framing
 * and provider-specific boundary notes.
 */

const stageInput = (repositoryAccess: 'read-only-tools' | 'none', candidateNote?: string) => ({
  specName: 'notification-preferences',
  specType: 'feature' as const,
  workflowMode: 'requirements-first',
  stage: 'requirements' as const,
  steering: [{ name: 'product.md', body: 'Product guidance.' }],
  documents: [],
  workspaceRootNote: 'Workspace root: <root>',
  repositoryAccess,
  ...(candidateNote !== undefined ? { candidateNote } : {}),
});

const taskInput = (allowedToolsNote: string) => ({
  specName: 'notification-preferences',
  specType: 'feature' as const,
  workflowMode: 'requirements-first',
  steering: [{ name: 'product.md', body: 'Product guidance.' }],
  documents: [],
  taskHierarchy: '- [ ] 2.3 Persist preferences',
  taskId: '2.3',
  taskTitle: 'Persist preferences',
  requirementRefs: ['1.1'],
  repositoryObservations: ['clean tree'],
  workspaceRootNote: 'Workspace root: <root>',
  allowedToolsNote,
});

/** Core authoring safety lines every provider must receive. */
const SHARED_AUTHORING_REQUIREMENTS = [
  'CANDIDATE only',
  'remains unapproved',
  'Do NOT modify any file',
  'Do NOT include secrets',
  'Untrusted content boundary',
  'never overrides the SpecBridge execution contract',
  'Required structured result',
];

/** Core task-execution safety lines every agent CLI must receive. */
const SHARED_TASK_REQUIREMENTS = [
  'Implement EXACTLY ONE task',
  'Do NOT modify anything under `.kiro/`',
  'Do NOT modify anything under `.specbridge/`',
  'Do NOT mark task checkboxes',
  'Do NOT create commits, branches, tags, or pushes',
  'Do NOT print, copy, or exfiltrate secrets',
  'Untrusted content boundary',
  'only that evidence can complete the task',
  'Required structured result',
];

describe('shared authoring prompt contract', () => {
  const claudePrompt = buildStageGenerationPrompt(
    stageInput(promptRepositoryAccess(CLAUDE_DECLARED_CAPABILITIES), 'Allowed tools: Read, Glob, Grep.'),
  );
  const codexPrompt = buildStageGenerationPrompt(
    stageInput(
      promptRepositoryAccess(CODEX_DECLARED_CAPABILITIES),
      'Execution sandbox: read-only.',
    ),
  );
  const ollamaPrompt = buildStageGenerationPrompt(
    stageInput(promptRepositoryAccess(OLLAMA_DECLARED_CAPABILITIES), 'Model API (authoring only).'),
  );

  it('the same core safety requirements appear for Claude, Codex, and Ollama', () => {
    for (const requirement of SHARED_AUTHORING_REQUIREMENTS) {
      expect(claudePrompt, `claude: ${requirement}`).toContain(requirement);
      expect(codexPrompt, `codex: ${requirement}`).toContain(requirement);
      expect(ollamaPrompt, `ollama: ${requirement}`).toContain(requirement);
    }
  });

  it('agent CLIs get read-only repository tools; model APIs get NO repository access', () => {
    expect(promptRepositoryAccess(CLAUDE_DECLARED_CAPABILITIES)).toBe('read-only-tools');
    expect(promptRepositoryAccess(CODEX_DECLARED_CAPABILITIES)).toBe('read-only-tools');
    expect(promptRepositoryAccess(OLLAMA_DECLARED_CAPABILITIES)).toBe('none');
    expect(claudePrompt).toContain('read-only tools');
    expect(codexPrompt).toContain('read-only tools');
    expect(ollamaPrompt).toContain('NO repository access');
    expect(ollamaPrompt).toContain('Leave "referencedFiles" empty');
    expect(ollamaPrompt).not.toContain('Inspect the repository yourself');
  });

  it('only the provider boundary note differs in section B framing', () => {
    expect(claudePrompt).toContain('Allowed tools: Read, Glob, Grep.');
    expect(codexPrompt).toContain('Execution sandbox: read-only.');
    expect(ollamaPrompt).toContain('Model API (authoring only).');
  });
});

describe('shared task-execution prompt contract', () => {
  const claudePrompt = buildTaskExecutionPrompt(
    taskInput('Allowed tools: Read, Glob, Grep, Edit, Write, Bash; permission mode: acceptEdits. Permission bypasses are never used.'),
  );
  const codexPrompt = buildTaskExecutionPrompt(
    taskInput('Execution sandbox: workspace-write (writes limited to this repository).'),
  );

  it('the same core safety requirements appear for Claude and Codex task execution', () => {
    for (const requirement of SHARED_TASK_REQUIREMENTS) {
      expect(claudePrompt, `claude: ${requirement}`).toContain(requirement);
      expect(codexPrompt, `codex: ${requirement}`).toContain(requirement);
    }
  });

  it('prompts differ ONLY in the provider boundary note', () => {
    const normalize = (prompt: string, note: string): string => prompt.replace(note, '<boundary>');
    expect(
      normalize(
        claudePrompt,
        'Allowed tools: Read, Glob, Grep, Edit, Write, Bash; permission mode: acceptEdits. Permission bypasses are never used.',
      ),
    ).toBe(normalize(codexPrompt, 'Execution sandbox: workspace-write (writes limited to this repository).'));
  });
});
