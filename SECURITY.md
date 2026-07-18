# Security policy

SpecBridge's security model is documented in
[docs/security/threat-model.md](docs/security/threat-model.md) (the
consolidated v1.0.0 threat model) and the per-area documents it links. The
short version of the design goal: a wrong edit to your `.kiro` files or your
repository is the one failure SpecBridge must never cause.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x (current major) | Yes — security fixes land on the latest 1.x release |
| 0.x | No — unsupported once 1.0.0 is released; please upgrade |

## Reporting a vulnerability

Please report vulnerabilities **privately** rather than in a public issue:

1. Open the repository's **Security** tab on
   `github.com/HelloThisWorld/specbridge` and, if GitHub's *private
   vulnerability reporting* is enabled there, use **Report a
   vulnerability** to open a private advisory draft.
2. If private reporting is not available on the Security tab, open a
   minimal public issue that says only "I have a security report — please
   open a private channel" with **no vulnerability details**, and a
   maintainer will arrange one.

There is no security email address for this project; GitHub is the
reporting channel.

## What to include

- The SpecBridge version (`specbridge --version`) and how you installed it
  (npm, plugin, source)
- Platform: OS and version, Node.js version
- Reproduction steps — the smallest workspace and command sequence that
  demonstrates the issue
- Impact: what an attacker gains (which threat-model entry it defeats, if
  you can tell)
- Any relevant output, with sensitive paths redacted

**Never include real secrets, live credentials, API keys, or proprietary
company code in a report.** Reproduce with placeholder values and synthetic
specs; reports are handled by maintainers and may become public advisories
after a fix.

## Known limitations to read before reporting

Some behaviors are documented limitations, not vulnerabilities:

- **Extensions are not sandboxed.** An enabled executable extension runs
  out of process with a sanitized environment, but with your
  operating-system permissions. Permission declarations and hashes are
  review and audit boundaries, not an OS sandbox. "An enabled malicious
  extension can do X on my machine" is the documented trust model, not a
  bypass — a way to run a *disabled* or *never-accepted* extension, or to
  escape the declared input boundaries, absolutely is a vulnerability.
- **Binaries are unsigned.** Release artifacts are published with SHA-256
  checksums but are not code-signed; checksums prove integrity, not
  publisher identity.
- **Registry listing is not endorsement.** The community index is
  unreviewed metadata.
- **Model output is nondeterministic** and can be wrong; SpecBridge's
  guarantees apply to its deterministic controls (approvals, hashes,
  evidence, verification), not to what a model writes.

See "Explicit non-claims" in the
[threat model](docs/security/threat-model.md) for the full list.

## Disclosure expectations

- We ask for a reasonable time to fix before publication — please
  coordinate a disclosure date rather than publishing immediately.
- This is an independent open-source project maintained on a best-effort
  basis: acknowledgement and fixes are prioritized honestly, but there is
  no SLA and no bug bounty.
- Credit is given in release notes to reporters who want it.
