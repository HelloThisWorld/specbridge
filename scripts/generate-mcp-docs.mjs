#!/usr/bin/env node
/**
 * Generate docs/mcp/tool-reference.md from the authoritative MCP registries
 * (TOOL_CATALOG / RESOURCE_CATALOG / PROMPT_CATALOG in the built
 * @specbridge/mcp-server), so the documentation cannot drift from the code.
 *
 * Usage:
 *   node scripts/generate-mcp-docs.mjs           # rewrite the doc
 *   node scripts/generate-mcp-docs.mjs --check   # CI: fail when it drifts
 *
 * Requires `pnpm build`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'mcp', 'tool-reference.md');
const CHECK = process.argv.includes('--check');

const distPath = path.join(ROOT, 'packages', 'mcp-server', 'dist', 'index.js');
if (!existsSync(distPath)) {
  console.error('generate-mcp-docs: packages/mcp-server/dist is missing — run "pnpm build" first.');
  process.exit(1);
}
const mcp = await import(pathToFileURL(distPath).href);

const lines = [
  '# MCP tool reference',
  '',
  '<!-- GENERATED FILE — do not edit by hand. -->',
  '<!-- Regenerate with: pnpm generate:mcp-docs (CI checks drift via pnpm check:mcp-docs). -->',
  '',
  `Generated from the authoritative registries of the \`${mcp.MCP_SERVER_NAME}\` MCP server`,
  `(version ${mcp.MCP_SERVER_VERSION}). Tool names, resource URI templates, and prompt`,
  'names are stable contracts — see docs/stability/public-contracts.md.',
  '',
  `## Tools (${mcp.TOOL_CATALOG.length})`,
  '',
  '| Tool | Access | Summary |',
  '| --- | --- | --- |',
];
for (const tool of [...mcp.TOOL_CATALOG].sort((a, b) => a.name.localeCompare(b.name))) {
  lines.push(`| \`${tool.name}\` | ${tool.readOnly ? 'read-only' : 'write'} | ${tool.summary} |`);
}
lines.push(
  '',
  'Write tools mutate only spec documents and SpecBridge sidecar state through',
  'the same guarded code paths as the CLI; there is deliberately no arbitrary',
  'filesystem, shell, or Git tool, and no stage-approval tool.',
  '',
  `## Resources (${mcp.RESOURCE_CATALOG.length})`,
  '',
  '| URI template | Summary |',
  '| --- | --- |',
);
for (const resource of [...mcp.RESOURCE_CATALOG].sort((a, b) => a.uri.localeCompare(b.uri))) {
  lines.push(`| \`${resource.uri}\` | ${resource.summary} |`);
}
lines.push('', `## Prompts (${mcp.PROMPT_CATALOG.length})`, '', '| Prompt | Summary |', '| --- | --- |');
for (const prompt of [...mcp.PROMPT_CATALOG].sort((a, b) => a.name.localeCompare(b.name))) {
  lines.push(`| \`${prompt.name}\` | ${prompt.summary} |`);
}
lines.push('');
const content = lines.join('\n');

if (CHECK) {
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== content) {
    console.error(
      'check:mcp-docs: docs/mcp/tool-reference.md drifted from the MCP registries.\n' +
        'Run "pnpm generate:mcp-docs" and commit the result.',
    );
    process.exit(1);
  }
  console.log('check:mcp-docs: OK — tool reference matches the registries.');
} else {
  mkdirSync(path.dirname(DOC), { recursive: true });
  writeFileSync(DOC, content);
  console.log(`generate-mcp-docs: wrote ${path.relative(ROOT, DOC)} (${mcp.TOOL_CATALOG.length} tools).`);
}
