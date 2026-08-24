# StepRelay Demo & Workbench

Add a complete StepRelay demo/workbench feature inside the existing StepRelay repository.

The demo must be a subproject/module in the same repository.

Use one Spring Boot demo application. Different REST controllers/services inside the same
application should simulate multiple microservices or serverless functions/actions.

Create sample StepRelay workflow configuration files.

## The demo workflow

The demo workflow is an airport passenger identity / boarding validation workflow.

Input includes:

- passport information;
- boarding-pass information;
- a face-photo binary string representation.

The workflow conceptually contains two airport gates:

Gate 1:
    validate passport and boarding-pass information.

Gate 2:
    perform/ simulate face verification.

The workflow must represent cases such as:

    Gate 1 opens, Gate 2 fails.

Use deterministic simulation where real biometric recognition is not appropriate for a
demo.

## Edge cases

The demo must cover edge cases including at least:

- passport present, boarding pass missing;
- boarding pass present, passport missing;
- passport and boarding pass present, face photo missing;
- invalid passport;
- invalid boarding pass;
- mismatched passenger/passport/boarding information;
- malformed face data;
- first gate failure;
- first gate success followed by second gate failure;
- both gates succeed;
- service timeout/failure/retry scenarios where appropriate.

## Workflow authoring

The configuration should provide a Step Functions-compatible or Step Functions-like
workflow authoring experience.

If the meaning or required degree of Step Functions compatibility is ambiguous, ask a
product question during discovery rather than assuming a compatibility promise.

## Infrastructure

Provide the infrastructure necessary to run the demo end to end.

Use Docker Compose and provision the real middleware needed by the chosen StepRelay
production adapters, including the database and event/broker infrastructure where required.

The demo must actually run workflows against the environment rather than being a static
code sample.

## Operations console

Also add a Step Functions-style visualization / operations console.

The console must support:

- discover/view workflow definitions;
- visualize the workflow state graph;
- list workflow executions;
- inspect one workflow execution;
- show current state;
- show completed/failed/waiting states;
- inspect attempts/transitions/events;
- start a new workflow execution;
- submit external workflow events;
- replay/redrive where supported by StepRelay semantics.

## Generic visualization

The visualization must NOT be hard-coded to the airport workflow.

It must be driven from the workflow definition/model.

If a different valid workflow configuration is loaded, the console must automatically
render the corresponding different workflow graph and state structure without frontend
code changes.

The frontend therefore must reason in generic StepRelay concepts such as:

- WorkflowDefinition
- State
- Transition
- WorkflowInstance
- StateOccurrence
- Attempt
- Event

and must not contain airport-specific workflow topology.

The airport workflow is a demo configuration, not the dashboard architecture.

## Verification

Add browser-level automated verification proving the console can operate the real demo.

The final result must be buildable, runnable locally and demonstrably usable end to end.
