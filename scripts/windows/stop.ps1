param([string]$Desktop)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'desktop-common.ps1')
if (-not $Desktop) { $Desktop = Get-NodDesktopFolder }
if ($Desktop) {
    $Desktop = Resolve-NodDesktopFolder $Desktop
    Set-Location $repo
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    $env:Path = "$env:APPDATA\npm;$env:Path"
    Write-Host 'Asking Nod to quit, the same as Quit Nod in its tray menu. This never force-closes it.'
    $answer = @(Invoke-NodDesktopApp $repo @('quit', '--user-data', $Desktop))
    $code = $LASTEXITCODE
    $answer | ForEach-Object { Write-Host $_ }
    exit $code
}

$port = 4310
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^PORT=(\d+)\s*$' | Select-Object -First 1
    if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
}

$repoPath = (Resolve-Path $repo).Path
$processes = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -in @('node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe') -and
    $_.CommandLine -and $_.CommandLine.Contains($repoPath) -and
    $_.CommandLine -match 'start\.mjs|tsx|pnpm|scripts\\windows\\start\.ps1'
}
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $processes -and -not $listener) { Write-Host "Nod is not running."; exit 0 }

$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Something is still listening on port $port."
}
Push-Location $repo
$ErrorActionPreference = 'Continue'
try { docker compose stop *> $null } finally { Pop-Location }
Write-Host "Nod is stopped. Start it again with scripts\windows\start.ps1 or by signing in to Windows."
