import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MarkdownDocument,
  analyzeSpec,
  analyzeWorkspace,
  detectKiroWorkspace,
  discoverSpecs,
  parseTasks,
  requireSpec,
  specFile,
} from '@specbridge/compat-kiro';
import type { VerificationReport } from '@specbridge/core';
import { readSpecState } from '@specbridge/core';
import type { VerifySpecsResult } from '@specbridge/drift';
import { resolveAffectedSpecs, resolveComparison, verifySpecs } from '@specbridge/drift';
import { listSpecEvidence } from '@specbridge/evidence';
import { listInstalledExtensions, searchInstalledExtensions } from '@specbridge/extensions';
import {
  readRegistriesConfig,
  resolveRegistryIndex,
  searchRegistryIndexes,
} from '@specbridge/registry';
import {
  createJsonReport,
  renderVerificationHtml,
  renderVerificationMarkdown,
  serializeJsonReport,
} from '@specbridge/reporting';
import { loadTemplateCatalog, searchTemplates } from '@specbridge/templates';
import { callTool, connectMcp } from '../helpers-mcp.js';
import type { LargeWorkspace } from './fixture.js';
import { PERF_REGISTRY_SOURCE, buildLargeWorkspace } from './fixture.js';

/**
 * v1.0.0 large-repository performance suite.
 *
 * Fully offline and deterministic: no model calls, no network — the MCP
 * session runs over in-memory transports and registry search reads a
 * pre-written cache. Every measurement warms up first, then times a single
 * run with performance.now() and asserts against a budget 5–10x the number
 * measured on a development machine (see docs/performance.md), so CI slowness
 * never flakes the suite while the logged values still act as a benchmark.
 *
 * Every measurement is logged as `perf: <metric> = <value> <unit>` so CI logs
 * double as an informational benchmark. Set SPECBRIDGE_SKIP_PERF=1 to skip
 * the whole suite (for quick local iteration on unrelated tests).
 */

const SKIP_PERF = process.env['SPECBRIDGE_SKIP_PERF'] === '1';

/**
 * Generous CI budgets. Each is ~10x the number measured on a development
 * machine (docs/performance.md lists the raw measurements), then rounded up
 * to a friendly class; sub-10 ms measurements get an absolute floor of
 * 500–2000 ms instead, because a single GC pause would flake a literal 10x
 * budget. Budgets involving git subprocesses or thousands of filesystem
 * metadata operations get extra headroom for slow Windows CI runners.
 */
const BUDGET_MS = {
  workspaceDetectAndDiscovery: 5_000,
  parseAllTasks: 3_000,
  singleSpecRead: 3_000,
  verifyDiagnosticsSpec: 10_000,
  workingTreeComparison: 15_000,
  affectedSpecs: 10_000,
  evidenceHistory: 2_000,
  templateCatalog: 15_000,
  templateSearch: 500,
  extensionCatalog: 2_000,
  extensionSearch: 500,
  registryResolve: 1_000,
  registrySearch: 500,
  mcpSpecListPage: 15_000,
  reportRenderAll: 1_000,
  workspaceAnalyze: 15_000,
} as const;

const MAX_HEAP_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB — informational bound.

function log(metric: string, value: number, unit: 'ms' | 'bytes' | 'MB'): void {
  const rendered = unit === 'ms' || unit === 'MB' ? value.toFixed(1) : String(Math.round(value));
  console.log(`perf: ${metric} = ${rendered} ${unit}`);
}

interface Measured<T> {
  value: T;
  ms: number;
}

function measure<T>(metric: string, fn: () => T): Measured<T> {
  const start = performance.now();
  const value = fn();
  const ms = performance.now() - start;
  log(metric, ms, 'ms');
  return { value, ms };
}

async function measureAsync<T>(metric: string, fn: () => Promise<T>): Promise<Measured<T>> {
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  log(metric, ms, 'ms');
  return { value, ms };
}

describe.skipIf(SKIP_PERF)('large-repository performance', () => {
  const DIAG_SPEC = 'perf-diagnostics';
  let large: LargeWorkspace;
  let diag: LargeWorkspace;
  let diagReport: VerificationReport | undefined;
  let verifyCounter = 0;

  async function runDiagVerify(): Promise<VerifySpecsResult> {
    verifyCounter += 1;
    const result = await verifySpecs({
      workspace: diag.workspace,
      selection: { mode: 'single', spec: DIAG_SPEC },
      comparison: { mode: 'working-tree' },
      failOn: 'error',
      toolVersion: '1.0.0-perf',
      clock: () => new Date('2026-07-12T10:00:00.000Z'),
      idFactory: () => `perf-verification-${verifyCounter}`,
    });
    diagReport = result.report;
    return result;
  }

  beforeAll(() => {
    const buildLarge = measure('fixture-build-large-workspace', () =>
      buildLargeWorkspace({
        specs: 500,
        tasksPerSpec: 20,
        stateEvery: 5,
        unicodeEvery: 50,
        largeDocEvery: 100,
        evidence: { spec: 'spec-0000', records: 300 },
        routedEvidenceSpecs: 8,
        git: true,
        diffFiles: 2000,
        templatePacks: 490,
        extensionEntries: 500,
        registryEntries: 500,
      }),
    );
    large = buildLarge.value;
    const buildDiag = measure('fixture-build-diagnostics-workspace', () =>
      buildLargeWorkspace({
        specs: 10,
        tasksPerSpec: 20,
        git: true,
        diagnosticsSpec: { name: DIAG_SPEC, doneTasks: 200 },
      }),
    );
    diag = buildDiag.value;
  }, 240_000);

  afterAll(() => {
    // Best-effort cleanup; read-only git objects on Windows may refuse.
    for (const root of [large?.root, diag?.root]) {
      if (root === undefined) continue;
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // The OS temp directory owns whatever remains.
      }
    }
  });

  it('detects the workspace and discovers 500 specs within budget', { timeout: 60_000 }, () => {
    detectKiroWorkspace(large.root);
    discoverSpecs(large.workspace);

    const detect = measure('workspace-detect', () => detectKiroWorkspace(large.root));
    expect(detect.value.found).toBe(true);
    expect(detect.value.hasSpecsDir).toBe(true);

    const discovery = measure('spec-discovery-500-specs', () => discoverSpecs(large.workspace));
    expect(discovery.value).toHaveLength(500);
    const fileCount = discovery.value.reduce((count, folder) => count + folder.files.length, 0);
    expect(fileCount).toBe(1500);

    expect(detect.ms + discovery.ms).toBeLessThan(BUDGET_MS.workspaceDetectAndDiscovery);
  });

  it('parses all 10,000 tasks across 500 tasks.md documents', { timeout: 120_000 }, () => {
    const folders = discoverSpecs(large.workspace);
    const countAllTasks = (): number => {
      let count = 0;
      for (const folder of folders) {
        const tasksFile = specFile(folder, 'tasks');
        if (tasksFile === undefined) continue;
        count += parseTasks(MarkdownDocument.load(tasksFile.path)).allTasks.length;
      }
      return count;
    };

    countAllTasks(); // warm-up (OS file cache + JIT)
    const parsed = measure('parse-all-tasks-10000', countAllTasks);
    expect(large.totalTasks).toBe(10_000);
    expect(parsed.value).toBe(10_000);
    expect(parsed.ms).toBeLessThan(BUDGET_MS.parseAllTasks);
  });

  it('reads a single spec without scaling with workspace size', { timeout: 60_000 }, () => {
    const readSingle = (): ReturnType<typeof analyzeSpec> => {
      const folder = requireSpec(large.workspace, 'spec-0250');
      return analyzeSpec(large.workspace, folder);
    };

    readSingle(); // warm-up
    const single = measure('single-spec-read', readSingle);
    expect(single.value.tasks?.allTasks).toHaveLength(20);
    expect(single.value.requirements?.requirements).toHaveLength(10);
    // spec-0250 is in the sidecar-state subset with byte-exact approval hashes.
    const state = readSpecState(large.workspace, 'spec-0250');
    expect(state.state?.stages.requirements?.status).toBe('approved');
    // Must stay far below the full-workspace budgets: this is the
    // "interactive command" class of docs/performance.md.
    expect(single.ms).toBeLessThan(BUDGET_MS.singleSpecRead);
  });

  it('verifies one spec carrying ~200 diagnostics deterministically', { timeout: 120_000 }, async () => {
    await runDiagVerify(); // warm-up
    const verified = await measureAsync('verify-spec-200-diagnostics', runDiagVerify);

    const specResult = verified.value.report.specResults[0];
    expect(specResult?.specName).toBe(DIAG_SPEC);
    const sbv004 = (specResult?.diagnostics ?? []).filter((d) => d.ruleId === 'SBV004');
    expect(sbv004).toHaveLength(200);
    // Warnings only — the run passes under failOn: error and stays deterministic.
    expect(verified.value.report.summary.warnings).toBeGreaterThanOrEqual(200);
    expect(verified.ms).toBeLessThan(BUDGET_MS.verifyDiagnosticsSpec);
  });

  it('resolves a 2,000-file working-tree diff and the affected specs', { timeout: 300_000 }, async () => {
    await resolveComparison(large.root, { mode: 'working-tree' }); // warm-up
    const comparison = await measureAsync('working-tree-comparison-2000-files', () =>
      resolveComparison(large.root, { mode: 'working-tree' }),
    );
    expect(comparison.value.ok).toBe(true);
    expect(comparison.value.changedFiles).toHaveLength(2000);
    expect(comparison.ms).toBeLessThan(BUDGET_MS.workingTreeComparison);

    // Warm with a slice (primes policy/design/evidence reads), then time the full set.
    resolveAffectedSpecs(large.workspace, comparison.value.changedFiles.slice(0, 100));
    const affected = measure('affected-specs-500-specs-2000-files', () =>
      resolveAffectedSpecs(large.workspace, comparison.value.changedFiles),
    );
    // Every spec claims its `src/<spec>/index.ts` + `service.ts` via design references.
    expect(affected.value.affected).toHaveLength(500);
    const sample = affected.value.affected.find((spec) => spec.specName === 'spec-0000');
    expect(sample?.matches.some((match) => match.via.includes('design reference'))).toBe(true);
    // The extra-*.txt waves are deliberately unclaimed.
    expect(affected.value.unmapped).toHaveLength(1000);
    expect(affected.value.ambiguous).toHaveLength(0);
    expect(affected.ms).toBeLessThan(BUDGET_MS.affectedSpecs);
  });

  it('reads a 300-record append-only evidence history', { timeout: 60_000 }, () => {
    listSpecEvidence(large.workspace, 'spec-0000'); // warm-up
    const history = measure('evidence-history-300-records', () =>
      listSpecEvidence(large.workspace, 'spec-0000'),
    );
    const total = [...history.value.values()].reduce((count, records) => count + records.length, 0);
    expect(total).toBe(300);
    expect(history.ms).toBeLessThan(BUDGET_MS.evidenceHistory);
  });

  it('loads and searches a 500-pack template catalog', { timeout: 120_000 }, () => {
    loadTemplateCatalog(large.workspace); // warm-up
    const catalog = measure('template-catalog-500-packs', () => loadTemplateCatalog(large.workspace));
    expect(catalog.value.entries).toHaveLength(500);
    expect(catalog.value.entries.filter((entry) => entry.source === 'project')).toHaveLength(490);
    expect(catalog.value.entries.filter((entry) => entry.source === 'builtin')).toHaveLength(10);
    expect(catalog.value.entries.every((entry) => entry.valid)).toBe(true);

    const search = measure('template-search-500-packs', () =>
      searchTemplates(catalog.value, 'telemetry'),
    );
    expect(search.value.length).toBeGreaterThanOrEqual(10);
    expect(catalog.ms).toBeLessThan(BUDGET_MS.templateCatalog);
    expect(search.ms).toBeLessThan(BUDGET_MS.templateSearch);
  });

  it('lists and searches 500 installed extension entries', { timeout: 60_000 }, () => {
    listInstalledExtensions(large.workspace); // warm-up
    const catalog = measure('extension-catalog-500-entries', () =>
      listInstalledExtensions(large.workspace),
    );
    expect(catalog.value.entries).toHaveLength(500);
    expect(catalog.value.diagnostics).toHaveLength(0);

    const search = measure('extension-search-500-entries', () =>
      searchInstalledExtensions(catalog.value, 'telemetry'),
    );
    expect(search.value.length).toBeGreaterThan(0);
    const exact = searchInstalledExtensions(catalog.value, 'perf-ext-123');
    expect(exact[0]?.id).toBe('perf-ext-123');
    expect(catalog.ms).toBeLessThan(BUDGET_MS.extensionCatalog);
    expect(search.ms).toBeLessThan(BUDGET_MS.extensionSearch);
  });

  it('searches a 500-entry cached registry index offline', { timeout: 60_000 }, () => {
    const config = readRegistriesConfig(large.workspace);
    const source = config.config.registries.find((entry) => entry.name === PERF_REGISTRY_SOURCE);
    expect(source?.type).toBe('https');
    if (source === undefined) throw new Error('perf registry source missing');

    resolveRegistryIndex(large.workspace, source); // warm-up
    const resolved = measure('registry-cache-read-500-entries', () =>
      resolveRegistryIndex(large.workspace, source),
    );
    expect(resolved.value?.origin).toBe('cache');
    expect(resolved.value?.index.extensions).toHaveLength(500);
    if (resolved.value === undefined) throw new Error('perf registry cache missing');

    const indexes = [{ registryName: resolved.value.sourceName, index: resolved.value.index }];
    const search = measure('registry-search-500-entries', () =>
      searchRegistryIndexes(indexes, 'telemetry'),
    );
    expect(search.value.length).toBeGreaterThan(0);
    expect(searchRegistryIndexes(indexes, 'reg-ext-321')[0]?.entry.id).toBe('reg-ext-321');
    expect(resolved.ms).toBeLessThan(BUDGET_MS.registryResolve);
    expect(search.ms).toBeLessThan(BUDGET_MS.registrySearch);
  });

  it('serves a bounded, paginated spec_list over MCP', { timeout: 300_000 }, async () => {
    const session = await connectMcp(large.root, { logLevel: 'silent' });
    try {
      await callTool(session, 'spec_list', { limit: 5 }); // warm-up

      const first = await measureAsync('mcp-spec-list-page', () => callTool(session, 'spec_list', {}));
      expect(first.value.isError).toBe(false);
      const specs = first.value.structured['specs'] as { name: string }[];
      const pagination = first.value.structured['pagination'] as {
        totalCount: number;
        truncated: boolean;
        nextCursor?: string;
      };
      // Bounded: the default page is 50 summaries, never the whole workspace.
      expect(specs).toHaveLength(50);
      expect(specs[0]?.name).toBe('spec-0000');
      expect(pagination.totalCount).toBe(500);
      expect(pagination.truncated).toBe(true);
      expect(typeof pagination.nextCursor).toBe('string');

      const pageBytes = Buffer.byteLength(JSON.stringify(first.value.structured), 'utf8');
      log('mcp-spec-list-page-size', pageBytes, 'bytes');
      expect(pageBytes).toBeLessThan(512 * 1024);

      // The cursor advances deterministically to the next 50 specs.
      const second = await callTool(session, 'spec_list', {
        cursor: pagination.nextCursor as string,
      });
      expect(second.isError).toBe(false);
      const secondSpecs = second.structured['specs'] as { name: string }[];
      expect(secondSpecs).toHaveLength(50);
      expect(secondSpecs[0]?.name).toBe('spec-0050');

      expect(first.ms).toBeLessThan(BUDGET_MS.mcpSpecListPage);
    } finally {
      await session.close();
    }
  });

  it('renders JSON, Markdown, and HTML verification reports within budget', { timeout: 120_000 }, async () => {
    const report = diagReport ?? (await runDiagVerify()).report;
    // Warm-up
    serializeJsonReport(createJsonReport('specbridge.verification-report', 'perf-suite', report));
    renderVerificationMarkdown(report, { maxDiagnosticsPerSpec: 500 });
    renderVerificationHtml(report);

    const json = measure('report-render-json', () =>
      serializeJsonReport(createJsonReport('specbridge.verification-report', 'perf-suite', report)),
    );
    const markdown = measure('report-render-markdown', () =>
      renderVerificationMarkdown(report, { maxDiagnosticsPerSpec: 500 }),
    );
    const html = measure('report-render-html', () => renderVerificationHtml(report));

    expect(json.value).toContain('SBV004');
    expect(markdown.value).toContain('# SpecBridge Verification');
    expect(markdown.value).toContain('SBV004');
    expect(html.value).toContain('SBV004');
    log('report-json-size', Buffer.byteLength(json.value, 'utf8'), 'bytes');
    log('report-html-size', Buffer.byteLength(html.value, 'utf8'), 'bytes');
    // Bounded output: even a 200-diagnostic report stays comfortably under 5 MiB.
    expect(Buffer.byteLength(json.value, 'utf8')).toBeLessThan(5 * 1024 * 1024);
    expect(Buffer.byteLength(html.value, 'utf8')).toBeLessThan(5 * 1024 * 1024);
    expect(json.ms + markdown.ms + html.ms).toBeLessThan(BUDGET_MS.reportRenderAll);
  });

  it('keeps heap bounded after a full 500-spec analysis pass', { timeout: 300_000 }, () => {
    const analysis = measure('analyze-workspace-500-specs', () => analyzeWorkspace(large.workspace));
    expect(analysis.value.specs).toHaveLength(500);
    expect(analysis.value.roundTripSafe).toBe(true);

    const heapUsed = process.memoryUsage().heapUsed;
    log('heap-used-after-analysis', heapUsed / (1024 * 1024), 'MB');
    // Informational, deliberately generous: the pass must not need gigabytes.
    expect(heapUsed).toBeLessThan(MAX_HEAP_BYTES);
    expect(analysis.ms).toBeLessThan(BUDGET_MS.workspaceAnalyze);
  });
});
