import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SKILLS = [
  'specbridge-design',
  'specbridge-research',
  'specbridge-review',
  'specbridge-approve',
  'specbridge-status',
];

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('thin conversational integrations', () => {
  for (const integration of ['codex-plugin', 'claude-code-plugin']) {
    it(`packages the ${integration} frontend without a bundled runtime`, () => {
      const plugin = path.join(ROOT, 'integrations', integration, 'specbridge');
      const manifestPath = path.join(
        plugin,
        integration === 'codex-plugin' ? '.codex-plugin' : '.claude-plugin',
        'plugin.json',
      );
      const manifest = json(manifestPath);
      expect(manifest['name']).toBe('specbridge');
      expect(manifest['version']).toBe('2.0.0');

      const mcp = json(path.join(plugin, '.mcp.json'));
      const servers = mcp['mcpServers'] as Record<string, Record<string, unknown>>;
      expect(servers['specbridge']?.['command']).toBe('specbridge');
      expect(servers['specbridge']?.['args']).toEqual(['mcp']);

      const skillRoot = path.join(plugin, 'skills');
      const installedSkills = readdirSync(skillRoot, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(path.join(skillRoot, entry.name, 'SKILL.md')),
        )
        .map((entry) => entry.name)
        .sort();
      expect(installedSkills).toEqual([...SKILLS].sort());
      for (const name of SKILLS) {
        const content = readFileSync(path.join(skillRoot, name, 'SKILL.md'), 'utf8');
        expect(content.startsWith('---\n')).toBe(true);
        expect(content).toContain(`name: ${name}`);
        expect(content).not.toMatch(/TODO|spec approve|implementation runtime/i);
      }
      for (const obsoleteDirectory of ['dist', 'bin']) {
        const target = path.join(plugin, obsoleteDirectory);
        expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
      }
    });
  }
});
