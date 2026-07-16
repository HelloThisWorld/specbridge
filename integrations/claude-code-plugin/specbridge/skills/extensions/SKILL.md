---
name: extensions
description: Discover SpecBridge extensions — list installed extensions with enablement and permission status, search validated registry caches, show one extension's permissions and permission hash, or run a read-only health check. Discovery only; installation and permission acceptance remain explicit terminal actions. Read-only.
---

# SpecBridge extensions

Arguments: `[query]`, `show <extension-id>`, or `doctor <extension-id>`
(all optional).

Read-only discovery. From this skill, NEVER install, uninstall, enable,
disable, or update anything, never run `specbridge extension …` or
`specbridge registry …` commands, never invoke an extension's operations,
and never expose credential or environment-variable values. Do not present
a listed extension as safe or endorsed — listing is metadata, not review.

## No arguments

1. Call the SpecBridge MCP tool `extension_list`.
2. Present a compact table: ID, version, kind, enabled, permissions
   accepted, conformance status.
3. Call `registry_list` and mention which registries are readable.

## Search (a query is given)

1. Call `extension_search` with the query (installed + cached registries).
2. Present matches with kind, version, and source registry.
3. Note that search is offline; caches update only via the terminal command
   `specbridge registry update <name> --network`.

## `show <extension-id>`

1. Call `extension_show` (fall back to `registry_show` for extensions that
   are not installed).
2. Present the kind, versions, and the full permission list plainly —
   especially repositoryWrite, network, childProcess, and any environment
   variable names.
3. Show the permission hash and the exact terminal command the user must run
   themselves to enable it:

   ```
   specbridge extension enable <extension-id> --accept-permissions <hash>
   ```

   Explain that accepting binds to the current manifest: any manifest change
   invalidates the grant.

## `doctor <extension-id>`

1. Call `extension_doctor` (read-only; at most a bounded no-op handshake).
2. Report integrity, grant status, and handshake outcome.
3. For problems, point to the terminal commands (`specbridge extension
   doctor`, `disable`, `uninstall`) — do not run them.

Installation flow to explain when asked (terminal, never from here):
`specbridge extension install <source>` → `specbridge extension show <id>` →
review permissions → `specbridge extension enable <id> --accept-permissions
<hash>`.
