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
try { $marker = Get-Content -LiteralPath (Join-Path $root $MarkerName) -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail-Safe 'Installation marker is invalid.' }
if ($marker.repository -cne $Repository -or $marker.schemaVersion -ne 1) { Fail-Safe 'Installation marker is not manager-owned.' }
$exe = Join-Path $root 'harness-mrtool.exe'; $exeItem = Get-Item -LiteralPath $exe -Force -ErrorAction Stop
if (($exeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $exeItem.PSIsContainer) { Fail-Safe 'Owned executable is invalid.' }
& $exe self-update status --output json *> $null; if ($LASTEXITCODE -ne 0) { Fail-Safe 'Updater recovery did not complete.' }
& $exe self-test --output json *> $null; if ($LASTEXITCODE -ne 0) { Fail-Safe 'Installed self-test did not pass.' }
