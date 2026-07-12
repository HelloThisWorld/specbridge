# Model-assisted spec authoring

`spec generate` and `spec refine` let a configured runner draft or improve
individual spec stages. The offline templates from `spec new` remain the
default path; model assistance is always explicit opt-in.

```sh
specbridge spec generate <name> --stage <requirements|bugfix|design|tasks>
specbridge spec refine   <name> --stage <stage> --instruction "<text>"
```

Options: `--runner <name>`, `--dry-run`, `--json`, `--model`, `--max-turns`,
`--max-budget-usd`, `--timeout` (generate); `--instruction-file <path>`
(refine).

## Who writes the file

The runner returns Markdown **inside structured output**; SpecBridge — not
the agent — writes the `.kiro` document. That preserves atomic writes,
deterministic validation, approval invalidation, and auditability. During
generation the agent's tools are restricted to repository *reading*
(`Read`, `Glob`, `Grep`); requirements/bugfix generation is fully read-only
and design/tasks generation allows inspection but no source modification.

## Workflow prerequisites (enforced, never assumed)

| Workflow | Rule |
| --- | --- |
| requirements-first | requirements while draft → design needs approved requirements → tasks needs approved requirements + design |
| design-first | design while draft → requirements needs approved design → tasks needs both approved |
| quick | requirements/design in either order; tasks may be generated from the current (even unapproved) documents, with a warning |
| bugfix | bugfix first → design needs approved bugfix → tasks needs approved bugfix + design |

Additional rules:

- **Nothing is ever auto-approved.** A generated stage is `draft`; review it,
  then `spec analyze` and `spec approve` as usual.
- **An approved stage is never overwritten.** Generation and refinement
  refuse with `spec approve <name> --stage <stage> --revoke` as the
  remediation; approval is never revoked implicitly.
- A spec without SpecBridge workflow state cannot generate (the workflow
  mode would be unknown): approve one stage first to initialize state, or
  create specs with `spec new`.

## After generation

1. Structured runner output is validated (including `referencedFiles` paths —
   anything outside the repository is dropped with a warning).
2. The candidate Markdown is retained under `.specbridge/runs/<run-id>/`.
3. The deterministic v0.2 analyzer runs against the candidate.
4. **Errors ⇒ the current document is untouched.** The candidate stays in the
   run directory for inspection (exit code 1). There is no `--force`; fix and
   regenerate, or write the document yourself.
5. No errors ⇒ the document is written atomically (line-ending convention of
   an existing file is preserved) and any approvals that depended on the
   stage are invalidated — they were made against different content.

## Refinement specifics

Refinement loads the current document plus prerequisite approved documents
and steering, applies your instruction with the smallest coherent change,
prints a unified diff, and follows the same validation/apply pipeline. The
instruction and the previous content are retained in the run directory.

## Dry runs

`--dry-run` plans without invoking the runner and without writing any file
or state: it prints the runner, tool policy, target file, prompt (versioned
contract v1), and — for Claude Code — the exact redacted argument vector.
Deterministic except for generated ids and timestamps.

## Language

Everything SpecBridge itself writes (prompts, templates, reports) is
English. User-authored spec content in any language is preserved — the
refinement prompt explicitly instructs the model to keep the document's
existing language.
