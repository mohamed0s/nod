param([Parameter(Mandatory = $true)][string]$UserData, [switch]$Show)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'desktop-common.ps1')
$UserData = Resolve-NodDesktopFolder $UserData
Set-Location $repo
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:NOD_DESKTOP_USER_DATA = $UserData
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:Path = "$env:APPDATA\npm;$env:Path"
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}

if (Test-NodDesktopRunning $repo $UserData) {
    if ($Show) { Invoke-NodDesktopApp $repo @('show', '--user-data', $UserData) | Out-Null }
    Write-Host 'Nod is already running.'
    exit 0
}

$name = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($UserData.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
$mutex = New-Object Threading.Mutex($false, "Local\nod-desktop-start-$name")
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Write-Host 'Nod is already starting.'
    exit 0
}

New-Item -ItemType Directory -Force $UserData | Out-Null
$log = Join-Path $UserData 'desktop-start.log'
if (Test-Path $log) { Move-Item $log (Join-Path $UserData 'desktop-start.prev.log') -Force }
function Say($text) { Add-Content $log ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $text) -Encoding UTF8 }

try {
    Initialize-NodDesktopCheckout -Repo $repo -UserData $UserData -Write { param($line) Say $line }
} catch {
    Say "Nod did not start: $($_.Exception.Message)"
    exit 1
}

Say 'Starting Nod.'
$ErrorActionPreference = 'Continue'
& pnpm run desktop:dev 2>&1 | ForEach-Object { ConvertTo-NodLine $_ } | Out-File -FilePath $log -Append -Encoding utf8
Say "Nod stopped with exit code $LASTEXITCODE."
