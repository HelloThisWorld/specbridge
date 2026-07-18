# Claude Code plugin

The self-contained plugin bundles the CLI, the local stdio MCP server, and
eleven skills — no global npm install, no nested Claude processes, and
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

## The eleven skills

`/specbridge:doctor` · `/specbridge:status` · `/specbridge:new` ·
`/specbridge:author` · `/specbridge:approve` · `/specbridge:implement` ·
`/specbridge:continue` · `/specbridge:verify` · `/specbridge:runners` ·
`/specbridge:templates` · `/specbridge:extensions`

All eleven passed live-model verification against a real workspace —
results and per-skill reports:
[skill verification](../skill-verification/README.md).

## More

- [Claude Code plugin reference](../claude-code-plugin.md)
- [Interactive task execution](../interactive-task-execution.md)
- [Plugin security](../plugin-security.md)
