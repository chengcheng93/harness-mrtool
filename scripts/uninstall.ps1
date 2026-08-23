[CmdletBinding()]
param(
  [string]$Destination = $(if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { '' } else { Join-Path $env:LOCALAPPDATA 'HarnessMrTool' }),
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
$Repository = 'chengcheng93/harness-mrtool'; $MarkerName = '.harness-mrtool-install.json'
function Fail-Safe { param([string]$Message) throw [InvalidOperationException]::new($Message) }
if ([string]::IsNullOrWhiteSpace($Destination)) { Fail-Safe 'LOCALAPPDATA is unavailable; specify a destination.' }
$root = [IO.Path]::GetFullPath($Destination); if ([IO.Path]::GetPathRoot($root) -eq $root) { Fail-Safe 'Refusing to remove a filesystem root.' }
$item = Get-Item -LiteralPath $root -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) { Fail-Safe 'Installation root is not manager-owned.' }
$markerPath = Join-Path $root $MarkerName; $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $markerItem.PSIsContainer) { Fail-Safe 'Installation marker is invalid.' }
try { $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail-Safe 'Installation marker is invalid.' }
if ($marker.repository -cne $Repository -or $marker.schemaVersion -ne 1 -or $marker.executableSha256 -notmatch '^[a-f0-9]{64}$') { Fail-Safe 'Installation marker is not owned by harness-mrtool.' }
$exe = Join-Path $root 'harness-mrtool.exe'; $exeItem = Get-Item -LiteralPath $exe -Force -ErrorAction Stop
if (($exeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $exeItem.PSIsContainer) { Fail-Safe 'Owned executable is invalid.' }
$sha = [Security.Cryptography.SHA256]::Create(); $stream = $null
try { $stream = [IO.File]::OpenRead($exe); $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { if ($null -ne $stream) { $stream.Dispose() }; $sha.Dispose() }
if ($actual -cne $marker.executableSha256) { Fail-Safe 'Owned executable does not match its marker.' }
if (-not $WhatIf) { Remove-Item -LiteralPath $root -Recurse -Force }
