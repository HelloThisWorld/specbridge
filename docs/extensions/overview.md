# Extension architecture

SpecBridge v0.7.1 lets third parties extend SpecBridge without modifying the
core. The design rests on three decisions: executable extension code always
runs **out of process** behind a versioned stdio protocol, every extension
**installs disabled** and runs only after explicit, hash-bound permission
acceptance, and extension output is always **data the host validates** —
never instructions and never evidence. This page is the map; the
[hub page](../extensions.md) links every guide, and
[security.md](security.md) carries the threat model.

## Five kinds

| Kind | Contract | Execution |
| --- | --- | --- |
| `template-provider` | Contributes v0.7.0-format template packs under `templates/` | None — data-only, no entrypoint, no process ever starts |
| `analyzer` | Receives bounded spec content, returns diagnostics | Out-of-process |
| `verifier` | Receives a bounded verification context, returns a status plus diagnostics | Out-of-process |
| `exporter` | Receives a bounded spec context, returns candidate files the host writes | Out-of-process |
| `runner` | Implements the frozen v0.6.0 runner semantics behind a host-side proxy | Out-of-process |

Kind determines which operations a manifest may declare and which inputs the
host will ever send. See [manifest.md](manifest.md) for the declaration rules
and the per-kind creation guides for the payload shapes.

## The stdio protocol

Executable extensions are spawned as `node <entrypoint>` (argv array, never a
shell) with the installed extension directory as working directory and a
sanitized environment. Communication is JSON-RPC 2.0 over JSON Lines: exactly
one JSON object per stdout line, protocol version `1.0.0`, messages bounded
at 2 MB. stdout is reserved for protocol messages; all extension logging goes
to stderr. One fresh process serves one invocation session — there is no
long-lived extension daemon. [protocol.md](protocol.md) documents the
methods, the initialize handshake, error codes, and timeouts.

## Lifecycle

```text
specbridge extension install <source>     # validate only; installs DISABLED; runs no code
specbridge extension show <id>            # permissions + the exact permission hash
specbridge extension enable <id> --accept-permissions <hash>
specbridge spec analyze <spec> --extension <id>   # (or verify / export / run)
```

1. **Install** never executes anything: no lifecycle scripts, no imports.
   The package is validated (manifest, checksums, forbidden files, limits),
   staged, atomically renamed into place, and revalidated from disk.
2. **Show** prints the declared permissions and the deterministic permission
   hash computed from the extension ID, version, exact manifest bytes, and
   normalized permission set.
3. **Enable** requires `--accept-permissions` with exactly that hash. The
   installed package is revalidated, executable kinds must pass a no-op
   initialize handshake, and the grant is stored. Any later manifest,
   version, or permission change invalidates the grant (`SBE018`).
4. **Use** goes through a single gate: installed, enabled, and grant-valid,
   re-checked on every invocation. `disable` and `uninstall` (disabled
   versions only, recoverable via a trash directory) reverse the lifecycle;
   append-only records preserve the history.

[permissions.md](permissions.md) covers the permission model and grant
invalidation in full.

## State layout

Extension state lives outside `.kiro`, under `.specbridge/extensions/`:

```text
.specbridge/extensions/
├── installed/<extension-id>/<version>/   # the installed package files
├── state.json                            # installed + enabled bookkeeping
├── grants.json                           # accepted permission grants
├── records.jsonl                         # append-only operation history
└── trash/                                # recoverable uninstalled versions
```

Reads are tolerant — invalid state degrades to diagnostics, never crashes,
and is never silently repaired. Writes are atomic and workspace-guarded.
Registry configuration and caches are separate; see [registry](../registry.md).

## What extensions can never do

These are host-enforced invariants, not conventions:

- **Approve stages.** Approval is a human CLI action; no extension code path
  reaches it. `spec analyze` gates approval on built-in analysis; extension
  diagnostics are additive and namespaced (`<extension-id>/<RULE>`).
- **Complete tasks or change evidence.** Verifier and runner results are
  claims. Task completion still requires Git snapshots, trusted verification,
  and the evidence gate; verifier extensions feed the quality gate only
  through the built-in `SBV026` rollup.
- **Disable protected paths or built-in rules.** Built-in verification rules,
  including protected-path checks, always run.
- **Mutate `.kiro` or `.specbridge` state.** Extensions receive bounded data
  and return bounded data; the host performs every write, and conformance
  checks that an extension did not modify its own installed package.
- **Escalate at runtime.** The initialize handshake rejects identity
  mismatches and any capability not declared in the installed manifest.

Process isolation and permission declarations are safety and audit
boundaries, **not an OS sandbox** — an enabled executable extension runs as
local code with your operating-system permissions. Read
[security.md](security.md) before enabling anything.
