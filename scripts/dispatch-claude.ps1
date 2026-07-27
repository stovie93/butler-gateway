# Launch a headless Claude Code (Fable 5) job in the background.
# Usage:
#   dispatch-claude.ps1 -Project <name-or-path> -Task "<what to build>"
#   dispatch-claude.ps1 -Project <name-or-path> -Task "<follow-up>" -Continue
# -Continue resumes Claude Code's previous conversation in that project, so
# follow-ups keep full context of what was already built.
# Returns immediately with a job id; check progress with check-claude.ps1.
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$Task,
    [switch]$Continue
)

$ErrorActionPreference = 'Stop'
$jobsDir = "$env:USERPROFILE\.openclaw\workspace\jobs"
New-Item -ItemType Directory -Force $jobsDir | Out-Null

# Resolve the project. Bare names always map to ~\repos\<name> regardless of cwd;
# only rooted paths (or paths with separators) are used as-is.
$looksLikePath = [System.IO.Path]::IsPathRooted($Project) -or $Project -match '[\\/]'
if ($looksLikePath -and (Test-Path $Project)) {
    $proj = (Resolve-Path $Project).Path
} else {
    $proj = "$env:USERPROFILE\repos\$Project"
    if (-not (Test-Path $proj)) {
        New-Item -ItemType Directory -Force $proj | Out-Null
        git -C $proj init 2>$null | Out-Null
    }
}

# Refuse to double-dispatch onto a project with a running job.
$running = Get-ChildItem $jobsDir -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object {
    $m = Get-Content $_.FullName -Raw | ConvertFrom-Json
    if ($m.status -eq 'running' -and $m.project -eq $proj) { $m }
}
if ($running) {
    Write-Output "BLOCKED: job $($running[0].id) is already running on this project. Wait for it or check it first."
    exit 1
}

$id = Get-Date -Format "yyyyMMdd-HHmmss"
$log = "$jobsDir\$id.log"
$taskFile = "$jobsDir\$id.task.txt"
Set-Content $taskFile $Task -Encoding utf8

@{
    id       = $id
    project  = $proj
    task     = $Task
    continue = [bool]$Continue
    started  = (Get-Date -Format o)
    status   = "running"
    reported = $false
} | ConvertTo-Json | Set-Content "$jobsDir\$id.json" -Encoding utf8

$continueFlag = if ($Continue) { '--continue' } else { '' }

$runner = @"
Set-Location '$proj'
# Record our own PID so the job can be canceled (taskkill /T) and so startup
# reconciliation can tell a live runner from one killed by a crash/reboot.
try {
    `$m0 = Get-Content '$jobsDir\$id.json' -Raw | ConvertFrom-Json
    `$m0 | Add-Member -NotePropertyName runnerPid -NotePropertyValue `$PID -Force
    `$m0 | ConvertTo-Json | Set-Content '$jobsDir\$id.json' -Encoding utf8
} catch {}
# Claude Code writes UTF-8. Without these two lines PowerShell 5.1 decodes its
# stdout using the console's OEM codepage, so every em-dash and arrow in the
# summary lands in the log as mojibake (— becomes ΓÇö) and stays corrupted for
# good. Set both directions: OutputEncoding for what we read back, `$OutputEncoding
# for the task text we pipe in.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
`$OutputEncoding = [System.Text.Encoding]::UTF8
Get-Content '$taskFile' -Raw | claude -p $continueFlag --output-format stream-json --verbose --dangerously-skip-permissions *> '$log'
`$code = `$LASTEXITCODE
`$meta = Get-Content '$jobsDir\$id.json' -Raw | ConvertFrom-Json
`$meta.status = if (`$code -eq 0) { 'done' } else { 'failed' }
`$meta | Add-Member -NotePropertyName finished -NotePropertyValue (Get-Date -Format o) -Force
`$meta | Add-Member -NotePropertyName exitCode -NotePropertyValue `$code -Force
`$meta | ConvertTo-Json -Depth 5 | Set-Content '$jobsDir\$id.json' -Encoding utf8
# The result summary is parsed out of the log by the code-dispatch plugin during
# jobFinished, not here: PowerShell 5.1 reads BOM-less UTF-8 as ANSI, which turned
# every em-dash and arrow in Claude's summary into mojibake.
# Hand the finished job to the code-dispatch plugin, which finds the build
# artifact, asks the butler to describe the outcome in its own voice, and pushes
# that to the phone. Everything past this point is JS, not escaped PowerShell.
# Best-effort: the plugin also sweeps for unreported jobs, so a failed POST here
# only costs latency, never the report.
try {
    `$cfg = Get-Content '$env:USERPROFILE\.openclaw\openclaw.json' -Raw | ConvertFrom-Json
    `$gtok = `$cfg.gateway.auth.token
    `$gport = if (`$cfg.gateway.port) { `$cfg.gateway.port } else { 18789 }
    `$fbody = @{ action = 'jobFinished'; jobId = '$id' } | ConvertTo-Json
    Invoke-RestMethod -Uri ("http://127.0.0.1:" + `$gport + "/api/v1/code-dispatch") -Method Post -Headers @{ Authorization = ('Bearer ' + `$gtok); 'Content-Type' = 'application/json' } -Body `$fbody -TimeoutSec 150 *> "$jobsDir\$id.notify.log"
} catch {}
"@
$runnerFile = "$jobsDir\$id.runner.ps1"
Set-Content $runnerFile $runner -Encoding utf8

Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runnerFile -WindowStyle Hidden

Write-Output "Dispatched job $id"
Write-Output "Project: $proj"
Write-Output "Task: $Task"
if ($Continue) { Write-Output "Mode: continuing previous Claude Code conversation in this project" }
Write-Output "Check with: check-claude.ps1 -JobId $id"
