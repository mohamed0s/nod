param([int]$Minutes = 90)

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'desktop-common.ps1')
$desktop = Get-NodDesktopFolder
$port = 4310
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^PORT=(\d+)\s*$' | Select-Object -First 1
    if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
}

Add-Type -Namespace NodWake -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[NodWake.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null
try {
    if ($desktop -or -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        Start-ScheduledTask -TaskPath '\Nod\' -TaskName 'start'
    }
    Start-Sleep -Seconds ($Minutes * 60)
} finally {
    [NodWake.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null
}
