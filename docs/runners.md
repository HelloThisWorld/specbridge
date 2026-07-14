# Runners

SpecBridge v0.6 runs spec work through **runner profiles** — named
configurations of runner implementations. You keep your `.kiro` specs and
choose a compatible coding agent or authoring model per operation.

## Two kinds of runners

**Agent CLI runners** (`claude-code`, `codex-cli`, `gemini-cli`) wrap a
locally installed, independently authenticated coding-agent CLI. They may
inspect the repository, modify source files under a bounded sandbox or
tool restriction, execute approved implementation tasks, and (when
supported) resume sessions. Gemini task execution and resume are
capability-gated on the installed version proving a bounded edit policy —
never YOLO, never arbitrary shell access.

**Model authoring runners** (`ollama`, `openai-compatible`) wrap a model
API endpoint. They generate and refine spec documents with
schema-validated structured output. They never receive repository access,
never modify files, and never execute tasks — SpecBridge validates every
candidate and writes the document itself.

**Experimental adapters** (`antigravity-cli`, v0.6.1) provide capability
detection and diagnostics only; automation is disabled.

**Mock runners** exist for deterministic tests and conformance runs.

## Operation matrix (v0.6.1)

Generated from registered runner metadata — run `specbridge runner matrix`
(`--json`, `--markdown`) for the live version:

| Profile | Support | Author | Refine | Execute | Resume | Local |
|---------|---------|--------|--------|---------|--------|-------|
| claude-code | production | yes | yes | yes | yes | no |
| codex-default | production | yes | yes | yes | yes | no |
| gemini-default | production | yes | yes | yes | yes | no |
| ollama-local | production | yes | yes | no | no | yes |
| openai-compatible-local | production | yes | yes | no | no | yes |
| antigravity | experimental | no | no | no | no | no |
| mock | production | yes | yes | yes | yes | yes |

Gemini's Execute/Resume columns reflect DECLARED capabilities; detection
downgrades them per installed version (`specbridge runner doctor
gemini-default` shows the effective set). "Local" means inference stays on
this machine (loopback model API). Agent CLIs run locally but talk to
their own provider using their own authentication.

## Commands

```bash
specbridge runner list                    # profiles, status, operations
specbridge runner matrix                  # capability matrix
specbridge runner show <profile>          # configuration + capabilities
specbridge runner doctor [profile]        # read-only diagnostics
specbridge runner test <profile> --network  # minimal structured-output probe
specbridge runner conformance <profile>   # conformance suite
specbridge runner models <profile>        # provider-supported model listing
```

Authoring and execution take `--runner <profile>`:

```bash
specbridge spec generate my-feature --stage requirements --runner gemini-default
specbridge spec refine my-feature --stage design --runner openai-compatible-local
specbridge spec run my-feature --task 2.3 --runner codex-default
```

The same diagnostics are available inside MCP hosts (`runner_list`,
`runner_show`, `runner_doctor`, `runner_matrix`) and through the Claude
Code plugin's `/specbridge:runners` skill.

## What never changes, whichever runner you pick

- Generated stages stay DRAFT; nothing is auto-approved.
- Approved stages are never overwritten.
- Task completion needs actual Git evidence plus trusted verification —
  provider claims are recorded but never sufficient.
- No commits, pushes, rollbacks, or checkbox edits by any provider.
- SpecBridge stores no credentials and reads no provider credential files.

SpecBridge does not include provider subscriptions, hosted models, API
usage, or authentication — you install and authenticate providers yourself.

See also: [runner-capabilities.md](runner-capabilities.md),
[runner-profiles.md](runner-profiles.md),
[runner-selection.md](runner-selection.md),
[runner-fallback.md](runner-fallback.md),
[runner-conformance.md](runner-conformance.md),
[codex-cli-runner.md](codex-cli-runner.md),
[gemini-cli-runner.md](gemini-cli-runner.md),
[ollama-runner.md](ollama-runner.md),
[openai-compatible-runner.md](openai-compatible-runner.md),
[antigravity-cli-runner.md](antigravity-cli-runner.md),
[runner-security.md](runner-security.md),
[configuration-migration.md](configuration-migration.md).
