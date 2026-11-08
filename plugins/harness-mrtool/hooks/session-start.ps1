[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$context = 'Harness MR GitLab initialization has not completed. Before reporting this plugin ready or preparing any MR, run the bundled scripts/setup-gitlab.ps1 with the matching CLI in an interactive terminal. Enter the token only at its hidden prompt. Do not submit an MR as part of setup.'
try {
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 65536) { throw 'Hook input is too large.' }
  $inputValue = $inputText | ConvertFrom-Json
  if ($inputValue.hook_event_name -ne 'SessionStart') { throw 'Unexpected hook event.' }
  $pluginRoot = Split-Path -Parent $PSScriptRoot
  $setup = Join-Path $pluginRoot 'scripts/setup-gitlab.ps1'
  $executable = $env:HARNESS_MRTOOL_EXECUTABLE
  if ([string]::IsNullOrWhiteSpace($executable) -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $executable = Join-Path $env:LOCALAPPDATA 'HarnessMrTool/harness-mrtool.exe' }
  if ([string]::IsNullOrWhiteSpace($executable) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    $available = Get-Command 'harness-mrtool.exe' -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $available) { $executable = $available.Source }
  }
  if (-not [string]::IsNullOrWhiteSpace($executable) -and (Test-Path -LiteralPath $executable -PathType Leaf)) {
    # A separate process contains setup's exit statement and keeps the hook read-only.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $setup.Replace('"', '') + '" -Executable "' + $executable.Replace('"', '') + '" -NonInteractive -CheckOnly'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $start
    try {
      if ($child.Start()) {
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if ($child.WaitForExit(35000)) {
          $safeOutput = $stdout.GetAwaiter().GetResult()
          [void]$stderr.GetAwaiter().GetResult()
          if ($safeOutput.Length -lt 65536) {
            $result = $safeOutput | ConvertFrom-Json
            if ($child.ExitCode -eq 0 -and $result.ok -eq $true -and $result.state -eq 'authorized') {
              if ($result.processRefreshRequired) {
                $context = 'Harness MR saved GitLab API credentials passed verification, but this Codex process has missing or stale environment credentials. Restart Codex before reporting the plugin ready or preparing an MR. This hook did not write credentials or an MR.'
              } else {
              $context = 'Harness MR read-only GitLab API initialization check passed for the configured host. This does not authorize creating an MR. Continue to follow the user request and recheck target-project access when using the CLI.'
              }
            } elseif ($result.code -eq 'GITLAB_ERROR') {
              $context = 'Harness MR initialization could not verify GitLab API connectivity. Do not report the plugin ready. Check the GitLab address/network and run harness-mrtool auth check --output json, then complete setup. No MR or credential write was attempted by this hook.'
            } elseif ($result.state -eq 'authorization-unverified') {
              $context = 'Harness MR GitLab API authorization check failed. Before preparing an MR, run the bundled scripts/setup-gitlab.ps1 -Reconfigure in an interactive terminal and enter an api-scope token only at the hidden prompt. No MR or credential write was attempted by this hook.'
            }
          }
        } else { try { $child.Kill() } catch { } }
      }
    } finally { $child.Dispose() }
  }
} catch {
  # Hook input, child output, exceptions and credentials are never reflected into model context.
}
[ordered]@{ hookSpecificOutput = [ordered]@{ hookEventName = 'SessionStart'; additionalContext = $context } } | ConvertTo-Json -Depth 4 -Compress | Write-Output
exit 0
