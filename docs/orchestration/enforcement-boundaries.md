# Enforcement boundaries

Some orchestration rules are enforced by code that refuses the operation.
Some are enforced by a contract the host cannot satisfy without lying in a
recorded field. Some are only instructions in a skill document, which a host
can ignore.

Conflating these would be dishonest, so this page states which is which.

| Level | Meaning |
| --- | --- |
| `hard-enforced` | SpecBridge code refuses the operation outright |
| `contract-enforced` | The MCP/CLI contract requires structured evidence (a hash, an explicit decision) that a host cannot fabricate without a recorded falsehood |
| `skill-guided` | Instructional only — the host can bypass it |

**A skill instruction is never a security boundary.** If the only thing
stopping an action is prose in a `SKILL.md`, this page says `skill-guided`.

## The v1.1 rules

| Rule | Level | How |
| --- | --- | --- |
| Stage approval is human-only | hard-enforced | No MCP tool approves a stage; the tool catalog is closed and tested against a forbidden-name list |
| Completion requires verified evidence | hard-enforced | `orchestration_finalize` refuses `completed` without `verified`/`manually-accepted` from `task_complete` |
| Checkbox updates require verified evidence | hard-enforced | Unchanged v0.3 evidence pipeline; orchestration never writes `tasks.md` |
| No source edit before a plan exists | hard-enforced | `EDIT` is absent from the allowed-action set of every pre-plan phase |
| No source edit before plan review (`review` mode) | hard-enforced | `recordAction` refuses `EDIT` unless `planReview.decision === 'approved'` |
| No execution against a stale plan | hard-enforced | The mutating path re-binds the plan and refuses when stale |
| Budgets terminate the run | hard-enforced | The decision engine checks budgets before any continuation |
| Cancellation is never auto-restarted | hard-enforced | Cancellation is evaluated before every other rule |
| Finalized runs never resume | hard-enforced | Final phases have no outgoing transitions |
| Invalid phase transitions | hard-enforced | Frozen transition table, fails closed |
| Protected paths | hard-enforced | Unchanged v0.3 checks in the completion pipeline |
| Trusted commands come only from config | hard-enforced | Plan, clarification, spec, and repository text are never read as commands |
| Workspace confinement, atomic writes | hard-enforced | `assertInsideWorkspace` + `writeFileAtomic` on every write |
| Event and input bounds | hard-enforced | Oversized inputs and events are refused, never truncated |
| A plan review belongs to one exact plan | contract-enforced | The review is bound to the plan hash; a stale hash is refused |
| The user was actually asked before a plan review | **skill-guided** | SpecBridge records `channel: "user-relayed"`; it cannot observe the conversation |
| Intent provenance is honest | contract-enforced | Unsafe provenance downgrades `READY`; but the host chooses what to declare |
| Recorded actions describe real work | contract-enforced | Claims are recorded as claims; Git evidence decides completion |
| Clarification questions are genuinely needed | **skill-guided** | `whyItMatters` is required and duplicates are refused, but relevance is a judgement |
| No nested coding agent from the plugin | contract-enforced | `validate-plugin.mjs` fails the build on any un-negated nested-agent reference in a skill |
| Repository content is data | hard-enforced | No orchestration decision reads repository content as instructions |

## The two that are only skill-guided

**"Present the plan and ask the user before recording a review."** SpecBridge
sees a tool call carrying a decision and a plan hash. It cannot see whether a
human was asked. What it *can* do — and does — is bind the review to the exact
plan, record how it arrived (`user-relayed`), and refuse to let a review carry
over to a materially different plan. If a host records an approval nobody
gave, that is a recorded falsehood by the host, not a gate SpecBridge opened.

**"Ask only questions whose answers change the implementation."** The
structure is enforced (justification required, duplicates and re-asks
refused, rounds bounded). Whether a specific question is genuinely load-bearing
is a judgement call that no deterministic rule can make.

Both are stated plainly in `/specbridge:develop` rather than implied.

## Claude Code hook usage

**None.** v1.1 uses no Claude Code plugin hooks.

The investigation: hooks could in principle add real enforcement — refusing a
`Write` during a planning phase, for example. But the enforcement SpecBridge
needs already exists at the layer that matters. The MCP tools refuse the
operations, and the completion gate re-derives changed files from Git
regardless of what any editor did. A hook would add a second, weaker,
host-specific copy of rules that are already hard-enforced in shared code —
and it would be a copy that only works in one host, while the CLI and any
other MCP client kept using the real one.

No transcript scraping, no PTY automation, and no invented hook capabilities
are used. If a future Claude Code release exposes a stable, documented
capability that closes one of the two `skill-guided` gaps above, that is worth
revisiting; nothing here depends on it in the meantime.

## Context-window checkpointing

`/specbridge:develop` encourages calling `orchestration_checkpoint` before a
long stretch of work and whenever a session may be interrupted. It does not
read a context-usage API, because inventing one that may not exist would be
worse than checkpointing on a simple, honest trigger.
