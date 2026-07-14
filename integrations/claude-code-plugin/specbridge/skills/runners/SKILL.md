---
name: runners
description: Inspect SpecBridge runner profiles — list configured runners, show the capability matrix (author/refine/execute/resume), diagnose one profile, and recommend compatible profiles for an operation. Use when the user asks which runners are available, why a runner is not usable, or which profile can execute tasks. Read-only.
---

# SpecBridge runners

Arguments: `[profile-name]` (optional, e.g. `gemini-default`,
`openai-compatible-local`, `antigravity`).

Read-only diagnostics: never edit configuration, never invoke a provider,
never send a network request yourself, never authenticate, and never start
Gemini, Codex, Antigravity, Ollama inference, or API inference from this
skill. All information comes from the SpecBridge MCP diagnostic tools
(from the `specbridge` MCP server this plugin bundles; your host may show
them with an `mcp__…` prefix) — they run safe local probes only and never
make a model request.

## No profile name given

1. Call the SpecBridge MCP tool `runner_list`.
2. Call the SpecBridge MCP tool `runner_matrix`.
3. Present a compact overview:
   - each profile: implementation, category (agent-cli / model-api /
     experimental), enabled or disabled, support level;
   - the capability matrix (Author / Refine / Execute / Resume / Local).
4. Explain the boundaries briefly:
   - agent CLIs (claude-code, codex-cli, gemini-cli) run locally and handle
     their own provider connectivity;
   - model APIs (ollama, openai-compatible) are authoring-only — they can
     never execute tasks or modify source;
   - experimental adapters (antigravity-cli) are detection-only;
   - network-backed profiles are never selected implicitly.
5. Mention that disabled profiles must be enabled explicitly in
   `.specbridge/config.json` — but do not edit that file yourself.

## Profile name given

1. Call the SpecBridge MCP tool `runner_show` with the profile name.
2. If the user asked why something is broken or not ready, also call
   `runner_doctor` with the profile name for the actionable findings.
3. Present concisely:
   - availability, support level, and authentication state;
   - detected capabilities and which operations they support;
   - the security boundary (read-only authoring, bounded edit policy, no
     YOLO, no arbitrary shell, no credential storage);
   - known limitations and the remediation steps from the diagnostics.
4. If the requested operation is unsupported (for example task execution on
   `openai-compatible-local` or `antigravity`), recommend the compatible
   profiles the tools report instead — typically `claude-code` or
   `codex-default`.

## Boundaries

- Never modify `.kiro`, `.specbridge`, or any configuration file from this
  skill.
- Never run a provider CLI or send an HTTP request to check something the
  MCP tools already report.
- Never present provider claims as verification: task completion is decided
  by Git evidence and trusted verification commands, whatever runner is
  used.
- Deeper checks are explicit CLI actions for the user, not this skill:
  `specbridge runner conformance <profile>` and
  `specbridge runner test <profile> --network`.
