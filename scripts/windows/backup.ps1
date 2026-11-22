param([string]$Destination, [int]$Keep = 14, [string]$Desktop)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Destination) { $Destination = Join-Path (Split-Path -Parent $repo) 'nod-backups' }
function Native([scriptblock]$run) { $ErrorActionPreference = 'Continue'; & $run }
if ($Desktop) {
    . (Join-Path $PSScriptRoot 'desktop-common.ps1')
    $Desktop = Resolve-NodDesktopFolder $Desktop
}

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$target = Join-Path $Destination $stamp
New-Item -ItemType Directory -Force $target | Out-Null
$log = Join-Path $target 'backup.log'
function Say($text) { Add-Content $log ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $text) -Encoding UTF8 }

Push-Location $repo
try {
    if ($Desktop) {
        $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
        $env:Path = "$env:APPDATA\npm;$env:Path"
        try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
        Invoke-NodDesktopApp $repo @('backup', '--user-data', $Desktop, '--out', $target) | ForEach-Object { Say $_ }
        if ($LASTEXITCODE -ne 0) { throw "The desktop backup failed. See $log" }
    } else {
        $postgres = (Native { docker compose ps -q postgres }) | Select-Object -First 1
        if (-not $postgres) { throw 'The Nod database container is not running, so there is nothing to back up.' }
        Native { docker exec $postgres sh -c 'pg_dump -U nod -Fc nod > /tmp/nod-backup.dump' }
        if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }
        Native { docker cp "${postgres}:/tmp/nod-backup.dump" (Join-Path $target 'database.dump') } | Out-Null
        Native { docker exec $postgres rm -f /tmp/nod-backup.dump }
        Say 'Saved the database.'

        $localDir = Join-Path $repo '.local'
        if (Test-Path $localDir) {
            Native { tar -czf (Join-Path $target 'local.tgz') -C $repo .local 2>$null }
            Say 'Saved the .local data folder.'
        }

        $volumes = Native { docker volume ls --format '{{.Name}}' } | Where-Object { $_ -match '_(browser-data|postgres-data|workspace-tools)$' -and $_ -notmatch 'postgres-data$' }
        foreach ($volume in $volumes) {
            Native { docker run --rm -v "${volume}:/v:ro" -v "${target}:/b" alpine tar czf "/b/volume-$volume.tgz" -C /v . } | Out-Null
            if ($LASTEXITCODE -eq 0) { Say "Saved volume $volume." } else { Say "Could not save volume $volume." }
        }
    }
} finally {
    Pop-Location
}

$old = Get-ChildItem $Destination -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' } | Sort-Object Name -Descending | Select-Object -Skip $Keep
foreach ($dir in $old) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
$size = (Get-ChildItem $target -File | Measure-Object Length -Sum).Sum / 1MB
Say ("Done: {0:N1} MB in {1}. Kept the newest {2} backups." -f $size, $target, $Keep)
Write-Host ("Backup saved: {0} ({1:N1} MB)" -f $target, $size)
