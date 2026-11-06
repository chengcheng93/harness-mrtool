import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { isToolError } from "../../src/contracts/errors.ts";
import { resolveWindowsIcaclsPath, resolveWindowsPowerShellPath, systemWindowsAclVerifier } from "../../src/platform/state-path.ts";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
async function directory(t: test.TestContext): Promise<string> {
  const base = resolve(tmpdir());
  const path = await mkdtemp(resolve(base, "harness-mrtool-native-acl-"));
  t.after(async () => {
    assert.ok(resolve(path).startsWith(base + sep));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

test("Windows ACL commands share the canonical trusted system directory", () => {
  assert.equal(resolveWindowsIcaclsPath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\icacls.exe");
  for (const systemRoot of ["Windows", ".\\Windows", "C:\\Windows\\..\\attacker", "\\\\server\\share\\Windows", "\\\\?\\C:\\Windows", "C:\\Windows\\"]) {
    for (const resolver of [resolveWindowsIcaclsPath, resolveWindowsPowerShellPath]) {
      assert.throws(() => resolver({ SystemRoot: systemRoot }), (error: unknown) => isToolError(error, "INTERNAL_ERROR", /SystemRoot|state path/i));
    }
  }
});

test("native Windows ACL verification works without inherited PATHEXT", { skip: process.platform !== "win32" }, async (t) => {
  const path = await directory(t);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATHEXT"));
  const moduleUrl = pathToFileURL(resolve(root, "src/platform/state-path.ts")).href;
  const code = 'const { ensurePrivateStateDirectory } = await import(' + JSON.stringify(moduleUrl) + '); await ensurePrivateStateDirectory(process.argv[1]); await ensurePrivateStateDirectory(process.argv[1]); console.log("verified");';
  const result = await execFileAsync(process.execPath, ["--import", pathToFileURL(resolve(root, "node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "--eval", code, path], { cwd: root, env: environment, windowsHide: true, timeout: 20_000 });
  assert.equal(result.stdout.trim(), "verified");
});

test("native Windows ACL verification ignores an inherited incompatible PowerShell module path", { skip: process.platform !== "win32" }, async (t) => {
  const path = await directory(t);
  const moduleRoot = resolve(path, "incompatible-modules");
  const securityModule = resolve(moduleRoot, "Microsoft.PowerShell.Security");
  await mkdir(securityModule, { recursive: true });
  await writeFile(resolve(securityModule, "Microsoft.PowerShell.Security.psd1"), `@{
RootModule = 'Security.psm1'
ModuleVersion = '7.0.0'
GUID = '34937293-9ee6-40ab-af06-786218a45dc0'
PowerShellVersion = '7.0'
FunctionsToExport = @('Get-Acl')
CmdletsToExport = @()
AliasesToExport = @()
VariablesToExport = @()
}
`);
  await writeFile(resolve(securityModule, "Security.psm1"), "function Get-Acl { throw 'Incompatible inherited module must not load' }\n");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  environment.PsMoDuLePaTh = moduleRoot;
  const moduleUrl = pathToFileURL(resolve(root, "src/platform/state-path.ts")).href;
  const code = 'const { ensurePrivateStateDirectory } = await import(' + JSON.stringify(moduleUrl) + '); await ensurePrivateStateDirectory(process.argv[1]); console.log("verified");';
  const result = await execFileAsync(process.execPath, ["--import", pathToFileURL(resolve(root, "node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "--eval", code, resolve(path, "state")], { cwd: root, env: environment, windowsHide: true, timeout: 20_000 });
  assert.equal(result.stdout.trim(), "verified");
});

test("native Windows ACL verification still rejects an explicit Everyone allow", { skip: process.platform !== "win32" }, async (t) => {
  const path = await directory(t);
  await systemWindowsAclVerifier.verify(path);
  await execFileAsync(resolveWindowsIcaclsPath(), [path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true, timeout: 5_000 });
  await assert.rejects(systemWindowsAclVerifier.verify(path), (error: unknown) => isToolError(error, "INTERNAL_ERROR", /rules stage/i));
});
