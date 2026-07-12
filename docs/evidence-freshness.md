# Evidence freshness

v0.3 evidence records prove what happened at the moment a task ran. Whether
a record still describes the repository *now* is decided at verification
time, deterministically. Model claims inside records (`runnerClaims`) are
audit data and are never consulted.

## The task-plan hash, semantics v2

Approving `tasks.md` records two hashes in the sidecar state:

```json
{
  "approvedHash": "<sha256 of the exact file bytes>",
  "approvedPlanHash": "<sha256 with checkbox state normalized>",
  "hashAlgorithm": "sha256",
  "hashSemanticsVersion": "2"
}
```

`approvedPlanHash` normalizes exactly one thing: the single state character
inside a recognized checkbox (`[ ]`, `[x]`, `[X]`, `[-]`, `[~]`) outside
code fences. Task text, numbering, indentation, requirement references, line
endings, and the BOM all stay byte-significant. Consequently:

- `[ ]` → `[x]` progress keeps the task-plan approval effective
- editing task text, IDs, hierarchy, or references invalidates it
- requirements and design approvals remain exact-byte hashes — unchanged

Sidecar state written before v0.4 has no `approvedPlanHash` and keeps
validating; it simply falls back to exact-byte semantics (v0.3 behavior)
until the next approval or sanctioned checkbox write records the new
fields. Nothing migrates silently.

## What each evidence record captures (v0.4)

New records carry a `specContext` (all fields optional, so v0.3 records
keep validating):

```json
"specContext": {
  "documentHash": "<approved requirements/bugfix hash at evidence time>",
  "designHash": "<approved design hash at evidence time>",
  "tasksPlanHash": "<checkbox-normalized plan hash at evidence time>",
  "taskFingerprint": "<sha256 of task id + title + requirement refs>",
  "taskText": "<the raw checkbox line>"
}
```

The task fingerprint is checkbox-invariant: progress never changes it,
renaming or renumbering the task does.

## Validation at verification time

A record counts toward completion only when its status is `verified` or
`manually-accepted`. It is then bucketed:

- **valid** — spec name matches; every recorded path stays inside the
  repository; the recorded hashes equal the currently approved content
  (plan hash for tasks); the task fingerprint matches the task as it exists
  now; recorded commits are ancestors of HEAD where resolvable
- **stale** — any of those comparisons fails (SBV011 for evidence-side
  drift: task identity, lineage, unapproved stages; SBV015 for spec-side
  drift: approved content changed or was re-approved after the evidence)
- **invalid** — structural problems: wrong spec name, unparseable
  timestamps, a `manually-accepted` status without its acceptance block, or
  paths escaping the repository (SBV024)
- **missing** — no accepted record exists for a checked task (SBV004)

Legacy v0.3 records without `specContext` are checked by recorded approval
timestamps instead: a stage (re)approved *after* the evidence was evaluated
makes it stale. This is deterministic — both timestamps are recorded data.

Manual acceptance stays valid only while the spec stages it was recorded
against remain unchanged and the task identity still matches; reports label
it distinctly (`manuallyAccepted` in the evidence summary).

## Evidence reuse for verification commands

With `--no-run-verification`, a policy-required command may be satisfied by
recorded evidence only when **all** of these hold:

1. the evidence record is valid and fresh (rules above),
2. the record shows that command passing, and
3. the record's `headAfter` commit is the exact current HEAD.

Anything less runs the command or fails honestly (SBV012 explains that the
command did not run and nothing reusable covered it). Reused results are
labelled `reused-evidence` in every report.
