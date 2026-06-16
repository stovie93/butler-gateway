# Check status of Claude Code jobs started by dispatch-claude.ps1.
# Usage:
#   check-claude.ps1                      -> list all jobs (newest first)
#   check-claude.ps1 -JobId <id>          -> details + log tail for one job
#   check-claude.ps1 -MarkReported <id>   -> flag a finished job as already reported to Jordan
param(
    [string]$JobId,
    [string]$MarkReported
)

$jobsDir = "$env:USERPROFILE\.openclaw\workspace\jobs"
if (-not (Test-Path $jobsDir)) { Write-Output "No jobs yet."; exit 0 }

if ($MarkReported) {
    $metaFile = "$jobsDir\$MarkReported.json"
    if (-not (Test-Path $metaFile)) { Write-Output "No such job: $MarkReported"; exit 1 }
    $meta = Get-Content $metaFile -Raw | ConvertFrom-Json
    $meta.reported = $true
    $meta | ConvertTo-Json | Set-Content $metaFile -Encoding utf8
    Write-Output "Marked $MarkReported as reported."
    exit 0
}

if ($JobId) {
    $metaFile = "$jobsDir\$JobId.json"
    if (-not (Test-Path $metaFile)) { Write-Output "No such job: $JobId"; exit 1 }
    $meta = Get-Content $metaFile -Raw | ConvertFrom-Json
    Write-Output "Job:      $($meta.id)  [$($meta.status)]"
    Write-Output "Project:  $($meta.project)"
    Write-Output "Task:     $($meta.task)"
    Write-Output "Started:  $($meta.started)"
    if ($meta.finished) { Write-Output "Finished: $($meta.finished)" }
    $log = "$jobsDir\$JobId.log"
    if (Test-Path $log) {
        Write-Output ""
        Write-Output "--- log tail ---"
        Get-Content $log -Tail 40
    }
    exit 0
}

$jobs = Get-ChildItem $jobsDir -Filter "*.json" | Sort-Object Name -Descending
if (-not $jobs) { Write-Output "No jobs yet."; exit 0 }
foreach ($file in $jobs | Select-Object -First 15) {
    $meta = Get-Content $file.FullName -Raw | ConvertFrom-Json
    $flag = if ($meta.status -in @('done', 'failed') -and -not $meta.reported) { ' *UNREPORTED*' } else { '' }
    $taskBrief = if ($meta.task.Length -gt 70) { $meta.task.Substring(0, 70) + '…' } else { $meta.task }
    Write-Output "$($meta.id)  [$($meta.status)]$flag  $(Split-Path $meta.project -Leaf): $taskBrief"
}
