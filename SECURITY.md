# Security policy

Report suspected vulnerabilities privately to the maintainers through GitHub's security advisory flow. Do not open a public issue containing exploit details, credentials, or private repository content.

## Security boundary

SpecBridge reads repository content and writes design artifacts beneath `.specbridge/`. It does not launch implementation agents, execute generated code, manage worktrees, or supervise coding sessions.

Repository scanning is bounded and excludes symlinks, common build outputs, caches, and binary files. Workspace writes use containment checks and atomic replacement. External research is supplied through a provider-neutral interface and its output is treated as untrusted evidence requiring source and freshness metadata.

## Sensitive content

Do not place secrets in prompts, research reports, or Spec Packs. Integrations should pass only the repository context necessary for the active design question. Review generated specifications for credentials, personal data, and proprietary material before sharing them.

## Supported versions

Security fixes target the current 2.x release line. The discontinued 1.x implementation runtime is not supported.
