import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Claude Code plugin structure, safety, and bundle tests. The heavy
 * isolated-copy verification lives in scripts/verify-plugin-bundle.mjs and
 * is exercised here end-to-end; the structural rules are asserted directly
 * so failures name the exact violated requirement.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginRoot = path.join(repoRoot, 'integrations', 'claude-code-plugin', 'specbridge');
const skillsDir = path.join(pluginRoot, 'skills');

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')) as Record<string, unknown>;
}

function skillMarkdown(name: string): string {
  return readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
}

function frontmatterOf(markdown: string): string {
  const end = markdown.indexOf('\n---', 4);
  return markdown.slice(4, end);
}

beforeAll(() => {
  if (!existsSync(path.join(pluginRoot, 'dist', 'cli.cjs'))) {
    execFileSync('pnpm', ['build:plugin'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  }
}, 600_000);

describe('plugin structure', () => {
  it('plugin.json validates with real repository metadata', () => {
    const manifest = readJson('integrations/claude-code-plugin/specbridge/.claude-plugin/plugin.json');
    expect(manifest['name']).toBe('specbridge');
    expect(manifest['version']).toBe('0.6.0');
    expect(manifest['license']).toBe('MIT');
    expect((manifest['author'] as { name: string }).name).toBe('HelloThisWorld');
    expect(manifest['repository']).toBe('https://github.com/HelloThisWorld/specbridge');
  });

  it('marketplace.json validates and matches the plugin version', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json');
    expect(marketplace['name']).toBe('specbridge-plugins');
    expect(String(marketplace['name'])).not.toMatch(/anthropic|official/i);
    const plugins = marketplace['plugins'] as { name: string; source: string; version: string }[];
    const entry = plugins.find((plugin) => plugin.name === 'specbridge');
    expect(entry).toBeDefined();
    expect(entry?.version).toBe('0.6.0');
    // The relative source resolves to the plugin root.
    expect(path.resolve(repoRoot, entry?.source as string)).toBe(pluginRoot);
  });

  it('.mcp.json is at the plugin root and launches the bundled server', () => {
    const config = readJson('integrations/claude-code-plugin/specbridge/.mcp.json');
    const server = (config['mcpServers'] as Record<string, { command: string; args: string[] }>)['specbridge'];
    expect(server?.command).toBe('node');
    expect(server?.args).toContain('--stdio');
    expect(server?.args.join(' ')).toContain('${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs');
    expect(server?.args.join(' ')).toContain('${CLAUDE_PROJECT_DIR}');
    for (const arg of server?.args ?? []) {
      expect(path.isAbsolute(arg) && !arg.startsWith('${'), `absolute path in .mcp.json: ${arg}`).toBe(false);
    }
  });

  it('only plugin.json lives inside .claude-plugin/; skills and .mcp.json sit at the root', () => {
    expect(readdirSync(path.join(pluginRoot, '.claude-plugin'))).toEqual(['plugin.json']);
    expect(existsSync(path.join(pluginRoot, '.mcp.json'))).toBe(true);
    expect(existsSync(path.join(pluginRoot, 'skills'))).toBe(true);
  });

  it('all eight namespaced skills exist with unique names and valid frontmatter', () => {
    const dirs = readdirSync(skillsDir).sort();
    expect(dirs).toEqual(['approve', 'author', 'continue', 'doctor', 'implement', 'new', 'status', 'verify']);
    const names = new Set<string>();
    for (const dir of dirs) {
      const markdown = skillMarkdown(dir);
      expect(markdown.startsWith('---\n'), `${dir} has frontmatter`).toBe(true);
      const frontmatter = frontmatterOf(markdown);
      expect(frontmatter).toMatch(/description:\s+\S/);
      const nameMatch = /name:\s*(\S+)/.exec(frontmatter);
      const name = nameMatch?.[1] ?? dir;
      expect(names.has(name), `duplicate skill name ${name}`).toBe(false);
      names.add(name);
    }
  });

  it('the approve skill disables model invocation; no other skill grants tools', () => {
    const approve = frontmatterOf(skillMarkdown('approve'));
    expect(approve).toContain('disable-model-invocation: true');
    for (const dir of ['author', 'continue', 'doctor', 'implement', 'new', 'status', 'verify']) {
      expect(frontmatterOf(skillMarkdown(dir))).not.toContain('allowed-tools');
    }
  });

  it('no skill grants unrestricted Bash or enables permission bypasses', () => {
    for (const dir of readdirSync(skillsDir)) {
      const markdown = skillMarkdown(dir);
      expect(markdown, `${dir} must not use Bash(*)`).not.toMatch(/Bash\(\*\)/);
      expect(markdown.toLowerCase()).not.toContain('bypasspermissions');
      expect(markdown.toLowerCase()).not.toContain('dangerously-skip-permissions');
    }
  });

  it('no skill instructs direct .kiro or .specbridge edits or nested Claude runs', () => {
    for (const dir of readdirSync(skillsDir)) {
      const markdown = skillMarkdown(dir);
      for (const [index, line] of markdown.split('\n').entries()) {
        // Any mention of editing .kiro/.specbridge or nested-agent commands
        // must be a prohibition, never an instruction.
        if (/edit(s|ing)? `?\.(kiro|specbridge)/i.test(line)) {
          expect(/never|not|no\b|don't/i.test(line), `${dir}:${index + 1} "${line.trim()}"`).toBe(true);
        }
        if (/claude -p|spec run\b/i.test(line)) {
          expect(/never|not|no\b/i.test(line), `${dir}:${index + 1} "${line.trim()}"`).toBe(true);
        }
      }
    }
    // The implement skill uses the MCP lifecycle.
    const implement = skillMarkdown('implement');
    expect(implement).toContain('task_begin');
    expect(implement).toContain('task_complete');
    expect(implement).toContain('task_abort');
  });

  it('the plugin contains every runtime file it needs', () => {
    for (const required of [
      'README.md',
      'LICENSE',
      'NOTICE.md',
      'bin/specbridge',
      'bin/specbridge.cmd',
      'dist/cli.cjs',
      'dist/mcp-server.cjs',
      'dist/THIRD_PARTY_LICENSES.txt',
      'dist/checksums.json',
    ]) {
      expect(existsSync(path.join(pluginRoot, required)), required).toBe(true);
    }
  });

  it('installation docs use the actual names and never claim marketplace publication', () => {
    const docs = readFileSync(path.join(repoRoot, 'docs', 'plugin-installation.md'), 'utf8');
    expect(docs).toContain('specbridge@specbridge-plugins');
    expect(docs).toContain('/specbridge:doctor');
    // Every mention of an official/community marketplace must be a denial.
    for (const [index, line] of docs.split('\n').entries()) {
      if (/official|community marketplace/i.test(line)) {
        expect(/\bnot\b|\bnever\b/i.test(line), `line ${index + 1}: "${line.trim()}"`).toBe(true);
      }
    }
  });
});

describe('bundle safety', () => {
  it('bundles embed no private absolute build paths and no workspace imports', () => {
    const repoVariants = [repoRoot.split(path.sep).join('/'), repoRoot.split(path.sep).join('\\\\')];
    for (const bundleName of ['cli.cjs', 'mcp-server.cjs']) {
      const bundle = readFileSync(path.join(pluginRoot, 'dist', bundleName), 'utf8');
      for (const variant of repoVariants) {
        expect(bundle.includes(variant), `${bundleName} embeds ${variant}`).toBe(false);
      }
      expect(bundle).not.toMatch(/require\(['"]@specbridge\//);
      expect(existsSync(path.join(pluginRoot, 'dist', `${bundleName}.map`))).toBe(false);
    }
  });

  it('the checksum manifest matches the bundles deterministically', async () => {
    const { createHash } = await import('node:crypto');
    const checksums = readJson(
      'integrations/claude-code-plugin/specbridge/dist/checksums.json',
    ) as { files: Record<string, { sha256: string; bytes: number }> };
    for (const [name, expected] of Object.entries(checksums.files)) {
      const buffer = readFileSync(path.join(pluginRoot, 'dist', name));
      expect(createHash('sha256').update(buffer).digest('hex'), name).toBe(expected.sha256);
      expect(buffer.length, `${name} size`).toBe(expected.bytes);
    }
  });

  it('the wrappers are syntactically sound for their platforms', () => {
    const posix = readFileSync(path.join(pluginRoot, 'bin', 'specbridge'), 'utf8');
    expect(posix.startsWith('#!/bin/sh')).toBe(true);
    expect(posix).toContain('"$@"');
    expect(posix).not.toContain('\r');
    const cmd = readFileSync(path.join(pluginRoot, 'bin', 'specbridge.cmd'), 'utf8');
    expect(cmd).toMatch(/%~dp0/);
    expect(cmd).toMatch(/%\*/);
    expect(cmd).toMatch(/exit \/b %errorlevel%/i);
  });

  it('the deterministic validator passes end-to-end', () => {
    const output = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'validate-plugin.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(output).toContain('validate-plugin: OK');
  }, 120_000);

  it('the isolated-copy verification passes end-to-end (mandatory)', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'verify-plugin-bundle.mjs')],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(output).toContain('all 8 checks passed');
  }, 300_000);
});
