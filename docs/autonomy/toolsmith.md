# Toolsmith

The Toolsmith formalizes a sentence a human had to type into a prompt at
midnight during the previous dogfood:

> If you need a tool, build it.

and does it without turning it into "do whatever you like".

---

## The one rule

> **Agents may create TOOLS. Agents may never create AUTHORITY.**

A request to add a verification command, widen a protected path, raise a
spend ceiling, or edit the autonomy policy is a request to change what
SpecBridge is *allowed to do*, wearing the costume of a request to install
something. `WOULD_CREATE_AUTHORITY` is the denial reason for exactly that,
and it fires whatever capability class carries the request.

The authority-shaped targets, denied unconditionally:

```
.specbridge/config.json          the policy itself
.specbridge/autonomy/**          seals, ledgers, telemetry
.claude/settings*.json           the harness's own permissions
.kiro/**                         approved product truth
```

## Capabilities, not commands

A request names a **capability class**, never a command line:

| Capability                | What it permits                                       |
| ------------------------- | ----------------------------------------------------- |
| `PROJECT_LOCAL_SCRIPT`    | write a script or tool inside the workspace            |
| `PROJECT_DEPENDENCY`      | add a dev/test dependency to the project's manifest    |
| `PACKAGE_MANAGER_INSTALL` | run the project's package manager                      |
| `PROJECT_LOCAL_TOOLCHAIN` | download a build toolchain into the project            |
| `BROWSER_RUNTIME`         | download a browser runtime                             |
| `CONTAINER_IMAGE`         | pull an image from a configured registry               |
| `CONTAINER_LIFECYCLE`     | start/stop containers for the product under test       |
| `USER_LOCAL_CLI`          | install a CLI into a user-local (never system) prefix  |
| `CODE_GENERATION`         | generate fixtures, fakes, simulators, fault injectors  |

The executor maps each capability to a **fixed argv shape with exactly one
variable position**, and that position is the already-brokered target. No
shell, no string interpolation into an executable, no user-supplied flags.
That constraint is what makes "the agent installs what it needs" a bounded
statement rather than an open one.

A capability with no single safe command shape — `PROJECT_LOCAL_TOOLCHAIN`,
whose installation differs per language and platform — is **refused with the
alternative named** rather than guessed at. A wrong guess about how to
install a JDK at 03:00 is worse than an honest "this one needs you".

## Scope preference

```
PROJECT_LOCAL  ->  PORTABLE  ->  CONTAINERIZED  ->  USER_LOCAL
```

There is no machine-global option. A tool that genuinely requires
administrator rights is not an engineering problem the runtime can solve; it
is a question for a person, and it leaves through the [authority
firewall](authority-firewall.md) rather than through this broker.

When a request asks for something admin-shaped, the broker denies it **and
names the portable route**, because "install Docker Desktop" and "pull a
container image" are wildly different asks that people conflate:

```
REQUIRES_ADMIN_PRIVILEGE
  "/usr/local/bin/kcat resolves to a system location. SpecBridge never
   installs into a system prefix, and a tool that genuinely needs one is a
   question for a person."
  -> Use a project-local install, a portable archive, or a container image.
```

A request whose scope does not match the capability's canonical scope is
**narrowed**, not granted where it asked. A "project-local" install that
quietly landed in a user profile would outlive the job that created it.

## Denials are recorded

A denial is the interesting record: it is the moment the runtime wanted
something and did not take it. An operator reading the morning report needs
to see that as clearly as they see what was installed.

```bash
specbridge autonomy toolsmith <jobId>
```

```
3 Toolsmith request(s)
  PROJECT_DEPENDENCY  vitest      APPLIED
  BROWSER_RUNTIME     chromium    APPLIED
  PROJECT_LOCAL_SCRIPT  .specbridge/config.json  DENIED  (WOULD_CREATE_AUTHORITY)
```

`selfCreatedTools` in the telemetry counts **APPLIED** file-writing grants,
not granted ones: a grant that was never used did not create a tool, and the
morning report should say what exists.

## Denial reasons

| Reason                        | Means                                              |
| ----------------------------- | -------------------------------------------------- |
| `TOOLSMITH_DISABLED`          | policy has it off; a missing tool stops the run     |
| `CAPABILITY_NOT_ENABLED`      | this class was not granted                          |
| `GRANT_BUDGET_EXHAUSTED`      | `maxGrantsPerJob` is spent                          |
| `TARGET_OUTSIDE_WORKSPACE`    | project tooling lives in the project                |
| `TARGET_PROTECTED_PATH`       | the writer would refuse it anyway                   |
| `REGISTRY_NOT_ALLOWED`        | an image registry outside the allowed list          |
| `REQUIRES_ADMIN_PRIVILEGE`    | a system prefix; the portable route is named        |
| `WOULD_CREATE_AUTHORITY`      | control-plane state wearing a costume               |
| `DOWNLOAD_TOO_LARGE`          | past `maxDownloadBytes`                             |
| `PORTABLE_ALTERNATIVE_REQUIRED` | the scope is wrong for this capability            |

The protected-path check uses the same small glob subset (`*`, `**`, `?`) the
execution layer uses. A near-miss would be worse than no check: it would
grant something the writer then refuses, halfway through, at 03:00.

## Configuration

```jsonc
"autonomy": {
  "toolsmith": {
    "enabled": true,
    "capabilities": [
      "PROJECT_LOCAL_SCRIPT", "PROJECT_DEPENDENCY", "PACKAGE_MANAGER_INSTALL",
      "PROJECT_LOCAL_TOOLCHAIN", "BROWSER_RUNTIME", "CONTAINER_IMAGE",
      "CONTAINER_LIFECYCLE", "CODE_GENERATION"
    ],
    "maxGrantsPerJob": 40,
    "maxDownloadBytes": 2147483648,
    "timeoutMs": 900000,
    "allowedImageRegistries": [],     // empty: the daemon's own configuration
    "allowedPackageRegistries": [],   // empty: the project's own registry
    "userLocalPrefix": ".specbridge/tools"
  }
}
```

`USER_LOCAL_CLI` is deliberately **not** in the OVERNIGHT preset. Writing
outside the workspace into a user profile is a bigger promise than
"engineering inside this project", and an operator who wants it says so.

## Why this is not a permission bypass

Nothing here weakens an existing boundary:

- protected paths still refuse
- the workspace boundary still refuses
- verification commands still come only from configuration
- approvals still have no agent-reachable surface
- spend still requires the vNext.5 authorization

The Toolsmith adds one thing: a *named, bounded, audited* way to obtain
engineering tooling that a project needs and does not have. Missing package,
missing test harness, missing local script, missing browser binary — every
one of those is an engineering problem, and none of them should cost eight
hours.
