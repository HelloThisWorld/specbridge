# SpecBridge extensions

SpecBridge v0.7.1 adds a secure extension ecosystem: third parties extend
SpecBridge **without modifying the core**. Executable extensions always run
out of process behind a versioned stdio protocol, install disabled, and can
run only after the user explicitly accepts their declared permissions.

Five stable extension kinds exist:

| Kind | What it does | Executable |
| --- | --- | --- |
| `template-provider` | Contributes v0.7.0-format spec template packs | No — data-only |
| `analyzer` | Returns diagnostics for bounded spec content | Yes |
| `verifier` | Returns diagnostics for a bounded verification context | Yes |
| `exporter` | Returns candidate output files; SpecBridge writes them | Yes |
| `runner` | An out-of-process adapter behind the frozen v0.6.0 runner contract | Yes |

Extensions can never approve stages, mark tasks complete, change evidence, or
disable built-in protected-path rules. Their output is never task-completion
evidence. See [extensions/overview.md](extensions/overview.md) for the
architecture and [extensions/security.md](extensions/security.md) for the
threat model and the honest limitations: **process isolation and permission
declarations are safety boundaries and audit mechanisms, not an OS sandbox**,
and **checksums prove integrity, not publisher identity**.

## Gallery

<!-- BEGIN GENERATED EXTENSION GALLERY (pnpm generate:extension-gallery) -->

Registry: **specbridge-examples** (5 extensions). Listing is not endorsement; review permissions before enabling.

| Extension | Kind | Version | Description | Permissions | SpecBridge | Source |
| --- | --- | --- | --- | --- | --- | --- |
| `example-analyzer` | analyzer | 1.0.0 | Deterministic spec diagnostics contributed by the example-analyzer analyzer extension. | specRead | `>=0.7.1 <2.0.0` | [source](https://github.com/HelloThisWorld/specbridge) |
| `example-exporter` | exporter | 1.0.0 | Candidate export files produced by the example-exporter exporter extension. | specRead | `>=0.7.1 <2.0.0` | [source](https://github.com/HelloThisWorld/specbridge) |
| `example-runner` | runner | 1.0.0 | An out-of-process runner adapter provided by the example-runner extension. | specRead, repositoryRead, repositoryWrite | `>=0.7.1 <2.0.0` | [source](https://github.com/HelloThisWorld/specbridge) |
| `example-template-provider` | template-provider | 1.0.0 | Spec template packs contributed by the example-template-provider template-provider extension. | none | `>=0.7.1 <2.0.0` | [source](https://github.com/HelloThisWorld/specbridge) |
| `example-verifier` | verifier | 1.0.0 | Verification diagnostics contributed by the example-verifier verifier extension. | specRead | `>=0.7.1 <2.0.0` | [source](https://github.com/HelloThisWorld/specbridge) |

<!-- END GENERATED EXTENSION GALLERY -->

The reference extensions above live in [`examples/extensions/`](../examples/extensions)
and are maintained with SpecBridge itself — reference implementations, not
production recommendations.

## Try it

```bash
# Discover (offline; searches the built-in and cached registry indexes)
specbridge registry search analyzer

# Install from a local archive or directory — installs disabled, runs no code
specbridge extension install ./example-analyzer-1.0.0.specbridge-extension.zip
specbridge extension show example-analyzer

# Enable by accepting the exact permission hash shown by `show`
specbridge extension enable example-analyzer --accept-permissions <hash>

# Use it
specbridge spec analyze my-spec --extension example-analyzer
```

## Build your own

```bash
specbridge extension scaffold my-analyzer --kind analyzer --output ./my-analyzer
specbridge extension validate ./my-analyzer
specbridge extension conformance ./my-analyzer --yes
specbridge extension package ./my-analyzer
```

Guides: [creating analyzers](extensions/creating-analyzers.md) ·
[verifiers](extensions/creating-verifiers.md) ·
[exporters](extensions/creating-exporters.md) ·
[runners](extensions/creating-runners.md) ·
[template providers](extensions/creating-template-providers.md) ·
[packaging](extensions/packaging.md) ·
[publishing](extensions/publishing.md) ·
[registry contribution](extensions/registry-contribution.md)

Contributions enter the community index via
[`registry/CONTRIBUTING.md`](../registry/CONTRIBUTING.md).
