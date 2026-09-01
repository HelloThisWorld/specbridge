# SpecBridge CLI

SpecBridge turns rough software ideas into repository-grounded, research-backed, implementation-ready system design specifications.

The CLI is a secondary interface for debugging and automation. Normal use happens through the lightweight Claude Code or Codex conversational integration.

```powershell
specbridge bootstrap
specbridge design start "Tenant-aware support" "Turn this bot into a multi-tenant SaaS"
specbridge design read <session-id>
specbridge design generate <session-id> problem-framing --file stage.json
specbridge design research <session-id> --file report.json
specbridge design evaluate <session-id>
specbridge design approve <session-id> "I approve this specification"
specbridge spec list
specbridge spec show <slug>
specbridge mcp
```

SpecBridge compiles portable Spec Packs and stops. It does not launch coding agents, own worktrees, schedule workers, or supervise implementation.
