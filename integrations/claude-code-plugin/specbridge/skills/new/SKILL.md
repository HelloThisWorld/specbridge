---
name: new
description: Create a new Kiro-compatible spec with SpecBridge — always preview first, then create only after the user confirms. Use when the user wants to start a new spec, feature, or bugfix plan in .kiro/specs.
---

# SpecBridge new spec

Arguments: `<spec-name> [description…]`.

Preview-first, always. Never skip the preview, never overwrite an existing
spec, and never create files yourself — the MCP tool performs the write.

1. Parse the spec name (first argument) and description (the rest). Ask for a
   short description if none was given. If the user hinted at a bug fix, use
   `type: "bugfix"`; if they asked for a specific workflow, map it to
   `mode` (`requirements-first` default, `design-first`, `quick`).
2. Call the SpecBridge MCP tool `spec_create` with `apply: false`.
3. Present the preview:
   - the files that would be created (paths and a short excerpt),
   - the spec type and workflow mode,
   - the initial workflow status.
4. Ask the user explicitly: "Create this spec?" and STOP until they answer.
5. Only after the user confirms, call `spec_create` again with the same
   arguments plus `apply: true`.
6. Show the created paths and the next step:
   `/specbridge:author <spec-name> requirements` (or `bugfix` for bugfix
   specs).

If `spec_create` reports the spec already exists (SBMCP002), show the
message and suggest `/specbridge:status <spec-name>` instead. Never retry
with `apply: true` to force anything.
