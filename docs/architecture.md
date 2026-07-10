# Architecture

SpecBridge is a pnpm workspace of small, single-purpose TypeScript packages.
The CLI is a thin presentation layer; everything it does is available as a
library, so future surfaces (GitHub Action, MCP server) reuse the same code
instead of duplicating logic.

## Packages

| Package | Responsibility |
| --- | --- |
| `@specbridge/core` | Shared types, errors, workspace detection, path-safety guards, atomic writes, sidecar state (`.specbridge/`) |
| `@specbridge/compat-kiro` | Everything `.kiro`: line-preserving Markdown model, steering loader, spec discovery/classification, tolerant parsers, round-trip writer, workspace analysis, agent-context assembly |
| `@specbridge/drift` | Deterministic drift primitives: git-diff parsing, impact areas, requirement/task coverage, evidence storage, report assembly |
| `@specbridge/runners` | Model/agent adapters behind one `AgentRunner` interface (mock implemented; CLI runners detection-only in v0.1) |
| `@specbridge/reporting` | Terminal formatting, JSON report envelope, self-contained HTML rendering |
| `specbridge` (packages/cli) | Commander-based CLI wiring the above together |

Dependency direction (arrows = "may import"):

```
cli ──▶ compat-kiro ──▶ core
cli ──▶ reporting   ──▶ core
drift ─▶ compat-kiro, core        (cli wires drift in Phase H)
runners ─▶ core                   (cli wires runners in Phase F)
```

## Design principles

1. **`.kiro` is the source of truth.** SpecBridge state never leaks into
   `.kiro` files; it lives in `.specbridge/` (see
   [sidecar-state.md](sidecar-state.md)).
2. **Line preservation over ASTs.** Documents are stored as exact lines plus
   their individual line endings. Structure (headings, tasks) is *detected
   over* the lines and carries line indexes; serialization replays the
   original bytes. This is what makes the no-op round trip byte-identical
   and edits surgical. See `packages/compat-kiro/src/markdown-document.ts`.
3. **Tolerant reading, honest reporting.** Parsers never throw on unusual
   content. Anything unrecognized becomes a diagnostic (`info`/`warning`/
   `error`) and the bytes are preserved. A file with zero recognized
   structure is still a valid file.
4. **Deterministic by default.** Default commands are offline and produce
   deterministic output (no timestamps or random ids in v0.1 reports), which
   keeps them testable and CI-friendly. Model invocation is always explicit
   and never required.
5. **Honest stubs.** Documented-but-unimplemented commands and runners exist,
   are labeled "(planned)", and exit with `NOT_IMPLEMENTED` errors. Nothing
   pretends to work.

## Data flow of a typical command

`specbridge spec context <name>`:

1. `core.resolveWorkspace` walks up from the cwd to find `.kiro`.
2. `compat-kiro.requireSpec` locates the spec folder.
3. `compat-kiro.analyzeSpec` loads each Markdown file into a
   `MarkdownDocument`, runs the tolerant parsers, checks the no-op round trip
   in memory, and merges diagnostics.
4. `compat-kiro.buildAgentContextMarkdown` assembles steering + documents +
   progress + working agreements deterministically.
5. The CLI prints the result; with `--out` it writes atomically via
   `core.writeFileAtomic`, refusing paths inside `.kiro`.

## Exit-code contract

`0` success · `1` findings / quality-gate failure (doctor problems, round-trip
mismatch, future drift) · `2` invalid usage, unknown resource, or runtime
error. Planned commands exit `2`.

## Testing strategy

Tests live at the repository root (`tests/`) and run against package
*sources* via vitest aliases, so the suite needs no build. CI additionally
builds and smoke-tests the **built** CLI against `examples/` on
Linux/macOS/Windows × Node 20/22. Fixtures under `tests/fixtures/` are
byte-exact (protected by `.gitattributes -text`) and cover CRLF, BOM, UTF-8,
hand-edited, partial, and unknown-heading workspaces.
