$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dataRoot = Join-Path $repo '.local'
New-Item -ItemType Directory -Force $dataRoot | Out-Null
$log = Join-Path $dataRoot 'windows-start.log'
if (Test-Path $log) { Move-Item $log (Join-Path $dataRoot 'windows-start.prev.log') -Force }

function Say($text) { Add-Content $log ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $text) -Encoding UTF8 }

$port = 4310
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^PORT=(\d+)\s*$' | Select-Object -First 1
    if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Say "Nod is already running on port $port."
    exit 0
}

$dockerUp = { $ErrorActionPreference = 'Continue'; docker info --format '{{.ServerVersion}}' *> $null; $LASTEXITCODE -eq 0 }
if (-not (& $dockerUp)) {
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $desktop)) { Say "Docker Desktop is not installed at $desktop."; exit 1 }
    Say 'Starting Docker Desktop.'
    Start-Process $desktop
    $deadline = (Get-Date).AddMinutes(5)
    while (-not (& $dockerUp)) {
        if ((Get-Date) -gt $deadline) { Say 'Docker did not start within 5 minutes.'; exit 1 }
        Start-Sleep -Seconds 5
    }
}
Say 'Docker is running. Starting Nod.'

$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:Path = "$env:APPDATA\npm;$env:Path"
Set-Location $repo
$ErrorActionPreference = 'Continue'
& pnpm start 2>&1 | ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8
Say "Nod stopped with exit code $LASTEXITCODE."
