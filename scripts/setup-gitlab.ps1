[CmdletBinding()]
param(
  [string]$Executable = $(if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { '' } else { Join-Path $env:LOCALAPPDATA 'HarnessMrTool/harness-mrtool.exe' }),
  [string]$GitLabHost,
  [switch]$NonInteractive,
  [switch]$CheckOnly,
  [switch]$Reconfigure,
  [switch]$InstalledCli
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$HostVariable = 'HARNESS_MRTOOL_GITLAB_HOST'
$TokenVariable = 'HARNESS_MRTOOL_GITLAB_TOKEN'
$SetupNextStep = 'Run setup-gitlab.ps1 -Executable <installed-cli> -GitLabHost http(s)://your-gitlab in an interactive terminal. Enter a personal access token with api scope at the hidden prompt. Then run harness-mrtool auth check --output json. Never put a token in arguments, files, or chat.'

if ($InstalledCli) { $SetupNextStep = 'Rerun this installer with -SetupOnly -Destination <installed-directory> -GitLabHost http(s)://your-gitlab. Add -Reconfigure to replace a token at the hidden prompt. No release download is needed. Then run harness-mrtool auth check --output json. Never put a token in arguments, files, or chat.' }

function Write-SetupResult {
  param([bool]$Ok, [string]$Code, [string]$State, [string]$Message, [int]$ExitCode)
  if ($InstalledCli -and -not $Ok) { $Message = 'CLI is installed, but GitLab initialization is incomplete. ' + $Message }
  [ordered]@{ ok = $Ok; processRefreshRequired = $(if (Get-Variable processRefreshRequired -ErrorAction SilentlyContinue) { [bool]$processRefreshRequired } else { $false }); code = $Code; command = 'setup.gitlab'; state = $State; message = $Message; safeNextStep = $(if ($Ok) { 'GitLab API authorization verified. Restart existing Codex or terminal processes to inherit saved user environment variables.' } else { $SetupNextStep }) } | ConvertTo-Json -Compress | Write-Output
  exit $ExitCode
}

function Get-Origin {
  param([string]$Value)
  $parsed = $null
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -cne $Value.Trim() -or $Value -match '[\r\n\x00" ]' -or -not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) { return $null }
  if ($parsed.Scheme -notin @('http', 'https') -or $parsed.UserInfo -ne '' -or $parsed.AbsolutePath -ne '/' -or $parsed.Query -ne '' -or $parsed.Fragment -ne '') { return $null }
  return $parsed.GetLeftPart([UriPartial]::Authority)
}

function Get-ScopedCredentials {
  param([string]$RequiredHost)
  foreach ($scope in @('User', 'Process')) {
    $boundHost = [Environment]::GetEnvironmentVariable($HostVariable, $scope)
    $boundToken = [Environment]::GetEnvironmentVariable($TokenVariable, $scope)
    if ([string]::IsNullOrWhiteSpace($boundHost) -or [string]::IsNullOrWhiteSpace($boundToken)) { continue }
    if ($boundHost -cne $boundHost.Trim() -or $boundHost -match '[\r\n\x00/@]' -or $boundToken -cne $boundToken.Trim() -or $boundToken.Length -gt 16384 -or $boundToken -match '[\r\n\x00]') { continue }
    if ($RequiredHost -ne '' -and -not [string]::Equals($boundHost, $RequiredHost, [StringComparison]::OrdinalIgnoreCase)) { continue }
    Write-Output @{ Host = $boundHost; Token = $boundToken }
  }
}

function Read-HiddenToken {
  [Console]::Error.WriteLine('Create a personal access token on the selected GitLab instance with api scope. The token is only saved after the read-only API check succeeds.')
  $secure = Read-Host 'GitLab API token (hidden)' -AsSecureString
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secure.Dispose()
  }
}

function Invoke-AuthorizationCheck {
  param([string]$Path, [string]$Origin, [hashtable]$Credential)
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Path
  $info.Arguments = 'auth check --output json'
  if ($Origin -ne '') { $info.Arguments += ' --host "' + $Origin + '"' }
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  # Run outside a repository: initialization verifies the selected host, not an unrelated checkout.
  $info.WorkingDirectory = [Environment]::GetFolderPath('Windows')
  $info.EnvironmentVariables[$HostVariable] = $Credential.Host
  $info.EnvironmentVariables[$TokenVariable] = $Credential.Token
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { return @{ Ok = $false; Code = 'INITIALIZATION_ERROR' } }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { try { $process.Kill() } catch { }; return @{ Ok = $false; Code = 'GITLAB_ERROR' } }
    $output = $stdout.GetAwaiter().GetResult()
    [void]$stderr.GetAwaiter().GetResult()
    if ($output.Length -gt 65536) { return @{ Ok = $false; Code = 'INITIALIZATION_ERROR' } }
    $result = $output | ConvertFrom-Json
    if ($process.ExitCode -eq 0 -and $result.ok -eq $true -and $result.code -eq 'OK' -and $result.data.command -eq 'auth.check' -and $result.data.authenticated -eq $true -and $result.data.apiScope.status -eq 'verified' -and @($result.data.apiScope.scopes) -contains 'api' -and $result.remoteWrite.state -eq 'not-attempted') { return @{ Ok = $true; Code = 'OK' } }
    $code = 'INITIALIZATION_ERROR'
    if ($result.code -in @('AUTH_ERROR', 'GITLAB_ERROR')) { $code = $result.code }
    return @{ Ok = $false; Code = $code }
  } catch {
    # Do not relay child output or exception text: either may contain sensitive values.
    return @{ Ok = $false; Code = 'INITIALIZATION_ERROR' }
  } finally {
    $info.EnvironmentVariables.Remove($TokenVariable)
    $process.Dispose()
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($Executable) -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    Write-SetupResult $false 'INITIALIZATION_ERROR' 'cli-missing' 'CLI is unavailable. Install or build the matching CLI, then run GitLab setup.' 3
  }
  $origin = ''
  if (-not [string]::IsNullOrWhiteSpace($GitLabHost)) {
    $origin = Get-Origin $GitLabHost
    if ($null -eq $origin) { Write-SetupResult $false 'AUTH_ERROR' 'host-invalid' 'GitLabHost must be an exact http(s) origin without credentials, path, query, or fragment.' 3 }
  }
  $requiredHost = $(if ($origin -ne '') { ([Uri]$origin).Authority } else { '' })
  $credentialCandidates = @(Get-ScopedCredentials $requiredHost)
  if ($origin -eq '' -and @($credentialCandidates | ForEach-Object { $_.Host.ToLowerInvariant() } | Select-Object -Unique).Count -gt 1) {
    Write-SetupResult $false 'AUTH_ERROR' 'host-ambiguous' 'Process and user credentials name different GitLab hosts. Select the intended origin with -GitLabHost; no credential was overwritten.' 3
  }
  $credential = $null
  $interactive = -not $NonInteractive -and -not $CheckOnly -and -not [Console]::IsInputRedirected -and [Environment]::UserInteractive
  if ($Reconfigure) { $credentialCandidates = @() }
  if ($credentialCandidates.Count -eq 0) {
    if (-not $interactive) { Write-SetupResult $false 'AUTH_ERROR' 'credentials-missing' 'GitLab initialization is incomplete: no complete, matching local API credential was found. No prompt or credential write was attempted.' 3 }
    if ($origin -eq '') {
      $origin = Get-Origin (Read-Host 'GitLab origin (http://host or https://host)')
      if ($null -eq $origin) { Write-SetupResult $false 'AUTH_ERROR' 'host-invalid' 'Enter an exact http(s) GitLab origin.' 3 }
    }
    [Console]::Error.WriteLine('Token creation page: ' + $origin + '/-/user_settings/personal_access_tokens')
    $credential = @{ Host = ([Uri]$origin).Authority; Token = Read-HiddenToken }
    if ([string]::IsNullOrWhiteSpace($credential.Token) -or $credential.Token -cne $credential.Token.Trim() -or $credential.Token.Length -gt 16384 -or $credential.Token -match '[\r\n\x00]') {
      Write-SetupResult $false 'AUTH_ERROR' 'token-invalid' 'The token format is invalid. Nothing was saved.' 3
    }
    $credentialCandidates = @($credential)
  }
  $checked = @{ Ok = $false; Code = 'AUTH_ERROR' }
  foreach ($candidate in $credentialCandidates) {
    $checked = Invoke-AuthorizationCheck $Executable $origin $candidate
    if ($checked.Ok) { $credential = $candidate; break }
    if ($checked.Code -ne 'AUTH_ERROR') { break }
  }
  if (-not $checked.Ok) {
    $next = $(if ($checked.Code -eq 'AUTH_ERROR') { 'GitLab API authorization failed. Run setup again with -Reconfigure to replace the token. Nothing was saved.' } else { 'GitLab API check did not complete. Check connectivity and CLI compatibility, then retry. Nothing was saved.' })
    Write-SetupResult $false $checked.Code 'authorization-unverified' $next 3
  }
  $processRefreshRequired = [Environment]::GetEnvironmentVariable($HostVariable, 'Process') -cne $credential.Host -or [Environment]::GetEnvironmentVariable($TokenVariable, 'Process') -cne $credential.Token
  if (-not $CheckOnly) {
    $oldHost = [Environment]::GetEnvironmentVariable($HostVariable, 'User')
    $oldToken = [Environment]::GetEnvironmentVariable($TokenVariable, 'User')
    try {
      [Environment]::SetEnvironmentVariable($HostVariable, $credential.Host, 'User')
      [Environment]::SetEnvironmentVariable($TokenVariable, $credential.Token, 'User')
      if ([Environment]::GetEnvironmentVariable($HostVariable, 'User') -cne $credential.Host -or [Environment]::GetEnvironmentVariable($TokenVariable, 'User') -cne $credential.Token) { throw 'Credential persistence verification failed.' }
    } catch {
      try { [Environment]::SetEnvironmentVariable($HostVariable, $oldHost, 'User'); [Environment]::SetEnvironmentVariable($TokenVariable, $oldToken, 'User') } catch { }
      Write-SetupResult $false 'INITIALIZATION_ERROR' 'credential-save-failed' 'API authorization passed, but the user credential could not be saved. Initialization remains incomplete.' 3
    }
    [Environment]::SetEnvironmentVariable($HostVariable, $credential.Host, 'Process')
    [Environment]::SetEnvironmentVariable($TokenVariable, $credential.Token, 'Process')
  }
  Write-SetupResult $true 'OK' 'authorized' 'GitLab API authorization passed the read-only initialization check. No MR was created or changed.' 0
} catch {
  Write-SetupResult $false 'INITIALIZATION_ERROR' 'initialization-failed' 'GitLab initialization could not complete. No sensitive diagnostic output was emitted.' 3
} finally {
  if (Get-Variable credential -ErrorAction SilentlyContinue) { if ($null -ne $credential) { $credential.Token = $null }; $credential = $null }
}
