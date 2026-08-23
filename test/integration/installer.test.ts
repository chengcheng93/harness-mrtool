import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// @ts-expect-error The packaging helper intentionally has no declaration file.
import { packagePortableRelease, validateReleaseArchive } from "../../scripts/package-portable.mjs";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const scripts = resolve(repositoryRoot, "scripts");

test("PowerShell installer entrypoints parse without executing", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell syntax gate runs on Windows");
    return;
  }
  for (const name of ["install.ps1", "uninstall.ps1", "repair.ps1"]) {
    const path = join(scripts, name);
    const escaped = path.replaceAll("'", "''");
    const command = `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$errors); if ($errors.Count -ne 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`;
    await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      timeout: 20_000,
      windowsHide: true,
    });
  }
});

test("installers pin the repository and enforce bounded verified extraction", async () => {
  const windows = await readFile(join(scripts, "install.ps1"), "utf8");
  const portable = await readFile(join(scripts, "install.sh"), "utf8");
  for (const source of [windows, portable]) {
    assert.match(source, /chengcheng93\/harness-mrtool/u);
    assert.match(source, /SHA-?256|sha256/u);
    assert.match(source, /self-test/u);
    assert.match(source, /CON\|PRN\|AUX\|NUL|reserved/u);
    assert.match(source, /256\s*\*\s*1024\s*\*\s*1024|268435456|256MB/u);
  }
  assert.doesNotMatch(windows, /Expand-Archive|Invoke-Expression/u);
  assert.doesNotMatch(portable, /\beval\b|curl[^\n]*\|[^\n]*(?:sh|bash)/u);
  assert.doesNotMatch(portable, /\$\{[^}]*,,/u, "POSIX installer must not require Bash 4 case conversion");
});

test("POSIX installer creates a missing parent before canonicalizing the destination", async () => {
  const portable = await readFile(join(scripts, "install.sh"), "utf8");
  const createParent = portable.indexOf('mkdir -p "$parent"');
  const canonicalizeDestination = portable.indexOf("destination=$(cd");
  assert.notEqual(createParent, -1, "installer must create its parent directory");
  assert.notEqual(
    canonicalizeDestination,
    -1,
    "installer must canonicalize the destination",
  );
  assert.ok(
    createParent < canonicalizeDestination,
    "a first install cannot cd into a parent that has not been created",
  );
});

test("POSIX installer bounds archive expansion before extraction", async () => {
  const portable = await readFile(join(scripts, "install.sh"), "utf8");
  assert.match(portable, /MAX_ENTRY_BYTES[\s\S]*MAX_ENTRY_BYTES/u);
  assert.match(portable, /MAX_EXPANDED_BYTES/u);
  assert.doesNotMatch(portable, /declare\s+-A/u);
  assert.match(portable, /url_effective|allowed host|trusted host/u);
  assert.match(portable, /unzip[^\n]*(?:-l|-v|-Z)/u);
  const extraction = portable.indexOf('unzip -p "$archive"');
  const sizeInspection = Math.max(
    portable.indexOf("MAX_ENTRY_BYTES", portable.indexOf("MAX_ENTRY_BYTES") + 1),
    portable.indexOf("MAX_EXPANDED_BYTES"),
  );
  assert.ok(extraction >= 0, "POSIX installer must extract only named entries");
  assert.ok(sizeInspection < extraction, "archive sizes must be checked before extraction");
  assert.doesNotMatch(portable, /unzip\s+-q\s+-o\s+"\$archive"/u);
});

test("uninstall and repair require the manager-owned installation marker", async () => {
  const uninstall = await readFile(join(scripts, "uninstall.ps1"), "utf8");
  const repair = await readFile(join(scripts, "repair.ps1"), "utf8");
  for (const source of [uninstall, repair]) {
    assert.match(source, /\.harness-mrtool-install\.json/u);
    assert.match(source, /chengcheng93\/harness-mrtool/u);
    assert.doesNotMatch(source, /Remove-Item\s+[^\n]*-Recurse\s+[^\n]*\$env:(?:USERPROFILE|LOCALAPPDATA)/iu);
  }
  assert.match(uninstall, /Assert-PlainTree[\s\S]*ReparsePoint/u);
  assert.match(uninstall, /Assert-PlainTree \$root[\s\S]*if \(-not \$WhatIf\) \{ Remove-PlainTree \$root \}/u);
  assert.doesNotMatch(uninstall, /Remove-Item\s+-LiteralPath\s+\$root\s+-Recurse/u);
  assert.match(repair, /self-update\s+status/u);
});

test("Windows installer rechecks the archive while holding a no-write handle", async () => {
  const windows = await readFile(join(scripts, "install.ps1"), "utf8");
  const initialHash = windows.indexOf("Get-FileHashHex $archivePath");
  const verifiedOpen = windows.indexOf("Open-VerifiedArchive $archivePath");
  const zipOpen = windows.indexOf("[IO.Compression.ZipArchive]::new");
  assert.ok(initialHash >= 0 && verifiedOpen > initialHash && zipOpen > verifiedOpen);
  assert.match(windows, /FileShare\]::None/u);
  assert.doesNotMatch(windows, /ZipFile::OpenRead/u);
});

test("installers count bytes emitted by each archive entry", async () => {
  const windows = await readFile(join(scripts, "install.ps1"), "utf8");
  const portable = await readFile(join(scripts, "install.sh"), "utf8");
  assert.match(windows, /written[\s\S]*entry\.Length|bytesWritten[\s\S]*entry\.Length/u);
  assert.match(portable, /extracted_bytes|actual_entry_bytes/u);
});

test("release archive validation rejects tampering and packaging refuses overwrite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-installer-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "harness-mrtool.exe");
  const receipt = join(directory, "bundle-receipt.envelope.json");
  const notices = join(directory, "THIRD_PARTY_NOTICES.md");
  const license = join(directory, "Node.txt");
  const output = join(directory, "release.zip");
  const receiptPayload = Buffer.from("{\"receiptVersion\":1}\n", "utf8").toString("base64url");
  const receiptSignature = Buffer.alloc(64).toString("base64url");
  const receiptBytes = `{"payload":"${receiptPayload}","signatures":[{"algorithm":"Ed25519","keyId":"release-key-1","signature":"${receiptSignature}"}]}\n`;
  await Promise.all([
    writeFile(executable, "exe\n"),
    writeFile(receipt, receiptBytes),
    writeFile(notices, "notices\n"),
    writeFile(license, "license\n"),
  ]);
  const options = {
    executablePath: executable,
    receiptPath: receipt,
    noticesPath: notices,
    nodeLicensePath: license,
    outputPath: output,
  };
  await packagePortableRelease(options);
  await assert.rejects(packagePortableRelease(options), /refusing to overwrite/u);
  const entries = {
    SHA256SUMS: new Uint8Array(),
    "THIRD_PARTY_NOTICES.md": new Uint8Array(),
    "bundle-receipt.envelope.json": new Uint8Array(),
    "harness-mrtool.exe": new Uint8Array(),
    "licenses/Node.txt": new Uint8Array(),
    "../escape": new Uint8Array(),
  };
  assert.throws(() => validateReleaseArchive(entries), /archive tree|unsafe path/u);
});
