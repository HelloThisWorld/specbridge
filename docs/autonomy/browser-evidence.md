# Browser evidence and the UX critic

> A frontend build passing is not proof that a UI works.

A React app compiles fine with a modal rendered behind the header and a
submit control off-screen. Browser verification is a first-class evidence
source because that premise is wrong, and no amount of unit testing fixes it.

---

## Scenarios are a closed vocabulary, not a script

There is **no** "evaluate this JavaScript in the page" step, deliberately. A
scenario that could script the DOM could also fabricate what it then asserts,
and evidence that can forge itself is not evidence.

| Acting steps | Asserting steps |
| --- | --- |
| `NAVIGATE` `RELOAD` `CLICK` `TYPE` `FILL_FORM` `SUBMIT` `WAIT_FOR_SELECTOR` `WAIT_FOR_TEXT` `SET_VIEWPORT` `SCREENSHOT` `SWITCH_CONTEXT` | `EXPECT_SELECTOR` `EXPECT_TEXT` `EXPECT_ABSENT` `EXPECT_URL` `EXPECT_NO_CONSOLE_ERRORS` `EXPECT_NO_FAILED_REQUESTS` |

Only assertion steps can fail a scenario, and authoring **refuses** a
scenario containing none: a test that cannot fail is not evidence about
anything.

`assertionsRun` is counted, and `isClosingBrowserResult` requires it to be
non-zero. A scenario that navigated somewhere and took a screenshot has
demonstrated that a server responded.

## Contexts are first-class

The products that need this are the multi-user ones. Player A, Player B, and
a spectator each get an **isolated** `BrowserContext` — separate cookies,
separate storage, separate session. A model where a scenario is implicitly
one session could not express the case at all, and sharing one context would
make a multi-user scenario a single-user scenario with extra steps.

```jsonc
{
  "contexts": ["player-a", "player-b", "spectator"],
  "steps": [
    { "kind": "NAVIGATE", "context": "player-a", "url": "/executions" },
    { "kind": "NAVIGATE", "context": "player-b", "url": "/executions" },
    { "kind": "CLICK", "context": "player-a", "selector": "[data-test=trigger]" },
    { "kind": "WAIT_FOR_SELECTOR", "context": "player-b", "selector": "[data-test=row]" },
    { "kind": "EXPECT_SELECTOR", "context": "player-b", "selector": "[data-test=row]" },
    { "kind": "EXPECT_NO_CONSOLE_ERRORS", "context": "player-a" }
  ]
}
```

A step naming a context the scenario never declared is refused at authoring
time.

## Playwright is optional, on purpose

It is loaded by dynamic `import()` and is **not** a declared dependency:

- Installing SpecBridge should not download three browsers. Most workspaces
  never run a browser scenario.
- The [Toolsmith](toolsmith.md) already knows how to provide one, at the
  moment it is needed, under a granted `BROWSER_RUNTIME` capability.
- Absence must be a **skip with a reason** — never a failure, and never a
  pass.

```
status: SKIPPED_NO_RUNTIME
skipReason: "Playwright is not installed in this workspace. Grant the
             BROWSER_RUNTIME Toolsmith capability, or add playwright as a
             dev dependency."
```

A skipped scenario closes nothing. An acceptance criterion requiring browser
evidence stays unclosed and generates gap work. The run does not "succeed
anyway".

## Evidence

Execution stops at the **first failed assertion** but still captures
evidence. Continuing past a failed precondition produces a cascade of
meaningless failures; capturing nothing produces a morning report that says
"it broke" and cannot say how.

The DOM snapshot is taken **at the moment of failure**, not in a cleanup
pass — the difference between evidence about the failure and evidence about
whatever the page settled into.

Retained per result: screenshots, the DOM at failure, the console and network
log, the step trace, and one result record per viewport in a responsive
matrix. Collapsing viewports into one result would hide *which* viewport
broke, which is the only interesting fact a responsive check produces.

## The UX critic

The critic exists because deterministic evidence has a real blind spot: a
scenario can click every button, assert every selector, and pass while the
modal renders behind the header. A human looking at the screenshot sees it in
a second.

It is also the single most dangerous thing in vNext.10, because *"the
reviewer did not like it"* is an infinitely renewable source of work at 3am.
So its limits are structural, not advisory.

### There is no PASS verdict

```
NO_MATERIAL_FINDINGS   the absence of problems it looked for
MATERIAL_FINDINGS      something worth repairing
NOT_RUN                the critic is disabled
INSUFFICIENT_EVIDENCE  it could not see enough to judge
```

The strongest thing a critic may say asserts the absence of problems *it
looked for* and nothing about whether the product works. Naming it `PASS`
would eventually let someone read it as evidence, and it is not evidence.

### Taste cannot create work

An `AESTHETIC_PREFERENCE` finding is forced to `COSMETIC` severity whatever
the critic claimed, and only `MATERIAL` findings create work. The list of
always-cosmetic kinds is a list rather than a special case because the
pressure to add "well, *this* aesthetic issue is really a usability issue" is
constant, and a list makes each addition a visible decision.

### The verdict is computed, not reported

A critic returning `MATERIAL_FINDINGS` alongside three cosmetic observations
would otherwise manufacture work by asserting a conclusion its own evidence
does not support. The service computes the verdict from the normalized
findings.

### Deterministic failure is never overridden

```
deterministic evidence FAILS  +  critic says fine      ->  still FAILS
deterministic evidence PASSES +  critic finds material ->  bounded repair
```

`critiqueEffect()` refuses to act on a scenario that already failed
deterministically: repair is driven by the deterministic failure, and letting
the critique also claim it would create a code path where critic state
affects what a deterministic failure means.

`criticCanOverrideDeterministicFailure()` returns `false`, always. The
function is trivial; the guarantee is not, and the cheapest way to keep a
guarantee true is to give it a name something can call.

### Cycles are bounded

Once the critic has caused `maxCriticRepairCycles` for a scenario, further
critiques are recorded as **advisory**. The run does not fail; the critic
simply stops being able to spend anyone's night on it.

## Configuration

```jsonc
"autonomy": {
  "browser": {
    "enabled": true,
    "maxContexts": 4,
    "navigationTimeoutMs": 30000,
    "scenarioTimeoutMs": 300000,
    "captureScreenshots": true,
    "captureConsole": true,
    "maxEvidenceBytes": 16777216,
    "viewports": ["1280x800", "390x844"]
  },
  "critic": {
    "mode": "BLOCKING",          // DISABLED | ADVISORY | BLOCKING
    "maxCriticRepairCycles": 2,
    "maxFindings": 25
  }
}
```

There is no critic mode in which a critique can pass something deterministic
evidence failed. Negative authority only, in every mode.
