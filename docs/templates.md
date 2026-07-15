# Spec templates

SpecBridge v0.7.0 adds a secure, deterministic, offline-first template system
for Kiro-compatible specs: reusable spec templates without executable
generators or platform lock-in.

Templates are **data, not code**. A template pack is a JSON manifest plus
plain Markdown files with `{{variable}}` placeholders. Applying a template
renders those files once — no scripts, no network, no model — and creates a
normal Kiro spec through the same atomic creation path as `spec new`. The
generated stages start unapproved; templates never bypass the approval
workflow, and `.kiro` files never carry template metadata.

## Quick start

```bash
specbridge template list

specbridge template search migration

specbridge template show database-migration

specbridge template preview database-migration \
  --name add-payment-status-index \
  --var tableName=payments

specbridge template apply database-migration \
  --name add-payment-status-index \
  --var tableName=payments
```

`template preview` and `template apply --dry-run` share the exact rendering
path with the real apply and write nothing.

## Template sources

| Source | Reference | Location | Notes |
| --- | --- | --- | --- |
| Built-in | `builtin:<id>` | bundled with SpecBridge | immutable at runtime, versioned with SpecBridge |
| Project | `project:<id>` | `.specbridge/templates/<id>/` | installed explicitly from a local path |

An unqualified reference (`rest-api`) works only while exactly one source
provides that ID. If the same ID exists in both sources, SpecBridge returns
an ambiguity error (SBT002) listing the qualified references — one source
never silently shadows another.

There is no remote registry, no URL installation, and no npm installation in
v0.7.0. Installation reads a local directory inside your repository, and
nothing else. See [docs/template-installation.md](template-installation.md).

## Built-in template gallery

<!-- BEGIN GENERATED TEMPLATE GALLERY (pnpm generate:template-gallery) -->

10 built-in templates ship with SpecBridge. This table is generated from the
template manifests — do not edit it by hand.

| Template | Description | Kind | Modes | Tags | Example |
| --- | --- | --- | --- | --- | --- |
| `authentication` — Authentication | A feature spec template for adding or changing authentication or authorization behavior: credential and session flow, authorization boundaries, wrong-credential and lockout behavior, expiry, revocation, replay protection, rate limiting, audit events, and security tests. | feature | requirements-first, design-first, quick | authentication, authorization, security, session, identity | `specbridge template apply authentication --name login-session-refresh --var actor=user --var sessionKind=token` |
| `background-job` — Background Job | A feature spec template for adding or changing an asynchronous background job or worker: trigger, scheduling, retries, idempotency, duplicate delivery, timeouts, dead-letter behavior, cancellation, observability, and tests. | feature | requirements-first, design-first, quick | background-job, worker, queue, async, scheduling | `specbridge template apply background-job --name invoice-export-worker --var jobName=invoice-export` |
| `bugfix-regression` — Bugfix Regression | A bugfix spec template built around evidence: current vs expected behavior, unchanged behavior, reproduction, root cause, the smallest safe fix, and the regression tests that keep it fixed. | bugfix | requirements-first, quick | bugfix, regression, debugging, quality | `specbridge template apply bugfix-regression --name checkout-total-rounding --var severity=high` |
| `cli-tool` — Command-Line Tool | A feature spec template for adding or changing a command-line tool or command: command surface, arguments and options, exit codes, stdout/stderr behavior, machine-readable output, non-interactive use, platform compatibility, error handling, and tests. | feature | requirements-first, design-first, quick | cli, command-line, tooling, developer-experience, ux | `specbridge template apply cli-tool --name my-tool --var commandName=mycli` |
| `database-migration` — Database Migration | A feature spec template for a schema or data migration: the schema change, batched backfill, backward compatibility, zero-downtime deployment order, indexes and locking, rollback limitations, validation, and observability. | feature | requirements-first, design-first, quick | database, migration, schema, sql, backfill | `specbridge template apply database-migration --name orders-status-backfill --var tableName=orders` |
| `event-driven-service` — Event-Driven Service | A feature spec template for a producer/consumer change on an event bus, queue, or stream: event contract, delivery semantics, ordering, idempotency, retries, dead-letter behavior, schema evolution, tracing, and rollout. | feature | requirements-first, design-first, quick | events, messaging, queue, streaming, async | `specbridge template apply event-driven-service --name order-events --var eventName=order-created` |
| `performance-optimization` — Performance Optimization | A feature spec template for a measurable performance improvement: numeric baseline and target, measurement method, workload definition, bottleneck evidence, constraints, regression risks, before/after validation, and rollback. | feature | requirements-first, design-first, quick | performance, optimization, profiling, latency, benchmarking | `specbridge template apply performance-optimization --name checkout-latency --var targetMetric="p95 latency"` |
| `refactoring` — Refactoring | A feature spec template for a behavior-preserving restructuring: an explicit inventory of behavior that must not change, refactor boundaries, an incremental plan with safe checkpoints, regression tests, rollback points, and measurable completion criteria. | feature | requirements-first, design-first, quick | refactoring, maintainability, tech-debt, restructuring, regression-safety | `specbridge template apply refactoring --name extract-billing-module --var componentName=billing` |
| `rest-api` — REST API | A feature spec template for adding or changing a REST API endpoint: request/response contract, validation, status codes, authentication, idempotency, pagination, compatibility, observability, and rollout. | feature | requirements-first, design-first, quick | api, rest, http, backend | `specbridge template apply rest-api --name orders-list-endpoint --var resourceName=order --var basePath=/api/v1/orders` |
| `security-hardening` — Security Hardening | A feature spec template for closing a specific security weakness or hardening a trust boundary: threat and assets at risk, abuse cases, required secure behavior, an explicit fail-closed decision, logging without secret leakage, negative tests, and rollout. | feature | requirements-first, design-first, quick | security, hardening, threat-model, abuse-case, defense | `specbridge template apply security-hardening --name harden-webhook-deserialization --var threatArea=deserialization` |

<!-- END GENERATED TEMPLATE GALLERY -->

Regenerate with `pnpm generate:template-gallery`; CI fails when the table
drifts from the manifests (`pnpm check:template-gallery`).

## What templates cannot do

- execute code, lifecycle scripts, or shell commands
- read environment variables or arbitrary files
- write outside `.kiro/specs/<spec-name>/`
- use loops, conditionals, expressions, or includes in placeholders
- render recursively (one pass; values are never re-scanned)
- overwrite an existing spec
- mark any generated stage as approved

See [docs/template-security.md](template-security.md) for the threat model
and the full list of enforced limits.

## Related documentation

- [Creating templates](creating-templates.md) — scaffold, edit, validate, share
- [Template manifest reference](template-manifest.md)
- [Template rendering rules](template-rendering.md)
- [Template installation](template-installation.md)
- [Template security](template-security.md)
- [Contribution guide](template-contribution-guide.md)
