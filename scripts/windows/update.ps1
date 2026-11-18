$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo
function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Native([scriptblock]$run) { $ErrorActionPreference = 'Continue'; & $run }

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

Step 'Stopping Nod'
& (Join-Path $PSScriptRoot 'stop.ps1')

Step "Merging n8n's changes into this fork"
Native { git merge --no-edit upstream/main } | Out-Null
if ($LASTEXITCODE -ne 0) {
    Native { git merge --abort }
    Start-ScheduledTask -TaskPath '\Nod\' -TaskName 'start'
    throw "n8n's changes clash with this fork's changes, so nothing was updated and Nod was restarted as it was. Ask Claude Code: 'merge upstream/main into mine and resolve the conflicts'."
}

Step 'Saving the update to your GitHub fork'
Native { git push origin upstream/main:main --quiet }
Native { git push origin mine --quiet }
if ($LASTEXITCODE -ne 0) { Write-Host '    Could not push to GitHub; the update is still applied on this PC.' -ForegroundColor Yellow }

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
