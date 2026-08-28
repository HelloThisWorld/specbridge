# Workspace Bootstrap (vNext.10.2 Phase 1)

An evidence-backed, bounded understanding of the current system, built
BEFORE Product Discovery begins — so a Brownfield conversation starts from
the system that exists instead of re-inventing it.

---

## Three artifacts, three lifetimes

```text
RepositoryContextIndex   = disposable retrieval index
CurrentSystemSnapshot    = durable evidence-backed system understanding
Product Contract         = authoritative product truth
```

These are not interchangeable. The index is derived and rebuildable —
deleting it loses nothing. The snapshot is durable because it is the
explainable starting point of Product Discovery — but it authorizes
nothing. Only the mission lifecycle creates or changes a Product Contract,
and deleting or rebuilding either of the first two never touches the third.

## The lifecycle

```text
workspace opens
    ↓
specbridge workspace bootstrap        (or the workspace_bootstrap MCP tool)
    ↓
CurrentSystemSnapshot                 what does this system currently appear to be?
    ↓
Claude conversation                   builds ON the existing system
    ↓
repository_inspect                    bounded depth, on demand
    ↓
spec-draft                            a product DELTA, not a re-founding
    ↓
formal Spec Intake                    unchanged — still the authority boundary
```

Bootstrap is breadth — a map of the system. Repository retrieval is depth —
inspect details when the conversation needs them. Neither loads a large
repository into a model context.

## Brownfield vs Greenfield

Mode is decided from deterministic evidence, never from a model guessing:

- **BROWNFIELD** — three or more source files, or any existing SpecBridge
  product truth. The snapshot carries capabilities, architecture, public
  surfaces, domain objects, patterns, and constraints, each with evidence.
- **GREENFIELD** — no source and no product truth. A clean empty baseline,
  explicitly not an error; conversation and `spec-draft` behave exactly as
  before.
- **PARTIAL** — not enough evidence to call it (one or two files, a
  truncated index, a repository the resolution flagged). Honest, not fatal.

## Evidence classes

Every finding carries the class of its source, and only one class binds:

| Class | Source | Binds? |
| --- | --- | --- |
| `SEALED_PRODUCT_TRUTH` | active contracts, constitution rules, mission ADRs, seals | yes — existing product authority |
| `DOCUMENTED_ARCHITECTURE` | the repository's own documentation | no — evidence of intent |
| `OBSERVED_IMPLEMENTATION` | source, configuration, manifests, tests | no — what the code does today |
| `INFERRED_PATTERN` | interpretation across several observations | no — visibly inference |

The hard rule: **repository observations cannot become product authority.**
"JobScheduler currently retries three times" is an observation; it becomes
"jobs MUST retry exactly three times" only through a human decision inside
formal Spec Intake. Nothing in bootstrap writes to any mission, contract,
or job store — structurally, not merely by policy.

Every material finding carries evidence refs (repository id, path, symbol,
content hash, or contract/ADR id with revision). A finding without evidence
is rejected by the schema. File bodies are never stored in the snapshot;
the repository remains the source of truth for implementation bytes.

## Freshness

Snapshot identity records each repository's baseline individually. Reads
(`workspace snapshot`, `workspace_snapshot`) always return an explicit
freshness verdict — FRESH, STALE (with reasons), or ABSENT — and a stale
snapshot is never silently presented as current.

`workspace bootstrap` reuses the persisted snapshot only when the committed
baselines match AND the index refresh (hash-verified, additions-discovering)
found no changed bytes. Repository bytes win over the cache; corruption of
either the index cache or the snapshot degrades to a rebuild, never to
partial trust.

## Multi-repository projects

Supported, bounded, inside the workspace root:

1. **Manifest** (`.specbridge/repositories.json`):

   ```json
   {
     "repositories": [
       { "id": "control-plane", "path": "control-plane", "role": "backend" },
       { "id": "agent", "path": "agent", "role": "host-agent" },
       { "id": "console", "path": "console", "role": "frontend" }
     ]
   }
   ```

2. **Detection** — with no manifest, direct child directories carrying
   `.git` are the repositories (plus the root when it is one).
3. **Single repository** — neither of the above: the workspace root is the
   repository. Today's behaviour, zero new configuration.

Baselines are recorded per repository, and every evidence ref names its
repository, so one repository moving never blurs another's evidence.

**Limitation, by design:** repository paths must resolve INSIDE the
workspace root. `assertInsideWorkspace` guards every read/write boundary in
SpecBridge; supporting external sibling roots would mean weakening it
everywhere, so an out-of-root manifest path fails closed. Put the
repository roots inside one workspace directory.

## How Claude uses it

The plugin's MCP surface:

- `workspace_bootstrap` — build or revalidate the snapshot.
- `workspace_snapshot` — the concise current-system summary plus freshness.
- `repository_inspect` — bounded sections for a deeper question, selected
  by the EXISTING deterministic index and retrieval ranking. Protected and
  credential-shaped paths are not reachable through it.

The `spec-draft` skill consults the snapshot for Brownfield work and writes
a product DELTA: existing capabilities are reused by reference, sealed
truth is respected by name, and observations become requirements only
through the user's own words.

## Intake still governs

Workspace Bootstrap is NOT Spec Intake. `spec start` continues to run its
own repository-grounded discovery and remains the only path to product
authority. The double-grounding is intentional: bootstrap helps the
conversation; intake governs the product.
