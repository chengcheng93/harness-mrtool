[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$Tag,
  [Parameter(Mandatory = $false)]
  [string]$Sha256,
  [string]$Destination = $(if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { '' } else { Join-Path $env:LOCALAPPDATA 'HarnessMrTool' }),
  [switch]$Repair
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Repository = 'chengcheng93/harness-mrtool'
$ReleaseHost = 'github.com'
$AssetName = 'harness-mrtool-windows-x64.zip'
$MaxArchiveBytes = 256MB
$MaxEntryBytes = 256MB
$MaxExpandedBytes = 512MB
$MarkerName = '.harness-mrtool-install.json'
$ExpectedNames = @('SHA256SUMS', 'THIRD_PARTY_NOTICES.md', 'bundle-receipt.envelope.json', 'harness-mrtool.exe', 'licenses/Node.txt')

function Fail-Safe { param([string]$Message) throw [InvalidOperationException]::new($Message) }
function Get-SafePath { param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains([char]0)) { Fail-Safe 'Installation path is invalid.' }
  try { $full = [IO.Path]::GetFullPath($Path) } catch { Fail-Safe 'Installation path is invalid.' }
  if ([IO.Path]::GetPathRoot($full) -eq $full) { Fail-Safe 'Installation path is invalid.' }
  return $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}
function Get-SafeItem { param([string]$Path)
  try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { Fail-Safe 'Installation path is unavailable.' }
}
function Assert-PlainItem { param([object]$Item, [bool]$Directory = $false)
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Safe 'Reparse points are not allowed.' }
  if ($Directory -and -not $Item.PSIsContainer) { Fail-Safe 'Expected a directory.' }
  if (-not $Directory -and $Item.PSIsContainer) { Fail-Safe 'Expected a regular file.' }
}
function Ensure-Directory { param([string]$Path)
  $full = Get-SafePath $Path
  if (-not (Test-Path -LiteralPath $full)) { [IO.Directory]::CreateDirectory($full) | Out-Null }
  Assert-PlainItem (Get-SafeItem $full) $true
  return $full
}
function Remove-SafeTree { param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-SafeItem $Path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName, $false) } else { [IO.File]::Delete($item.FullName) }
    return
  }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) { Remove-SafeTree $child.FullName }
    [IO.Directory]::Delete($item.FullName, $false)
  } else { [IO.File]::Delete($item.FullName) }
}
function Assert-ArchivePath { param([string]$Path)
  if ([string]::IsNullOrEmpty($Path) -or $Path.Contains('\') -or $Path.Contains(':') -or $Path.StartsWith('/') -or $Path.Contains([char]0)) { Fail-Safe 'Release archive contains an unsafe path.' }
  foreach ($part in ($Path -split '/')) {
    if ([string]::IsNullOrEmpty($part) -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ')) { Fail-Safe 'Release archive contains an unsafe path.' }
    if ($part.TrimEnd('.', ' ').ToUpperInvariant() -match '^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') { Fail-Safe 'Release archive contains a reserved device name.' }
  }
  return $Path
}
function Get-FileHashHex { param([string]$Path)
  $item = Get-SafeItem $Path; Assert-PlainItem $item $false
  $hash = [Security.Cryptography.SHA256]::Create(); $stream = $null
  try { $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { if ($null -ne $stream) { $stream.Dispose() }; $hash.Dispose() }
}
function Open-VerifiedArchive { param([string]$Path, [string]$ExpectedHash)
  $item = Get-SafeItem $Path; Assert-PlainItem $item $false
  $hash = [Security.Cryptography.SHA256]::Create(); $stream = $null
  try {
    # Keep an exclusive handle while the verified bytes are parsed by ZipArchive.
    $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $actual = ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    if ($actual -cne $ExpectedHash) { Fail-Safe 'Downloaded release changed during verification.' }
    $stream.Position = 0
    return $stream
  } catch {
    if ($null -ne $stream) { $stream.Dispose() }
    throw
  } finally { $hash.Dispose() }
}
function Download-Bounded { param([Uri]$Uri, [string]$DestinationPath)
  Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
  $handler = New-Object Net.Http.HttpClientHandler; $handler.AllowAutoRedirect = $false
  $client = New-Object Net.Http.HttpClient($handler); $client.Timeout = [TimeSpan]::FromSeconds(90)
  $current = $Uri; $stream = $null
  try {
    for ($hop = 0; $hop -lt 4; $hop++) {
      if ($current.Scheme -ne 'https' -or $current.UserInfo -ne '' -or $current.Host -notin @($ReleaseHost, 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')) { Fail-Safe 'Release redirect is not an allowed HTTPS GitHub host.' }
      $response = $client.GetAsync($current, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      try {
        if ([int]$response.StatusCode -ge 300 -and [int]$response.StatusCode -lt 400) { if ($null -eq $response.Headers.Location) { Fail-Safe 'Release redirect has no location.' }; $current = [Uri]$response.Headers.Location; continue }
        if (-not $response.IsSuccessStatusCode) { Fail-Safe 'Release download failed.' }
        $contentLength = $response.Content.Headers.ContentLength
        if ($null -ne $contentLength -and [Int64]$contentLength -gt $MaxArchiveBytes) { Fail-Safe 'Release archive is too large.' }
        $stream = [IO.File]::Open($DestinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult(); $buffer = New-Object byte[] 65536; [Int64]$total = 0
        try { while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) { $total += $read; if ($total -gt $MaxArchiveBytes) { Fail-Safe 'Release archive is too large.' }; $stream.Write($buffer, 0, $read) }; if ($total -lt 1) { Fail-Safe 'Release archive is empty.' }; $stream.Flush($true) }
        finally { $input.Dispose() }
        return
      } finally { $response.Dispose() }
    }
    Fail-Safe 'Release download redirected too many times.'
  } finally { if ($null -ne $stream) { $stream.Dispose() }; $client.Dispose(); $handler.Dispose() }
}
function Read-ManagedMarker { param([string]$Root)
  $rootItem = Get-SafeItem $Root; Assert-PlainItem $rootItem $true
  $path = Join-Path $Root $MarkerName; $item = Get-SafeItem $path; Assert-PlainItem $item $false
  try { $value = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail-Safe 'Installation marker is invalid.' }
  $keys = @($value.PSObject.Properties.Name | Sort-Object)
  if (($keys -join '|') -cne 'archiveSha256|executableSha256|repository|schemaVersion|tag' -or $value.schemaVersion -ne 1 -or $value.repository -cne $Repository -or $value.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or $value.executableSha256 -notmatch '^[a-f0-9]{64}$' -or $value.tag -notmatch '^cli-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { Fail-Safe 'Installation marker fields are invalid.' }
  return $value
}
function Validate-ReleaseTree { param([string]$Root)
  $files = @(Get-ChildItem -LiteralPath $Root -Force -File -Recurse -ErrorAction Stop)
  $actual = @($files | ForEach-Object { $_.FullName.Substring($Root.Length + 1).Replace('\', '/') } | Sort-Object)
  $expected = @($ExpectedNames | Sort-Object)
  if (($actual -join '|') -cne ($expected -join '|')) { Fail-Safe 'Release tree is not exact.' }
  foreach ($file in $files) { Assert-PlainItem $file $false; if ($file.Length -gt $MaxEntryBytes) { Fail-Safe 'Release entry is too large.' } }
  $seen = @{}
  foreach ($line in @(Get-Content -LiteralPath (Join-Path $Root 'SHA256SUMS') -Encoding UTF8)) {
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { Fail-Safe 'SHA256SUMS is invalid.' }
    $name = Assert-ArchivePath $Matches[2]; if ($name -eq 'SHA256SUMS' -or $name -notin $expected -or $seen.ContainsKey($name)) { Fail-Safe 'SHA256SUMS is invalid.' }
    if ((Get-FileHashHex (Join-Path $Root ($name.Replace('/', [IO.Path]::DirectorySeparatorChar)))) -cne $Matches[1]) { Fail-Safe 'SHA256SUMS does not match release bytes.' }; $seen[$name] = $true
  }
  if ($seen.Count -ne 4) { Fail-Safe 'SHA256SUMS is incomplete.' }
  try { $receipt = Get-Content -LiteralPath (Join-Path $Root 'bundle-receipt.envelope.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail-Safe 'Bundle receipt is invalid.' }
  if ($null -eq $receipt) { Fail-Safe 'Bundle receipt is invalid.' }
}
function Invoke-ExecutableSelfTest { param([string]$Executable)
  $info = New-Object Diagnostics.ProcessStartInfo; $info.FileName = $Executable; $info.Arguments = 'self-test --output json'; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $process = New-Object Diagnostics.Process; $process.StartInfo = $info
  try { if (-not $process.Start()) { Fail-Safe 'Installed executable could not start.' }; if (-not $process.WaitForExit(60000)) { try { $process.Kill() } catch { }; Fail-Safe 'Installed executable self-test timed out.' }; if ($process.ExitCode -ne 0) { Fail-Safe 'Installed executable self-test failed.' } }
  finally { $process.Dispose() }
}

if ([string]::IsNullOrWhiteSpace($Destination)) { Fail-Safe 'LOCALAPPDATA is unavailable; specify a destination.' }
$destinationFull = Get-SafePath $Destination; $parent = Ensure-Directory (Split-Path -Parent $destinationFull)
if ($Repair) {
  $marker = Read-ManagedMarker $destinationFull; $exe = Join-Path $destinationFull 'harness-mrtool.exe'
  if ((Get-FileHashHex $exe) -cne $marker.executableSha256) { Fail-Safe 'Installed executable does not match its marker.' }
  Invoke-ExecutableSelfTest $exe; & $exe self-update status --output json *> $null; if ($LASTEXITCODE -ne 0) { Fail-Safe 'Updater recovery did not complete.' }; exit 0
}
if ($Tag -notmatch '^cli-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { Fail-Safe 'Release tag is invalid.' }
if ($Sha256 -notmatch '^[A-Fa-f0-9]{64}$') { Fail-Safe 'Release hash is invalid.' }
$expectedHash = $Sha256.ToLowerInvariant(); $uri = [Uri]::new("https://$ReleaseHost/$Repository/releases/download/$Tag/$AssetName")
$lockPath = Join-Path $parent '.harness-mrtool-install.lock'; $archivePath = Join-Path $parent ('.harness-mrtool-download-' + [Guid]::NewGuid().ToString('N') + '.zip'); $stagePath = Join-Path $parent ('.harness-mrtool-stage-' + [Guid]::NewGuid().ToString('N')); $backupPath = Join-Path $parent ('.harness-mrtool-old-' + [Guid]::NewGuid().ToString('N'))
$lock = $null; $moved = $false; $published = $false
try {
  try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { Fail-Safe 'Another installation is already running.' }
  Download-Bounded $uri $archivePath; if ((Get-FileHashHex $archivePath) -cne $expectedHash) { Fail-Safe 'Downloaded release hash does not match the expected hash.' }; Ensure-Directory $stagePath | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
  $archiveStream = $null; $archive = $null
  try {
    $archiveStream = Open-VerifiedArchive $archivePath $expectedHash
    $archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    if ($archive.Entries.Count -ne $ExpectedNames.Count) { Fail-Safe 'Release archive entry count is invalid.' }; $seen = @{}; [Int64]$expanded = 0; [Int64]$writtenTotal = 0
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith('/')) { Fail-Safe 'Release archive contains a directory entry.' }; $name = Assert-ArchivePath $entry.FullName
      if ($name -notin $ExpectedNames -or $seen.ContainsKey($name) -or $entry.Length -lt 1 -or $entry.Length -gt $MaxEntryBytes) { Fail-Safe 'Release archive tree is invalid.' }
      $expanded += [Int64]$entry.Length; if ($expanded -gt $MaxExpandedBytes) { Fail-Safe 'Release archive expands beyond its limit.' }
      $destination = Join-Path $stagePath ($name.Replace('/', [IO.Path]::DirectorySeparatorChar)); Ensure-Directory (Split-Path -Parent $destination) | Out-Null
      $out = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $input = $entry.Open()
      try {
        $buffer = New-Object byte[] 65536
        [Int64]$written = 0
        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $written += $read
          if ($written -gt [Int64]$entry.Length -or $written -gt $MaxEntryBytes) { Fail-Safe 'Release archive entry emitted too many bytes.' }
          $writtenTotal += $read
          if ($writtenTotal -gt $MaxExpandedBytes) { Fail-Safe 'Release archive emitted too many bytes.' }
          $out.Write($buffer, 0, $read)
        }
        if ($written -ne [Int64]$entry.Length) { Fail-Safe 'Release archive entry emitted an unexpected byte count.' }
        $out.Flush($true)
      } finally { $input.Dispose(); $out.Dispose() }; $seen[$name] = $true
    }
  } finally { if ($null -ne $archive) { $archive.Dispose() }; if ($null -ne $archiveStream) { $archiveStream.Dispose() } }
  Validate-ReleaseTree $stagePath; $exe = Join-Path $stagePath 'harness-mrtool.exe'; Invoke-ExecutableSelfTest $exe
  $marker = [ordered]@{ schemaVersion = 1; repository = $Repository; tag = $Tag; archiveSha256 = $expectedHash; executableSha256 = Get-FileHashHex $exe }
  [IO.File]::WriteAllText((Join-Path $stagePath $MarkerName), ($marker | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $destinationFull) { Read-ManagedMarker $destinationFull | Out-Null; [IO.Directory]::Move($destinationFull, $backupPath); $moved = $true }
  [IO.Directory]::Move($stagePath, $destinationFull); $published = $true; Read-ManagedMarker $destinationFull | Out-Null
  if ($moved) { Remove-SafeTree $backupPath; $moved = $false }
} catch {
  if ($published -and (Test-Path -LiteralPath $destinationFull)) { Remove-SafeTree $destinationFull }
  if ($moved -and (Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $destinationFull)) { [IO.Directory]::Move($backupPath, $destinationFull) }
  throw
} finally { if ($null -ne $lock) { $lock.Dispose() }; Remove-SafeTree $archivePath; if (-not $published) { Remove-SafeTree $stagePath }; if ($moved) { Remove-SafeTree $backupPath } }
