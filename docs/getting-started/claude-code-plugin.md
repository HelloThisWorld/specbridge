# Claude Code plugin

The self-contained plugin bundles the CLI, the local stdio MCP server, and
twelve skills — no global npm install, no nested Claude processes, and
stage approval stays an explicit human action.

Install (inside Claude Code):

```text
/plugin marketplace add HelloThisWorld/specbridge
/plugin install specbridge@specbridge-plugins
/reload-plugins
```

Full instructions — local checkout, development mode, the release ZIP, and
installation verification — live in
[plugin installation](../plugin-installation.md).

## The fourteen skills

`/specbridge:doctor` · `/specbridge:status` · `/specbridge:new` ·
`/specbridge:author` · `/specbridge:approve` · `/specbridge:implement` ·
`/specbridge:develop` · `/specbridge:discover` · `/specbridge:orchestrate` ·
`/specbridge:continue` · `/specbridge:verify` · `/specbridge:runners` ·
`/specbridge:templates` · `/specbridge:extensions`

`/specbridge:implement` is the direct task lifecycle (`task_begin` → edit →
`task_complete`) and is unchanged. `/specbridge:develop` (v1.1) drives the
governed lifecycle: intent assessment, clarification, execution planning, a
plan review gate, a bounded implementation loop, and evidence-backed
completion. `/specbridge:continue` is now orchestration-aware.
`/specbridge:orchestrate` (v1.2) inspects and gates long-running jobs.
`/specbridge:discover` runs Mission Discovery — from a product direction to
an approved spec of objectives — and approves nothing along the way
([Mission Discovery](../mission/mission-discovery.md)).

The eleven v1.0 skills passed live-model verification against a real
workspace — results and per-skill reports:
[skill verification](../skill-verification/README.md).

## More

- [Claude Code plugin reference](../claude-code-plugin.md)
- [Interactive task execution](../interactive-task-execution.md)
- [Governed agent orchestration](../orchestration/agent-orchestration.md)
- [Plugin security](../plugin-security.md)
