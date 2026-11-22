param([switch]$Desktop)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo
function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Native([scriptblock]$run) { $ErrorActionPreference = 'Continue'; & $run }
. (Join-Path $PSScriptRoot 'desktop-common.ps1')
$desktopMode = $Desktop -or [bool](Get-NodDesktopFolder)

function Get-RuntimeInputs {
    $env:NOD_DESKTOP_TARGET = 'win32-x64'
    try { $output = @(Native { node desktop/scripts/runtime-inputs.mjs 2>&1 }) } finally { Remove-Item Env:NOD_DESKTOP_TARGET -ErrorAction SilentlyContinue }
    $errors = ($output | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { ConvertTo-NodLine $_ }) -join ' '
    if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ fingerprint = $null; inputs = @(); error = "exit code $LASTEXITCODE $errors" } }
    return ($output | Where-Object { $_ -is [string] }) -join "`n" | ConvertFrom-Json
}

function Format-Names([string[]]$names) {
    $shown = ($names | Select-Object -First 3) -join ', '
    if ($names.Count -gt 3) { return "$shown and $($names.Count - 3) more" }
    return $shown
}

if ((Native { git status --porcelain }) -ne $null) { throw 'You have uncommitted changes. Commit or put them aside first, then run the update again.' }
if ((Native { git rev-parse --abbrev-ref HEAD }) -ne 'mine') { throw "Switch to the 'mine' branch first: git switch mine" }
if (-not (Native { git remote } | Select-String -Pattern '^upstream$' -Quiet)) {
    Native { git remote add upstream https://github.com/n8n-io/nod.git }
    Native { git remote set-url --push upstream DISABLED }
}

Step "Getting n8n's latest Nod"
Native { git fetch upstream --quiet }
if ($LASTEXITCODE -ne 0) { throw 'Could not reach GitHub. Check your connection and try again.' }
$behind = [int](Native { git rev-list --count mine..upstream/main })
if ($behind -eq 0) { Write-Host 'Already up to date with n8n.' -ForegroundColor Green; exit 0 }
Write-Host "    $behind new change(s) from n8n."

if ($desktopMode) {
    $before = Native { git rev-parse HEAD }
    $runtimeBefore = Get-RuntimeInputs
} else {
    Step 'Stopping Nod'
    & (Join-Path $PSScriptRoot 'stop.ps1')
}

Step "Merging n8n's changes into this fork"
Native { git merge --no-edit upstream/main } | Out-Null
if ($LASTEXITCODE -ne 0) {
    Native { git merge --abort }
    if ($desktopMode) {
        throw "n8n's changes clash with this fork's changes, so nothing was updated and Nod keeps running as it was. Ask Claude Code: 'merge upstream/main into mine and resolve the conflicts'."
    }
    Start-ScheduledTask -TaskPath '\Nod\' -TaskName 'start'
    throw "n8n's changes clash with this fork's changes, so nothing was updated and Nod was restarted as it was. Ask Claude Code: 'merge upstream/main into mine and resolve the conflicts'."
}

Step 'Saving the update to your GitHub fork'
Native { git push origin upstream/main:main --quiet }
Native { git push origin mine --quiet }
if ($LASTEXITCODE -ne 0) { Write-Host '    Could not push to GitHub; the update is still applied on this PC.' -ForegroundColor Yellow }

if ($desktopMode) {
    $changed = @(Native { git diff --name-only $before HEAD })
    $restart = @($changed | Where-Object { $_ -match '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|patches/|desktop/)' })
    $runtimeAfter = Get-RuntimeInputs
    $inputs = @($runtimeBefore.inputs) + @($runtimeAfter.inputs)
    $images = @($changed | Where-Object { $inputs -contains $_ })
    $runtimeChanged = $runtimeBefore.fingerprint -ne $runtimeAfter.fingerprint
    if (-not $restart.Count -and -not $runtimeChanged) {
        Write-Host 'Updated. A running Nod follows the change by itself: its engine restarts once no reply or task is running, and the window reloads for web changes.' -ForegroundColor Green
    } else {
        Write-Host 'Updated. A running Nod follows server and web changes by itself, but not these:' -ForegroundColor Green
    }
    if ($restart.Count) {
        Write-Host "    $(Format-Names $restart) changed, which a running Nod can't pick up." -ForegroundColor Yellow
        Write-Host '    Quit Nod from its tray icon, then start it with the Nod shortcut. The start installs new packages first.' -ForegroundColor Yellow
    }
    if (-not $runtimeBefore.fingerprint -or -not $runtimeAfter.fingerprint) {
        Write-Host "    Could not check whether the runtime images changed: $($runtimeBefore.error)$($runtimeAfter.error)" -ForegroundColor Yellow
    } elseif ($runtimeChanged) {
        $what = if ($images.Count) { Format-Names $images } else { 'the browser packages in pnpm-lock.yaml' }
        Write-Host "    The runtime images include $what, so Nod keeps its current runtime." -ForegroundColor Yellow
        Write-Host '    Prepare a new runtime (pnpm run desktop:windows:prepare), then quit Nod and start it again.' -ForegroundColor Yellow
    }
    exit 0
}

Step 'Starting Nod. It rebuilds what changed, so give it a few minutes.'
Start-ScheduledTask -TaskPath '\Nod\' -TaskName 'start'
$log = Join-Path $repo '.local\windows-start.log'
$deadline = (Get-Date).AddMinutes(30)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Nod is ready at' -Quiet)) {
        Write-Host 'Updated and running.' -ForegroundColor Green
        exit 0
    }
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Nod stopped with exit code|did not start' -Quiet)) {
        throw "Nod did not start after the update. See $log. To go back: git reset --hard ORIG_HEAD, then start Nod again."
    }
}
throw "Nod is still starting after 30 minutes. See $log"
