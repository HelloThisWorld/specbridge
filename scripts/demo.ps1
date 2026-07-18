# SpecBridge demo (~60-90 s of terminal action, offline, deterministic).
#
# Runs the full drift-verification story against a THROWAWAY COPY of
# examples/claude-code-workflow: doctor -> spec list -> spec status ->
# verify (passes) -> edit an approved file (verify fails, SBV002) ->
# restore (verify passes) -> template search -> registry search ->
# JSON + HTML reports. No network, no model, no API key; the repository
# itself is never modified. Requires: node on PATH, git, `pnpm build` done.
#
# Windows PowerShell 5.1 compatible (no && / ternary). Optional:
# $env:SPECBRIDGE_DEMO_PAUSE = seconds to pause between stages (default 0).

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $RepoRoot 'packages\cli\dist\index.js'
$Pause = 0
if ($env:SPECBRIDGE_DEMO_PAUSE) { $Pause = [int]$env:SPECBRIDGE_DEMO_PAUSE }

if (-not (Test-Path -LiteralPath $Cli)) {
    [Console]::Error.WriteLine("demo: built CLI not found at $Cli - run `"pnpm build`" first.")
    exit 2
}

$OriginalLocation = Get-Location
$DemoDir = Join-Path ([System.IO.Path]::GetTempPath()) ("specbridge-demo-" + [guid]::NewGuid().ToString('N'))

function Banner([string]$Step, [string]$Title) {
    Write-Host ''
    Write-Host '=================================================================='
    Write-Host "  [$Step] $Title"
    Write-Host '=================================================================='
    if ($Pause -gt 0) { Start-Sleep -Seconds $Pause }
}

function Show([string]$CommandLine) {
    Write-Host "> specbridge $CommandLine"
    Write-Host ''
}

function Invoke-Sb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
    # Out-Host keeps the CLI output on screen while the function returns
    # only the exit code.
    & node $Cli @CliArgs | Out-Host
    return $LASTEXITCODE
}

function Expect-Exit([int]$Actual, [int]$Expected, [string]$Label) {
    if ($Actual -ne $Expected) {
        [Console]::Error.WriteLine("demo: `"$Label`" exited $Actual (expected $Expected) - aborting.")
        exit 1
    }
}

function Invoke-DemoGit {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    & git @GitArgs | Out-Host
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("demo: git $($GitArgs -join ' ') failed - aborting.")
        exit 1
    }
}

try {
    New-Item -ItemType Directory -Path $DemoDir | Out-Null
    Copy-Item -Path (Join-Path $RepoRoot 'examples\claude-code-workflow\*') -Destination $DemoDir -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $DemoDir '.kiro'))) {
        Write-Error 'demo: the example copy is missing .kiro - aborting.'
        exit 1
    }
    Set-Location -LiteralPath $DemoDir

    # A git history to compare against; byte-exact, no line-ending rewriting.
    Invoke-DemoGit init -q
    Invoke-DemoGit config core.autocrlf false
    Invoke-DemoGit config user.name 'SpecBridge Demo'
    Invoke-DemoGit config user.email 'demo@example.invalid'
    Invoke-DemoGit config commit.gpgsign false
    Invoke-DemoGit add -A
    Invoke-DemoGit commit -q -m 'existing Kiro project with SpecBridge approvals'

    Banner '1/9' 'An existing Kiro project - no conversion, no migration'
    Show 'doctor'
    Expect-Exit (Invoke-Sb doctor) 0 'doctor'

    Banner '2/9' 'One managed spec, mid-workflow'
    Show 'spec list'
    Expect-Exit (Invoke-Sb spec list) 0 'spec list'

    Banner '3/9' 'Approvals are SHA-256 hashes of the exact file bytes'
    Show 'spec status notification-digest'
    Expect-Exit (Invoke-Sb spec status notification-digest) 0 'spec status'

    Banner '4/9' 'Deterministic drift verification - currently aligned'
    Show 'spec verify notification-digest --working-tree'
    Expect-Exit (Invoke-Sb spec verify notification-digest --working-tree) 0 'spec verify (clean)'

    Banner '5/9' "Edit an APPROVED requirements file behind the spec's back"
    $Req = '.kiro\specs\notification-digest\requirements.md'
    Write-Host "> Add-Content $Req `"Also send digests by SMS.`""
    Add-Content -LiteralPath $Req -Value "`nAlso send digests by SMS."
    Write-Host ''
    Show 'spec verify notification-digest --working-tree'
    Expect-Exit (Invoke-Sb spec verify notification-digest --working-tree) 1 'spec verify (drift)'
    Write-Host ''
    Write-Host '  -> caught: SBV002, spec approval stale. Exit code 1 fails CI.'

    Banner '6/9' 'Restore the approved bytes - verification passes again'
    Write-Host "> git checkout -- $Req"
    Invoke-DemoGit checkout -- '.kiro/specs/notification-digest/requirements.md'
    Write-Host ''
    Show 'spec verify notification-digest --working-tree'
    Expect-Exit (Invoke-Sb spec verify notification-digest --working-tree) 0 'spec verify (restored)'

    Banner '7/9' 'Built-in spec templates (data-only, offline)'
    Show 'template search rest-api'
    Expect-Exit (Invoke-Sb template search rest-api) 0 'template search'

    Banner '8/9' 'Extension discovery against the built-in registry (offline)'
    Show 'registry search analyzer'
    Expect-Exit (Invoke-Sb registry search analyzer) 0 'registry search'

    Banner '9/9' 'The same verification as JSON and self-contained HTML'
    Show 'spec verify notification-digest --working-tree --format json --output specbridge-report.json'
    Expect-Exit (Invoke-Sb spec verify notification-digest --working-tree --format json --output specbridge-report.json) 0 'report (json)'
    Show 'spec verify notification-digest --working-tree --format html --output specbridge-report.html'
    Expect-Exit (Invoke-Sb spec verify notification-digest --working-tree --format html --output specbridge-report.html) 0 'report (html)'
    Write-Host 'Generated in the throwaway workspace:'
    foreach ($Name in 'specbridge-report.json', 'specbridge-report.html') {
        $Item = Get-Item -LiteralPath $Name
        Write-Host ("  {0} ({1} bytes)" -f $Name, $Item.Length)
    }
    Get-Content -LiteralPath 'specbridge-report.json' -TotalCount 4 | ForEach-Object { Write-Host $_ }

    Write-Host ''
    Write-Host '=================================================================='
    Write-Host '  Demo complete. Everything ran offline against a throwaway copy'
    Write-Host '  of examples/claude-code-workflow; the repository was not touched.'
    Write-Host '  (The temporary directory is removed on exit.)'
    Write-Host '=================================================================='
    exit 0
}
finally {
    Set-Location -LiteralPath $OriginalLocation.Path
    if (Test-Path -LiteralPath $DemoDir) {
        try { Remove-Item -LiteralPath $DemoDir -Recurse -Force -ErrorAction Stop } catch {}
    }
}
