---
name: templates
description: Discover, preview, and apply reusable SpecBridge spec templates — always preview first, apply only with the candidate hash after explicit confirmation. Use when the user wants to browse templates, search for one, or create a spec from a template.
---

# SpecBridge templates

Arguments: `[query]` | `show <template>` | `apply <template> <spec-name> [key=value…]`.

Everything goes through the SpecBridge MCP template tools. Never edit
`.kiro` or `.specbridge` yourself, never render template content yourself,
and never run shell commands for template operations — the MCP tools perform
every read and the one write. Rendering is deterministic and local: no
model, no network, no remote registry.

## No arguments, or a search query

1. With no arguments, call `template_list` and show a compact table:
   qualified reference, display name, kind, tags.
2. With a query (e.g. `/specbridge:templates database`), call
   `template_search` and show the ranked results.
3. Suggest the next step: `/specbridge:templates show <template>`.

## `show <template>`

1. Call `template_show` with the reference.
2. Present: description, kind, supported modes, variables (name, type,
   default, required), target files, and the usage example.
3. If the reference is ambiguous, the tool returns the qualified candidates
   (`builtin:x` vs `project:x`) — show them and let the user pick.

## `apply <template> <spec-name> [key=value…]`

1. Parse variables from `key=value` arguments. If a required variable is
   missing, `template_show` tells you which — ask the user for it.
2. Call `template_preview` with the template reference, spec name, and
   variables. Present:
   - the target paths and a short excerpt of each rendered file,
   - any diagnostics,
   - the proposed workflow status (all stages start unapproved).
3. Ask the user explicitly: "Apply this template?" and STOP until they
   answer.
4. Only after the user confirms, call `template_apply` with the SAME
   arguments plus `expectedCandidateHash` set to the `candidateHash` from
   the preview and `acknowledgement: "apply-reviewed-template"`.
5. Show the created paths and the next step:
   `/specbridge:author <spec-name> requirements` (or `bugfix` for bugfix
   templates).

If `template_apply` reports a candidate hash mismatch (SBT023), the template
or inputs changed since the preview — run the preview again and re-confirm;
never guess a hash. If the spec already exists (SBT020), show the message
and suggest `/specbridge:status <spec-name>`; never try to force an
overwrite.

Installing, uninstalling, and scaffolding templates are deliberate CLI-only
operations (`specbridge template install|uninstall|scaffold`) — point the
user to the terminal for those instead of attempting them here.
