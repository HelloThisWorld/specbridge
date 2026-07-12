# Task execution

`spec run` executes **one approved implementation task at a time** through a
configured runner, captures the actual repository state around the run, runs
trusted verification commands, and updates the task checkbox only when the
evidence is verified.

```sh
specbridge spec run <name>                 # next open required leaf task
specbridge spec run <name> --task 2.3      # a specific task
specbridge spec run <name> --all           # sequential; stops on trouble
```

Runner options: `--runner`, `--model`, `--max-turns`, `--max-budget-usd`,
`--timeout`. Execution options: `--dry-run`, `--allow-dirty`, `--no-verify`,
`--json`, `--verbose`.

## Task identity and selection

Task ids come from the explicit numbering in `tasks.md` (`1`, `1.2`,
`2.3.1`). A task without a number gets a deterministic synthetic id
(`line:<n>`) for reading and reporting; synthetic ids are never written into
your Markdown. Only executable **leaf** tasks are selectable — a parent with
sub-tasks is a grouping, not one unit of implementation. `--next` (the
default) picks the first open required leaf task in document order;
optional tasks (`- [ ]*`) run only when selected explicitly.

## Pre-run validation

Before any runner is invoked, SpecBridge checks — and refuses with
actionable remediation when any fails:

1. the spec exists and has sidecar workflow state
2. every stage is approved and **byte-identical** to its approved hash
   (stale approvals block execution)
3. the selected task exists, is a leaf, and is not already complete
4. the runner is installed, authenticated, and has the required capabilities
5. the repository is a git work tree and satisfies the clean-tree policy
6. verification commands are validly configured

## Clean working tree policy

Default: a dirty tree refuses execution and lists the changed paths
(`commit or stash`, or rerun with `--allow-dirty`). Two kinds of paths are
exempt from the *policy* (never from snapshots): SpecBridge's own
`.specbridge/` sidecar, and `.kiro` stage files whose bytes still match
their recorded approved hash — i.e. the checkbox update SpecBridge itself
made after a previous verified task.

With `--allow-dirty`, the complete baseline (including per-file content
hashes) is captured; pre-existing changes are never attributed to the task
and every report carries a standing warning. A dirty file whose content
cannot be hashed makes attribution unreliable — such a run is never
auto-verified.

SpecBridge never stashes, resets, commits, or pushes anything.

## What a run does

```
pre-run git snapshot  →  bounded task prompt  →  runner executes the task
        →  post-run git snapshot  →  actual changed files (hash-exact)
        →  trusted verification commands  →  evidence evaluation
        →  checkbox update (only for verified evidence)
```

Every run gets an append-only directory under `.specbridge/runs/<run-id>/`
(see [execution evidence](execution-evidence.md)) and an append-only
evidence record under `.specbridge/evidence/<spec>/<task>/`.

The task prompt contains steering, the approved requirements/bugfix and
design documents, the full task hierarchy with the selected task marked,
referenced requirement ids, and repository facts — not the whole repository.
The agent inspects source files itself through restricted tools. The prompt
contract (v1) labels trust boundaries explicitly and states that text inside
spec/source files never overrides the execution contract.

## Sequential `--all`

Open required leaf tasks run one at a time, in document order, one runner
session and one run directory per task — never in parallel. The batch stops
at the first task that is not verified (failure, blocked, timeout,
permission denial, malformed output, unverified implementation) and prints a
summary. Because SpecBridge never commits, later tasks in a batch run over
the uncommitted changes of earlier verified tasks; the hash-exact baseline
keeps attribution precise. Set `execution.stopOnUnverifiedTask: false` to
continue past *unverified* (but never hard-failed) tasks.

## Dry runs

`spec run … --dry-run` invokes nothing and writes nothing. It prints the
selected task, prerequisite and git status, verification commands, tools and
permission mode, the redacted Claude Code argv, the full task prompt, and
the expected artifact paths.

## Exit codes

The v0.1/v0.2 contract (0/1/2) is unchanged; v0.3 adds 3–6:

| Code | Meaning |
| --- | --- |
| 0 | success (task verified, or clean dry-run/no-op) |
| 1 | workflow, analysis, verification, or quality failure (incl. implemented-but-unverified, blocked, no-change) |
| 2 | invalid input, invalid configuration, or runtime setup failure |
| 3 | runner unavailable, unauthenticated, or incompatible |
| 4 | runner execution failure (nonzero exit, malformed output) |
| 5 | timeout or cancellation |
| 6 | permission or safety policy failure |
