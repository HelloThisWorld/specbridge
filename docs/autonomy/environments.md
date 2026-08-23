# Environment lifecycle

A product that needs Postgres, Kafka, a backend, and a frontend to
demonstrate anything cannot be verified by a test script that shells out to
`docker compose up` and sleeps.

That approach fails in the two ways that matter overnight: it cannot say
*why* something is not ready, and it leaves nothing behind when it gives up.

---

## Three records

| Record                | Answers                                   | Lifetime    |
| --------------------- | ----------------------------------------- | ----------- |
| `EnvironmentPlan`     | what should exist                          | reusable    |
| `EnvironmentInstance` | what does exist, and how it got there      | disposable  |
| `EnvironmentEvidence` | what was actually proven                   | durable     |

The same shape a job has, for the same reason.

## Readiness that means something

`docker ps` says a Postgres container is running several seconds before
Postgres will accept a connection. A test suite started in that window fails
in a way that looks like a product bug.

| Probe                   | Proves                                          |
| ----------------------- | ----------------------------------------------- |
| `PROCESS_ALIVE`         | a process exists. **Weakest; named as such.**    |
| `TCP_CONNECT`           | a port accepts                                   |
| `HTTP_STATUS`           | the service answers HTTP with an expected status |
| `HTTP_BODY`             | the response contains an expected marker         |
| `COMMAND_EXIT`          | a command against the service exits zero         |
| `PROTOCOL_HANDSHAKE`    | the service spoke its own protocol               |
| `CONTAINER_HEALTHCHECK` | the runtime's own healthcheck reports healthy    |

`PROCESS_ALIVE` exists so a plan can *say* it is only checking liveness, and
so the evidence can mark that as shallow. A readiness model with no weak
option would push authors to lie with a strong one.

A container that declares **no** healthcheck reports an empty status, and
that is **not healthy**: it means nobody defined what healthy would look
like. Treating the absence of a check as a passing check is the exact
shortcut this module exists to avoid.

## The honesty field

`EnvironmentEvidence` splits readiness two ways:

```json
{
  "applicationLevelReady": ["postgres", "kafka", "api"],
  "livenessOnlyReady": [],
  "notReady": []
}
```

A closure oracle that read "READY" and closed a distributed-system
requirement on it deserves to know whether anything spoke Postgres or whether
four processes merely existed.

`composePlanFromServices` gives an unspecified service a
`CONTAINER_HEALTHCHECK` probe, **not** `PROCESS_ALIVE`. Defaulting to liveness
would silently produce shallow evidence for every service nobody thought
about.

## The readiness graph

`dependsOn` is about **readiness**, not start order. An application server is
started immediately and simply not probed until its database answers — both
faster and closer to how the services themselves behave.

A cyclic plan is **refused at plan time** rather than broken arbitrarily. A
plan where A waits for B and B waits for A can never become ready, and
discovering that at plan time costs nothing while discovering it via a
readiness timeout costs however long the timeout is.

## Restarts happen inside the wait

A broker that crashes on first start and comes up clean on the second is an
ordinary event. Making the whole environment fail and be re-provisioned would
turn a three-second hiccup into a full teardown.

Restarts are spaced across the readiness window rather than fired
immediately: restarting at once fights the ordinary slow start of a database;
never restarting sits through a crash loop until the timeout.

## Failure retains evidence

An overnight run that fails at 04:00 and helpfully deletes the database it
failed against has destroyed the only record of what went wrong.

On failure, per-service logs are captured into
`.specbridge/autonomy/environments/logs/<instanceId>/<serviceId>.log` and
referenced from the evidence. `teardown` passes `--volumes` only when it was
asked to discard everything; a failed instance is stopped and **retained** by
default.

Failure kinds are classified so a repair can be chosen, and anything
unrecognised is `UNKNOWN` rather than guessed — a wrong classification sends
the runtime down a repair path that cannot work and burns the restart budget
getting there:

`RUNTIME_UNAVAILABLE` · `IMAGE_PULL_FAILED` · `PORT_CONFLICT` ·
`READINESS_TIMEOUT` · `SERVICE_CRASHED` · `DEPENDENCY_UNREADY` ·
`CONFIGURATION_INVALID` · `RESOURCE_EXHAUSTED` · `UNKNOWN`

## Compose specifics

`--project-name` is always passed. Without it compose derives a project name
from the directory, and two SpecBridge instances working in sibling worktrees
would silently share containers — a failure that presents as inexplicable
cross-talk between unrelated runs.

`--remove-orphans` on teardown cleans up services a previous plan revision
started under the same project name; without it a renamed service leaks a
container that outlives every run that could stop it.

## System scenarios

A task-level test proves a unit works. A **system scenario** proves the
product works: real persistence, a real broker, a real API, a process
restart, a browser looking at the result.

A scenario composes things that already exist — an environment plan, argv
verification steps, optional browser scenarios — and may inject a fault
(`RESTART_SERVICE`, `STOP_SERVICE`) scoped to services in **its own** plan.

`ENVIRONMENT_UNAVAILABLE` is a distinct status from `FAILED`, and it is the
same distinction the reliability runtime makes between FAIL and INCONCLUSIVE:
an environment that would not start has proved nothing about the product.
Repairing the product because Docker was down is exactly the wasted overnight
cycle that classification prevents — so an `ENVIRONMENT_UNAVAILABLE` scenario
registers **no closure evidence at all**, in either direction.

## Configuration

```jsonc
"autonomy": {
  "environments": {
    "enabled": true,
    "maxInstances": 3,
    "readinessTimeoutMs": 180000,
    "probeIntervalMs": 2000,
    "maxServiceRestarts": 3,
    "retainDiagnosticsOnFailure": true,
    "maxLogBytesPerService": 2097152,
    "teardownOnJobFinal": true
  }
}
```

## Preflight

A container runtime is a **machine-level** prerequisite: no policy can
delegate starting a daemon. If a mission's sealed criteria imply containers
and `docker info` does not answer, preflight reports `HUMAN_REQUIRED` and
refuses the launch — in the evening, when starting Docker takes ten seconds.
