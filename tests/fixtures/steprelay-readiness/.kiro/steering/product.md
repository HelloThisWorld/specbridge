# StepRelay (readiness fixture)

StepRelay is a small event-driven workflow backend. A workflow configuration
names an ordered set of actions; a start message begins a run, and each action
emits a next message that routes the run to the worker responsible for the
following action.

This is a synthetic fixture used to exercise SpecBridge orchestration
governance. It is not an implementation of StepRelay and must never become
one.

## Vocabulary

- **workflow** — an ordered configuration of actions.
- **action** — one unit of work handled by a worker.
- **start message** — begins a workflow run.
- **next message** — advances a run to the following action.
- **broker** — the message transport abstraction.
- **worker** — the process that handles one or more actions.
- **execution state** — the durable record of where a run has reached.
