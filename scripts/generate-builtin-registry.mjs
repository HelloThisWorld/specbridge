// Embed registry/index.json into @specbridge/registry as the built-in
// example registry (mirrors the builtin-template codegen). Run after
// `pnpm generate:extension-registry`; CI detects drift with --check.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexPath = path.join(rootDir, 'registry', 'index.json');
const generatedPath = path.join(rootDir, 'packages', 'registry', 'src', 'builtin-index.generated.ts');

if (!existsSync(indexPath)) {
  console.error('generate-builtin-registry: registry/index.json is missing.');
  process.exit(1);
}
const indexText = readFileSync(indexPath, 'utf8');
JSON.parse(indexText); // must at least be valid JSON before embedding

const generated = `// GENERATED FILE — do not edit by hand.
// Source of truth: registry/index.json (regenerate with
// \`pnpm generate:builtin-registry\`; CI checks drift with
// \`pnpm check:builtin-registry\`).

export const BUILTIN_REGISTRY_INDEX_JSON = ${JSON.stringify(indexText)};
`;

if (process.argv.includes('--check')) {
  const current = existsSync(generatedPath) ? readFileSync(generatedPath, 'utf8') : '';
  if (current !== generated) {
    console.error('check:builtin-registry: builtin-index.generated.ts is out of date. Run `pnpm generate:builtin-registry`.');
    process.exit(1);
  }
  console.log('check:builtin-registry: OK');
  process.exit(0);
}
writeFileSync(generatedPath, generated);
console.log(`generate-builtin-registry: embedded ${indexText.length} bytes.`);
