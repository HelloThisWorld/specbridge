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
