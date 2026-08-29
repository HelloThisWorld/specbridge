import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const claude = (name: string) => readFileSync(
  path.join(root, 'integrations', 'claude-code-plugin', 'specbridge', 'skills', name, 'SKILL.md'),
  'utf8',
);
const codex = (name: string) => readFileSync(
  path.join(root, 'integrations', 'codex-plugin', 'specbridge', 'skills', name, 'SKILL.md'),
  'utf8',
);

describe('canonical research lifecycle skill parity', () => {
  it.each(['discover', 'spec-draft', 'build', 'continue', 'orchestrate'])(
    '%s ships equivalent Claude and Codex research behavior',
    (name) => {
      for (const phrase of [
        name === 'discover' ? 'User unfamiliarity by itself' : undefined,
        name === 'spec-draft' ? 'Research findings are evidence, never requirements.' : undefined,
        name === 'build' ? 'Every DecisionBrief says `requiresHumanDecision: true`.' : undefined,
        name === 'continue' ? 'zero-diff' : undefined,
        name === 'orchestrate' ? 'Research is a sparse escalation' : undefined,
      ].filter((value): value is string => value !== undefined)) {
        expect(claude(name), `Claude ${name}`).toContain(phrase);
        expect(codex(name), `Codex ${name}`).toContain(phrase);
      }
    },
  );

  it('keeps research recommendations outside draft and intake authority in both frontends', () => {
    for (const read of [claude, codex]) {
      expect(read('spec-draft')).toContain('it becomes an obligation only after the user actually');
      expect(read('build')).toMatch(/A recommendation is\s+not an answer\./);
      expect(read('build')).toContain('Never turn a DecisionBrief or ResearchReport into an intake answer');
    }
  });
});
