import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { zipSync } from "fflate";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Windows PowerShell 5.1 opens a verified archive using the installer's real ZIP reader", async (t) => {
  if (process.platform !== "win32") {
    t.skip("The .NET Framework ZIP runtime gate runs on Windows PowerShell 5.1");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "harness-installer-zip-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = join(directory, "runtime.zip");
  const probePath = join(directory, "probe.ps1");
  const archiveBytes = zipSync({ "probe.txt": Buffer.from("verified bytes") });
  await writeFile(archivePath, archiveBytes);
  await writeFile(probePath, String.raw`param([string]$InstallerPath, [string]$ArchivePath, [string]$ExpectedHash)
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$null, [ref]$null)
foreach ($name in @('Fail-Safe', 'Get-SafeItem', 'Assert-PlainItem', 'Open-VerifiedArchive', 'New-ZipArchiveReader')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if ($null -eq $definition) { throw "Installer helper is missing: $name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}
$stream = Open-VerifiedArchive $ArchivePath $ExpectedHash
$archive = $null
try {
  $archive = New-ZipArchiveReader $stream
  $reader = [IO.StreamReader]::new($archive.GetEntry('probe.txt').Open())
  try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
  $archive.Dispose(); $archive = $null
  [ordered]@{version=$PSVersionTable.PSVersion.ToString(); content=$content; streamRemainsOpen=$stream.CanRead} | ConvertTo-Json -Compress
} finally {
  if ($null -ne $archive) { $archive.Dispose() }
  $stream.Dispose()
}
`);
  const { stdout } = await run("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probePath,
    "-InstallerPath", join(repositoryRoot, "scripts/install.ps1"), "-ArchivePath", archivePath,
    "-ExpectedHash", createHash("sha256").update(archiveBytes).digest("hex"),
  ], { timeout: 20_000, windowsHide: true });
  const result = JSON.parse(stdout.trim());
  assert.match(result.version, /^5\.1\./u);
  assert.equal(result.content, "verified bytes");
  assert.equal(result.streamRemainsOpen, true, "the verified handle must remain open until extraction finishes");
  assert.equal(
    await readFile(join(repositoryRoot, "plugins/harness-mrtool/scripts/install-cli.ps1"), "utf8"),
    await readFile(join(repositoryRoot, "scripts/install.ps1"), "utf8"),
    "the shipped plugin installer must use the same reader",
  );
});
