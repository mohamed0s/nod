function Resolve-NodDesktopFolder([string]$Folder) {
    $trimmed = "$Folder".Trim().TrimEnd('\')
    if ($trimmed -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\).+') {
        throw "The desktop folder must be a full path such as D:\Nod\desktop, not '$Folder'."
    }
    return $trimmed
}

function Get-NodDesktopFolder {
    $task = Get-ScheduledTask -TaskPath '\Nod\' -TaskName 'start' -ErrorAction SilentlyContinue
    foreach ($action in @($task.Actions)) {
        if ("$($action.Arguments)" -match 'desktop-start\.ps1"?\s+-UserData\s+"([^"]+)"') { return $Matches[1] }
    }
    return $null
}

function ConvertTo-NodLine($item) {
    if ($item -is [Management.Automation.ErrorRecord]) { return $item.Exception.Message }
    return "$item"
}

function Invoke-NodDesktopApp([string]$Repo, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & pnpm --dir $Repo exec tsx (Join-Path $Repo 'scripts\windows\desktop-app.ts') @Arguments 2>&1 | ForEach-Object { ConvertTo-NodLine $_ }
}

function Test-NodDesktopRunning([string]$UserData) {
    try {
        $stream = [IO.File]::Open((Join-Path $UserData 'lockfile'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]'ReadWrite, Delete')
        $stream.Dispose()
        return $false
    } catch [IO.FileNotFoundException] {
        return $false
    } catch [IO.DirectoryNotFoundException] {
        return $false
    } catch [UnauthorizedAccessException] {
        return $true
    } catch [IO.IOException] {
        if (($_.Exception.HResult -band 0xFFFF) -in @(32, 33)) { return $true }
        throw
    }
}

function Get-NodDesktopStartName([string]$UserData) {
    $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($UserData.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
    return "Local\nod-desktop-start-$hash"
}

function Test-NodDesktopStarting([string]$UserData) {
    $mutex = $null
    if (-not [Threading.Mutex]::TryOpenExisting((Get-NodDesktopStartName $UserData), [ref]$mutex)) { return $false }
    $mutex.Dispose()
    return $true
}

function Invoke-NodLogged([scriptblock]$Write, [scriptblock]$Run) {
    $ErrorActionPreference = 'Continue'
    & $Run 2>&1 | ForEach-Object { & $Write (ConvertTo-NodLine $_) }
}

function Initialize-NodDesktopCheckout([string]$Repo, [string]$UserData, [scriptblock]$Write) {
    $manifest = Join-Path $Repo 'windows-runtime\manifest.json'
    if (-not (Test-Path $manifest)) {
        throw "This checkout has no Windows runtime: $manifest is missing. Put the runtime (manifest.json, guest.tar.gz and bin\docker.exe) in the windows-runtime folder first."
    }
    if (-not $env:electron_config_cache) { $env:electron_config_cache = Join-Path (Split-Path -Parent $Repo) 'electron-cache' }

    $lockfiles = @('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'desktop\pnpm-lock.yaml', 'desktop\pnpm-workspace.yaml')
    $text = $Repo.ToLowerInvariant() + "`n" + (($lockfiles | ForEach-Object { "${_}:$((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Repo $_)).Hash)" }) -join "`n")
    $stamp = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant()
    $stampFile = Join-Path $UserData 'desktop-start.stamp'
    $current = (Test-Path $stampFile) -and ((Get-Content -LiteralPath $stampFile -Raw).Trim() -eq $stamp)
    if (-not $current -or -not (Test-Path (Join-Path $Repo 'node_modules')) -or -not (Test-Path (Join-Path $Repo 'desktop\node_modules'))) {
        & $Write 'Installing packages, because this is the first start or a lockfile changed since the last install.'
        Invoke-NodLogged $Write { pnpm --dir $Repo install --frozen-lockfile }
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE." }
        Invoke-NodLogged $Write { pnpm --dir (Join-Path $Repo 'desktop') install --frozen-lockfile }
        if ($LASTEXITCODE -ne 0) { throw "pnpm --dir desktop install failed with exit code $LASTEXITCODE." }
        New-Item -ItemType Directory -Force $UserData | Out-Null
        Set-Content -LiteralPath $stampFile -Value $stamp -Encoding ASCII
    }

    $electron = Join-Path $Repo 'desktop\node_modules\electron'
    if (-not (Test-Path (Join-Path $electron 'path.txt')) -or -not (Test-Path (Join-Path $electron 'dist\electron.exe'))) {
        & $Write "Downloading Electron into its cache at $env:electron_config_cache."
        Invoke-NodLogged $Write { node (Join-Path $electron 'install.js') }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $electron 'dist\electron.exe'))) {
            throw "Electron could not be installed (exit code $LASTEXITCODE)."
        }
    }

    if (-not (Test-Path (Join-Path $Repo 'dist\web\index.html'))) {
        & $Write 'Building the web app once, because dist\web is missing.'
        Invoke-NodLogged $Write { pnpm --dir $Repo run build }
        if ($LASTEXITCODE -ne 0) { throw "pnpm run build failed with exit code $LASTEXITCODE." }
    }
}
