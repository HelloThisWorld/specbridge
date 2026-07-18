# Extension manifest reference

Every extension package carries a `specbridge-extension.json` at its root.
The manifest is parsed with a strict schema — unknown fields are rejected,
every string is length-bounded, and documents above **256 KB** fail before
parsing (`SBE008`). Validation never executes anything; all findings are
reported at once as `SBE` issues.

## Full example

The maintained reference analyzer
(`examples/extensions/example-analyzer/specbridge-extension.json`):

```json
{
  "schemaVersion": "1.0.0",
  "protocolVersion": "1.0.0",
  "id": "example-analyzer",
  "version": "1.0.0",
  "displayName": "example-analyzer",
  "description": "Deterministic spec diagnostics contributed by the example-analyzer analyzer extension.",
  "kind": "analyzer",
  "entrypoint": "dist/extension.cjs",
  "compatibility": {
    "specbridge": ">=1.0.0 <2.0.0",
    "extensionSdk": ">=1.0.0 <2.0.0"
  },
  "capabilities": {
    "operations": ["analyzer.analyze"]
  },
  "permissions": {
    "specRead": true,
    "repositoryRead": false,
    "repositoryWrite": false,
    "network": false,
    "childProcess": false,
    "environmentVariables": []
  },
  "license": "MIT",
  "keywords": ["analyzer", "specbridge-extension"]
}
```

## Required fields

| Field | Rules |
| --- | --- |
| `schemaVersion` | Strict `X.Y.Z`; supported major is `1` (`SBE005` otherwise) |
| `protocolVersion` | Strict `X.Y.Z`; major must match the supported protocol `1.0.0` (`SBE007`) |
| `id` | Extension ID grammar below; max 64 characters (`SBE003`) |
| `version` | Strict `X.Y.Z` — no ranges, no prerelease tags |
| `displayName` | 1–100 characters |
| `description` | 1–500 characters |
| `kind` | One of `template-provider`, `analyzer`, `verifier`, `exporter`, `runner` |
| `compatibility.specbridge` | A validated semver range the running SpecBridge must satisfy (`SBE006` at load time) |
| `capabilities.operations` | Operations declared for this kind (table below); max 16, no duplicates |
| `permissions` | All six permission fields, explicitly (see [permissions.md](permissions.md)) |
| `license` | 1–100 characters (SPDX identifier recommended) |

## Optional fields

`entrypoint` (rules below), `compatibility.extensionSdk` (semver range),
`author` (`{name, email?, url?}`), `homepage` and `repository` (must be
`https://` URLs), `keywords` (max 12, each max 30 characters), `deprecated`
(boolean), `replacement` (a valid extension ID; warns unless `deprecated` is
true), `examples` (max 5), `configurationSchema` (a JSON object describing
the extension's `configuration` input), and `minimumNodeVersion` (`X.Y.Z`).

## Entrypoint rules

- **Required** for executable kinds (`analyzer`, `verifier`, `exporter`,
  `runner`) — missing is `SBE012`.
- **Forbidden** for `template-provider` — data-only packages must not declare
  one (`SBE004`).
- Must be a relative, forward-slash path to a `.cjs`, `.mjs`, or `.js` file
  inside the package: no `..`, no leading `/`, no drive letters, no
  backslashes, no null bytes. The declared file must exist in the package,
  and symlinks anywhere on the entrypoint path are rejected at run time
  (`SBE011`).

The host always runs the entrypoint as `node <entrypoint>` in a fresh child
process — an entrypoint is never imported into the SpecBridge process.

## Extension ID grammar

`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, at most 64 characters: lowercase letters
and digits in hyphen-separated segments, starting with a letter. IDs double
as store directory names, registry keys, and the namespace prefix for
diagnostic rule IDs, so the grammar is deliberately restrictive.

| Example | Verdict |
| --- | --- |
| `security-analyzer`, `jira-exporter`, `runner2` | Valid |
| `Security-Analyzer` | Invalid — uppercase |
| `security_analyzer` | Invalid — underscore |
| `-analyzer`, `analyzer-` | Invalid — leading/trailing hyphen |
| `security--analyzer` | Invalid — consecutive hyphens |
| `2fast` | Invalid — starts with a digit |
| `sec/analyzer` | Invalid — path separator |

## Operations per kind

| Kind | Required | Optional |
| --- | --- | --- |
| `template-provider` | none — must declare **no** operations | none |
| `analyzer` | `analyzer.analyze` | — |
| `verifier` | `verifier.verify` | — |
| `exporter` | `exporter.export` | — |
| `runner` | `runner.detect` | `runner.generateStage`, `runner.refineStage`, `runner.executeTask`, `runner.resumeTask`, `runner.listModels` |

Declaring an operation outside the kind's list is `SBE021`. Declared
operations are a ceiling, not a suggestion: the host only ever invokes
declared operations, and an extension reporting undeclared operations at
runtime fails the handshake.

`template-provider` manifests are additionally rejected when they request
`repositoryRead`, `repositoryWrite`, `network`, `childProcess`, or any
environment variable — data-only packages get no permissions.
