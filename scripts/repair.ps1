[CmdletBinding()]
param(
  [string]$Destination = $(if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { '' } else { Join-Path $env:LOCALAPPDATA 'HarnessMrTool' })
)
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
$Repository = 'chengcheng93/harness-mrtool'; $MarkerName = '.harness-mrtool-install.json'
function Fail-Safe { param([string]$Message) throw [InvalidOperationException]::new($Message) }
if ([string]::IsNullOrWhiteSpace($Destination)) { Fail-Safe 'LOCALAPPDATA is unavailable; specify a destination.' }
$root = [IO.Path]::GetFullPath($Destination); if ([IO.Path]::GetPathRoot($root) -eq $root) { Fail-Safe 'Refusing to repair a filesystem root.' }
$item = Get-Item -LiteralPath $root -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) { Fail-Safe 'Installation root is not manager-owned.' }
$markerPath = Join-Path $root $MarkerName; $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $markerItem.PSIsContainer) { Fail-Safe 'Installation marker is invalid.' }
try { $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail-Safe 'Installation marker is invalid.' }
$markerKeys = @($marker.PSObject.Properties.Name | Sort-Object)
if (($markerKeys -join '|') -cne 'archiveSha256|executableSha256|repository|schemaVersion|tag' -or
    $marker.repository -cne $Repository -or $marker.schemaVersion -ne 1 -or
    $marker.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or $marker.executableSha256 -notmatch '^[a-f0-9]{64}$' -or
    $marker.tag -notmatch '^cli-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  Fail-Safe 'Installation marker is not manager-owned.'
}
$exe = Join-Path $root 'harness-mrtool.exe'; $exeItem = Get-Item -LiteralPath $exe -Force -ErrorAction Stop
if (($exeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $exeItem.PSIsContainer) { Fail-Safe 'Owned executable is invalid.' }
$sha = [Security.Cryptography.SHA256]::Create(); $stream = $null
try { $stream = [IO.File]::OpenRead($exe); $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { if ($null -ne $stream) { $stream.Dispose() }; $sha.Dispose() }
if ($actual -cne $marker.executableSha256) { Fail-Safe 'Owned executable does not match its marker.' }
& $exe self-update status --output json *> $null; if ($LASTEXITCODE -ne 0) { Fail-Safe 'Updater recovery did not complete.' }
& $exe self-test --output json *> $null; if ($LASTEXITCODE -ne 0) { Fail-Safe 'Installed self-test did not pass.' }
