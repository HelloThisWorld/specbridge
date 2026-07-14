import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * v0.6.1 security source scans. Production implementation and plugin files
 * must never ENABLE forbidden behavior; the tokens may legitimately appear
 * in prohibition lists, assertions, and negative-test fixtures.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const runnersSrc = path.join(repoRoot, 'packages', 'runners', 'src');

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

function sourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) results.push(full);
  }
  return results;
}

describe('v0.6.1 security source scans', () => {
  it('no adapter ever pushes a YOLO flag or yolo approval mode into an argv', () => {
    for (const file of sourceFiles(runnersSrc)) {
      const source = readFileSync(file, 'utf8');
      // The literal may appear only in forbidden lists / assertions; it must
      // never be an argv push.
      expect(source, file).not.toMatch(/push\(\s*['"]--yolo['"]/);
      expect(source, file).not.toMatch(/['"]--approval-mode['"]\s*,\s*['"]yolo['"]/);
    }
  });

  it('the gemini invocation exposes yolo only inside prohibition lists and assertions', () => {
    const invocation = read('packages/runners/src/gemini-cli/invocation.ts');
    expect(invocation).toContain('GEMINI_FORBIDDEN_ARGUMENTS');
    expect(invocation).toContain("'--yolo'");
    // The only approval-mode values that can be assembled come from the
    // profile enums (plan / auto_edit / default) — yolo is not one of them.
    expect(invocation).toContain("GEMINI_ALLOWED_APPROVAL_MODES = ['plan', 'default', 'auto_edit']");
  });

  it('no runner source assembles a shell command string from untrusted text', () => {
    for (const file of sourceFiles(runnersSrc)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/child_process['"]\)/);
      expect(source, file).not.toMatch(/\bexecSync\(|\bexec\(\s*`/);
      expect(source, file).not.toMatch(/shell:\s*true/);
    }
  });

  it('no runner source logs or stores an Authorization value', () => {
    for (const file of sourceFiles(runnersSrc)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/console\.(log|error|warn)/);
      // The bearer header is assembled in exactly one place and never
      // serialized into results (behavioral redaction tests cover the rest).
      if (file.includes('openai-compatible')) {
        expect(source).not.toMatch(/JSON\.stringify\([^)]*headers/i);
      }
    }
  });

  it('no adapter reads provider credential files or stores', () => {
    const forbiddenPaths = [
      '.codex/auth',
      'oauth_creds',
      'application_default_credentials',
      '.config/gcloud',
      'credentials.json',
      'auth.json',
    ];
    for (const file of sourceFiles(runnersSrc)) {
      const source = readFileSync(file, 'utf8');
      for (const fragment of forbiddenPaths) {
        expect(source.includes(fragment), `${file}: ${fragment}`).toBe(false);
      }
    }
  });

  it('the openai-compatible adapter reads ONLY the configured environment variable', () => {
    const runner = read('packages/runners/src/openai-compatible/runner.ts');
    // Exactly one process.env access, parameterized by the configured name.
    const accesses = runner.match(/process\.env\[/g) ?? [];
    expect(accesses).toHaveLength(1);
    expect(runner).toContain('process.env[variable]');
    expect(runner).not.toMatch(/Object\.(keys|entries)\(process\.env\)/);
  });

  it('the plugin runners skill never invokes a provider or nested agent', () => {
    const skill = read('integrations/claude-code-plugin/specbridge/skills/runners/SKILL.md');
    for (const [index, line] of skill.split('\n').entries()) {
      if (/run (a )?provider|`(gemini|codex|agy|ollama) |claude -p/i.test(line)) {
        expect(/never|not\b|no\b/i.test(line), `runners skill line ${index + 1}: "${line.trim()}"`).toBe(
          true,
        );
      }
    }
    expect(skill).not.toContain('Bash(*');
  });

  it('MCP runner tools are wired read-only in the catalog and use shared services', () => {
    const registry = read('packages/mcp-server/src/tools/registry.ts');
    for (const tool of ['runner_list', 'runner_show', 'runner_doctor', 'runner_matrix']) {
      expect(registry).toContain(`{ name: '${tool}', readOnly: true`);
    }
    const matrixTool = read('packages/mcp-server/src/tools/runner-matrix.ts');
    // The matrix comes from the shared implementation — no second matrix.
    expect(matrixTool).toContain('runnerMatrixRows');
    expect(matrixTool).toContain('renderRunnerMatrixMarkdown');
  });
});
