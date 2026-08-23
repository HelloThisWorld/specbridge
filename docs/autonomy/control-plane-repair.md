# Control-plane self-repair

The previous dogfood exposed a real SpecBridge defect in the Claude Code
integration, and the operator became the SpecBridge maintainer at midnight.

That is the failure this removes. It is also the single most dangerous
capability in vNext.10, because **a runtime that can patch itself can patch
away the things stopping it.**

---

## The asymmetry

A repair is easy to reject and hard to activate.

```
DETECTED
PRODUCT_JOB_CHECKPOINTED
ISOLATED
DIAGNOSED
PATCHED
REGRESSION_TEST_ADDED
FOCUSED_TESTS_PASSED
FULL_QUALIFICATION_PASSED
ARTIFACT_REBUILT
ARTIFACT_VERIFIED
CANARY_PASSED
ACTIVATED
PRODUCT_JOB_RESUMED
```

`completeStage()` accepts **only the next stage**. A repair that could jump
from `DIAGNOSED` to `ACTIVATED` would be a repair with no qualification, and
the ordering is the only thing standing between "SpecBridge fixed itself" and
"SpecBridge changed itself".

## The invariant screen runs first

Before the tests. That ordering matters: a patch that disables the
verification gate never gets the chance to make the suite green.

`PROTECTED_CONTROL_PLANE_INVARIANTS` is short because it is meant to be
memorable, and every member is something a sufficiently frustrated agent
would find attractive at 4am:

```
PERMISSION_BYPASS          PROTECTED_PATH_ENFORCEMENT
VERIFICATION_AUTHORITY     APPROVAL_AUTHORITY
SPEND_AUTHORIZATION        EVIDENCE_REQUIREMENT
AUTHORITY_FIREWALL         COMPLETION_ORACLE
```

A patch touching any of them is **REJECTED, not reviewed**.

### Added vs removed

The screen reads added and removed lines separately, because conflating them
produces either constant false positives or a screen that misses the actual
attack:

- An **added** `bypassPermissions`, `--yolo`, `mayComplete = true`, or
  `maxCostPerJobUsd: null` is a violation.
- A **removed** `assertInsideWorkspace`, `evaluateAuthority`,
  `consumeApiSpendApproval`, `assertMissionMayComplete`, or
  `CLOSING_EVIDENCE_KINDS` is a violation — *unless the same file adds it
  back*. A refactor that moves a guard is not a weakening.
- A removed comment mentioning permissions is not a violation.

The screen errs towards rejecting. A false positive costs one repair attempt
and a clear message; a false negative is an agent that disabled its own
verification gate at 4am to make a failing task pass. Those are not
symmetric.

### An unreadable diff is a refusal

"We could not look at the patch" and "we looked and it was fine" must never
produce the same outcome. A diff that fails to parse abandons the repair.

## The running control plane is never overwritten

A repair builds into a **staged** artifact path
(`.specbridge/autonomy/repairs/artifacts/<repairId>`) and records a pointer.
The supervisor adopts it on its next start.

The staged path is derived, not configurable: an operator who could point it
at the live install would have configured a process that overwrites itself
mid-flight, which is a class of failure nobody should debug at 4am.

## A regression test is mandatory

`activateRepair()` refuses without `regressionTestPath`. A control-plane fix
with no test is a fix that will be reintroduced, and the next unattended run
will spend another night on it.

It also refuses without `CANARY_PASSED`: the exact operation that failed must
be re-run against the rebuilt artifact before anything switches to it.

## Bounded per job

`maxRepairsPerJob` (default 2). A product job that keeps hitting
control-plane defects is a signal for a person, not a reason for another
self-repair cycle.

## Configuration

```jsonc
"autonomy": {
  "controlPlaneRepair": {
    "enabled": false,                 // opt-in; needs a sourcePath
    "sourcePath": "/path/to/specbridge",
    "maxRepairsPerJob": 2,
    "requireFullQualification": true,
    "requireCanary": true,
    "timeoutMs": 7200000
  }
}
```

`autonomy setup --mode overnight` leaves this **off**. It needs a
`sourcePath` only the operator knows, and enabling it blind would make every
preflight report a prerequisite the preset itself created. Enable it with:

```bash
specbridge autonomy setup --mode overnight --specbridge-source /path/to/specbridge
```

## What a repair may never do

An agent fixing SpecBridge because its product task keeps failing has an
obvious shortcut available. Beyond the screen:

- the Toolsmith denies writes to `.specbridge/config.json` and
  `.specbridge/autonomy/**` as `WOULD_CREATE_AUTHORITY`
- the seal is immutable and its authority digest is recorded
- approvals and seal authorization have no agent-reachable surface
- spend still requires the vNext.5 authorization
- the completion oracle still reads only evidence

The repair path removes one specific cost: a recoverable SpecBridge defect no
longer means the operator becomes the maintainer at midnight. It does not
give the runtime a way to change what SpecBridge promises.

## Inspecting

```bash
specbridge autonomy repairs
```

```
2 control-plane repair(s)
  cpr-a1  PROVIDER_CLI_INCOMPATIBILITY  SUCCEEDED
  cpr-b2  RUNNER_CONTRACT_MISMATCH      REJECTED_WEAKENS_INVARIANT
      rejected: weakens VERIFICATION_AUTHORITY
```
