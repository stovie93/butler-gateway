# Cancel a running Claude Code job dispatched by dispatch-claude.ps1.
# Usage:
#   cancel-claude.ps1 -JobId <id>
# Kills the runner process tree (the headless `claude` is a child of the runner's
# powershell host) via taskkill /T, then marks the job 'canceled'.
param(
    [Parameter(Mandatory = $true)][string]$JobId
)

$jobsDir  = "$env:USERPROFILE\.openclaw\workspace\jobs"
$metaFile = "$jobsDir\$JobId.json"

if (-not (Test-Path $metaFile)) {
    Write-Output "No such job: $JobId"
    exit 1
}

$meta = Get-Content $metaFile -Raw | ConvertFrom-Json

if ($meta.status -ne 'running') {
    Write-Output "Job $JobId is '$($meta.status)', not running. Nothing to cancel."
    exit 0
}

$pidToKill = $meta.runnerPid
if ($pidToKill) {
    # /T kills the whole tree (powershell host + the claude child), /F forces it.
    taskkill /PID $pidToKill /T /F 2>&1 | Out-Null
} else {
    Write-Output "Warning: no runnerPid recorded yet; marking canceled without a kill."
}

$meta.status = 'canceled'
$meta | Add-Member -NotePropertyName finished -NotePropertyValue (Get-Date -Format o) -Force
$meta | ConvertTo-Json -Depth 5 | Set-Content $metaFile -Encoding utf8

Write-Output "Canceled job $JobId$(if ($pidToKill) { " (killed PID $pidToKill)" })."
