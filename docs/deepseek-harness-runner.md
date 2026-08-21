# DeepSeek Harness runner (vNext.3, PREVIEW)

The `deepseek-harness` implementation drives a [DeepSeek
Harness](https://github.com/deepseek-ai/deepseek-harness) runtime as a
**disposable agent execution engine** underneath the SpecBridge control
plane, over the official TypeScript SDK's stdio JSON-RPC protocol.

```text
SpecBridge            =  engineering control plane
                         (Mission/Job, Task, Contract, ExecutionAttempt,
                          Checkpoint, canonical Context, Quota, Scheduling,
                          Evidence, completion authority, ExecutionLedger)

DeepSeek Harness      =  disposable agent execution runtime
                         (agent loop, fs/shell tools, sandbox, tool
                          registry, agent-local session + context, native
                          compaction, attempt-internal subagents)
```

The invariant everything below serves: **DSH state is disposable working
state; SpecBridge state is canonical durable engineering state.** Killing
the DSH process, deleting its sessions, or replacing its version must never
destroy a Job, Task, Contract, Checkpoint, Decision, or Evidence — and the
vNext.3 validation suite proves exactly that scenario end to end.

## Ownership boundary

```text
Task
  ├── ExecutionAttempt #1 ── DSH session A   (disposable)
  └── ExecutionAttempt #2 ── DSH session B   (disposable)
```

- A DSH session is owned by ONE ExecutionAttempt; it is never the Task.
- DSH-native compaction is attempt-local working-memory optimization; the
  structured SpecBridge Checkpoint remains the only canonical state. A
  future handoff (DSH → Claude Code) never requires the next provider to
  understand DSH's compacted state.
- Pre-dispatch context assembly stays SpecBridge-owned: durable Task state
  → Checkpoint → pinned context → working set → recent delta →
  ContextLifecycle budget/compact → ContextPackage → DSH prompt. DSH may
  inspect the repository with its own tools during its attempt; canonical
  task memory still comes from SpecBridge.
- Everything DSH reports (`completed`, changed files, test claims) is an
  unverified CLAIM. Completion still requires SpecBridge Git snapshots,
  trusted verification commands, and evidence evaluation.

## Dependency isolation

- The exact tested SDK is pinned: `@deepseek-ai/dsh-sdk-client 0.1.1-rc.1`
  (+ its runtime dependency `@deepseek-ai/dsh-sdk-protocol 0.1.1-rc.1`),
  developer preview, isolated inside `@specbridge/runners`. The pin is
  surfaced by `runner doctor` and recorded on every run's `runner.started`
  event together with the handshake-reported runtime version.
- One narrow internal adapter (`DshSdkAdapter`) owns every SDK call:
  runtime launch, `initialize` handshake (the wire-stable
  `deepseek-harness-sdk-runtime` identity is verified; anything else is
  refused as incompatible), session prompt, notification collection,
  teardown, and error classification. A breaking SDK change lands in one
  file.
- DSH runs OUT-OF-PROCESS: SpecBridge spawns and controls the runtime
  subprocess; the Cordis plugin graph is never embedded into the
  SpecBridge process, and no DSH/Cordis type appears in
  `@specbridge/core`, `@specbridge/context`, `@specbridge/execution`,
  `@specbridge/evidence`, or orchestration domain state.

## Enabling it (explicit, never automatic)

The built-in `deepseek-harness` profile ships DISABLED, is `preview`
support level (explicit `--runner` selection only — never a default, never
an operation default, never a fallback), and does not change any scheduler
behavior: vNext.2 LOCAL/SUBSCRIPTION routing is byte-identical with the
profile enabled or not. Automatic `LOCAL → HARNESS` routing is explicitly
deferred to vNext.4.

```jsonc
{
  "runnerProfiles": {
    "deepseek-harness": {
      "runner": "deepseek-harness",
      "enabled": true,                          // ← your explicit opt-in
      // Explicit launch spec: SpecBridge never assumes a global `dsh`
      // command, npx, a user profile, or a runtime home.
      "command": {
        "executable": "node",
        "args": ["/opt/dsh/lib/bin.js", "/opt/dsh/cordis.yml"]
      },
      "provider": "deepseek-official",          // initialize route (required)
      "model": "deepseek-v4-flash",             // initialize model (required)
      "maxTokens": 49152,                       // optional output cap
      "workspaceBoundary": "runtime-profile",   // ← attestation, see Safety
      "sessionPersistence": "none",             // or "runtime-managed"
      "environmentPassthrough": [],             // extra env NAMES, never values
      "timeoutMs": 1800000,
      "handshakeTimeoutMs": 30000
    }
  }
}
```

The runner is NOT tied to one model or lane: `provider`/`model` are
explicit configuration passed to the runtime handshake, and the effective
route is recorded from the runtime's own `request/context` events when it
logs one (otherwise the configured value is recorded and nothing is
guessed). How local Qwen or API-backed models route through this harness
is vNext.4/vNext.5 work.

## Safety (what is actually enforced)

The tested public SDK exposes **no sandbox, filesystem, or tool
restriction configuration** — the launched runtime's own profile
(`cordis.yml`) composes its tools and boundaries. SpecBridge therefore
does not pretend production support:

- the adapter is `preview` and can never be confirmed production by
  conformance;
- task execution **fails closed** (`sandbox_unavailable`, before any
  process spawn) until the operator sets
  `workspaceBoundary: "runtime-profile"`, attesting that the configured
  runtime profile confines writes to the workspace;
- SpecBridge's own protections still apply after every run regardless of
  the attestation: pre/post Git snapshots, protected-path checks
  (`.kiro` approvals, `.specbridge` state), trusted verification, and
  evidence evaluation;
- authoring (`generateStage`) is refused before any model call: without an
  enforceable read-only boundary, SpecBridge does not claim one;
- the child environment is REPLACED, not inherited: a minimal safe base
  (PATH, TEMP, HOME, …) plus the profile's explicit
  `environmentPassthrough` names. Credentials are never inherited
  implicitly and never stored;
- there is no permission-bypass configuration of any kind, and commands
  are argv-based (shell strings are rejected by the config schema).

## Sessions, resume, and the continuity guard

`sessionId` maps one-to-one onto a DSH wire session; each ExecutionAttempt
gets its own. The SDK protocol has no way to verify that a runtime
actually restored a session (an unknown id is silently created empty), so
resume is **attested, then verified**:

- `sessionPersistence: "none"` (default): resume is not offered
  (`resumeSupported: false`); interrupted tasks continue from the
  SpecBridge checkpoint with a fresh session — always available.
- `sessionPersistence: "runtime-managed"`: the fast path sends the resume
  prompt to the original session id and watches the first session-log
  event's `seq`. A genuinely restored session continues its log
  (`seq > 0`); `seq 0` means the runtime silently created it empty — the
  run is stopped (bounded close) BEFORE any agentic work and fails as
  `session_unavailable`, and orchestration falls back to the canonical
  path: latest SpecBridge Checkpoint + current repository state +
  ContextLifecycle reconstruction → fresh DSH session.

A lost DSH session can therefore never make a Task unrecoverable, and a
fake resume can never run on wrong context.

## Cancellation, timeout, crash

The DSH wire protocol has **no mid-turn cancel**: abandoning a run means
closing the runtime. SpecBridge propagates `AbortSignal` and the
per-invocation timeout by closing the SDK client, which walks the SDK's
bounded teardown ladder (protocol `shutdown` → stdin-EOF quiesce → SIGTERM
→ SIGKILL; on Windows forced termination) until the child has actually
exited — idempotent, no orphaned processes. Cancellation classifies as
`cancelled` (never auto-retried), a deadline as `timed_out`, and a runtime
crash as `process_failed`: a worker failure that preserves the attempt
record, the checkpoint, and the Job.

## Events, reasoning, usage

Safe lifecycle notifications normalize into the existing
`NormalizedRunnerEvent` vocabulary (session/turn/tool/command/message/
usage events, `plan.updated` for todo writes, subagent start/finish as
bounded tool activity, and the additive `compaction.occurred` for observed
native compaction). Reasoning is strict: `reasoning` blocks,
`reasoning-delta` chunks, and any thinking output are NEVER persisted —
normalized events carry only occurrence metadata (part/char counts), and
the retained raw notification log is deep-redacted (`[redacted reasoning:
N chars]`; `request/header` payloads — system prompt and tool schemas —
are elided entirely). Usage is provider-reported only: token counts from
`assistant/message` accounting (disjoint cached-input semantics
preserved), `null` when unreported, and cost is never computed by
SpecBridge.

## Diagnostics

```bash
specbridge runner list                           # profile + enabled/disabled
specbridge runner show deepseek-harness          # config + capability set
specbridge runner doctor deepseek-harness        # spawns ONE handshake probe:
                                                 # identity, runtime version,
                                                 # attestations — no model turn
specbridge runner conformance deepseek-harness   # applicable groups
specbridge runner test deepseek-harness --network  # explicit minimal model probe
```

Cheap detection verifies only static facts (command resolves, profile
complete). Authentication is always reported `unknown` — the SDK exposes
no read-only credential check and SpecBridge never guesses.

## Manual live smoke test (optional, never in CI)

CI runs entirely against the deterministic fake runtime. To validate a
real local setup once (real DSH runtime + a local model you already
serve), configure a scratch workspace profile like the example above —
pointing `command` at your actual runtime entry point and `cordis.yml`,
and `provider`/`model` at a route your runtime mounts (a local
OpenAI-compatible endpoint serving e.g. a Qwen build works; SpecBridge
does not assume or hard-code any particular local model):

```bash
specbridge runner doctor deepseek-harness          # handshake only
specbridge runner test deepseek-harness --network  # one bounded model turn
specbridge spec run <spec> --task <id> --runner deepseek-harness
```

Then verify the run report: the edit exists in Git, trusted verification
ran, and the task completed only on `verified` evidence.

## Current limitations (developer preview)

- vNext.3 does NOT route LOCAL jobs through DSH automatically — the
  current LocalExecutor and all scheduler defaults are unchanged. The
  `LOCAL → DIRECT_MODEL | HARNESS` split is vNext.4; API-lane gap routing
  is vNext.5.
- No wire-level cancel (close-only), no per-prompt result attribution
  (the final response is the last committed assistant text before idle),
  and no server→client approval flows in the tested SDK.
- Session persistence and the workspace boundary are runtime-profile
  properties the public SDK can neither configure nor verify — hence the
  attestations, the seq-continuity guard, and the preview support level.
