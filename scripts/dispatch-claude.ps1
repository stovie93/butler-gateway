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
Get-Content '$taskFile' -Raw | claude -p $continueFlag --output-format stream-json --verbose --dangerously-skip-permissions *> '$log'
`$code = `$LASTEXITCODE
`$meta = Get-Content '$jobsDir\$id.json' -Raw | ConvertFrom-Json
`$meta.status = if (`$code -eq 0) { 'done' } else { 'failed' }
`$meta | Add-Member -NotePropertyName finished -NotePropertyValue (Get-Date -Format o) -Force
`$meta | Add-Member -NotePropertyName exitCode -NotePropertyValue `$code -Force
# Persist a summary from the final stream-json result event so the apps don't
# have to re-parse the whole log on every poll. Best-effort: never block the status write.
try {
    `$resultLine = Get-Content '$log' -ErrorAction Stop | Where-Object { `$_ -match '"type":"result"' } | Select-Object -Last 1
    if (`$resultLine) {
        `$r = `$resultLine | ConvertFrom-Json
        `$summary = [string]`$r.result
        if (`$summary.Length -gt 500) { `$summary = `$summary.Substring(0, 500) + [char]0x2026 }
        `$resObj = [pscustomobject]@{
            durationMs = `$r.duration_ms
            costUsd    = `$r.total_cost_usd
            isError    = [bool]`$r.is_error
            summary    = `$summary
        }
        `$meta | Add-Member -NotePropertyName result -NotePropertyValue `$resObj -Force
    }
} catch {}
`$meta | ConvertTo-Json -Depth 5 | Set-Content '$jobsDir\$id.json' -Encoding utf8
# Wake the butler so it reports the result to Jordan right away (WhatsApp/app).
`$note = "SYSTEM EVENT: Claude Code job $id for project '$(Split-Path $proj -Leaf)' just finished with status `$(`$meta.status). Use the code-dispatch skill: check the job log, send Jordan a short plain-text summary of the outcome, then mark it reported."
openclaw agent --agent main --message `$note *> "$jobsDir\$id.notify.log"
"@
$runnerFile = "$jobsDir\$id.runner.ps1"
Set-Content $runnerFile $runner -Encoding utf8

Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runnerFile -WindowStyle Hidden

Write-Output "Dispatched job $id"
Write-Output "Project: $proj"
Write-Output "Task: $Task"
if ($Continue) { Write-Output "Mode: continuing previous Claude Code conversation in this project" }
Write-Output "Check with: check-claude.ps1 -JobId $id"
