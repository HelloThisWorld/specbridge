---
name: doctor
description: Check the SpecBridge setup in this project — .kiro workspace detection, .specbridge configuration, MCP server health, and plugin versions. Use when the user asks whether SpecBridge works here, why a SpecBridge tool is failing, or how to get started in a Kiro project. Read-only.
---

# SpecBridge doctor

Diagnose the SpecBridge setup. Everything here is read-only — change nothing.

1. Call the SpecBridge MCP tool `workspace_detect` (from the `specbridge` MCP
   server this plugin bundles; your host may show it with an `mcp__…` prefix).
2. Report, from its output:
   - whether a `.kiro` workspace was found and where,
   - steering and spec counts,
   - `.specbridge` sidecar presence and configuration status,
   - the Git summary (interactive execution requires a Git repository).
3. If the MCP tool is unavailable, say so and suggest the bundled CLI check:
   `"${CLAUDE_PLUGIN_ROOT}/bin/specbridge" mcp doctor` — but do not run it
   without the user's go-ahead.
4. Report the plugin version (0.6.1) and the MCP server version from the tool
   results where shown.
5. Suggest the next command:
   - no workspace → `/specbridge:new <spec-name> [description]`
   - specs exist → `/specbridge:status`
   - configuration invalid → tell the user which file to fix
     (`.specbridge/config.json`) and why; never edit it yourself.

Never modify `.kiro`, `.specbridge`, or any other file from this skill.
