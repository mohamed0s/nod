param([switch]$NoStart, [string]$WakeAt)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo
function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Native([scriptblock]$run) { $ErrorActionPreference = 'Continue'; & $run }
function Reload-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

Step 'Checking Node.js (24.21 or newer)'
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeOk = [version]((node --version).TrimStart('v')) -ge [version]'24.21.0' }
if (-not $nodeOk) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24.21 or newer from https://nodejs.org, then run this script again.' }
    Step 'Installing Node.js 24 with winget. Windows may ask for permission.'
    Native { winget install --id OpenJS.NodeJS.LTS --version 24.22.1 --exact --silent --accept-source-agreements --accept-package-agreements }
    Reload-Path
    if ([version]((node --version).TrimStart('v')) -lt [version]'24.21.0') { throw 'Node.js is still older than 24.21. Close this window, open a new one and run the script again.' }
}

Step 'Turning on pnpm through Corepack'
$npmDir = Join-Path $env:APPDATA 'npm'
New-Item -ItemType Directory -Force $npmDir | Out-Null
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $npmDir)) { [Environment]::SetEnvironmentVariable('Path', "$npmDir;$userPath", 'User') }
Reload-Path
Native { corepack enable --install-directory $npmDir pnpm }
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
Native { pnpm --version } | Out-Null

Step 'Checking Docker Desktop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/, start it once, then run this script again.' }
Native { docker info --format '{{.ServerVersion}}' *> $null }
if ($LASTEXITCODE -ne 0) {
    Start-Process (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
    $deadline = (Get-Date).AddMinutes(5)
    do {
        Start-Sleep -Seconds 5
        Native { docker info --format '{{.ServerVersion}}' *> $null }
        if ((Get-Date) -gt $deadline) { throw 'Docker Desktop did not start within 5 minutes. Start it by hand, then run this script again.' }
    } while ($LASTEXITCODE -ne 0)
}

Step 'Preparing settings (.env)'
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
    if (-not (Select-String -Path $envFile -Pattern '^NOD_VAULT_KEY=\S{40,}' -Quiet)) {
        throw '.env exists but has no NOD_VAULT_KEY. Put your original key back (saved logins need it) or remove .env to start fresh.'
    }
    Write-Host '    Keeping your existing .env.'
} else {
    $text = Get-Content (Join-Path $repo '.env.example') -Raw
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $settings = [ordered]@{ NOD_VAULT_KEY = [Convert]::ToBase64String($bytes); NOD_ANALYTICS_ENABLED = 'false'; NOD_TRACES_URL = '' }
    foreach ($key in $settings.Keys) {
        $pattern = "(?m)^$key=.*$"
        if ($text -match $pattern) { $text = $text -replace $pattern, "$key=$($settings[$key])" } else { $text = $text.TrimEnd() + "`n$key=$($settings[$key])`n" }
    }
    [IO.File]::WriteAllText($envFile, $text, (New-Object Text.UTF8Encoding $false))
    Write-Host '    Created .env with a new Vault key, usage data off and traces off.'
    Write-Host '    Save the NOD_VAULT_KEY line from .env in your password manager: saved logins cannot be read without it.' -ForegroundColor Yellow
}

Step 'Starting Nod at every Windows sign-in'
$start = Join-Path $PSScriptRoot 'start.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settingsSet = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName 'start' -TaskPath '\Nod\' -Action $action -Trigger $trigger -Settings $settingsSet -Principal $principal -Force | Out-Null

Step 'Backing up Nod every night at 03:30 (the newest 14 are kept)'
$backup = Join-Path $PSScriptRoot 'backup.ps1'
$backupAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$backup`"" -WorkingDirectory $repo
$backupTrigger = New-ScheduledTaskTrigger -Daily -At '03:30'
$backupSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'backup' -TaskPath '\Nod\' -Action $backupAction -Trigger $backupTrigger -Settings $backupSettings -Principal $principal -Force | Out-Null
Write-Host "    Backups go to $(Join-Path (Split-Path -Parent $repo) 'nod-backups')."

if ($WakeAt) {
    $wakeTime = [datetime]::ParseExact($WakeAt, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    Step "Waking the PC from sleep at $WakeAt and keeping it awake for 90 minutes"
    $wake = Join-Path $PSScriptRoot 'wake.ps1'
    $wakeAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wake`"" -WorkingDirectory $repo
    $wakeTrigger = New-ScheduledTaskTrigger -Daily -At $wakeTime
    $wakeSettings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'wake' -TaskPath '\Nod\' -Action $wakeAction -Trigger $wakeTrigger -Settings $wakeSettings -Principal $principal -Force | Out-Null
}

$port = 4310
$line = Select-String -Path $envFile -Pattern '^PORT=(\d+)\s*$' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
$desktop = [Environment]::GetFolderPath('Desktop')
Set-Content -Path (Join-Path $desktop 'nod.url') -Value "[InternetShortcut]`r`nURL=http://localhost:$port/`r`n" -Encoding ASCII
Write-Host "    Added a 'nod' shortcut to your desktop."

if ($NoStart) { Write-Host 'Done. Nod starts the next time you sign in to Windows.'; exit 0 }

Step 'Starting Nod now. The first start builds four containers and can take 10 minutes or more.'
Start-ScheduledTask -TaskPath '\Nod\' -TaskName 'start'
$log = Join-Path $repo '.local\windows-start.log'
$deadline = (Get-Date).AddMinutes(60)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (-not (Test-Path $log)) { continue }
    $ready = Select-String -Path $log -Pattern 'Nod is ready at (http\S+)' | Select-Object -Last 1
    if ($ready) {
        Start-Process $ready.Matches[0].Groups[1].Value
        Write-Host "Nod is running and open in your browser. Next time, use the 'nod' shortcut or http://localhost:$port." -ForegroundColor Green
        exit 0
    }
    if (Select-String -Path $log -Pattern 'Nod stopped with exit code|did not start|is not installed' -Quiet) {
        throw "Nod did not start. See $log"
    }
}
throw "Nod is still starting after 60 minutes. See $log"
