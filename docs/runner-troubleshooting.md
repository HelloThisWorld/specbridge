# Runner troubleshooting

Start with:

```bash
specbridge config doctor
specbridge runner list
specbridge runner doctor <profile> --verbose
```

## "Runner profile … is disabled"

New-provider profiles (`codex-default`, `ollama-local`) ship disabled. Set
`"enabled": true` on the profile in `.specbridge/config.json`. Nothing is
ever enabled silently.

## "Cannot perform task-execution using …"

You selected an authoring-only (model-API) profile for `spec run`. The
refusal lists the missing capabilities and the compatible configured
profiles — use an agent CLI profile (`claude-code`, `codex-default`).

## "… is network-backed … never selected implicitly"

A remote endpoint profile was reached through the global default. Select it
explicitly (`--runner <profile>`) or set it as an `operationDefaults` entry.

## Codex: `unavailable` / `incompatible` / `unauthenticated`

- `unavailable` — the executable was not found. Install the Codex CLI or
  fix `command.executable` on the profile.
- `incompatible` — the installed version lacks required capabilities
  (non-interactive `exec`, `--json`, `--sandbox`); the doctor names the
  exact missing one. Update the CLI. Authoring may survive when only
  workspace-write is missing.
- `unauthenticated` — run `codex login` yourself; SpecBridge never handles
  credentials.
- authentication `unknown` — this version has no safe status command; try
  `specbridge runner test codex-default --network` for a minimal probe.

## Ollama: `unavailable` / `misconfigured`

- endpoint unreachable — start it (`ollama serve`) or fix `baseUrl`.
- no model configured / model missing — list local models with
  `specbridge runner models ollama-local`, pull one yourself, and set
  `"model"` explicitly. SpecBridge never pulls or picks models.
- baseUrl rejected — loopback HTTP is fine; remote endpoints need HTTPS or
  the labeled `allowInsecureHttp` development override; credentials in
  URLs and non-http(s) schemes are always rejected.

## `structured_output_invalid`

The model's final message did not validate. The invalid candidate is
retained under `.specbridge/runs/<run-id>/attempts/…/invalid-candidate.txt`
for inspection; Ollama gets one bounded correction retry automatically.
Pick a stronger model, reduce context, or refine the instruction.

## Fallback did not trigger

Fallback is authoring-only, disabled unless `fallbacks.stageGeneration` /
`stageRefinement` name a chain, and never runs after authentication or
permission failures, invalid configuration, cancellation, quota
exhaustion, or repository modification. `runner-failed` output and the run's
`attempts/` directory show every attempt and skip reason.

## A task ran but the checkbox did not flip

Working as designed: only verified evidence (actual Git change + passing
trusted verification) completes a task. Inspect `specbridge run show
<run-id>`; use `specbridge spec accept-task` for explicit manual acceptance.

## Migration questions

See [configuration-migration.md](configuration-migration.md); `specbridge
config migrate --dry-run` is always safe (writes nothing), and applied
migrations leave `config.v1.backup.json` for rollback.
