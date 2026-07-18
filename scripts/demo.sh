#!/usr/bin/env bash
# SpecBridge demo (~60-90 s of terminal action, offline, deterministic).
#
# Runs the full drift-verification story against a THROWAWAY COPY of
# examples/claude-code-workflow: doctor -> spec list -> spec status ->
# verify (passes) -> edit an approved file (verify fails, SBV002) ->
# restore (verify passes) -> template search -> registry search ->
# JSON + HTML reports. No network, no model, no API key; the repository
# itself is never modified. Requires: node on PATH, git, `pnpm build` done.
#
# Optional: SPECBRIDGE_DEMO_PAUSE=<seconds> pauses between stages for
# screen recordings (default 0).

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/index.js"
PAUSE="${SPECBRIDGE_DEMO_PAUSE:-0}"

if [ ! -f "$CLI" ]; then
  echo "demo: built CLI not found at $CLI — run \"pnpm build\" first." >&2
  exit 2
fi

DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/specbridge-demo-XXXXXX")"
cleanup() { rm -rf "$DEMO_DIR"; }
trap cleanup EXIT

banner() {
  echo
  echo "=================================================================="
  echo "  [$1] $2"
  echo "=================================================================="
  if [ "$PAUSE" != "0" ]; then sleep "$PAUSE"; fi
}

show() {
  echo "\$ specbridge $*"
  echo
}

sb() {
  node "$CLI" "$@"
}

expect_exit() {
  # expect_exit <actual> <expected> <label>
  if [ "$1" -ne "$2" ]; then
    echo "demo: \"$3\" exited $1 (expected $2) — aborting." >&2
    exit 1
  fi
}

cp -R "$REPO_ROOT/examples/claude-code-workflow/." "$DEMO_DIR/"
cd "$DEMO_DIR"

# A git history to compare against; byte-exact, no line-ending rewriting.
git init -q
git config core.autocrlf false
git config user.name "SpecBridge Demo"
git config user.email "demo@example.invalid"
git config commit.gpgsign false
git add -A
git commit -q -m "existing Kiro project with SpecBridge approvals"

banner "1/9" "An existing Kiro project — no conversion, no migration"
show doctor
sb doctor
expect_exit $? 0 "doctor"

banner "2/9" "One managed spec, mid-workflow"
show spec list
sb spec list
expect_exit $? 0 "spec list"

banner "3/9" "Approvals are SHA-256 hashes of the exact file bytes"
show spec status notification-digest
sb spec status notification-digest
expect_exit $? 0 "spec status"

banner "4/9" "Deterministic drift verification — currently aligned"
show spec verify notification-digest --working-tree
sb spec verify notification-digest --working-tree
expect_exit $? 0 "spec verify (clean)"

banner "5/9" "Edit an APPROVED requirements file behind the spec's back"
REQ=".kiro/specs/notification-digest/requirements.md"
echo "\$ echo \"Also send digests by SMS.\" >> $REQ"
printf '\nAlso send digests by SMS.\n' >> "$REQ"
echo
show spec verify notification-digest --working-tree
sb spec verify notification-digest --working-tree
expect_exit $? 1 "spec verify (drift)"
echo
echo "  -> caught: SBV002, spec approval stale. Exit code 1 fails CI."

banner "6/9" "Restore the approved bytes — verification passes again"
echo "\$ git checkout -- $REQ"
git checkout -- "$REQ"
echo
show spec verify notification-digest --working-tree
sb spec verify notification-digest --working-tree
expect_exit $? 0 "spec verify (restored)"

banner "7/9" "Built-in spec templates (data-only, offline)"
show template search rest-api
sb template search rest-api
expect_exit $? 0 "template search"

banner "8/9" "Extension discovery against the built-in registry (offline)"
show registry search analyzer
sb registry search analyzer
expect_exit $? 0 "registry search"

banner "9/9" "The same verification as JSON and self-contained HTML"
show spec verify notification-digest --working-tree --format json --output specbridge-report.json
sb spec verify notification-digest --working-tree --format json --output specbridge-report.json
expect_exit $? 0 "report (json)"
show spec verify notification-digest --working-tree --format html --output specbridge-report.html
sb spec verify notification-digest --working-tree --format html --output specbridge-report.html
expect_exit $? 0 "report (html)"
echo "Generated in the throwaway workspace:"
for f in specbridge-report.json specbridge-report.html; do
  echo "  $f ($(wc -c < "$f" | tr -d '[:space:]') bytes)"
done
head -n 4 specbridge-report.json

echo
echo "=================================================================="
echo "  Demo complete. Everything ran offline against a throwaway copy"
echo "  of examples/claude-code-workflow; the repository was not touched."
echo "  (The temporary directory is removed on exit.)"
echo "=================================================================="
