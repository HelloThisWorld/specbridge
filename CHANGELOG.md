# Changelog

## 2.0.0 — Clean-break system design rewrite

### Product

- Repositioned SpecBridge as an AI System Design & Spec Compiler that ends at an approved, portable Spec Pack.
- Discontinued the 1.x implementation execution runtime and all compatibility guarantees for persisted Jobs.
- Made Claude Code and Codex the normal conversational frontends while keeping CLI usage secondary.

### Added

- Bounded, evidence-classified `CurrentSystemSnapshot` and deterministic repository context retrieval.
- Durable `DesignSession` lifecycle with product-authority routing and natural-language approval.
- Provider-neutral `ResearchProvider`, reusable structured `ResearchReport`, and `ResearchGate`.
- Fourteen validated system-design stages covering requirements, scale, architecture, deep dives, trade-offs, data, contracts, reliability, security, observability, deployment, migration, testing, and acceptance.
- Markdown-first Spec Compiler with revision archives, `spec.yaml`, multidimensional quality report, and `AGENT_HANDOFF.md`.
- Deterministic Spec Evaluator for completeness, grounding, product clarity, architecture, trade-offs, research, security, reliability, scope creep, contradictions, traceability, and implementation readiness.
- Compact design-only MCP surface and a simplified cross-platform CLI.
- Thin Claude Code and Codex integrations with design, research, review, approval, and status skills.
- Synthetic golden scenarios for greenfield, brownfield SaaS, event-driven, AI/RAG, monolith migration, and multi-channel support SaaS designs.
- Windows, macOS, and Linux CI across Node.js 20 and 22.

### Removed

- Mission, Job, WorkUnit, Attempt, candidate, worker, builder, driver, supervisor, scheduler, execution-ledger, worktree, runner, retry, handoff, session-recovery, and implementation-control-plane production code.
- Runtime-oriented packages, CLI commands, MCP tools, integrations, contracts, fixtures, documentation, build bundles, and tests.
- Marketplace, custom MCP launcher, duplicated runtime bundle, extension runtime, template runtime, and GitHub Action integration complexity.

The detailed 1.x history remains available in Git history. See [the migration guide](docs/specbridge-2-migration.md) for the intentionally unsupported runtime transition.
