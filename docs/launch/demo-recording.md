# v1.0.0 demo recording plan

Plan for a 60–90 second terminal recording for the v1.0.0 launch.

> **Status: no recording exists yet.** This document is the plan for
> producing one; nothing has been captured or published. Do not link to a
> recording from launch material until it actually exists.

## What the recording shows

One continuous story: an untouched Kiro project, SpecBridge working on it
with zero conversion, approvals as byte-exact hashes, drift caught
deterministically, and the same gate running in CI.

## The script to run

The terminal portion is fully scripted and reproducible — no live typing
of anything that can fail:

```sh
SPECBRIDGE_DEMO_PAUSE=2 bash scripts/demo.sh      # macOS / Linux / Git Bash
```

```powershell
$env:SPECBRIDGE_DEMO_PAUSE = 2; .\scripts\demo.ps1   # Windows PowerShell 5.1+
```

Both run offline against a throwaway copy of
`examples/claude-code-workflow`, never modify the repository, clean up
after themselves, and abort loudly if any stage behaves unexpectedly.
`SPECBRIDGE_DEMO_PAUSE` inserts a pause (seconds) between stages so each
result stays on screen long enough to read.

Prerequisites: `pnpm install && pnpm build` at the repository root; `git`
and `node` on `PATH`. Do a full rehearsal run before recording.

## Shot list (target 60–90 s total)

| # | Seconds | Shot | Source | On screen |
| --- | --- | --- | --- | --- |
| 1 | 0–5 | Existing Kiro project | demo stage 1 header + a quick `tree`/editor glance at `.kiro/` | "A real Kiro project. We change nothing." |
| 2 | 5–15 | No conversion: `doctor` | demo stage 1 | "No migration required — .kiro remains the source of truth" and "Safe for read-only use" |
| 3 | 15–25 | Plugin status | **supplementary capture** — Claude Code session running `/specbridge:status` in the same project | the plugin reporting the spec and its approvals; requires Claude Code with the plugin installed ([docs/plugin-installation.md](../plugin-installation.md)) |
| 4 | 25–35 | Implementation task | **supplementary capture** — `/specbridge:implement notification-digest` (or `specbridge spec run`) with a configured runner | a task executing under the approval workflow; requires a configured agent runner — cannot be faked offline, so cut this shot if no runner is available rather than staging it |
| 5 | 35–45 | Git evidence | demo stages 3–4 (`spec status`, `spec verify` passing) | "Approved … sha256", "Content unchanged since approval", "PASSED — 0 errors" |
| 6 | 45–65 | Drift caught | demo stages 5–6 | the append to `requirements.md`, the red `SBV002` finding with the fix hint, exit code 1, then the restore and green `PASSED` |
| 7 | 65–80 | Reports | demo stage 9 | JSON + self-contained HTML written; optionally open the HTML file for two seconds |
| 8 | 80–90 | GitHub Action result | **supplementary capture** — screenshot of a real PR check | failed check with SBV002 file/line annotation and the Step Summary table; requires an actual PR on a repository using `integrations/github-action` (see `examples/ci-drift-gate/.github/workflows/spec-verify.yml`) — record it only after the `@v1` tag exists, and never mock a GitHub UI screenshot |

Shots 3, 4, and 8 are not produced by the demo scripts and each depends on
real infrastructure (an installed plugin, a configured runner, a live PR).
If any of them cannot be captured genuinely, drop the shot and let the
terminal story stand on its own — a 60-second recording of shots 1, 2, 5,
6, 7 is complete and entirely honest.

Stages 2 (`spec list`), 7 (`template search`), and 8 (`registry search`)
of the demo script are pace-fillers here; keep them in the capture and
trim in the edit if the cut runs long.

## Terminal setup

- 110×30 terminal (fits the widest `spec list` table without wrapping);
  120×32 if your capture tool adds no chrome
- dark theme, high contrast; the CLI uses green/red/yellow ANSI colors —
  verify `✓`/`✗` glyphs render in your font (any Nerd Font or Cascadia
  Code / JetBrains Mono works)
- 16–18 pt font for 1080p output; do not record a maximized 4K terminal
- leave `NO_COLOR` unset (the recording wants color); clear any prompt
  customization that leaks personal paths — run from a directory whose
  path is unremarkable
- shell prompt: minimal (`$` or `>`); the script prints each command
  itself, so the prompt never needs to show typing

## Capture tooling (suggestions, none used yet)

- **asciinema** (macOS/Linux/WSL): `asciinema rec demo.cast`, then run the
  script; renders to SVG/GIF via `agg`. Best fidelity for terminal text.
- **terminalizer**: `terminalizer record demo`, YAML-editable frames,
  GIF export. Heavier but cross-platform.
- **Windows**: asciinema does not capture PowerShell 5.1 natively; record
  Windows Terminal with the built-in screen recorder (Win+Alt+R) or OBS
  while running `demo.ps1`.
- For shots 3, 4, and 8, use a normal screen recorder (OBS) — they are UI
  captures, not terminal casts.

## Editing notes

- Cut dead time between stages to ~1 s; the pauses exist for capture
  safety, not for the final cut.
- Do not speed-ramp the SBV002 failure — the red finding with its rule ID
  and fix hint is the single most important frame.
- End card: repository URL + `pnpm dlx`-free install line
  (`npm install -g specbridge` only if that package actually exists at
  release time — verify before including any install command).
