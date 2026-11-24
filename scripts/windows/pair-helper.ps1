param([string]$Code, [string]$UserData, [string]$Nod)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$extension = Join-Path $repo 'extensions\linkedin-helper'
$pattern = '^\s*[2-9A-HJKMNP-Za-hjkmnp-z]{4}[\s-]?[2-9A-HJKMNP-Za-hjkmnp-z]{4}\s*$'
$iterations = 210000
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
. (Join-Path $PSScriptRoot 'desktop-common.ps1')

function ConvertTo-Base64Url([byte[]]$Bytes) {
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Get-Hmac([byte[]]$Key, [string]$Text) {
    $hmac = [Security.Cryptography.HMACSHA256]::new($Key)
    try { return , $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) } finally { $hmac.Dispose() }
}
function Test-Same([string]$Actual, [string]$Expected) {
    if ($Actual.Length -ne $Expected.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Actual.Length; $index++) { $difference = $difference -bor ([int][char]$Actual[$index] -bxor [int][char]$Expected[$index]) }
    return $difference -eq 0
}
function Invoke-Nod([string]$Address, [string]$Path, [hashtable]$Body) {
    try {
        return Invoke-RestMethod -Method Post -Uri "$Address$Path" -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress) -TimeoutSec 60 -MaximumRedirection 0 -UseBasicParsing
    } catch {
        $reason = $null
        if ($_.ErrorDetails.Message) { try { $reason = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {} }
        if ($reason) { throw "Nod at $Address refused the pairing: $reason" }
        throw "Couldn't reach Nod at ${Address}: $($_.Exception.Message)"
    }
}

$manifest = Get-Content -Raw -LiteralPath (Join-Path $extension 'manifest.json') | ConvertFrom-Json
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($manifest.key))
$id = -join (($hash[0..15] | ForEach-Object { $_.ToString('x2') }) -join '').ToCharArray().ForEach({ [char](97 + [Convert]::ToInt32("$_", 16)) })

if ($Nod) {
    if ($Nod -notmatch '^http://127\.0\.0\.1:\d{2,5}$') { throw "-Nod must look like http://127.0.0.1:4310, not '$Nod'." }
    $address = $Nod
    Write-Host "Pairing with the Nod you named at $address. The script can't check which program answers there, but the exchange never gives it your code or the panel's key."
} else {
    if (-not $UserData) { $UserData = Get-NodDesktopFolder }
    if (-not $UserData) { $UserData = Join-Path $env:APPDATA 'nod' }
    $portFile = Join-Path $UserData 'profiles\local\engine-port.json'
    if (-not (Test-Path -LiteralPath $portFile)) { throw "Nod's desktop app hasn't recorded its address in $portFile. Start the Nod desktop app and run this again, or pass -UserData with its profile folder." }
    $owner = (Get-Acl -LiteralPath $portFile).GetOwner([Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $me.User.Value -and $owner.Value -ne 'S-1-5-32-544') { throw "$portFile belongs to another account ($owner), so the script doesn't trust it." }
    $recorded = Get-Content -Raw -LiteralPath $portFile | ConvertFrom-Json
    $port = [int]$recorded.port
    $engine = [int]$recorded.pid
    if ($port -lt 1024 -or $port -gt 65535 -or $engine -le 0 -or -not $recorded.executable) { throw "$portFile doesn't hold a port, process and program. Restart Nod and run this again." }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
    if (-not $listeners.Count) { throw "Nod isn't running: nothing listens on 127.0.0.1:$port. Start Nod and run this again." }
    $others = @($listeners | Where-Object { $_.OwningProcess -ne $engine })
    if ($others.Count) { throw "Another program (process $($others[0].OwningProcess)) holds 127.0.0.1:$port, not Nod. Close it, restart Nod and run this again." }
    $program = (Get-Process -Id $engine -ErrorAction SilentlyContinue).Path
    if (-not $program -or $program -ne $recorded.executable) { throw "The program on 127.0.0.1:$port ($program) isn't the Nod desktop app that recorded it. Restart Nod and run this again." }
    $started = (Get-Process -Id $engine).StartTime
    if ($started -gt (Get-Item -LiteralPath $portFile).LastWriteTime.AddSeconds(1)) { throw "The program on 127.0.0.1:$port started after Nod recorded its address, so it isn't the Nod that wrote $portFile. Restart Nod and run this again." }
    $address = "http://127.0.0.1:$port"
}

if (-not $Code) {
    $clip = ''
    try { $clip = "$(Get-Clipboard -Raw)" } catch {}
    if ($clip -match $pattern) {
        $Code = $clip
        Write-Host 'Using the pairing code Nod copied.'
    } else {
        $Code = Read-Host 'Pairing code from Nod (Jobs page, Helper tab, Pair the Edge panel)'
    }
}
if ($Code -notmatch $pattern) { throw "'$Code' isn't a pairing code. It looks like ABCD-2345 and is shown on Nod's Jobs page, Helper tab." }
$normal = $Code.ToUpperInvariant() -replace '[\s-]', ''

$random = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
$clientNonce = ConvertTo-Base64Url $random
$serverNonce = (Invoke-Nod $address '/api/helper-pairing/start' @{ extensionId = $id; clientNonce = $clientNonce }).serverNonce
if ($serverNonce -notmatch '^[A-Za-z0-9_-]{43}$') { throw "Nod at $address answered the pairing without a challenge." }
$derive = [Security.Cryptography.Rfc2898DeriveBytes]::new([Text.Encoding]::UTF8.GetBytes($normal), [Text.Encoding]::UTF8.GetBytes("nod-helper-pairing`n$clientNonce`n$serverNonce"), $iterations, [Security.Cryptography.HashAlgorithmName]::SHA256)
$root = $derive.GetBytes(32)
$derive.Dispose()
$proof = ConvertTo-Base64Url (Get-Hmac (Get-Hmac $root 'proof') "$id`n$clientNonce`n$serverNonce")
$answer = Invoke-Nod $address '/api/helper-pairing/finish' @{ extensionId = $id; clientNonce = $clientNonce; serverNonce = $serverNonce; proof = $proof }
if (-not $answer.iv -or -not $answer.sealed -or -not $answer.mac) { throw "Nod at $address answered the pairing without a key." }
$expected = ConvertTo-Base64Url (Get-Hmac (Get-Hmac $root 'mac') "$id`n$($answer.iv)`n$($answer.sealed)")
if (-not (Test-Same "$($answer.mac)" $expected)) { throw "The answer from $address wasn't made with your pairing code, so it isn't from your Nod. Nothing was saved." }
$aes = [Security.Cryptography.Aes]::Create()
try {
    $aes.Mode = 'CBC'
    $aes.Padding = 'PKCS7'
    $aes.Key = Get-Hmac $root 'encrypt'
    $aes.IV = [Convert]::FromBase64String($answer.iv)
    $sealed = [Convert]::FromBase64String($answer.sealed)
    $opened = [Text.Encoding]::UTF8.GetString($aes.CreateDecryptor().TransformFinalBlock($sealed, 0, $sealed.Length)) | ConvertFrom-Json
} finally { $aes.Dispose() }
if ($opened.id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $opened.token -notmatch '^[A-Za-z0-9_-]{43}$') { throw "Nod's answer didn't hold a key." }

$writeMask = [int64]1343029590
$allowed = @($me.User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
function Get-OpenWrites([string]$Path) {
    @((Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
        $_.AccessControlType -eq 'Allow' -and
        (([int64]$_.FileSystemRights) -band $writeMask) -ne 0 -and
        $allowed -notcontains $_.IdentityReference.Value
    })
}
$open = Get-OpenWrites $extension
if ($open.Count) {
    Write-Host "Other accounts can change the extension folder, so they could change the panel's code: $(($open | ForEach-Object { $name = $_.IdentityReference; try { $name = $name.Translate([Security.Principal.NTAccount]) } catch {}; "$name ($($_.FileSystemRights))" }) -join ', '). Limiting $extension to you, SYSTEM and Administrators."
    try {
        $tight = New-Object Security.AccessControl.DirectorySecurity
        $tight.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($me.User, [Security.Principal.SecurityIdentifier]'S-1-5-18', [Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
            $tight.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
        }
        Set-Acl -LiteralPath $extension -AclObject $tight
    } catch { throw "Couldn't limit who can change $extension ($($_.Exception.Message)). Nothing was saved; Revoke this pairing on the Jobs page, fix the folder's permissions and run this again." }
}
$still = @(Get-ChildItem -LiteralPath $extension -Force -Recurse | Where-Object { (Get-OpenWrites $_.FullName).Count })
if ((Get-OpenWrites $extension).Count -or $still.Count) { throw "Other accounts can still change $(if ($still.Count) { $still[0].FullName } else { $extension }). Nothing was saved; Revoke this pairing on the Jobs page, fix its permissions and run this again." }

$file = Join-Path $extension '.pairing.json'
$draft = Join-Path $extension ".pairing.$([guid]::NewGuid().ToString('N')).tmp"
New-Item -ItemType File -Path $draft | Out-Null
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me.User, 'FullControl', 'Allow')))
Set-Acl -LiteralPath $draft -AclObject $acl
$json = @{ nod = $address; id = $opened.id; token = $opened.token; pairedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($draft, $json, (New-Object Text.UTF8Encoding $false))
Move-Item -LiteralPath $draft -Destination $file -Force

Write-Host "Paired the Edge panel (extension $id) with Nod at $address."
Write-Host "The panel picks this up within 20 seconds. If you haven't loaded it yet: open edge://extensions, turn on Developer mode, select Load unpacked and choose $extension"
