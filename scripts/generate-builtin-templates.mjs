#!/usr/bin/env node
/**
 * Generate packages/templates/src/builtin-packs.generated.ts from the
 * template packs under packages/templates/builtins/.
 *
 * The packs on disk are the contributor-facing source of truth (plain
 * Markdown and JSON — no TypeScript required to contribute a template).
 * The generated module embeds them as string constants so every bundle
 * (CLI, MCP standalone, Claude Code plugin) ships the built-in catalog
 * with no runtime filesystem lookups.
 *
 * Usage:
 *   node scripts/generate-builtin-templates.mjs          # write the module
 *   node scripts/generate-builtin-templates.mjs --check  # fail on drift (CI)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtinsDir = path.join(rootDir, 'packages', 'templates', 'builtins');
const outputPath = path.join(rootDir, 'packages', 'templates', 'src', 'builtin-packs.generated.ts');

function fail(message) {
  console.error(`generate-builtin-templates: ${message}`);
  process.exit(1);
}

function collectFiles(dir, prefix = '') {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) fail(`symlink in built-in pack: ${relative}`);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath, relative));
      continue;
    }
    const buffer = readFileSync(entryPath);
    const text = buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer)) fail(`not valid UTF-8: ${relative}`);
    if (text.includes('\0')) fail(`binary content in built-in pack: ${relative}`);
    if (text.includes('\r\n')) fail(`CRLF line endings in built-in pack: ${relative} (repo uses LF)`);
    files.push([relative, text]);
  }
  return files;
}

const packDirs = readdirSync(builtinsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, 'en'));

if (packDirs.length === 0) fail(`no built-in packs found under ${builtinsDir}`);

const packs = packDirs.map((id) => {
  const packDir = path.join(builtinsDir, id);
  statSync(path.join(packDir, 'specbridge-template.json'));
  return { id, files: collectFiles(packDir) };
});

const lines = [];
lines.push('// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.');
lines.push('//');
lines.push('// Source of truth: packages/templates/builtins/');
lines.push('// Regenerate with: pnpm generate:builtin-templates');
lines.push('// CI drift check:  pnpm check:builtin-templates');
lines.push('//');
lines.push('// Built-in template packs are embedded as string constants so every');
lines.push('// bundle (CLI, MCP standalone, Claude Code plugin) ships the catalog');
lines.push('// without runtime filesystem lookups.');
lines.push('');
lines.push('export interface BuiltinTemplatePackData {');
lines.push('  readonly id: string;');
lines.push('  /** Pack-relative POSIX path -> UTF-8 content. */');
lines.push('  readonly files: Readonly<Record<string, string>>;');
lines.push('}');
lines.push('');
lines.push('export const BUILTIN_TEMPLATE_PACKS: readonly BuiltinTemplatePackData[] = [');
for (const pack of packs) {
  lines.push('  {');
  lines.push(`    id: ${JSON.stringify(pack.id)},`);
  lines.push('    files: {');
  for (const [relative, text] of pack.files) {
    lines.push(`      ${JSON.stringify(relative)}: ${JSON.stringify(text)},`);
  }
  lines.push('    },');
  lines.push('  },');
}
lines.push('] as const;');
lines.push('');

const output = lines.join('\n');

if (process.argv.includes('--check')) {
  let existing;
  try {
    existing = readFileSync(outputPath, 'utf8');
  } catch {
    fail(`missing generated module ${outputPath}; run pnpm generate:builtin-templates`);
  }
  if (existing !== output) {
    fail(
      'builtin-packs.generated.ts is out of date with packages/templates/builtins/; ' +
        'run pnpm generate:builtin-templates and commit the result',
    );
  }
  console.log(`check:builtin-templates: OK (${packs.length} packs)`);
} else {
  writeFileSync(outputPath, output);
  console.log(`generated ${path.relative(rootDir, outputPath)} (${packs.length} packs)`);
}
