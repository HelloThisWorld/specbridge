# Support

SpecBridge is an independent open-source project (MIT licensed), not
affiliated with AWS/Kiro, Anthropic, OpenAI, or Google. Support is
community-based and best-effort.

## Where to ask

- **Bugs and feature requests:** GitHub issues on
  `github.com/HelloThisWorld/specbridge` (please use the issue forms)
- **Security reports:** never a public issue — see
  [SECURITY.md](SECURITY.md)
- **Usage questions:** start with the documentation in
  [docs/](docs/) — the README links the per-topic guides

## Supported versions

- **1.x** is the supported major version.
- **Security fixes** target the latest 1.x minor release; older 1.x minors
  are expected to upgrade rather than receive backports.
- **0.x** releases are unsupported after the 1.0.0 release.

## What "supported" means here

Issues are triaged on a best-effort basis by the maintainers. Reproducible
bugs in documented behavior — especially anything touching the security
model or `.kiro` file integrity — get priority. There is **no guaranteed
response time, no support SLA, and no enterprise support offering**.

## Experimental integrations

Some integrations are explicitly experimental and supported on a
best-effort basis only, without a stability promise:

- **Antigravity CLI** — experimental detection only
- **Capability-gated Gemini operations** — Gemini task execution is enabled
  only when the installed CLI proves a bounded edit policy; which installed
  versions qualify can change outside SpecBridge's control

`specbridge runner matrix` and `specbridge runner doctor <profile>` report
the live status for your installation; issues against experimental
integrations are welcome but may be closed as environment-specific.

## What to include in a bug report

The issue form asks for all of this; reports missing it usually bounce:

- OS and version (Windows/macOS/Linux)
- Node.js version (`node --version`; Node >= 20 is required)
- SpecBridge version (`specbridge --version`) and install method
- The output of `specbridge doctor --json`, **with sensitive paths
  redacted** — it captures workspace layout, configuration status, and
  runner detection in one place
- The exact command, what happened, and what you expected
- A minimal reproduction (a tiny synthetic `.kiro` workspace is ideal)

Never paste credentials, API keys, or proprietary company content into an
issue. `specbridge doctor` prints no secret values by design, but paths in
its output can still reveal machine or project names — redact what matters
to you.
