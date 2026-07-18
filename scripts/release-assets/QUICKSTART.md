# SpecBridge {{VERSION}} — {{TARGET}} archive

SpecBridge is an open, model-agnostic spec runtime for existing Kiro
projects. It reads your `.kiro/steering` and `.kiro/specs` files exactly
where they are — no conversion, no duplicated specs, no lock-in — and adds
validated authoring, explicit approvals, evidence-gated execution,
deterministic drift verification, and an MCP server on top.

## What is in this archive

| Path | Purpose |
| --- | --- |
| `bin/` | launchers: `specbridge` (CLI) and `specbridge-mcp` (MCP server over stdio) |
| `lib/` | self-contained CommonJS bundles (`cli.cjs`, `mcp-server.cjs`) |
{{RUNTIME_ROW}}| `release-manifest.json` | build provenance and per-file SHA-256 checksums |
| `THIRD_PARTY_LICENSES.txt` | licenses of the third-party packages bundled into `lib/` |
| `LICENSE`, `NOTICE.md` | SpecBridge license (MIT) and independent-project notice |

Nothing here writes outside your project directory, and nothing phones
home. Verify the archive contents against `release-manifest.json` and the
release-level `SHA256SUMS.txt` if you want to check integrity. Checksums
prove integrity, not publisher identity: the archives are not code-signed.

## Run it

{{RUN_SECTION}}

## First commands

Run inside any project that contains a `.kiro/` directory:

```
specbridge doctor        # read-only health check
specbridge spec list     # every spec, with classification and status
specbridge spec show <name>
specbridge compat check  # proves byte-identical .kiro round-trips
```

`specbridge doctor` in a directory without `.kiro/` prints guidance and
exits non-zero — SpecBridge never scaffolds or modifies anything on its
own.

## MCP server

`bin/specbridge-mcp --stdio` starts the MCP server over stdio (37 tools).
Point your MCP client's command at that launcher. See
`specbridge mcp doctor` and the documentation for client configuration.

## Documentation

Full documentation, examples, templates, the extension SDK, and the Claude
Code plugin: <https://github.com/HelloThisWorld/specbridge>

SpecBridge is an independent open-source project, not affiliated with or
endorsed by AWS or the Kiro team (see `NOTICE.md`). MIT licensed.
