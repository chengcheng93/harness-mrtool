import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const powershell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const fixtureToken = "initialization-fixture-sensitive-value";

async function invoke(path: string, args: string[], environment: Record<string, string> = {}, input?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, ...args], {
      env: { ...process.env, ...environment }, windowsHide: true, timeout: 15_000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolveResult({ code: (error?.code as number) ?? 0, stdout, stderr });
    });
    child.stdin?.end(input ?? "");
  });
}

test("GitLab initialization assets stay synchronized and run after binary publication", async () => {
  const setup = await readFile(join(root, "scripts/setup-gitlab.ps1"), "utf8");
  const install = await readFile(join(root, "scripts/install.ps1"), "utf8");
  assert.equal(setup, await readFile(join(root, "plugins/harness-mrtool/scripts/setup-gitlab.ps1"), "utf8"));
  assert.equal(install, await readFile(join(root, "plugins/harness-mrtool/scripts/install-cli.ps1"), "utf8"));
  const embedded = install.split("# BEGIN EMBEDDED GITLAB SETUP\n& {\n")[1]?.split("\n} -Executable")[0];
  assert.equal(embedded, setup, "standalone installer embeds the same safe configuration flow");
  assert.ok(install.indexOf("# BEGIN EMBEDDED GITLAB SETUP") > install.indexOf("} finally { if ($null -ne $lock)"));
  assert.match(install, /\$SetupOnly/u);
  assert.match(setup, /Read-Host 'GitLab API token \(hidden\)' -AsSecureString/u);
  assert.match(setup, /ZeroFreeBSTR/u);
  assert.match(setup, /if \(-not \$CheckOnly\)/u);
  assert.match(setup, /processRefreshRequired/u);
  const portable = await readFile(join(root, "scripts/install.sh"), "utf8");
  assert.ok(portable.indexOf("auth_check_args=(auth check --output json)") > portable.indexOf('mv -n "$tmpdir/tree" "$destination"'));
  assert.match(portable, /CLI is installed, but GitLab initialization is incomplete/u);
});

test("Windows initialization checks credentials without prompts, token disclosure, or MR actions", async (t) => {
  if (process.platform !== "win32") { t.skip("Windows setup uses PowerShell 5.1"); return; }
  const directory = await mkdtemp(join(tmpdir(), "harness-gitlab-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const setupPath = join(directory, "setup-gitlab.ps1");
  const installerPath = join(directory, "install.ps1");
  await writeFile(setupPath, await readFile(join(root, "scripts/setup-gitlab.ps1")));
  await writeFile(installerPath, await readFile(join(root, "scripts/install.ps1")));
  const executable = join(directory, "harness-mrtool.exe");
  const fixture = [
    "using System;",
    "public class Fixture {",
    "public static int Main(string[] args) {",
    'if (args.Length < 4 || args[0] != "auth" || args[1] != "check" || args[2] != "--output" || args[3] != "json") return 12;',
    'string token = Environment.GetEnvironmentVariable("HARNESS_MRTOOL_GITLAB_TOKEN");',
    'foreach (string arg in args) if (arg.Contains("initialization-fixture-sensitive-value")) return 13;',
    'string mode = Environment.GetEnvironmentVariable("HARNESS_MRTOOL_SETUP_FIXTURE");',
    "if (mode == \"accept\" && token == \"initialization-fixture-sensitive-value\") { Console.WriteLine(\"{\\\"ok\\\":true,\\\"code\\\":\\\"OK\\\",\\\"data\\\":{\\\"command\\\":\\\"auth.check\\\",\\\"authenticated\\\":true,\\\"apiScope\\\":{\\\"status\\\":\\\"verified\\\",\\\"scopes\\\":[\\\"api\\\"]}},\\\"remoteWrite\\\":{\\\"state\\\":\\\"not-attempted\\\",\\\"operations\\\":[]}}\"); return 0; }",
    "if (mode == \"weak\") { Console.WriteLine(\"{\\\"ok\\\":true,\\\"code\\\":\\\"OK\\\"}\"); return 0; }",
    'if (mode == "malformed") { Console.WriteLine("not-json"); return 1; }',
    'Console.WriteLine("{\\"ok\\":false,\\"code\\":\\"AUTH_ERROR\\",\\"message\\":\\"initialization-fixture-sensitive-value\\"}");',
    'Console.Error.WriteLine("initialization-fixture-sensitive-value"); return 3;',
    "}}",
  ].join("\n");
  const source = Buffer.from(fixture).toString("base64");
  const escaped = executable.replaceAll("'", "''");
  const compile = "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + source + "')); Add-Type -TypeDefinition $source -OutputAssembly '" + escaped + "' -OutputType ConsoleApplication";
  await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", compile], { windowsHide: true, timeout: 20_000 });
  const base = { HARNESS_MRTOOL_GITLAB_HOST: "setup-fixture.invalid", HARNESS_MRTOOL_GITLAB_TOKEN: fixtureToken };
  const args = ["-Executable", executable, "-GitLabHost", "https://setup-fixture.invalid", "-NonInteractive", "-CheckOnly"];
  await t.test("missing matching credentials fail immediately with setup instructions", async () => {
    const result = await invoke(setupPath, args, { ...base, HARNESS_MRTOOL_GITLAB_TOKEN: "" });
    assert.equal(result.code, 3);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "credentials-missing");
    assert.match(output.safeNextStep, /setup-gitlab.ps1/u);
  });
  await t.test("host mismatch does not reuse another host's token", async () => {
    const result = await invoke(setupPath, args, { ...base, HARNESS_MRTOOL_GITLAB_HOST: "another-fixture.invalid" });
    assert.equal(JSON.parse(result.stdout).state, "credentials-missing");
  });
  await t.test("existing matching credentials pass a read-only check", async () => {
    const result = await invoke(setupPath, args, { ...base, HARNESS_MRTOOL_SETUP_FIXTURE: "accept" });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "authorized");
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureToken));
  });
  await t.test("failed child authentication never echoes raw stdout or stderr", async () => {
    const result = await invoke(setupPath, args, { ...base, HARNESS_MRTOOL_SETUP_FIXTURE: "reject" });
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stdout).code, "AUTH_ERROR");
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureToken));
  });
  await t.test("a generic OK output cannot masquerade as API authorization", async () => {
    const result = await invoke(setupPath, args, { ...base, HARNESS_MRTOOL_SETUP_FIXTURE: "weak" });
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stdout).code, "INITIALIZATION_ERROR");
  });
  await t.test("malformed child output fails closed", async () => {
    const result = await invoke(setupPath, args, { ...base, HARNESS_MRTOOL_SETUP_FIXTURE: "malformed" });
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stdout).code, "INITIALIZATION_ERROR");
  });
  await t.test("standalone installer retries setup without downloading or removing the CLI", async () => {
    const result = await invoke(installerPath, ["-SetupOnly", "-Destination", directory, "-GitLabHost", "https://setup-fixture.invalid", "-NonInteractive"], { ...base, HARNESS_MRTOOL_GITLAB_TOKEN: "" });
    assert.equal(result.code, 3);
    const output = JSON.parse(result.stdout);
    assert.match(output.message, /CLI is installed, but GitLab initialization is incomplete/u);
    assert.match(output.safeNextStep, /-SetupOnly/u);
    assert.ok((await readFile(executable)).byteLength > 0);
  });
  await t.test("SessionStart emits supported additionalContext when CLI is unavailable", async () => {
    const pluginRoot = join(directory, "plugin");
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await mkdir(join(pluginRoot, "scripts"), { recursive: true });
    const hook = join(pluginRoot, "hooks/session-start.ps1");
    await writeFile(hook, await readFile(join(root, "plugins/harness-mrtool/hooks/session-start.ps1")));
    await copyFile(setupPath, join(pluginRoot, "scripts/setup-gitlab.ps1"));
    const result = await invoke(hook, [], { Path: "", HARNESS_MRTOOL_EXECUTABLE: join(directory, "absent.exe"), LOCALAPPDATA: directory }, JSON.stringify({ hook_event_name: "SessionStart", cwd: directory }));
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /initialization has not completed/u);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureToken));
  });
});

test("POSIX SessionStart validates the full authorization result without leaking child output", async (t) => {
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
  try { await readFile(shell); } catch { t.skip("POSIX shell unavailable"); return; }
  const directory = await mkdtemp(join(tmpdir(), "harness-gitlab-hook-posix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = join(directory, "session-start.sh");
  await writeFile(hook, await readFile(join(root, "plugins/harness-mrtool/hooks/session-start.sh")));
  const fixture = join(directory, "fixture.sh");
  const success = JSON.stringify({ ok: true, code: "OK", data: { command: "auth.check", authenticated: true, apiScope: { status: "verified", scopes: ["api"] } }, remoteWrite: { state: "not-attempted", operations: [] } });
  await writeFile(fixture, "#!/bin/sh\ncase \"$HARNESS_MRTOOL_SETUP_FIXTURE\" in\naccept) printf '%s\\n' '" + success + "' ;;\nweak) printf '%s\\n' '{\"ok\":true,\"code\":\"OK\"}' ;;\n*) printf '%s\\n' '" + fixtureToken + "' >&2; exit 3 ;;\nesac\n", { mode: 0o755 });
  const environment = { ...process.env, HARNESS_MRTOOL_EXECUTABLE: fixture, HARNESS_MRTOOL_GITLAB_HOST: "setup-fixture.invalid", HARNESS_MRTOOL_GITLAB_TOKEN: fixtureToken };
  for (const mode of ["accept", "weak", "reject"]) {
    const result = await run(shell, ["-c", 'PATH="/usr/bin:$PATH" sh "$1"', "harness-hook-test", hook], { env: { ...environment, HARNESS_MRTOOL_SETUP_FIXTURE: mode }, windowsHide: true, timeout: 10_000 });
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, mode === "accept" ? /initialization check passed/u : /could not verify/u);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureToken));
  }
});
