[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [Parameter(Mandatory = $true)]
  [string]$Destination,
  [Parameter(Mandatory = $true)]
  [string]$ReleaseBaseUrl,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$Sha256
)

# This script is deliberately self-contained.  It is used before the CLI is
# available, so it cannot delegate archive validation to the Node runtime.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$MaxArchiveBytes = 16MB
$MaxSkillBytes = 16MB
$MaxSkillFileBytes = 4MB
$MaxSkillFiles = 128
$MaxManifestBytes = 64KB
$MaxArchiveEntries = 256
$Sha256Pattern = '^[a-f0-9]{64}$'
$SafePathPattern = '^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9._/-]+$'
$ReservedNamePattern = '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)'

function Fail-Security {
  param([string]$Message)
  throw [InvalidOperationException]::new($Message)
}

function Get-FullPathSafe {
  param([string]$Path)
  try {
    $full = [IO.Path]::GetFullPath($Path)
  } catch {
    Fail-Security 'A filesystem path is invalid.'
  }
  if ([string]::IsNullOrWhiteSpace($full) -or [IO.Path]::GetPathRoot($full) -eq $full) {
    Fail-Security 'A filesystem path is invalid.'
  }
  return $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-ItemSafe {
  param([string]$Path)
  try {
    return Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    Fail-Security 'A filesystem path is unavailable.'
  }
}

function Test-Exists {
  param([string]$Path)
  return Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue
}

function Assert-NotReparse {
  param([object]$Item)
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-Security 'Reparse points are not permitted in a Skill tree.'
  }
}

function Assert-SafeDirectory {
  param([string]$Path)
  $item = Get-ItemSafe $Path
  Assert-NotReparse $item
  if (-not $item.PSIsContainer) {
    Fail-Security 'A directory path is not a directory.'
  }
}

function Ensure-SafeDirectory {
  param([string]$Path)
  $full = Get-FullPathSafe $Path
  $root = [IO.Path]::GetPathRoot($full)
  $suffix = $full.Substring($root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $current = $root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  foreach ($part in $suffix -split '[\\/]') {
    if ([string]::IsNullOrEmpty($part)) { continue }
    $current = Join-Path $current $part
    if (-not (Test-Exists $current)) {
      try { [IO.Directory]::CreateDirectory($current) | Out-Null } catch { Fail-Security 'A directory could not be created.' }
    }
    Assert-SafeDirectory $current
  }
  Assert-SafeDirectory $full
  return $full
}

function Assert-SafeRelativePath {
  param([string]$Path)
  if ([string]::IsNullOrEmpty($Path) -or $Path.Length -gt 256 -or
      $Path.Contains('\') -or $Path.Contains([char]0) -or
      $Path -notmatch $SafePathPattern -or $Path.Contains(':')) {
    Fail-Security 'The Skill archive contains an unsafe path.'
  }
  $parts = $Path -split '/'
  foreach ($part in $parts) {
    if ([string]::IsNullOrEmpty($part) -or $part -eq '.' -or $part -eq '..' -or
        $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match $ReservedNamePattern) {
      Fail-Security 'The Skill archive contains an unsafe path.'
    }
    foreach ($character in $part.ToCharArray()) {
      if ([int][char]$character -lt 32) { Fail-Security 'The Skill archive contains an unsafe path.' }
    }
  }
  return $Path
}

function Get-RelativePathSafe {
  param([string]$Root, [string]$Path)
  $rootFull = (Get-FullPathSafe $Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    Fail-Security 'A filesystem path escapes its staging root.'
  }
  return $pathFull.Substring($rootFull.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, '/').Replace([IO.Path]::AltDirectorySeparatorChar, '/')
}

function Remove-SafeTree {
  param([string]$Path)
  if (-not (Test-Exists $Path)) { return }
  $item = Get-ItemSafe $Path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    # Never recurse through an object that changed into a junction/symlink.
    try {
      if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName, $false) }
      else { [IO.File]::Delete($item.FullName) }
    } catch { }
    return
  }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
      Remove-SafeTree $child.FullName
    }
    try { [IO.Directory]::Delete($item.FullName, $false) } catch { }
  } else {
    try { [IO.File]::Delete($item.FullName) } catch { }
  }
}

function Assert-NoReparseTree {
  param([string]$Root)
  $rootItem = Get-ItemSafe $Root
  Assert-NotReparse $rootItem
  if (-not $rootItem.PSIsContainer) { Fail-Security 'A Skill root is not a directory.' }
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push($rootItem)
  while ($stack.Count -gt 0) {
    $directory = $stack.Pop()
    foreach ($entry in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
      Assert-NotReparse $entry
      if ($entry.PSIsContainer) { $stack.Push($entry) }
    }
  }
}

function Get-Sha256Bytes {
  param([byte[]]$Bytes)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-Sha256File {
  param([string]$Path)
  $item = Get-ItemSafe $Path
  Assert-NotReparse $item
  if ($item.PSIsContainer) { Fail-Security 'A file path is not a file.' }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } catch {
    Fail-Security 'A file could not be hashed.'
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $algorithm.Dispose()
  }
}

function Read-JsonWhitespace {
  param([string]$Text, [ref]$Index)
  while ($Index.Value -lt $Text.Length) {
    $code = [int][char]$Text[$Index.Value]
    if ($code -ne 9 -and $code -ne 10 -and $code -ne 13 -and $code -ne 32) { break }
    [void]($Index.Value++)
  }
}

function Read-JsonString {
  param([string]$Text, [ref]$Index)
  if ($Index.Value -ge $Text.Length -or $Text[$Index.Value] -ne [char]34) { Fail-Security 'The Skill manifest is not valid JSON.' }
  [void]($Index.Value++)
  $builder = New-Object Text.StringBuilder
  while ($Index.Value -lt $Text.Length) {
    $character = [char]$Text[$Index.Value]
    [void]($Index.Value++)
    if ($character -eq [char]34) { return $builder.ToString() }
    if ([int][char]$character -lt 32) { Fail-Security 'The Skill manifest is not valid JSON.' }
    if ($character -ne [char]92) {
      [void]$builder.Append($character)
      continue
    }
    if ($Index.Value -ge $Text.Length) { Fail-Security 'The Skill manifest is not valid JSON.' }
    $escape = [char]$Text[$Index.Value]
    [void]($Index.Value++)
    switch ($escape) {
      '"' { [void]$builder.Append([char]34); continue }
      '\' { [void]$builder.Append([char]92); continue }
      '/' { [void]$builder.Append([char]47); continue }
      'b' { [void]$builder.Append([char]8); continue }
      'f' { [void]$builder.Append([char]12); continue }
      'n' { [void]$builder.Append([char]10); continue }
      'r' { [void]$builder.Append([char]13); continue }
      't' { [void]$builder.Append([char]9); continue }
      'u' {
        if ($Index.Value + 4 -gt $Text.Length) { Fail-Security 'The Skill manifest is not valid JSON.' }
        $hex = $Text.Substring($Index.Value, 4)
        if ($hex -notmatch '^[0-9A-Fa-f]{4}$') { Fail-Security 'The Skill manifest is not valid JSON.' }
        $code = [Convert]::ToInt32($hex, 16)
        [void]($Index.Value += 4)
        if ($code -ge 0xD800 -and $code -le 0xDBFF) {
          if ($Index.Value + 6 -gt $Text.Length -or $Text[$Index.Value] -ne [char]92 -or $Text[$Index.Value + 1] -ne 'u') {
            Fail-Security 'The Skill manifest contains invalid Unicode.'
          }
          $lowHex = $Text.Substring($Index.Value + 2, 4)
          if ($lowHex -notmatch '^[0-9A-Fa-f]{4}$') { Fail-Security 'The Skill manifest contains invalid Unicode.' }
          $low = [Convert]::ToInt32($lowHex, 16)
          if ($low -lt 0xDC00 -or $low -gt 0xDFFF) { Fail-Security 'The Skill manifest contains invalid Unicode.' }
          [void]($Index.Value += 6)
          [void]$builder.Append([char]$code)
          [void]$builder.Append([char]$low)
        } elseif ($code -ge 0xDC00 -and $code -le 0xDFFF) {
          Fail-Security 'The Skill manifest contains invalid Unicode.'
        } else {
          [void]$builder.Append([char]$code)
        }
        continue
      }
      default { Fail-Security 'The Skill manifest is not valid JSON.' }
    }
  }
  Fail-Security 'The Skill manifest is not valid JSON.'
}

function Read-JsonValue {
  param([string]$Text, [ref]$Index)
  Read-JsonWhitespace $Text $Index
  if ($Index.Value -ge $Text.Length) { Fail-Security 'The Skill manifest is not valid JSON.' }
  $character = [char]$Text[$Index.Value]
  if ($character -eq [char]34) { return Read-JsonString $Text $Index }
  if ($character -eq '{') {
    [void]($Index.Value++)
    $object = [ordered]@{}
    Read-JsonWhitespace $Text $Index
    if ($Index.Value -lt $Text.Length -and $Text[$Index.Value] -eq '}') { [void]($Index.Value++); return ,$object }
    while ($true) {
      Read-JsonWhitespace $Text $Index
      $key = Read-JsonString $Text $Index
      if ($object.Contains($key)) { Fail-Security 'The Skill manifest contains duplicate fields.' }
      Read-JsonWhitespace $Text $Index
      if ($Index.Value -ge $Text.Length -or $Text[$Index.Value] -ne ':') { Fail-Security 'The Skill manifest is not valid JSON.' }
      [void]($Index.Value++)
      $value = Read-JsonValue $Text $Index
      $object.Add($key, $value)
      Read-JsonWhitespace $Text $Index
      if ($Index.Value -ge $Text.Length) { Fail-Security 'The Skill manifest is not valid JSON.' }
      if ($Text[$Index.Value] -eq '}') { [void]($Index.Value++); return ,$object }
      if ($Text[$Index.Value] -ne ',') { Fail-Security 'The Skill manifest is not valid JSON.' }
      [void]($Index.Value++)
    }
  }
  if ($character -eq '[') {
    [void]($Index.Value++)
    $array = New-Object System.Collections.ArrayList
    Read-JsonWhitespace $Text $Index
    if ($Index.Value -lt $Text.Length -and $Text[$Index.Value] -eq ']') { [void]($Index.Value++); return ,$array }
    while ($true) {
      $value = Read-JsonValue $Text $Index
      [void]$array.Add($value)
      Read-JsonWhitespace $Text $Index
      if ($Index.Value -ge $Text.Length) { Fail-Security 'The Skill manifest is not valid JSON.' }
      if ($Text[$Index.Value] -eq ']') { [void]($Index.Value++); return ,$array }
      if ($Text[$Index.Value] -ne ',') { Fail-Security 'The Skill manifest is not valid JSON.' }
      [void]($Index.Value++)
    }
  }
  foreach ($literal in @(@('true', $true), @('false', $false), @('null', $null))) {
    $word = [string]$literal[0]
    if ($Index.Value + $word.Length -le $Text.Length -and $Text.Substring($Index.Value, $word.Length) -ceq $word) {
      [void]($Index.Value += $word.Length)
      return $literal[1]
    }
  }
  $start = $Index.Value
  while ($Index.Value -lt $Text.Length -and ([string]'0123456789+-.eE').Contains([char]$Text[$Index.Value])) { [void]($Index.Value++) }
  if ($Index.Value -eq $start) { Fail-Security 'The Skill manifest is not valid JSON.' }
  $token = $Text.Substring($start, $Index.Value - $start)
  if ($token -notmatch '^-?(?:0|[1-9][0-9]*)$') {
    if ($token -notmatch '^-?(?:0|[1-9][0-9]*)\.[0-9]+(?:[eE][+-]?[0-9]+)?$' -and
        $token -notmatch '^-?(?:0|[1-9][0-9]*)(?:[eE][+-]?[0-9]+)$') {
      Fail-Security 'The Skill manifest contains an invalid number.'
    }
    try { return [double]::Parse($token, [Globalization.CultureInfo]::InvariantCulture) } catch { Fail-Security 'The Skill manifest contains an invalid number.' }
  }
  try { return [Int64]::Parse($token, [Globalization.CultureInfo]::InvariantCulture) } catch { Fail-Security 'The Skill manifest contains an invalid number.' }
}

function ConvertTo-CanonicalJsonString {
  param([string]$Value)
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append([char]34)
  foreach ($character in $Value.ToCharArray()) {
    $code = [int][char]$character
    if ($character -eq [char]34) { [void]$builder.Append('\"'); continue }
    if ($character -eq [char]92) { [void]$builder.Append('\\'); continue }
    if ($character -eq [char]8) { [void]$builder.Append('\b'); continue }
    if ($character -eq [char]12) { [void]$builder.Append('\f'); continue }
    if ($character -eq [char]10) { [void]$builder.Append('\n'); continue }
    if ($character -eq [char]13) { [void]$builder.Append('\r'); continue }
    if ($character -eq [char]9) { [void]$builder.Append('\t'); continue }
    if ($code -lt 32) { [void]$builder.Append(('\u{0:x4}' -f $code)) } else { [void]$builder.Append($character) }
  }
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

function ConvertTo-CanonicalJsonValue {
  param([object]$Value)
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) { return ($(if ($Value) { 'true' } else { 'false' })) }
  if ($Value -is [string]) { return ConvertTo-CanonicalJsonString ([string]$Value) }
  if ($Value -is [System.Collections.IDictionary]) {
    $keys = @($Value.Keys | ForEach-Object { [string]$_ })
    [Array]::Sort($keys, [StringComparer]::Ordinal)
    $pieces = New-Object System.Collections.Generic.List[string]
    foreach ($key in $keys) { $pieces.Add((ConvertTo-CanonicalJsonString $key) + ':' + (ConvertTo-CanonicalJsonValue $Value[$key])) }
    return '{' + ($pieces -join ',') + '}'
  }
  if ($Value -is [System.Collections.IList]) {
    $pieces = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $Value) { $pieces.Add((ConvertTo-CanonicalJsonValue $entry)) }
    return '[' + ($pieces -join ',') + ']'
  }
  if ($Value -is [Int16] -or $Value -is [Int32] -or $Value -is [Int64] -or $Value -is [Byte] -or $Value -is [UInt16] -or $Value -is [UInt32] -or $Value -is [UInt64]) {
    return ([Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture))
  }
  if ($Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
    if ([double]::IsNaN([double]$Value) -or [double]::IsInfinity([double]$Value)) { Fail-Security 'The Skill manifest contains an invalid number.' }
    return ([double]$Value).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
  }
  Fail-Security 'The Skill manifest contains an unsupported JSON value.'
}

function Get-JsonField {
  param([System.Collections.IDictionary]$Object, [string]$Name)
  if (-not $Object.Contains($Name)) { Fail-Security 'The Skill manifest fields are invalid.' }
  Write-Output -NoEnumerate $Object[$Name]
}

function Get-JsonStringField {
  param([System.Collections.IDictionary]$Object, [string]$Name)
  $value = Get-JsonField $Object $Name
  if ($value -isnot [string] -or [string]::IsNullOrEmpty($value) -or $value.Contains([char]0) -or $value.Contains("`r") -or $value.Contains("`n")) {
    Fail-Security 'The Skill manifest fields are invalid.'
  }
  return [string]$value
}

function Get-JsonIntegerField {
  param([System.Collections.IDictionary]$Object, [string]$Name, [Int64]$Minimum, [Int64]$Maximum)
  $value = Get-JsonField $Object $Name
  if ($value -isnot [Int64] -and $value -isnot [Int32] -and $value -isnot [Int16]) { Fail-Security 'The Skill manifest fields are invalid.' }
  $number = [Int64]$value
  if ($number -lt $Minimum -or $number -gt $Maximum) { Fail-Security 'The Skill manifest fields are invalid.' }
  return $number
}

function Read-SkillManifest {
  param([string]$Root, [string]$ExpectedVersion, [string]$ExpectedAssetHash, [Int64]$ExpectedAssetSize)
  $path = Join-Path $Root '.harness-skill-manifest.json'
  $item = Get-ItemSafe $path
  Assert-NotReparse $item
  if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt $MaxManifestBytes) { Fail-Security 'The Skill manifest is invalid.' }
  try {
    $text = (New-Object Text.UTF8Encoding($false, $true)).GetString([IO.File]::ReadAllBytes($item.FullName))
  } catch { Fail-Security 'The Skill manifest is not valid UTF-8.' }
  $index = 0
  $manifest = Read-JsonValue $text ([ref]$index)
  Read-JsonWhitespace $text ([ref]$index)
  if ($index -ne $text.Length -or $manifest -isnot [System.Collections.IDictionary]) { Fail-Security 'The Skill manifest is invalid.' }
  $baseKeys = @('activation', 'cliVersionRange', 'files', 'manifestVersion', 'skillProtocol', 'tag', 'treeSha256', 'version')
  $provenanceKeys = @('activation', 'assetSha256', 'assetSize', 'cliVersionRange', 'files', 'manifestVersion', 'skillProtocol', 'tag', 'treeSha256', 'version')
  $actualKeys = @($manifest.Keys | ForEach-Object { [string]$_ }); [Array]::Sort($actualKeys, [StringComparer]::Ordinal)
  $sortedBase = @($baseKeys); [Array]::Sort($sortedBase, [StringComparer]::Ordinal)
  $sortedProvenance = @($provenanceKeys); [Array]::Sort($sortedProvenance, [StringComparer]::Ordinal)
  $hasProvenance = ($actualKeys -join '|') -ceq ($sortedProvenance -join '|')
  if (-not $hasProvenance -and ($actualKeys -join '|') -cne ($sortedBase -join '|')) { Fail-Security 'The Skill manifest fields are invalid.' }
  $version = Get-JsonStringField $manifest 'version'
  if ($version -cne $ExpectedVersion -or $version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') { Fail-Security 'The Skill manifest fields are invalid.' }
  if ((Get-JsonStringField $manifest 'tag') -cne "skill-v$version" -or (Get-JsonStringField $manifest 'activation') -cne 'explicit-host-refresh') { Fail-Security 'The Skill manifest fields are invalid.' }
  if ((Get-JsonIntegerField $manifest 'manifestVersion' 1 1) -ne 1) { Fail-Security 'The Skill manifest fields are invalid.' }
  [void](Get-JsonIntegerField $manifest 'skillProtocol' 1 ([Int64]::MaxValue))
  [void](Get-JsonStringField $manifest 'cliVersionRange')
  $assetHash = $null
  $assetSize = $null
  if ($hasProvenance) {
    $assetHash = Get-JsonStringField $manifest 'assetSha256'
    $assetSize = Get-JsonIntegerField $manifest 'assetSize' 1 $MaxArchiveBytes
    if (-not [string]::IsNullOrEmpty($ExpectedAssetHash) -and ($assetHash -cne $ExpectedAssetHash.ToLowerInvariant() -or $assetSize -ne $ExpectedAssetSize)) { Fail-Security 'The Skill manifest asset does not match the downloaded release.' }
  }
  $treeHash = Get-JsonStringField $manifest 'treeSha256'
  if ($treeHash -notmatch $Sha256Pattern) { Fail-Security 'The Skill manifest fields are invalid.' }
  $files = Get-JsonField $manifest 'files'
  if ($files -isnot [System.Collections.IList] -or $files.Count -lt 1 -or $files.Count -gt $MaxSkillFiles) { Fail-Security 'The Skill manifest files are invalid.' }
  $records = New-Object System.Collections.ArrayList
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $previous = $null
  foreach ($file in $files) {
    if ($file -isnot [System.Collections.IDictionary]) { Fail-Security 'The Skill manifest files are invalid.' }
    $keys = @($file.Keys | ForEach-Object { [string]$_ }); [Array]::Sort($keys, [StringComparer]::Ordinal)
    if (($keys -join '|') -cne 'path|sha256|size') { Fail-Security 'The Skill manifest files are invalid.' }
    $filePath = Assert-SafeRelativePath (Get-JsonStringField $file 'path')
    if (-not $seen.Add($filePath)) { Fail-Security 'The Skill manifest files are invalid.' }
    if ($null -ne $previous -and [StringComparer]::Ordinal.Compare($previous, $filePath) -ge 0) { Fail-Security 'The Skill manifest files are not ordered.' }
    $previous = $filePath
    $size = Get-JsonIntegerField $file 'size' 1 $MaxSkillFileBytes
    $hash = Get-JsonStringField $file 'sha256'
    if ($hash -notmatch $Sha256Pattern) { Fail-Security 'The Skill manifest files are invalid.' }
    [void]$records.Add([ordered]@{ path = $filePath; sha256 = $hash.ToLowerInvariant(); size = $size })
  }
  if (-not $seen.Contains('SKILL.md')) { Fail-Security 'The Skill archive must contain SKILL.md.' }
  $canonical = ConvertTo-CanonicalJsonValue $manifest
  if ($text -cne ($canonical + "`n")) { Fail-Security 'The Skill manifest is not canonical JSON.' }
  $treeCanonical = ConvertTo-CanonicalJsonValue $records
  if ((Get-Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($treeCanonical + "`n"))) -cne $treeHash.ToLowerInvariant()) { Fail-Security 'The Skill manifest tree hash is invalid.' }
  return [pscustomobject]@{ Version = $version; AssetSha256 = $assetHash; AssetSize = $assetSize; HasProvenance = $hasProvenance; Raw = $manifest; Files = $records; FileSet = $seen; ManifestPath = $path }
}

function Write-ManagerManifest {
  param([object]$Manifest, [string]$AssetHash, [Int64]$AssetSize)
  $value = [ordered]@{}
  foreach ($key in $Manifest.Raw.Keys) { $value.Add([string]$key, $Manifest.Raw[$key]) }
  if ($value.Contains('assetSha256')) { $value['assetSha256'] = $AssetHash.ToLowerInvariant() } else { $value.Add('assetSha256', $AssetHash.ToLowerInvariant()) }
  if ($value.Contains('assetSize')) { $value['assetSize'] = $AssetSize } else { $value.Add('assetSize', $AssetSize) }
  $text = (ConvertTo-CanonicalJsonValue $value) + "`n"
  $stream = $null
  try {
    $stream = [IO.File]::Open($Manifest.ManifestPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } catch { Fail-Security 'The Skill manifest could not be published.' }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Copy-ZipEntry {
  param([object]$Entry, [string]$Root, [Int64]$ExpectedLength)
  $relative = Assert-SafeRelativePath $Entry.FullName.TrimEnd('/')
  $destination = [IO.Path]::GetFullPath((Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
  $rootFull = (Get-FullPathSafe $Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if (-not $destination.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Fail-Security 'The Skill archive path escapes staging.' }
  $parent = Split-Path -Parent $destination
  Ensure-SafeDirectory $parent | Out-Null
  if (Test-Exists $destination) { Fail-Security 'The Skill archive contains duplicate paths.' }
  $input = $null; $output = $null
  try {
    $input = $Entry.Open()
    $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    [Int64]$total = 0
    while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $read
      if ($total -gt $ExpectedLength -or $total -gt $MaxSkillFileBytes) { Fail-Security 'The Skill archive file is too large.' }
      $output.Write($buffer, 0, $read)
    }
    if ($total -ne $ExpectedLength) { Fail-Security 'The Skill archive file length is invalid.' }
    $output.Flush($true)
  } catch {
    Remove-SafeTree $destination
    if ($_.Exception -is [InvalidOperationException]) { throw }
    Fail-Security 'The Skill archive could not be extracted.'
  } finally {
    if ($null -ne $output) { $output.Dispose() }
    if ($null -ne $input) { $input.Dispose() }
  }
}

function Validate-SkillTree {
  param([string]$Root, [object]$Manifest)
  Assert-NoReparseTree $Root
  $actualFiles = New-Object 'System.Collections.Generic.List[string]'
  $actualDirectories = New-Object 'System.Collections.Generic.List[string]'
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push((Get-ItemSafe $Root))
  while ($stack.Count -gt 0) {
    $directory = $stack.Pop()
    foreach ($entry in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
      Assert-NotReparse $entry
      $relative = Get-RelativePathSafe $Root $entry.FullName
      Assert-SafeRelativePath $relative | Out-Null
      if ($entry.PSIsContainer) {
        [void]$actualDirectories.Add($relative)
        $stack.Push($entry)
      } else {
        [void]$actualFiles.Add($relative)
      }
    }
  }
  $expectedFiles = New-Object System.Collections.Generic.List[string]
  foreach ($record in $Manifest.Files) { [void]$expectedFiles.Add($record.path) }
  [void]$expectedFiles.Add('.harness-skill-manifest.json')
  $actualSorted = @($actualFiles); [Array]::Sort($actualSorted, [StringComparer]::Ordinal)
  $expectedSorted = @($expectedFiles); [Array]::Sort($expectedSorted, [StringComparer]::Ordinal)
  if (($actualSorted -join '|') -cne ($expectedSorted -join '|')) { Fail-Security 'The extracted Skill tree is not exact.' }
  $expectedDirectories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($filePath in $expectedSorted) {
    $parts = $filePath -split '/'
    for ($index = 1; $index -lt $parts.Count; $index++) { [void]$expectedDirectories.Add(($parts[0..($index - 1)] -join '/')) }
  }
  foreach ($directory in $actualDirectories) { if (-not $expectedDirectories.Contains($directory)) { Fail-Security 'The extracted Skill tree contains an unexpected directory.' } }
  foreach ($record in $Manifest.Files) {
    $path = Join-Path $Root ($record.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
    $item = Get-ItemSafe $path; Assert-NotReparse $item
    if ($item.PSIsContainer -or $item.Length -ne $record.size -or (Get-Sha256File $path) -cne $record.sha256) { Fail-Security 'The extracted Skill file does not match its manifest.' }
  }
  $skillPath = Join-Path $Root 'SKILL.md'
  try {
    $skillBytes = [IO.File]::ReadAllBytes($skillPath)
    $skillText = (New-Object Text.UTF8Encoding($false, $true)).GetString($skillBytes)
  } catch { Fail-Security 'SKILL.md is not valid UTF-8.' }
  if ([string]::IsNullOrWhiteSpace($skillText) -or $skillText.Contains([char]0)) { Fail-Security 'SKILL.md is invalid.' }
}

if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
  Fail-Security 'Version must be an exact semantic version.'
}
$base = $null
try { $base = [Uri]$ReleaseBaseUrl } catch { Fail-Security 'ReleaseBaseUrl must be an HTTPS URL.' }
if ($base.Scheme -ne 'https' -or [string]::IsNullOrEmpty($base.Host) -or $base.UserInfo -ne '' -or $base.Query -ne '' -or $base.Fragment -ne '') {
  Fail-Security 'ReleaseBaseUrl must be an HTTPS URL without user information.'
}
$destinationFull = Get-FullPathSafe $Destination
$parent = Ensure-SafeDirectory (Split-Path -Parent $destinationFull)
$destinationName = Split-Path -Leaf $destinationFull
if ([string]::IsNullOrWhiteSpace($destinationName) -or $destinationName -match '[\\/:*?"<>|]') { Fail-Security 'Destination is invalid.' }
$shaExpected = $Sha256.ToLowerInvariant()
$asset = "harness-mr-skill-$Version.zip"
try { $uri = [Uri]::new($base, ($base.AbsoluteUri.TrimEnd('/') + '/' + $asset)) } catch { Fail-Security 'Release URL is invalid.' }

$suffix = [Guid]::NewGuid().ToString('N')
$archivePath = Join-Path $parent ('.harness-mr-bootstrap-' + $suffix + '.zip')
$stagingPath = Join-Path $parent ('.harness-mr-skill-staging-' + $suffix)
$backupPath = Join-Path $parent ('.harness-mr-skill-old-' + $suffix)
$lockPath = Join-Path $parent '.harness-mr-skill-bootstrap.lock'
$lock = $null
$published = $false
$oldMoved = $false
try {
  try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { Fail-Security 'Another Skill bootstrap is already running.' }
  Ensure-SafeDirectory $parent | Out-Null
  if (Test-Exists $destinationFull) {
    $destinationItem = Get-ItemSafe $destinationFull
    Assert-NotReparse $destinationItem
    if (-not $destinationItem.PSIsContainer) { Fail-Security 'Destination is not a directory.' }
    Assert-NoReparseTree $destinationFull
  }
  try { Invoke-WebRequest -Uri $uri -Method Get -MaximumRedirection 0 -TimeoutSec 60 -OutFile $archivePath | Out-Null } catch { Fail-Security 'The Skill release could not be downloaded.' }
  $archiveItem = Get-ItemSafe $archivePath
  Assert-NotReparse $archiveItem
  if ($archiveItem.PSIsContainer -or $archiveItem.Length -lt 1 -or $archiveItem.Length -gt $MaxArchiveBytes) { Fail-Security 'The Skill release archive is too large.' }
  if ((Get-Sha256File $archivePath) -cne $shaExpected) { Fail-Security 'Downloaded Skill hash does not match the signed release.' }
  Ensure-SafeDirectory $stagingPath | Out-Null
  Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
  Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
  $archive = $null
  try {
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt $MaxArchiveEntries) { Fail-Security 'The Skill archive has an invalid entry count.' }
    $entries = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $directories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [Int64]$expandedBytes = 0
    foreach ($entry in $archive.Entries) {
      $unixMode = (([Int64]$entry.ExternalAttributes -shr 16) -band 0xF000)
      if ($unixMode -eq 0xA000) { Fail-Security 'The Skill archive contains a symbolic link.' }
      $isDirectory = $entry.FullName.EndsWith('/')
      $rawPath = $entry.FullName.TrimEnd('/')
      if ([string]::IsNullOrEmpty($rawPath)) { Fail-Security 'The Skill archive contains an invalid path.' }
      $relative = Assert-SafeRelativePath $rawPath
      if ($isDirectory) {
        if (-not $directories.Add($relative) -or $entries.Contains($relative)) { Fail-Security 'The Skill archive contains duplicate paths.' }
        Ensure-SafeDirectory (Join-Path $stagingPath ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))) | Out-Null
        continue
      }
      if (-not $entries.Add($relative) -or $directories.Contains($relative)) { Fail-Security 'The Skill archive contains duplicate paths.' }
      if ($entry.Length -lt 1 -or $entry.Length -gt $MaxSkillFileBytes) { Fail-Security 'The Skill archive file is too large.' }
      $expandedBytes += [Int64]$entry.Length
      if ($expandedBytes -gt $MaxSkillBytes) { Fail-Security 'The extracted Skill is too large.' }
      Copy-ZipEntry $entry $stagingPath ([Int64]$entry.Length)
    }
  } finally {
    if ($null -ne $archive) { $archive.Dispose() }
  }
  $manifest = Read-SkillManifest $stagingPath $Version
  Write-ManagerManifest $manifest $shaExpected ([Int64]$archiveItem.Length)
  $manifest = Read-SkillManifest $stagingPath $Version $shaExpected ([Int64]$archiveItem.Length)
  Validate-SkillTree $stagingPath $manifest
  if (Test-Exists $destinationFull) {
    [IO.Directory]::Move($destinationFull, $backupPath)
    $oldMoved = $true
  }
  [IO.Directory]::Move($stagingPath, $destinationFull)
  $published = $true
  Validate-SkillTree $destinationFull $manifest
  if ($oldMoved) { Remove-SafeTree $backupPath; $oldMoved = $false }
} catch {
  if ($published -and (Test-Exists $destinationFull)) { Remove-SafeTree $destinationFull }
  if ($oldMoved -and (Test-Exists $backupPath) -and -not (Test-Exists $destinationFull)) {
    try { [IO.Directory]::Move($backupPath, $destinationFull) } catch { }
  }
  throw
} finally {
  if ($null -ne $lock) { $lock.Dispose() }
  Remove-SafeTree $archivePath
  if (-not $published) { Remove-SafeTree $stagingPath }
  if ($oldMoved) { Remove-SafeTree $backupPath }
}
