# Execution evidence

SpecBridge never trusts a model's claim that a task is complete. Every run
records what **actually** happened, and only that evidence can complete a
task.

## Actual vs. reported

Two separate ledgers exist for every run and are never merged:

- **Actual evidence** — pre/post git snapshots, hash-exact changed-file
  attribution, verification command exit codes. Only this can verify a task.
- **Runner claims** — the model's structured report (`changedFiles`,
  `commandsReported`, `testsReported`). Stored verbatim under
  `runnerClaims`, displayed as claims, and cross-checked (a claim without a
  matching repository change produces a warning, never credit).

## Repository snapshots

Captured before and after every run: HEAD commit, branch, machine-readable
`git status` entries with SHA-256 content hashes of each changed/untracked
file, and byte-exact hashes of every protected file (`.kiro/**`,
`.specbridge/config.json`, `.specbridge/state/**`). Symlinks are recorded
but never followed, so a link cannot leak or attribute content outside the
repository. SpecBridge's own `.specbridge/` writes are excluded from change
attribution.

Attribution is hash-exact: a path dirty only after the run is the run's
change; a pre-existing dirty file with an unchanged hash is excluded; a
pre-existing dirty file that changed during the run is attributed as a
delta with a standing warning.

A moved HEAD is a violation — runners must never commit.

## Run artifacts

```
.specbridge/runs/<run-id>/
├── run.json               # versioned run record (kind, spec, task, outcome, evidence status)
├── prompt.md              # the exact prompt used
├── runner-request.json    # redacted invocation summary
├── runner-result.json     # outcome, validated report, process observation
├── raw-stdout.log         # retained raw output (size-limited)
├── raw-stderr.log
├── git-before.json        # pre-run snapshot
├── git-after.json         # post-run snapshot
├── changed-files.json     # attributed changes
├── diff.patch             # tracked changes vs HEAD (subject to maximumPatchBytes)
├── events.jsonl           # run timeline
├── verification.json      # trusted command results
├── verification-<name>.stdout.log / .stderr.log
├── evidence.json          # the evidence record (also stored under evidence/)
├── checkbox-update.json   # present only when the checkbox changed
└── report.json            # the full versioned report
```

Run directories are append-only history. A patch exceeding
`execution.maximumPatchBytes` is not retained (the changed-file list always
is) and the truncation is reported. Temporary prompt/schema files under
`tmp/` are removed after successful completion.

## Evidence records

One versioned record per attempt, append-only, never overwritten:

```
.specbridge/evidence/<spec-name>/<task-id>/<run-id>.json
```

Fields include the evidence `status`, repository before/after facts, the
attributed `changedFiles` (with `preExisting` flags), executed
`verificationCommands` with exit codes, the untouched `runnerClaims`,
`violations`, `warnings`, and — for manual acceptance — the actor, reason,
and timestamp.

Evidence statuses: `no-change`, `implemented-unverified`, `verified`,
`failed`, `blocked`, `cancelled`, `timed-out`, `manually-accepted`.

## Inspecting runs

```sh
specbridge run list                 # newest first
specbridge run show <run-id>        # request, outcome, changes, verification, evidence
specbridge run show <run-id> --verbose   # + prompt and raw model output
```

Raw prompts and raw model output print only with `--verbose`; they are
always retained on disk.
