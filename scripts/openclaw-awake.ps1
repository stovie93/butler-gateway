# Keeps Windows awake ONLY while there is active work, then lets it sleep normally.
# Active work = a dispatched Claude Code job is running (workspace\jobs\*.json status=running),
# OR openclaw reports an active task. When nothing is active, this releases the hold and the
# machine's normal power/sleep settings apply unchanged.
#
# Mechanism: SetThreadExecutionState(ES_SYSTEM_REQUIRED) blocks system sleep while the flag
# is held; clearing it (or this process exiting) restores normal behavior. Display can still
# turn off — only system sleep is blocked.
#
# Singleton: only one instance runs at a time, so repeated gateway restarts don't pile up.

$mutex = New-Object System.Threading.Mutex($false, "Global\OpenClawAwake")
if (-not $mutex.WaitOne(0)) {
    # Another instance already owns the awake-guard; exit quietly.
    exit 0
}

Add-Type -Name "PowerMgmt" -Namespace "Win32" -MemberDefinition @"
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
"@

$ES_CONTINUOUS        = 0x80000000
$ES_SYSTEM_REQUIRED   = 0x00000001

$jobsDir        = "$env:USERPROFILE\.openclaw\workspace\jobs"
$stateFile      = "$env:USERPROFILE\.openclaw\workspace\keepawake-state.json"
$holdFile       = "$env:USERPROFILE\.openclaw\workspace\keepawake-hold.json"
$maxJobAgeHours = 6   # a job stuck on "running" longer than this is treated as crashed/stale
$awake          = $false

function Get-HoldUntil {
    # Manual "/awake <duration>" hold, if still in the future.
    if (Test-Path $holdFile) {
        try {
            $h = Get-Content $holdFile -Raw | ConvertFrom-Json
            $until = [datetime]::MinValue
            if ([datetime]::TryParse([string]$h.until, [ref]$until) -and (Get-Date) -lt $until) {
                return $until
            }
        } catch { }
    }
    return $null
}

function Test-ActiveWork {
    # 0) Manual keep-awake hold (/awake) still in effect?
    if (Get-HoldUntil) { return $true }
    # 1) Any dispatched Claude Code job still running and not stale?
    if (Test-Path $jobsDir) {
        $cutoff = (Get-Date).AddHours(-$maxJobAgeHours)
        foreach ($f in Get-ChildItem $jobsDir -Filter "*.json" -ErrorAction SilentlyContinue) {
            try {
                $m = Get-Content $f.FullName -Raw | ConvertFrom-Json
                if ($m.status -eq 'running') {
                    $started = [datetime]::MinValue
                    if ([datetime]::TryParse([string]$m.started, [ref]$started) -and $started -gt $cutoff) {
                        return $true
                    }
                }
            } catch { }
        }
    }
    # 2) Any active openclaw task? Parse the actual counts from the
    #    "Task pressure: N queued · M running · …" line (the literal words
    #    always appear, so we must read the numbers, not match the words).
    try {
        $tasks = openclaw tasks 2>&1 | Out-String
        $queued  = if ($tasks -match '(\d+)\s+queued')  { [int]$Matches[1] } else { 0 }
        $running = if ($tasks -match '(\d+)\s+running') { [int]$Matches[1] } else { 0 }
        if ($queued -gt 0 -or $running -gt 0) { return $true }
    } catch { }
    return $false
}

while ($true) {
    $active = Test-ActiveWork
    if ($active -and -not $awake) {
        [Win32.PowerMgmt]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
        $awake = $true
    } elseif (-not $active -and $awake) {
        [Win32.PowerMgmt]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
        $awake = $false
    }
    try {
        $hold = Get-HoldUntil
        @{
            checkedAt     = (Get-Date -Format o)
            active        = $active
            blockingSleep = $awake
            holdUntil     = if ($hold) { $hold.ToString('o') } else { $null }
            pid           = $PID
        } | ConvertTo-Json | Set-Content $stateFile -Encoding utf8
    } catch { }
    Start-Sleep -Seconds 30
}
