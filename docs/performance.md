# Performance (v1.0.0 large-repository suite)

SpecBridge's v1.0.0 performance suite measures the library surface against a
deterministically generated large workspace and gates every measurement with a
generous CI budget. The suite lives in `tests/performance/` and is fully
offline: no model calls, no network — the MCP session runs over in-memory
transports and registry search reads a pre-written cache.

## How to run

```bash
npx vitest run tests/performance
```

The suite runs as part of the normal test tree (it matches the standard
`tests/**/*.test.ts` include). Set `SPECBRIDGE_SKIP_PERF=1` to skip it during
quick local iteration on unrelated tests. The whole suite — including building
both fixtures from scratch — completes in about one minute on a development
machine and is budgeted to stay well under four minutes on slow CI runners.

Every measurement is printed in a stable format so CI logs double as an
informational benchmark:

```
perf: <metric> = <value> ms
```

## Methodology

### Fixture shape

`tests/performance/fixture.ts` generates the workspace deterministically — a
fixed-seed linear congruential counter and a fixed epoch drive every varying
value; there is no `Math.random` and no wall-clock input, so two builds with
the same options are byte-identical apart from the temp-directory name.

The primary fixture is `buildLargeWorkspace({ specs: 500, tasksPerSpec: 20, … })`:

- **500 specs / 10,000 tasks** under `.kiro/specs/spec-0000` … `spec-0499`.
  Each spec has a `requirements.md` with 10 requirements × 3 EARS-style
  acceptance criteria, a `design.md` whose backtick path references
  (`src/<spec>/index.ts`, `src/<spec>/service.ts`) give affected-spec
  detection a real matching surface, and a `tasks.md` whose checkbox
  hierarchy nests four levels deep (`b` → `b.1` → `b.1.1` → `b.1.1.1`) with
  `_Requirements: r.c_` references on detail lines.
- **Large UTF-8 content**: every 50th spec carries CJK, emoji (including
  ZWJ sequences), and combining characters; every 100th spec has a ~64 KiB
  design document.
- **Sidecar state for a subset**: every 5th spec (100 total) has a
  schema-valid `spec-state` JSON (schemaVersion 1.0.0) whose
  requirements/design approvals record `approvedHash` values computed with
  SHA-256 over the exact bytes on disk.
- **Evidence history**: 300 append-only evidence records on `spec-0000`
  (round-robin across its leaf tasks) plus thin routed evidence on eight more
  specs, all schema-validated at write time.
- **Template packs**: 490 valid local packs under `.specbridge/templates/`
  plus the 10 built-ins = a 500-entry catalog.
- **Extension catalog**: `.specbridge/extensions/state.json` with 500
  installed entries (no real archives) and permission grants for half.
- **Registry**: a 500-entry index cached under `.specbridge/registry-cache/`
  for a configured `https` source, so search runs entirely offline.
- **Git diff surface**: a real git repository (baseline commit of everything
  above) plus 2,000 untracked working-tree files under `src/` — two waves
  land exactly on the paths each spec's design references (claimed), two
  waves are deliberately unmapped extras.

A second, small fixture (10 specs + one `perf-diagnostics` spec with 200
checked leaf tasks and no evidence) drives the many-diagnostics verification
and report-rendering measurements without contaminating them with the large
diff surface: verification of that spec deterministically produces exactly
200 `SBV004` warnings.

### Cold vs. warm

Each test performs one warm-up call and then times a single run with
`performance.now()`. The published numbers are therefore **warm** numbers:
the OS file cache and the JIT are primed. Cold-start costs show up only in
the (unasserted) fixture-build metric and in each test's warm-up. This is
intentional — the budgets exist to catch algorithmic regressions, not to
model first-touch disk latency, which varies wildly across CI hardware.

### Hardware disclaimer

The measurements below are **indicative only**. They were taken on a single
Windows 11 development machine (NTFS, local SSD, Node 22-line, vitest 3);
absolute values on other machines — especially CI runners with cold caches
and slower filesystem metadata operations — will differ by multiples. Only
the relative shape (what is O(1), what scales with workspace size) transfers.

## Measured numbers (indicative) and CI budgets

| Metric | What it covers | Measured | CI budget |
| --- | --- | ---: | ---: |
| `workspace-detect` + `spec-discovery-500-specs` | `.kiro` detection + full spec-folder discovery (500 specs, 1,500 files) | 0.8 ms + 186.3 ms | 5,000 ms |
| `parse-all-tasks-10000` | Load + parse all 500 `tasks.md` documents, count 10,000 tasks | 89.8 ms | 3,000 ms |
| `single-spec-read` | `requireSpec` + `analyzeSpec` of one spec on the 500-spec workspace | 182.9 ms | 3,000 ms |
| `verify-spec-200-diagnostics` | Deterministic drift verification of one spec producing 200 SBV004 diagnostics | 292.3 ms | 10,000 ms |
| `working-tree-comparison-2000-files` | git working-tree comparison resolving 2,000 changed files | 851.6 ms | 15,000 ms |
| `affected-specs-500-specs-2000-files` | Affected-spec resolution: 500 specs × 2,000 files | 592.1 ms | 10,000 ms |
| `evidence-history-300-records` | Read + validate a 300-record append-only evidence history | 56.2 ms | 2,000 ms |
| `template-catalog-500-packs` | Load 490 disk packs + 10 built-ins with full validation | 846.2 ms | 15,000 ms |
| `template-search-500-packs` | Keyword search over the loaded 500-entry catalog | 2.6 ms | 500 ms |
| `extension-catalog-500-entries` | List 500 installed-extension entries with grant/compat checks | 50.3 ms | 2,000 ms |
| `extension-search-500-entries` | Keyword search over the extension catalog | 0.6 ms | 500 ms |
| `registry-cache-read-500-entries` | Read + schema-validate the 500-entry cached registry index | 10.9 ms | 1,000 ms |
| `registry-search-500-entries` | Lexical search over the cached index | 0.9 ms | 500 ms |
| `mcp-spec-list-page` | One paginated `spec_list` MCP call on the 500-spec workspace | 1,050.9 ms | 15,000 ms |
| `mcp-spec-list-page-size` | Serialized structured response of that page (50 summaries) | 14,638 bytes | < 512 KiB |
| `report-render-json` / `-markdown` / `-html` | Render the 200-diagnostic verification report in all three formats | 0.6 / 0.3 / 0.4 ms | 1,000 ms (sum) |
| `analyze-workspace-500-specs` | Full doctor-style workspace analysis (parse + round-trip check of every document) | 948.2 ms | 15,000 ms |
| `heap-used-after-analysis` | Process heap after the full analysis pass | 77.7 MB | < 1.5 GiB |
| `fixture-build-large-workspace` | Building the fixture itself (~9,000 files + git baseline commit) | 42.4 s | not asserted |

Whole-suite wall time on the same machine: **~63 s** (12 tests), dominated by
fixture construction, comfortably inside the ~4-minute suite target.

## Budget classes

- **Interactive commands stay interactive on the large fixture.** Single-spec
  read/status, verifying one spec, reading an evidence history, and every
  catalog/search operation each measure well under a second and are budgeted
  at a few seconds.
- **Whole-workspace passes are linear and bounded.** Discovery, the
  10,000-task parse, full analysis, affected-spec resolution over a
  2,000-file diff, and an MCP `spec_list` page each measure around or under
  one second and are budgeted at 3–15 s.
- **List/search results are bounded.** MCP list tools paginate (default page
  50, cursor-continued, 2 MiB structured-response ceiling); the measured
  `spec_list` page is ~14.6 KiB regardless of workspace size. In-memory
  searches over loaded catalogs are ~1 ms.
- **Memory is bounded.** A full parse-everything pass over 500 specs holds
  ~78 MB of heap — the 1.5 GiB assertion is an informational tripwire, not a
  target.
- **Verification parses each relevant document once per run.** The
  verification engine builds one context per selected spec (with run-level
  caches) and the 200-diagnostic run costs ~0.3 s; report rendering in all
  three formats is sub-millisecond.

## Why the CI thresholds are generous

Each budget is roughly **10x the measured value**, rounded up to a friendly
class, with two deliberate exceptions:

- Sub-10 ms measurements (the in-memory searches, report rendering) get an
  absolute floor of 500–1,000 ms instead — a literal 10x budget on a 0.6 ms
  measurement would flake on a single GC pause or scheduler hiccup.
- Operations dominated by git subprocesses or thousands of filesystem
  metadata calls (comparison, template catalog, MCP page, full analysis) get
  extra headroom, because Windows CI runners are routinely several times
  slower than a development machine for exactly these operations.

The budgets exist to catch algorithmic regressions (a linear pass turning
quadratic will blow through 10x immediately), not to benchmark CI hardware.
The logged `perf:` lines are the benchmark; the assertions are the tripwire.

## Findings (recorded, not fixed here)

Two linear-scan behaviors surfaced by the measurements are worth flagging.
Neither is quadratic and neither breaches its budget at the 500-spec target
scale, but both put a whole-workspace term inside nominally single-spec or
single-page operations:

1. **Single-spec lookup scans the whole specs directory.**
   `findSpec`/`requireSpec` (packages/compat-kiro/src/spec-discovery.ts) call
   `discoverSpecs`, which enumerates every spec folder and `stat`s every file,
   to locate one spec by name. The measurement makes the split visible:
   `single-spec-read` = 182.9 ms on the 500-spec workspace, of which the full
   directory enumeration accounts for ~186 ms-equivalent (`spec-discovery` =
   186.3 ms) while parsing the one spec's three documents costs ~0.2 ms
   (10,000 tasks parse in 89.8 ms ⇒ ~0.18 ms/spec). Every single-spec
   interactive command therefore carries an O(workspace) directory-scan term.
   A direct `.kiro/specs/<name>` existence check would make lookup O(1); the
   case-insensitive match currently requires the scan.

2. **MCP `spec_list` fully analyzes every spec on every page.**
   The handler (packages/mcp-server/src/tools/spec-list.ts) maps
   `discoverSpecs` → `analyzeSpec` — a full parse of all three documents for
   all 500 specs — before slicing out the requested page of 50. Measured:
   ~1,051 ms per page at 500 specs, repeated for each cursor continuation,
   while the response itself stays bounded at ~14.6 KiB. The work is
   O(workspace content) per page rather than O(page). Fine at 500 specs;
   extrapolated to 5,000 specs a single page would cost ~10 s. The filters
   (status, stale approvals, task progress) currently need the full analysis,
   but an unfiltered name-only page would not.

No superlinear behavior was observed anywhere: affected-spec resolution
performs 500 × 2,000 = 1,000,000 match probes in 592 ms, the template catalog
validates 490 disk packs in 846 ms, and task parsing sustains ~110k tasks/s.
