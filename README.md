# SpecBridge

> SpecBridge turns rough software ideas into repository-grounded, research-backed, implementation-ready system design specifications.

SpecBridge 2.0 is an AI System Design & Spec Compiler. It examines an existing repository, discovers requirements, routes uncertain external facts to research, makes ordinary engineering decisions, and compiles a portable Markdown-first Spec Pack.

SpecBridge does not write the product, launch coding agents, manage worktrees, schedule workers, or supervise implementation. Its responsibility ends at an approved specification.

```text
rough idea
    ↓
repository intelligence → requirements → research → system design
    ↓
approved, portable Spec Pack
    ↓
Claude Code / Codex / another coding agent / human developers
    ↓
independent implementation
```

## Example

```text
User:
“Turn this existing support bot into a multi-tenant SaaS with WhatsApp.”

SpecBridge:
- inspects the repository
- researches current WhatsApp constraints
- asks only material product questions
- designs the architecture
- generates the complete specification

Claude Code / Codex:
reads the approved Spec Pack and independently implements it.
```

## What SpecBridge owns

- Repository Intelligence with bounded, evidence-backed `CurrentSystemSnapshot` records.
- Requirement Discovery with traceable functional requirements, NFRs, and acceptance criteria.
- A provider-neutral Research layer with a `ResearchGate` and reusable structured reports.
- Product Authority that distinguishes product decisions, engineering choices, external facts, and assumptions.
- A validated, fourteen-stage `SystemDesignPipeline`.
- A Markdown-first Spec Compiler and multidimensional Spec Evaluator.
- Thin conversational integrations for Claude Code and Codex.

## What SpecBridge does not own

- Implementation planning or task decomposition.
- Coding-agent sessions, subagents, retries, handoffs, or token management.
- Worktrees, candidates, builders, supervisors, schedulers, or execution loops.
- The implementation itself.

## Spec Pack

Approved specifications are self-contained beneath:

```text
.specbridge/specs/<slug>/
├── spec.yaml
├── 00-overview.md
├── 01-goals-and-non-goals.md
├── 02-requirements.md
├── 03-current-system.md
├── 04-research.md
├── 05-system-design.md
├── 06-data-model.md
├── 07-api-and-events.md
├── 08-security.md
├── 09-reliability.md
├── 10-observability.md
├── 11-deployment-and-rollout.md
├── 12-testing.md
├── 13-acceptance-criteria.md
├── 14-open-decisions.md
├── 15-implementation-guidance.md
├── spec-quality.md
└── AGENT_HANDOFF.md
```

Critical meaning is kept in Markdown and YAML, not in a proprietary runtime. A developer or coding agent can consume a Spec Pack without installing SpecBridge. Later approvals create revision archives and record which product decisions, requirements, and acceptance criteria changed.

## Conversational use

The normal interface is a conversation in Claude Code or Codex. Requests such as these activate the design workflow:

```text
Design this system and turn it into a complete spec.
帮我把这个想法设计完整。
把这个现有项目改成 multi-tenant SaaS，并整理成可开发规格。
```

The frontend integration invokes bounded MCP operations, presents only material product questions, and asks for explicit natural-language approval before marking a specification approved.

## CLI

The CLI is intended for debugging and automation:

```powershell
specbridge bootstrap
specbridge design start "Add tenant-aware customer support"
specbridge design read <session-id>
specbridge design generate <session-id>
specbridge design evaluate <session-id>
specbridge design approve <session-id> "I approve this specification"
specbridge spec list
specbridge spec show <slug>
specbridge mcp
```

Run `specbridge --help` for the complete command surface.

## Development

Requirements:

- Node.js 20 or newer
- pnpm 9
- Git for Windows, macOS, or Linux

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

Windows 11 and PowerShell are first-class supported environments. The normal product does not require WSL, Bash, tmux, or Linux process semantics.

## Architecture and migration

- [Architecture](docs/architecture.md)
- [Migrating from SpecBridge 1.x](docs/specbridge-2-migration.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

SpecBridge is independent open-source software licensed under the [MIT License](LICENSE).
