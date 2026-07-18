# SpecBridge CLI

An open, model-agnostic spec runtime for existing Kiro projects. SpecBridge
reads your current `.kiro/steering` and `.kiro/specs` files exactly where
they are and adds validated stage authoring, explicit approvals,
evidence-gated task execution, deterministic drift verification, an MCP
server, and multi-runner agent execution on top — with no conversion, no
duplicated specs, and no lock-in. Your `.kiro` files remain the source of
truth and are never rewritten behind your back.

> The npm package is named `specbridge-cli` (the bare name `specbridge`
> belongs to an unrelated project on npm). The installed command is still
> `specbridge`.

## Install

```bash
npm install -g specbridge-cli
specbridge doctor
```

One-off use without a global install:

```bash
npx -p specbridge-cli specbridge doctor
```

Requires Node.js >= 20. Standalone archives with a bundled Node.js runtime
are available from the
[GitHub releases](https://github.com/HelloThisWorld/specbridge/releases).

## Quickstart

Run inside any project that contains a `.kiro/` directory:

```bash
specbridge doctor        # read-only health check of the workspace
specbridge spec list     # every spec, with classification and status
specbridge spec show <name>
specbridge compat check  # proves byte-identical .kiro round-trips
```

Full documentation, examples, templates, the extension SDK, and the Claude
Code plugin live in the repository:
<https://github.com/HelloThisWorld/specbridge>

## Independent project

SpecBridge is an independent open-source project. It is not affiliated
with, endorsed by, or sponsored by Amazon Web Services, Inc. (AWS) or the
Kiro team. Kiro is referenced only to describe compatibility with publicly
documented project file locations and observable document formats. See
[NOTICE.md](NOTICE.md).

## License

MIT — see [LICENSE](LICENSE).
