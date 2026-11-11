param([string] $Runner, [string] $Executable, [string] $Repository, [string] $Request, [string] $Log)
$ErrorActionPreference = 'Stop'
$env:RUN_FLOW_FAKE_MODE = 'block'
$env:RUN_FLOW_FAKE_COMMAND = 'create'
$env:RUN_FLOW_FAKE_LOG = $Log
$shell = [PowerShell]::Create()
try {
    [void] $shell.AddCommand($Runner).AddParameter('Phase', 'create').AddParameter('Repository', $Repository).AddParameter('ClientVersion', '0.1.11').AddParameter('SkillProtocol', '1').AddParameter('Executable', $Executable).AddParameter('RequestPath', $Request)
    $running = $shell.BeginInvoke()
    $ready = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists($Log) -and $ready.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 50 }
    if (-not [IO.File]::Exists($Log)) { throw 'Native child did not start.' }
    $nativeId = ((Get-Content -LiteralPath $Log | Select-Object -First 1) | ConvertFrom-Json).pid
    $shell.Stop()
    try { $shell.EndInvoke($running) } catch { }
    $remaining = Get-Process -Id $nativeId -ErrorAction SilentlyContinue
    if ($null -ne $remaining) { $remaining.Kill(); throw 'Cancelled runner left its native child alive.' }
} finally { $shell.Dispose() }
