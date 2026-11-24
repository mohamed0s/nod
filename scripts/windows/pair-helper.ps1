param([string]$Code, [string]$Nod)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$extension = Join-Path $repo 'extensions\linkedin-helper'
$pattern = '^\s*[2-9A-HJKMNP-Za-hjkmnp-z]{4}[\s-]?[2-9A-HJKMNP-Za-hjkmnp-z]{4}\s*$'

$manifest = Get-Content -Raw -LiteralPath (Join-Path $extension 'manifest.json') | ConvertFrom-Json
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($manifest.key))
$id = -join (($hash[0..15] | ForEach-Object { $_.ToString('x2') }) -join '').ToCharArray().ForEach({ [char](97 + [Convert]::ToInt32("$_", 16)) })

if (-not $Code) {
    $clip = ''
    try { $clip = "$(Get-Clipboard -Raw)" } catch {}
    if ($clip -match $pattern) {
        $Code = $clip
        Write-Host 'Using the pairing code Nod copied.'
    } else {
        $Code = Read-Host "Pairing code from Nod (Jobs page, Helper tab, Pair the Edge panel)"
    }
}
if ($Code -notmatch $pattern) { throw "'$Code' isn't a pairing code. It looks like ABCD-2345 and is shown on Nod's Jobs page, Helper tab." }

$candidates = [Collections.Generic.List[string]]::new()
if ($Nod) {
    if ($Nod -notmatch '^http://(127\.0\.0\.1|localhost):\d{2,5}$') { throw "-Nod must look like http://127.0.0.1:4310 or http://localhost:4310, not '$Nod'." }
    $candidates.Add($Nod)
} else {
    $candidates.Add('http://127.0.0.1:4310')
    $candidates.Add('http://localhost:4310')
    $listening = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue
    foreach ($socket in $listening) {
        $process = Get-Process -Id $socket.OwningProcess -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -in @('electron', 'Nod', 'node')) {
            $address = "http://127.0.0.1:$($socket.LocalPort)"
            if (-not $candidates.Contains($address)) { $candidates.Add($address) }
        }
    }
}

$body = @{ code = $Code.Trim(); extensionId = $id } | ConvertTo-Json -Compress
$paired = $null
$problem = $null
foreach ($address in $candidates) {
    try {
        $answer = Invoke-RestMethod -Method Post -Uri "$address/api/helper-pairing" -ContentType 'application/json' -Body $body -TimeoutSec 15 -UseBasicParsing
        if ($answer.token -match '^[A-Za-z0-9_-]{43}$') { $paired = @{ nod = $address; token = $answer.token }; break }
        $problem = "Nod at $address answered without a key."
    } catch {
        $detail = $_.ErrorDetails.Message
        $reason = $null
        if ($detail) { try { $reason = ($detail | ConvertFrom-Json).error } catch {} }
        if ($reason -and $reason -ne 'This host is not permitted.') { throw "Nod at $address refused the pairing: $reason" }
        $problem = if ($reason) { "Nod at $address answers only at another address." } else { "Nothing answered as Nod at ${address}: $($_.Exception.Message)" }
    }
}
if (-not $paired) { throw "Couldn't reach Nod. $problem Start Nod, or pass its address with -Nod http://127.0.0.1:<port>." }

$file = Join-Path $extension 'pairing.json'
$json = @{ nod = $paired.nod; token = $paired.token; pairedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))
Set-Acl -LiteralPath $file -AclObject $acl

Write-Host "Paired the Edge panel (extension $id) with Nod at $($paired.nod)."
Write-Host "The panel picks this up within 20 seconds. If you haven't loaded it yet: open edge://extensions, turn on Developer mode, select Load unpacked and choose $extension"
