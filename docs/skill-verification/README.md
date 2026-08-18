# SpecBridge plugin skill verification

Every SpecBridge Claude Code plugin skill was verified with the
[agent-skill-verification-template](https://github.com/HelloThisWorld/agent-skill-verification-template)
harness against a **real local model** — no mock, no API service:

- **Model:** `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` served by llama.cpp
  `llama-server` (OpenAI-compatible endpoint, temperature 0)
- **Tools:** every harness tool shells out to the **actual `specbridge` CLI**
  (`--json`, read-only commands only) against a committed fixture workspace
  with real sidecar state and two installed reference extensions
- **Grounding:** answers must cite exact `file:line` evidence that the
  harness re-reads from disk; CLI-only facts (runner profiles, template
  catalog, verification rules) are grounded through committed snapshots that
  the tools re-check against live CLI output on every call
- **Guard cases:** each skill must **refuse** requests to create, approve,
  execute, enable, install, edit, or mark anything complete — mutations stay
  explicit `specbridge` CLI actions

## Result: 11/11 skills PASSED

Gate: every test case must pass its recorded run (threshold 0.8, 1 run/case).
33 cases total (22 answered + 11 guard/negative), all passing schema,
citation, unsupported-claim, and tool-call validation.

| Skill | Cases | Pass rate | Schema | Citations | P95 latency | Report |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | 3 | 100% | 100% | 100% | 20.6s | [screenshot](screenshots/specbridge-status.png) |
| `doctor` | 3 | 100% | 100% | 100% | 33.5s | [screenshot](screenshots/specbridge-doctor.png) |
| `new` | 3 | 100% | 100% | 100% | 16.5s | [screenshot](screenshots/specbridge-new.png) |
| `author` | 3 | 100% | 100% | 100% | 150.1s | [screenshot](screenshots/specbridge-author.png) |
| `approve` | 3 | 100% | 100% | 100% | 49.4s | [screenshot](screenshots/specbridge-approve.png) |
| `implement` | 3 | 100% | 100% | 100% | 19.7s | [screenshot](screenshots/specbridge-implement.png) |
| `continue` | 3 | 100% | 100% | 100% | 19.5s | [screenshot](screenshots/specbridge-continue.png) |
| `verify` | 3 | 100% | 100% | 100% | 11.9s | [screenshot](screenshots/specbridge-verify.png) |
| `runners` | 3 | 100% | 100% | 100% | 147.0s | [screenshot](screenshots/specbridge-runners.png) |
| `templates` | 3 | 100% | 100% | 100% | 12.4s | [screenshot](screenshots/specbridge-templates.png) |
| `extensions` | 3 | 100% | 100% | 100% | 12.2s | [screenshot](screenshots/specbridge-extensions.png) |

Totals: 147k input / 56k output tokens of live inference. Machine-readable
results: [`results/specbridge-verification.json`](results/specbridge-verification.json)
plus one `results/specbridge-<skill>.summary.json` per skill (the harness's
untouched `summary.json`).

## v1.1 — `/specbridge:develop`: BLOCKED (not run)

The governed-workflow skill added in v1.1 has **not** been verified against a
live model. It is marked `BLOCKED`, not `PASS`.

### What was run

| Check | Result |
| --- | --- |
| `pnpm validate:plugin` (static plugin validation, 12 skills) | **PASS** — including new v1.1 rules: `develop` must reference `orchestration_begin`, `_assess_intent`, `_submit_plan`, `_review_plan`, `_record_action`, `_finalize`; no skill may reference a non-existent approval tool; every `orchestration_*`/`task_*` tool a skill names must exist in `contracts/mcp-contract.json` |
| `agent-skill-verifier validate` on `cases/specbridge-develop.json` | **PASS** — 9 checks, no errors |
| `agent-skill-verifier validate` on `cases/specbridge-develop-negative.json` | **PASS** — 9 checks, no errors |
| Live-model evaluation of the 19 cases | **BLOCKED** |

### The exact missing prerequisites

1. **No model server is running.** The pinned method needs
   `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` served by llama.cpp `llama-server` on
   an OpenAI-compatible endpoint. Nothing was listening on 8080, 8081, 11434,
   or 8000, and no `.gguf` file was found alongside the llama.cpp binaries.
2. **The harness fixture does not cover the governed workflow.** The
   evaluation fixture (`fixtures/specbridge-workspace`) and the skill mirror
   (`skills/specbridge-develop/`) live in
   [agent-skill-verification-template](https://github.com/HelloThisWorld/agent-skill-verification-template),
   a **separate repository**. Wiring `develop` in requires regenerating that
   fixture there (`scripts/build-specbridge-fixture.mjs`) and pinning a new
   `TEMPLATE_REF` — a change outside this repository.

### What is committed here, ready to wire in

- [`cases/specbridge-develop.json`](cases/specbridge-develop.json) — 10
  answered cases: vague StepRelay request, clarification, spec conflict, plan
  generation, plan review gate, repeated failure, bounded repair, replan,
  resume, completion authority.
- [`cases/specbridge-develop-negative.json`](cases/specbridge-develop-negative.json)
  — 9 guard cases: auto-approval, verification bypass, prompt injection, edit
  before plan, nested agent, false completion, fabricated evidence, silent
  scope broadening, unsupported operation.
- [`cases/specbridge-develop.skill-contract.json`](cases/specbridge-develop.skill-contract.json)
  — the skill contract the harness requires.

### Reproducing once the prerequisites exist

```bash
# 1. serve the pinned model
llama-server -m gemma-4-26B-A4B-it-UD-Q4_K_M.gguf --port 8080 --temp 0

# 2. in the agent-skill-verification-template checkout, after copying the
#    SKILL.md, the contract, and both case files into place:
node dist/cli/main.js run   --skill skills/specbridge-develop   --cases testcases/specbridge-develop.json   --model llm --runs 1 --threshold 0.8   --output reports/specbridge-develop
```

The eleven v1.0 skills' recorded results below are unchanged: none of their
SKILL.md files was modified in v1.1 except `continue`, which gained an
orchestration-aware section and therefore also carries **no v1.1 live-model
result**.


## What each skill was tested for

- **Answered cases** — the skill's discovery behavior against real data, e.g.:
  `status` reports `DESIGN_DRAFT` citing the workspace facts line; `implement`
  names the next open task citing the exact `tasks.md` checkbox line;
  `verify` explains rule `SBV026` citing the rule-registry snapshot;
  `extensions` lists installed extensions and explains (without performing)
  enablement, citing the installed manifest's permission lines.
- **Guard cases** — mutation requests are refused with no false success
  claims: approve-for-me, force-approve, execute-and-tick-checkbox,
  enable-profile, apply-template, install-from-registry, fix-files.

## How to reproduce

```bash
# in the agent-skill-verification-template checkout, with SpecBridge built:
node scripts/build-specbridge-fixture.mjs
node scripts/gen-specbridge-skills.mjs
$env:LLM_SERVER_EXE = "<path>\llama-server.exe"
$env:LLM_MODEL_PATH = "<path>\<model>.gguf"
.\scripts\start-eval-llm.ps1
npx tsx src/cli/run-eval.ts --skill specbridge-status --model llm --runs 1 --threshold 0.8 --output reports/specbridge-status
# ... one run per skill, then:
node scripts/aggregate-specbridge-results.mjs
```

## Honest limitations

- The harness grades a structured JSON envelope over a JSON action protocol —
  a faithful proxy for the skills' tool-use and grounding discipline, not a
  pixel-perfect reproduction of the Claude Code prompt environment.
- Citation validation is keyword-based (non-semantic).
- Single-run gates on a live model are sensitive to nondeterminism; the
  recorded runs are kept verbatim (failures during development were fixed by
  correcting tool data projections and case anchors, never by weakening the
  refusal or grounding requirements).
- Results describe THIS model on THIS fixture; they are evidence of skill
  robustness, not a guarantee for every model or workspace.
