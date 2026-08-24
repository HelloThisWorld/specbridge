# Operator setup — the evening checklist

Everything a person does happens before they go to bed. This is that list.

---

## Once per machine

```bash
specbridge autonomy setup --mode overnight
```

Writes the OVERNIGHT preset into `.specbridge/config.json`, preserving
everything already there. It prints what it granted and, below it, the
surfaces it did **not** — the ones no configuration can move.

To enable [control-plane self-repair](control-plane-repair.md), which needs a
path only you know:

```bash
specbridge autonomy setup --mode overnight --specbridge-source /path/to/specbridge
```

Check what you granted at any time:

```bash
specbridge autonomy policy
```

## Once per intent

The mission must have contracts, requirements, and success criteria. Then:

```bash
specbridge autonomy seal <mission> --confirm
```

**This is the human gate.** Without `--confirm` it drafts and shows you what
would be authorized; with it, the seal becomes executable.

An incomplete seal is refused with the gaps named, and every gap is something
you can fix in ten minutes:

```
Not authorizable: missing ACCEPTANCE_CRITERIA
  The mission records no success criteria. Without them the runtime cannot
  tell whether the product is finished, only whether the task list is.
```

Optional, and worth setting deliberately:

```bash
specbridge autonomy seal <mission> --confirm \
  --max-spend 20.00 \
  --lanes LOCAL,SUBSCRIPTION,API
```

The effective spend ceiling is the **smaller** of the seal's and the
configuration's. A generous seal cannot loosen a strict configuration, and a
generous configuration cannot loosen a strict seal.

## Before you leave

```bash
specbridge overnight preflight <mission>
```

You are looking for one line:

```
✓ OVERNIGHT_READY
```

Anything else, fix it now. Every `HUMAN_REQUIRED` finding prints what to do:

```
✗ CONTAINER_RUNTIME: the docker CLI is installed but the daemon did not answer
    Start the container runtime before leaving the machine. A daemon is a
    machine-level prerequisite: no policy can delegate starting one.
```

Lines marked *(the runtime provides this)* are **not** your problem — a
missing browser binary the Toolsmith may install is work, not a blocker.

`INDETERMINATE` means a probe could not decide. Do not launch on it: "we could
not tell" is not "probably fine".

### What preflight checks

workspace writability · disk space · git · protected paths · seal present ·
seal complete · autonomy policy complete · supervisor capable · strong worker
available · local model startable · API fallback authorized · spend ceiling
declared · trusted verification configured · package manager · package
registry · build toolchain · container runtime · container compose · browser
runtime · Toolsmith policy · environment policy · known credentials ·
control-plane repair configured

## Launch

```bash
specbridge overnight run <mission>
```

Then go to sleep. From this point nothing normal requires you.

## In the morning

Two outcomes are normal:

```
COMPLETED
  ✓ all 6 sealed contract item(s) close on trusted evidence,
    reproduced from a clean environment
```

```
NEEDS_AUTHORITY
  ⊘ Completing this work requires changing sealed contract CTR-002.
    Approve the change, amend the sealed intent, or direct a different approach.
```

Everything else — waiting on quota, restarting a provider, installing a
package, repairing an environment — happened and finished while you slept.
The report says how many times.

```bash
specbridge autonomy report <jobId>
```

## If it stopped for authority

The question names one decision. Three ways forward, all yours:

1. Approve the contract change, re-seal, re-run.
2. Reject it and direct an approach that keeps the contract intact.
3. Amend the sealed intent and re-seal.

Then:

```bash
specbridge overnight run <mission> --job <jobId>
```

## Inspecting mid-flight

All read-only. None of it is required for progress:

```bash
specbridge autonomy status              # what the supervisor owns
specbridge autonomy report <jobId>      # telemetry + the closure ledger
specbridge autonomy toolsmith <jobId>   # what it installed, and what it was denied
specbridge autonomy supervision         # the supervision log
specbridge autonomy repairs             # control-plane repairs
specbridge autonomy certification       # zero-touch runs recorded here
```

## Things worth deciding on purpose

**The spend ceiling.** An unknown ceiling is treated as *no* authorization,
not as unlimited. If you want API fallback overnight, declare a number.

**Protected paths.** An overnight run edits files for hours with nobody
watching the diff. Preflight requires at least one pattern.

**Verification commands.** Without them nothing can close a contract item on
trusted evidence, and the run cannot legitimately reach COMPLETED. Preflight
requires at least one.

**Whether the mission's criteria imply a browser or containers.** They are
derived from text *you wrote*, at seal time, and frozen. If a criterion
mentions a dashboard, the run will need browser evidence to close it.

## What will still stop the night

Honestly, and by design:

- permanent loss of every allowed compute lane
- a credential only you can supply
- a spend need past the authorized ceiling
- a genuine contradiction between sealed requirements
- machine failure

See [what zero-touch does not
guarantee](overnight-autonomy.md#what-zero-touch-does-not-guarantee).
