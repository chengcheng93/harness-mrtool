# Windows PowerShell 5.1 / native executable only. The CLI owns Request validation.
# For stdin from a native host, use -Command "& '.../run-flow.ps1' ... -RequestPath '-'";
# PS5.1 powershell.exe -File misbinds a bare dash before this script executes.
# Hard termination of this host cannot guarantee cleanup or final JSON. Never retry
# create when it started without a complete CLI result: the remote outcome is unknown.
[CmdletBinding()]
param(
    [string] $Phase,
    [string] $Repository,
    [string] $ClientVersion,
    [string] $SkillProtocol,
    [string] $Executable,
    [string] $RequestPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$steps = New-Object System.Collections.ArrayList
$cliJson = $null
$runnerError = $null
$outcome = 'not-started'
$exitCode = 1
$activeProcess = $null
$stepClock = $null
$stepRecorded = $true
$command = $null
$failureCode = 'INVALID_ARGUMENT'
$inputStream = $null
$ownsInput = $false

# All command-line values are fixed flags or validated version/protocol values.
# Repository and executable use ProcessStartInfo properties, never shell text.
function Invoke-CliStep([string] $Name, [string[]] $Arguments) {
    $script:command = $Name
    $script:cliJson = $null
    $script:stepClock = [System.Diagnostics.Stopwatch]::StartNew()
    $script:stepRecorded = $false
    $script:failureCode = 'PROCESS_START_FAILED'
    [Console]::Error.WriteLine(('run-flow: starting {0}' -f $Name))
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:Executable
    $info.WorkingDirectory = $script:Repository
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
    $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false, $false)
    $info.Arguments = $Arguments -join ' '
    $script:activeProcess = New-Object System.Diagnostics.Process
    $script:activeProcess.StartInfo = $info
    [void] $script:activeProcess.Start()
    $script:outcome = 'unknown'
    $script:failureCode = 'PROCESS_FAILED'
    # Drain both pipes before copying input or waiting; discard raw stderr so it
    # cannot disclose credentials and cannot accumulate unbounded progress text.
    $stdout = $script:activeProcess.StandardOutput.ReadToEndAsync()
    $stderr = $script:activeProcess.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
    if ($Name -eq 'create') {
        $copy = $script:inputStream.CopyToAsync($script:activeProcess.StandardInput.BaseStream)
        while (-not $copy.IsCompleted) { Start-Sleep -Milliseconds 100 }
        try { [void] $copy.GetAwaiter().GetResult() } catch [System.IO.IOException] {
            # The CLI may reject input and close its pipe early. Still drain and
            # inspect its authoritative envelope before deciding the outcome.
        }
    }
    $script:activeProcess.StandardInput.Close()
    # A short wait permits PowerShell pipeline cancellation. It is not a timeout:
    # keep waiting on this exact process, including when it exceeds thirty seconds.
    while (-not $script:activeProcess.WaitForExit(100)) { }
    $code = $script:activeProcess.ExitCode
    $raw = $stdout.GetAwaiter().GetResult()
    [void] $stderr.GetAwaiter().GetResult()
    $script:stepClock.Stop()
    [void] $script:steps.Add([ordered]@{ command = $Name; exitCode = $code; elapsedMs = $script:stepClock.ElapsedMilliseconds })
    $script:stepRecorded = $true
    $script:activeProcess.Dispose()
    $script:activeProcess = $null
    $script:failureCode = 'INVALID_CLI_RESULT'
    $envelope = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
    # Framing only: this wrapper does not duplicate the CLI's output or Request schema.
    if ($null -eq $envelope -or $envelope -is [array] -or
        $envelope.schemaVersion -ne 1 -or $envelope.ok -isnot [bool] -or
        $envelope.code -isnot [string] -or $envelope.message -isnot [string] -or
        $null -eq $envelope.PSObject.Properties['data'] -or
        $null -eq $envelope.PSObject.Properties['error'] -or
        $null -eq $envelope.PSObject.Properties['remoteWrite']) {
        throw 'Invalid CLI envelope.'
    }
    # Embed the original valid JSON instead of reserializing its numbers/nesting.
    $script:cliJson = $raw.Trim()
    $script:outcome = 'cli-result'
    if ($code -ne 0 -or -not $envelope.ok) {
        $script:failureCode = 'CLI_FAILED'
        throw 'CLI step failed.'
    }
    [Console]::Error.WriteLine(('run-flow: completed {0}' -f $Name))
}

try {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
        ($Phase -ne 'context' -and $Phase -ne 'create') -or
        [string]::IsNullOrWhiteSpace($Repository) -or -not [System.IO.Path]::IsPathRooted($Repository) -or
        -not [System.IO.Directory]::Exists($Repository) -or
        $ClientVersion -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' -or
        $SkillProtocol -cnotmatch '^[1-9][0-9]*$') {
        throw 'Invalid runner arguments.'
    }
    if ([string]::IsNullOrWhiteSpace($Executable)) {
        $failureCode = 'PROCESS_START_FAILED'
        $Executable = (Get-Command harness-mrtool.exe -CommandType Application -ErrorAction Stop).Source
    }
    if (-not [System.IO.Path]::IsPathRooted($Executable) -or [System.IO.Path]::GetExtension($Executable) -ine '.exe') {
        $failureCode = 'INVALID_ARGUMENT'
        throw 'A native executable absolute path is required.'
    }
    $identity = @('--auth', 'api', '--client', 'codex-skill', '--client-version', $ClientVersion, '--skill-protocol', $SkillProtocol)
    if ($Phase -eq 'context') {
        Invoke-CliStep 'schema show' @('schema', 'show', '--output', 'json')
        Invoke-CliStep 'profiles list' @('profiles', 'list', '--output', 'json')
        Invoke-CliStep 'context' (@('context') + $identity + @('--output', 'json'))
    } else {
        $failureCode = 'REQUEST_READ_FAILED'
        if ($RequestPath -eq '-') {
            $inputStream = [Console]::OpenStandardInput()
        } elseif (-not [string]::IsNullOrWhiteSpace($RequestPath) -and [System.IO.Path]::IsPathRooted($RequestPath)) {
            $inputStream = [System.IO.File]::OpenRead($RequestPath)
            $ownsInput = $true
        } else {
            throw 'An absolute Request path or stdin is required.'
        }
        Invoke-CliStep 'create' (@('create') + $identity + @('--input', '-', '--input-format', 'json', '--output', 'json'))
    }
    $exitCode = 0
} catch {
    # Exception messages and child stderr may include paths, secrets or Request text.
    # Only fixed codes/messages belong in runner diagnostics.
    $runnerError = [ordered]@{ code = $failureCode; message = 'Runner stopped; inspect cliResult when available. Do not retry an unknown create outcome.' }
} finally {
    if ($null -ne $activeProcess) {
        try {
            if (-not $activeProcess.HasExited) { $activeProcess.Kill(); $activeProcess.WaitForExit() }
        } catch { }
        if (-not $stepRecorded) {
            $nativeCode = $null
            try { if ($activeProcess.HasExited) { $nativeCode = $activeProcess.ExitCode } } catch { }
            $stepClock.Stop()
            [void] $steps.Add([ordered]@{ command = $command; exitCode = $nativeCode; elapsedMs = $stepClock.ElapsedMilliseconds })
        }
        $activeProcess.Dispose()
    }
    if ($ownsInput -and $null -ne $inputStream) { $inputStream.Dispose() }
    if ($exitCode -ne 0 -and $null -eq $runnerError) {
        $runnerError = [ordered]@{ code = 'CANCELLED'; message = 'Runner cancelled. Do not retry an unknown create outcome.' }
    }
    $clock.Stop()
    $wrapper = [ordered]@{ runnerSchemaVersion = 1; phase = $Phase; elapsedMs = $clock.ElapsedMilliseconds; steps = @($steps); outcome = $outcome; error = $runnerError }
    $json = ConvertTo-Json -InputObject $wrapper -Depth 8 -Compress
    if ($null -eq $cliJson) { $cliJson = 'null' }
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::Out.WriteLine($json.Substring(0, $json.Length - 1) + ',"cliResult":' + $cliJson + '}')
}
exit $exitCode
