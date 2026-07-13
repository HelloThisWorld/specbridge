# MCP resources

Read-only, repository-bounded views with declared content types, size
limits, and clear not-found errors. Resource URIs address **well-known names
and ids only** — there is no arbitrary-path resource, template variables
reject path syntax (`/`, `\`, `..`, null bytes), and symlinked content is
never followed outside the repository (the underlying readers refuse
workspace escape).

| URI | Type | Content |
| --- | --- | --- |
| `specbridge://workspace` | `application/json` | Workspace detection summary (same facts as `workspace_detect`). |
| `specbridge://steering/{name}` | `text/markdown` | One steering document body (front matter excluded). Listable. |
| `specbridge://specs/{specName}/requirements` | `text/markdown` | The requirements document. |
| `specbridge://specs/{specName}/bugfix` | `text/markdown` | The bugfix document. |
| `specbridge://specs/{specName}/design` | `text/markdown` | The design document. |
| `specbridge://specs/{specName}/tasks` | `text/markdown` | The tasks document. |
| `specbridge://specs/{specName}/status` | `application/json` | Workflow status: stages, stored/effective approval, hashes, staleness. |
| `specbridge://specs/{specName}/context` | `text/markdown` | The deterministic agent-ready context. |
| `specbridge://runs/{runId}` | `application/json` | Safe run summary — raw prompts, raw runner output, and full command logs are **never** exposed. |
| `specbridge://verification/rules` | `application/json` | The stable SBV001–SBV025 rule registry. |

Behavior notes:

- Markdown content is truncated at 1 MB with an explicit truncation notice;
  JSON responses over 2 MB are replaced by a small JSON notice pointing at
  the paginated tools — invalid JSON is never emitted.
- UTF-8 content is preserved; truncation cuts on character boundaries.
- Where practical the corresponding tools include source content hashes
  (`steering_list`, `spec_read`); resource consumers needing hashes should
  use those tools.
- `.specbridge/config.json` is **not** exposed as a resource: workspace
  views report only a redacted configuration *status*
  (`absent-defaults` / `valid` / `invalid`) and verification command names,
  never raw configuration contents.
- Every read emits a `resource_read` stderr log event.
