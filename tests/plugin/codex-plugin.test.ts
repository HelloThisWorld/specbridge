import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const integrationRoot = path.join(repoRoot, 'integrations', 'codex-plugin');
const pluginRoot = path.join(integrationRoot, 'specbridge');
const claudeRoot = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge');
const skillsDir = path.join(pluginRoot, 'skills');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<string, unknown>;
}

function skillNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function skill(name: string): string {
  return readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
}

function frontmatter(markdown: string): string {
  return markdown.slice(4, markdown.indexOf('\n---', 4));
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  visit(root);
  return files;
}

describe('Codex frontend plugin structure', () => {
  it('uses the current Codex manifest and marketplace locations', () => {
    const manifest = readJson('integrations/codex-plugin/specbridge/.codex-plugin/plugin.json');
    const rootVersion = readJson('package.json')['version'];
    expect(manifest['name']).toBe('specbridge');
    expect(manifest['version']).toBe(rootVersion);
    expect(manifest['skills']).toBe('./skills/');
    expect(manifest['mcpServers']).toBe('./.mcp.json');
    expect(manifest).not.toHaveProperty('hooks');

    const marketplace = readJson(
      'integrations/codex-plugin/.agents/plugins/marketplace.json',
    );
    expect(marketplace['name']).toBe('specbridge-local');
    const entry = (marketplace['plugins'] as Array<{
      name: string;
      source: { source: string; path: string };
      policy: { installation: string; authentication: string };
    }>).find((candidate) => candidate.name === 'specbridge');
    expect(entry?.source).toEqual({ source: 'local', path: './specbridge' });
    expect(path.resolve(integrationRoot, entry?.source.path as string)).toBe(pluginRoot);
    expect(entry?.policy).toEqual({ installation: 'AVAILABLE', authentication: 'ON_USE' });
  });

  it('bundles the shared MCP server through a project-root launcher', () => {
    const mcp = readJson('integrations/codex-plugin/specbridge/.mcp.json');
    const server = (mcp['mcpServers'] as Record<string, {
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    }>).specbridge;
    expect(server).toBeDefined();
    if (server === undefined) throw new Error('mcpServers.specbridge is missing');
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['${PLUGIN_ROOT}/dist/mcp-launcher.cjs']);
    expect(server.cwd).toBeUndefined();
    expect(server.env).toBeUndefined();

    const launcher = readFileSync(path.join(pluginRoot, 'dist', 'mcp-launcher.cjs'), 'utf8');
    expect(launcher).toContain('SPECBRIDGE_PROJECT_ROOT');
    expect(launcher).toContain('process.cwd()');
    expect(launcher).toContain('process.env.PWD');
    expect(launcher).toContain('spawn(');
    expect(launcher).toContain('shell: false');
    expect(launcher).toContain("stdio: 'inherit'");
    expect(launcher).not.toContain('cmd.exe');
    expect(launcher).not.toContain('CLAUDE_PROJECT_DIR');
  });

  it('contains the exact same public skill set as Claude', () => {
    const claudeSkills = skillNames(path.join(claudeRoot, 'skills'));
    const codexSkills = skillNames(skillsDir);
    expect(codexSkills).toEqual(claudeSkills);
    expect(codexSkills).toEqual([
      'approve',
      'author',
      'build',
      'continue',
      'develop',
      'discover',
      'doctor',
      'extensions',
      'implement',
      'new',
      'orchestrate',
      'runners',
      'spec-draft',
      'status',
      'templates',
      'verify',
    ]);
    for (const name of codexSkills) {
      const markdown = skill(name);
      const metadata = frontmatter(markdown);
      expect(metadata).toMatch(new RegExp(`^name:\\s*${name}$`, 'm'));
      expect(metadata).toMatch(/^description:\s*"?.{20}/m);
      expect([...metadata.matchAll(/^([A-Za-z-]+):/gm)].map((match) => match[1])).toEqual([
        'name',
        'description',
      ]);
      expect(markdown).not.toContain('CLAUDE_PLUGIN_ROOT');
      expect(markdown).not.toContain('/specbridge:');
      expect(markdown).not.toContain('disable-model-invocation');
      expect(markdown).not.toContain('allowed-tools');
    }
  });

  it('is deterministically derived from the Claude skill source', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'build-codex-plugin.mjs'), '--check'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(output).toContain('check-codex-plugin: OK — 16 skills');
  });

  it('shares byte-identical CLI/MCP bundles and has verified checksums', () => {
    for (const name of ['cli.cjs', 'mcp-server.cjs']) {
      expect(
        readFileSync(path.join(pluginRoot, 'dist', name)).equals(
          readFileSync(path.join(claudeRoot, 'dist', name)),
        ),
        name,
      ).toBe(true);
    }
    const checksums = readJson('integrations/codex-plugin/specbridge/dist/checksums.json') as {
      version: string;
      files: Record<string, { sha256: string; bytes: number }>;
    };
    expect(checksums.version).toBe(readJson('package.json')['version']);
    for (const [name, expected] of Object.entries(checksums.files)) {
      const data = readFileSync(path.join(pluginRoot, 'dist', name));
      expect(data.length, name).toBe(expected.bytes);
      expect(createHash('sha256').update(data).digest('hex'), name).toBe(expected.sha256);
    }
  });
});

describe('Codex workflow and authority contracts', () => {
  it('recognizes the five critical natural-language workflows', () => {
    expect(frontmatter(skill('spec-draft'))).toContain('把我们刚才聊的写成 spec');
    expect(frontmatter(skill('build'))).toContain('开始 build 这个 spec');
    expect(frontmatter(skill('status'))).toContain('现在跑到哪里了？');
    expect(frontmatter(skill('continue'))).toContain('继续刚才那个被中断的任务');
    expect(frontmatter(skill('doctor'))).toContain('检查一下 SpecBridge 环境有没有问题');
  });

  it('conversation-to-spec passes confirmed text to intake and never invents a gap', () => {
    const draft = skill('spec-draft');
    expect(draft).toContain('full Markdown as `specification`');
    expect(draft).toContain('verbatim and complete');
    expect(draft).toContain('A gap is a question, not a blank to fill creatively.');
    expect(draft).toContain('spec_intake_start');
    expect(draft).toContain('spec_intake_answer');
  });

  it('final approval is CLI-only and cannot be performed by a Codex skill', () => {
    const approval = skill('approve');
    const intake = skill('build');
    expect(approval).toContain('specbridge spec approve <spec-name> --stage <stage>');
    expect(approval).toMatch(/must never (execute|run)/i);
    expect(approval).toContain('STOP');
    expect(intake).toContain('specbridge spec approve <name> --build');
    expect(intake).toContain('You cannot run it, and no MCP tool can.');
    for (const name of skillNames(skillsDir)) {
      expect(skill(name), name).not.toContain('spec_intake_approve');
    }
  });

  it('uses MCP as the primary surface and never starts a nested Codex runner', () => {
    for (const name of ['implement', 'develop', 'continue']) {
      expect(skill(name)).toContain('task_begin');
      expect(skill(name)).toContain('task_complete');
    }
    for (const name of ['implement', 'develop', 'orchestrate']) {
      expect(skill(name)).toContain('codex exec');
      for (const [index, line] of skill(name).split('\n').entries()) {
        if (/codex exec/i.test(line)) {
          expect(line, `${name}:${index + 1}`).toMatch(/never|\bno\b|forbidden/i);
        }
      }
    }
    expect(skill('runners')).toContain('Read-only');
    expect(skill('runners')).toContain('runner_doctor');
  });

  it('contains no hook, credential, runner-enablement, or sandbox mutation surface', () => {
    expect(existsSync(path.join(pluginRoot, 'hooks'))).toBe(false);
    const text = filesUnder(pluginRoot)
      .filter((file) => !/\.(cjs|png|zip)$/i.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(text).not.toContain('codex-default.enabled');
    expect(text).not.toContain('danger-full-access');
    expect(text).not.toContain('CODEX_API_KEY');
    expect(text).not.toContain('OPENAI_API_KEY');
  });
});

describe('Codex installed-bundle validation', () => {
  it('passes current-Codex marketplace install/remove validation in an isolated home', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'validate-codex-plugin.mjs')],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(output).toContain('validate-codex-plugin: OK');
  }, 120_000);

  it('passes launcher, project-root, MCP-write, and stdout verification', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'verify-codex-plugin-bundle.mjs')],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(output).toMatch(/all \d+ checks passed/);
  }, 120_000);
});
