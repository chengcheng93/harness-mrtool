[CmdletBinding()]
param(
  [string]$Destination = $(if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { '' } else { Join-Path $env:LOCALAPPDATA 'HarnessMrTool' }),
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
$Repository = 'chengcheng93/harness-mrtool'; $MarkerName = '.harness-mrtool-install.json'
function Fail-Safe { param([string]$Message) throw [InvalidOperationException]::new($Message) }
function Assert-PlainTree { param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Safe 'Installation tree contains a reparse point.' }
  if (-not $item.PSIsContainer) { return }
  foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
    if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Safe 'Installation tree contains a reparse point.' }
    if ($child.PSIsContainer) { Assert-PlainTree $child.FullName }
  }
}
function Remove-PlainTree { param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Safe 'Installation tree changed to a reparse point.' }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) { Remove-PlainTree $child.FullName }
    $item = Get-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Safe 'Installation tree changed to a reparse point.' }
    [IO.Directory]::Delete($item.FullName, $false)
  } else {
    [IO.File]::Delete($item.FullName)
  }
}
if ([string]::IsNullOrWhiteSpace($Destination)) { Fail-Safe 'LOCALAPPDATA is unavailable; specify a destination.' }
$root = [IO.Path]::GetFullPath($Destination); if ([IO.Path]::GetPathRoot($root) -eq $root) { Fail-Safe 'Refusing to remove a filesystem root.' }
$item = Get-Item -LiteralPath $root -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) { Fail-Safe 'Installation root is not manager-owned.' }
$markerPath = Join-Path $root $MarkerName; $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $markerItem.PSIsContainer) { Fail-Safe 'Installation marker is invalid.' }
try { $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail-Safe 'Installation marker is invalid.' }
$markerKeys = @($marker.PSObject.Properties.Name | Sort-Object)
if (($markerKeys -join '|') -cne 'archiveSha256|executableSha256|repository|schemaVersion|tag' -or $marker.repository -cne $Repository -or $marker.schemaVersion -ne 1 -or $marker.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or $marker.executableSha256 -notmatch '^[a-f0-9]{64}$' -or $marker.tag -notmatch '^cli-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { Fail-Safe 'Installation marker is not owned by harness-mrtool.' }
$exe = Join-Path $root 'harness-mrtool.exe'; $exeItem = Get-Item -LiteralPath $exe -Force -ErrorAction Stop
if (($exeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $exeItem.PSIsContainer) { Fail-Safe 'Owned executable is invalid.' }
$sha = [Security.Cryptography.SHA256]::Create(); $stream = $null
try { $stream = [IO.File]::OpenRead($exe); $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { if ($null -ne $stream) { $stream.Dispose() }; $sha.Dispose() }
if ($actual -cne $marker.executableSha256) { Fail-Safe 'Owned executable does not match its marker.' }
Assert-PlainTree $root
if (-not $WhatIf) { Remove-PlainTree $root }
