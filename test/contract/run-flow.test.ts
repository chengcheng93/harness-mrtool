import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const windows = process.platform === "win32";
const ps = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const runner = resolve("skill/harness-mr/scripts/run-flow.ps1");
const mirror = resolve("plugins/harness-mrtool/skills/harness-mr/scripts/run-flow.ps1");
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("Windows PowerShell 5.1 thin runner native behavior", { skip: windows ? false : "requires Windows PowerShell 5.1 and native .NET Framework executable", timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "run-flow native 中文 "));
  const exe = join(dir, "fake cli.exe");
  const repository = join(dir, "repository");
  await mkdir(repository);
  const compiled = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -Path " + quote(resolve("test/helpers/run-flow-fake-cli.cs")) + " -ReferencedAssemblies System.Web.Extensions -OutputAssembly " + quote(exe) + " -OutputType ConsoleApplication"], { encoding: "utf8", windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  let serial = 0;
  type RunOptions = {
    mode?: string; command?: string; bytes?: Buffer; stdin?: boolean; executable?: string | null;
    output?: string; env?: NodeJS.ProcessEnv; lockTail?: boolean;
    partialPath?: "repository" | "executable" | "request"; driveRelative?: boolean;
  };
  async function run(phase: "context" | "create", options: RunOptions = {}) {
    const log = join(dir, "calls-" + serial++ + ".jsonl");
    const request = join(dir, "request-" + serial + ".json");
    const bytes = options.bytes ?? Buffer.from('{"body":"中文 😀 glpat-request-secret","a":1,"a":2}\r\n');
    await writeFile(request, bytes);
    const argumentPath = (kind: RunOptions["partialPath"], absolute: string) => {
      if (kind !== options.partialPath) return absolute;
      return options.driveRelative ? absolute.slice(0, 2) + basename(absolute) : absolute.slice(2);
    };
    // PS5.1 -File misbinds a standalone dash. Quote values as PowerShell literals.
    let command = "& " + quote(runner) + " -Phase " + phase + " -Repository " + quote(argumentPath("repository", repository)) + " -ClientVersion 0.1.11 -SkillProtocol 1";
    if (options.executable !== null) command += " -Executable " + quote(argumentPath("executable", options.executable ?? exe));
    if (phase === "create") command += " -RequestPath " + quote(options.stdin ? "-" : argumentPath("request", request));
    if (options.lockTail) {
      command = "$lock = [IO.File]::OpenRead(" + quote(request) + "); $lock.Lock(200000, 1); try { " + command + "; exit $LASTEXITCODE } finally { $lock.Dispose() }";
    }
    const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: dir, windowsHide: true,
      env: { ...process.env, ...options.env, RUN_FLOW_FAKE_LOG: log, RUN_FLOW_FAKE_OUTPUT: options.output,
        RUN_FLOW_FAKE_MODE: options.mode ?? "ok", RUN_FLOW_FAKE_COMMAND: options.command ?? (phase === "context" ? "context" : "create") },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => stdout.push(data)); child.stderr.on("data", (data: Buffer) => stderr.push(data));
    child.stdin.on("error", () => {}); child.stdin.end(options.stdin ? bytes : undefined);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const out = Buffer.concat(stdout).toString("utf8"); const err = Buffer.concat(stderr).toString("utf8");
    let result: any;
    try { result = JSON.parse(out); } catch { assert.fail("missing runner or invalid single runner JSON: " + err.slice(0, 500)); }
    assert.equal(result.runnerSchemaVersion, 1); assert.equal(result.phase, phase); assert.ok(result.elapsedMs >= 0);
    assert.equal(err.includes("glpat-"), false); assert.equal(err.includes("candidate-token"), false); assert.equal(err.includes("request-body"), false);
    assert.deepEqual(await readFile(request), bytes, "caller Request file must remain byte-identical");
    const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { result, exit, calls, out, err, bytes };
  }
  try {
    await t.test("context exact sequence, cwd, fixed identity, complete envelope and timings", async () => {
      const { result, exit, calls } = await run("context");
      assert.equal(exit, 0);
      const starts = calls.filter((call) => call.kind === "start");
      const identity = ["--auth", "api", "--client", "codex-skill", "--client-version", "0.1.11", "--skill-protocol", "1", "--output", "json"];
      assert.deepEqual(starts.map((call) => call.args), [["schema", "show", "--output", "json"], ["profiles", "list", "--output", "json"], ["context", ...identity]]);
      assert.ok(starts.every((call) => call.cwd === repository));
      assert.deepEqual(result.steps.map((step: any) => step.command), ["schema show", "profiles list", "context"]);
      assert.ok(result.steps.every((step: any) => step.exitCode === 0 && step.elapsedMs >= 0));
      assert.ok(result.elapsedMs >= result.steps.reduce((sum: number, step: any) => sum + step.elapsedMs, 0));
      assert.deepEqual(result.cliResult.data.profiles, ["code", "docs"]); assert.deepEqual(result.cliResult.data.binding, { head: "abc" }); assert.equal(result.cliResult.update.activationRequired, true);
    });
    await t.test("create preserves Unicode, duplicate keys and invalid UTF-8 from file and stdin", async () => {
      for (const bytes of [Buffer.from('{"人员":"李😀","label":"原样","x":1,"x":2}\r\n'), Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])]) {
        for (const stdin of [false, true]) {
          const { result, exit, calls } = await run("create", { bytes, stdin });
          assert.equal(exit, 0); assert.equal(result.cliResult.data.hash, hash(bytes));
          const starts = calls.filter((call) => call.kind === "start"); assert.equal(starts.length, 1);
          assert.deepEqual(starts[0].args, ["create", "--auth", "api", "--client", "codex-skill", "--client-version", "0.1.11", "--skill-protocol", "1", "--input", "-", "--input-format", "json", "--output", "json"]);
          assert.deepEqual(calls.filter((call) => call.kind === "input").map((call) => call.hash), [hash(bytes)]);
        }
      }
    });
    await t.test("early CLI input rejection preserves complete failure envelope after broken pipe", async () => {
      const { result, exit, calls } = await run("create", { mode: "early", bytes: Buffer.alloc(5_000_000, 0x61) });
      assert.notEqual(exit, 0);
      assert.equal(result.outcome, "cli-result");
      assert.equal(result.cliResult.ok, false);
      assert.equal(result.cliResult.code, "INPUT_ERROR");
      assert.deepEqual(result.cliResult.error, { field: "request", expected: "valid", actual: "invalid", safeNextStep: "stop" });
      assert.deepEqual(result.cliResult.remoteWrite, { state: "none", operations: [] });
      assert.deepEqual(result.cliResult.validation, { valid: false, issues: [] });
      assert.equal(result.cliResult.versions.cliVersion, "0.1.11");
      assert.equal(result.cliResult.update.activationRequired, true);
      assert.deepEqual(result.cliResult.warnings, []);
      assert.equal(result.cliResult.data.command, "create");
      assert.equal(calls.filter((call) => call.kind === "start").length, 1);
    });
    await t.test("nonzero, ok=false and malformed output stop at failed context step", async () => {
      for (const mode of ["nonzero", "false", "invalid", "malformed"]) {
        const { result, exit, calls } = await run("context", { mode, command: "profiles list" });
        assert.notEqual(exit, 0); assert.equal(calls.filter((call) => call.kind === "start").length, 2);
        assert.equal(result.steps.length, 2);
        if (mode === "false" || mode === "nonzero") { assert.equal(result.cliResult.ok, false); assert.equal(result.cliResult.code, "INPUT_ERROR"); }
        else { assert.equal(result.cliResult, null); assert.equal(result.error.code, "INVALID_CLI_RESULT"); }
      }
    });
    await t.test("create failures preserve CLI envelope or report unknown without retry", async () => {
      for (const mode of ["nonzero", "false", "invalid", "malformed"]) {
        const { result, exit, calls } = await run("create", { mode });
        assert.notEqual(exit, 0); assert.equal(calls.filter((call) => call.kind === "start").length, 1);
        if (mode === "false" || mode === "nonzero") assert.equal(result.cliResult.code, "INPUT_ERROR");
        else { assert.equal(result.outcome, "unknown"); assert.equal(result.cliResult, null); }
      }
    });
    await t.test("startup failure has bounded safe error and no fake envelope", async () => {
      const { result, exit, calls } = await run("create", { executable: join(dir, "glpat-missing-secret.exe") });
      assert.notEqual(exit, 0); assert.equal(result.cliResult, null); assert.equal(result.outcome, "not-started"); assert.equal(calls.length, 0); assert.equal(JSON.stringify(result).includes("glpat-"), false);
    });
    await t.test("finds the standard installer without PATH and still supports a PATH install", async () => {
      const local = join(dir, "local");
      const install = join(local, "HarnessMrTool");
      await mkdir(install, { recursive: true });
      await copyFile(exe, join(install, "harness-mrtool.exe"));
      for (const env of [
        { LOCALAPPDATA: local, PATH: dir },
        { LOCALAPPDATA: dir, PATH: install },
      ]) {
        const { result, exit, calls } = await run("create", { executable: null, env });
        assert.equal(exit, 0, JSON.stringify(result.error));
        assert.equal(calls.filter(call => call.kind === "start").length, 1);
      }
    });
    await t.test("rejects root-relative and drive-relative arguments before starting a process", async t => {
      for (const partialPath of ["repository", "executable", "request"] as const) {
        for (const driveRelative of [true, false]) {
          await t.test(partialPath + (driveRelative ? " drive-relative" : " root-relative"), async () => {
            const { result, exit, calls } = await run("create", { partialPath, driveRelative });
            assert.notEqual(exit, 0);
            assert.equal(result.outcome, "not-started");
            assert.equal(result.error.code, "INVALID_ARGUMENT");
            assert.equal(calls.length, 0);
          });
        }
      }
    });
    await t.test("a locked Request tail cannot submit a readable JSON prefix", async () => {
      const bytes = Buffer.alloc(300_000, 0x20);
      bytes.write('{"complete":"prefix"}');
      const { result, exit, calls } = await run("create", { bytes, lockTail: true });
      assert.notEqual(exit, 0);
      assert.equal(result.outcome, "not-started");
      assert.equal(result.error.code, "REQUEST_READ_FAILED");
      assert.equal(calls.length, 0);
    });
    await t.test("drains a large invalid UTF-8 result to child completion then reports unknown", async () => {
      const { result, exit, calls } = await run("create", { mode: "invalid-utf8" });
      assert.notEqual(exit, 0);
      assert.equal(result.steps[0].exitCode, 0, "native writer finished without its blocked-pipe watchdog");
      assert.equal(result.outcome, "unknown");
      assert.equal(result.error.code, "INVALID_CLI_RESULT");
      assert.equal(result.cliResult, null);
      assert.equal(calls.filter(call => call.kind === "start").length, 1);
    });
    await t.test("validates strict JSON framing and typed CLI envelope members", async t => {
      const envelope = {
        schemaVersion: 1, ok: true, code: "OK", message: "text", versions: {}, update: {},
        validation: {}, remoteWrite: {}, warnings: [], error: null, data: null,
      };
      const json = JSON.stringify(envelope);
      const invalid = new Map([
        ["single quotes", json.replaceAll('"', "'")],
        ["unquoted key", json.replace('"ok"', "ok")],
        ["trailing comma", json.slice(0, -1) + ",}"],
        ["comment", json.replace("true", "/* note */true")],
        ["multiple roots", json + "{}"],
        ["boolean schemaVersion", json.replace(':1,', ':true,')],
        ["string schemaVersion", json.replace(':1,', ':"1",')],
        ["incorrect key case", json.replace('"versions"', '"Versions"')],
      ]);
      for (const key of ["versions", "update", "validation", "warnings"] as const) {
        invalid.set("missing " + key, JSON.stringify({ ...envelope, [key]: undefined }));
      }
      for (const [name, output] of invalid) {
        await t.test(name, async () => {
          const { result, exit, calls } = await run("create", { output });
          assert.notEqual(exit, 0);
          assert.equal(result.outcome, "unknown");
          assert.equal(result.error.code, "INVALID_CLI_RESULT");
          assert.equal(result.cliResult, null);
          assert.equal(calls.filter(call => call.kind === "start").length, 1);
        });
      }
      const output = json.replace('"data":null', '"data": { "big": 9007199254740993, "value": 1.20e+3 }');
      const { out, exit } = await run("create", { output });
      assert.equal(exit, 0);
      assert.ok(out.includes(output), "original CLI number spelling and whitespace must survive");
    });
    await t.test("large simultaneous stdout and stderr drains without deadlock", async () => {
      const { result, exit } = await run("create", { mode: "large" });
      assert.equal(exit, 0); assert.equal(result.cliResult.data.padding.length, 2_000_000);
    });
    await t.test("one native PID survives over thirty seconds and completes", async () => {
      const { result, exit, calls } = await run("create", { mode: "long" });
      assert.equal(exit, 0); assert.equal(calls.filter((call) => call.kind === "start").length, 1); assert.ok(result.steps[0].elapsedMs >= 30_000); assert.equal(result.cliResult.ok, true);
    });
    await t.test("controlled PowerShell pipeline cancellation cleans up child and reports unknown", async () => {
      const log = join(dir, "cancel.jsonl"); const request = join(dir, "cancel-request.json"); await writeFile(request, "{}");
      const stopped = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("test/helpers/run-flow-cancel.ps1"), "-Runner", runner, "-Executable", exe, "-Repository", repository, "-Request", request, "-Log", log], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      const result = JSON.parse(stopped.stdout); assert.equal(result.outcome, "unknown"); assert.equal(result.cliResult, null); assert.equal(result.error.code, "CANCELLED");
      const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); assert.equal(calls.filter((call) => call.kind === "start").length, 1);
    });
    await t.test("PS5.1 AST parses both byte-identical runners", async () => {
      assert.deepEqual(await readFile(runner), await readFile(mirror));
      const parsed = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(" + quote(runner) + ",[ref]$tokens,[ref]$errors); if($PSVersionTable.PSVersion.Major -ne 5 -or $errors.Count -ne 0){exit 1}"], { encoding: "utf8", windowsHide: true });
      assert.equal(parsed.status, 0, parsed.stderr);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
