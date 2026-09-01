# Contributing to SpecBridge

SpecBridge 2.0 has one product boundary: it produces implementation-ready specifications and stops before implementation begins. Contributions must preserve that boundary.

## Development setup

Use Node.js 20 or newer and pnpm 9 on Windows, macOS, or Linux.

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

## Architecture rules

- Keep repository analysis bounded, deterministic, and evidence-backed.
- Treat observed code as implementation evidence, not automatic product truth.
- Ask humans only for decisions that materially define product behavior.
- Route current external facts through the provider-neutral research contract.
- Persist rationale summaries, evidence, decisions, and citations—not hidden reasoning.
- Keep Spec Packs portable, Markdown-first, and usable without SpecBridge.
- Do not add coding-agent launchers, worktree orchestration, worker scheduling, implementation retries, or execution supervision.
- Prefer small, explicit modules over workflow frameworks and state-machine proliferation.

## Tests

Changes should include proportionate coverage. The core qualification suite covers repository bootstrap, authority routing, research reuse, staged design generation, evaluation, portable Spec Packs, natural-language approval, and Windows path handling.

Use synthetic fixtures. Never depend on a contributor's private repository or external credentials.

## Pull requests

Explain the product behavior changed, the evidence for the design, and the validation performed. Breaking changes to the Spec Pack schema or MCP surface must also update documentation and tests.
