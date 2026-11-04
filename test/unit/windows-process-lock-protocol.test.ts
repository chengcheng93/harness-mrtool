import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { ProcessLockError, systemProcessLockProvider as locks } from "../../src/platform/process-lock.ts";

// Keep the provider, file identity checks, protocol parser and lease real. Only
// the PowerShell process boundary and elapsed time are controlled by these tests.
class ControlledHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    // Requesting termination does not prove that the process/stdio have closed.
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  close(): void {
    this.emit("close", this.exitCode, this.signalCode);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const reason = (expected: ProcessLockError["reason"]) => (error: unknown): boolean =>
  error instanceof ProcessLockError && error.reason === expected;

async function fixture(t: TestContext, timeoutMs = 50) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "windows-lock-protocol-"));
  const path = join(directory, "update.lock");
  await writeFile(path, "");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const systemRoot = process.env.SystemRoot;
  const helper = new ControlledHelper();
  let reportSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => { reportSpawn = resolve; });
  let outcome = "pending";

  t.after(async () => {
    helper.close();
    helper.stdin.destroy();
    helper.stdout.destroy();
    helper.stderr.destroy();
    t.mock.timers.reset();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    await rm(directory, { recursive: true, force: true });
  });

  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  process.env.SystemRoot = "C:\\Windows";
  t.mock.method(childProcess, "spawn", ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.ok(args.includes("-EncodedCommand"));
    assert.equal(options.env?.HMRTOOL_PROCESS_LOCK_TIMEOUT, String(timeoutMs));
    reportSpawn();
    return helper;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = locks.acquire(path, timeoutMs);
  void pending.then(() => { outcome = "acquired"; }, () => { outcome = "rejected"; });
  await Promise.race([spawned, pending]);
  return { helper, pending, outcome: () => outcome };
}

test("Windows missing READY expires at the separate 1050ms startup bound, then waits for close", async (t) => {
  const f = await fixture(t);
  t.mock.timers.tick(1049);
  assert.deepEqual(f.helper.kills, []);
  assert.equal(f.outcome(), "pending");
  t.mock.timers.tick(1);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  await flush();
  assert.equal(f.outcome(), "pending", "kill is not a successful reap");
  f.helper.exit(null, "SIGKILL");
  await flush();
  assert.equal(f.outcome(), "pending", "exit is not stdio closure");
  f.helper.close();
  await assert.rejects(f.pending, reason("timeout"));
});

test("Windows fragmented READY starts exactly 50ms of contention after a 1040ms startup", async (t) => {
  const f = await fixture(t);
  t.mock.timers.tick(1040);
  assert.deepEqual(f.helper.kills, [], "compilation is not lock contention");
  for (const chunk of ["R", "EA", "D", "Y\r", "\n"]) f.helper.stdout.write(chunk);
  t.mock.timers.tick(49);
  assert.deepEqual(f.helper.kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  f.helper.stdout.write("LOCKED\n");
  await flush();
  assert.equal(f.outcome(), "pending", "a late LOCKED must not resurrect an expired lease");
  f.helper.close();
  await assert.rejects(f.pending, reason("timeout"));
});

test("Windows startup is capped at 10s even with a 30s contention budget", async (t) => {
  const f = await fixture(t, 30_000);
  t.mock.timers.tick(9_999);
  assert.deepEqual(f.helper.kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  f.helper.close();
  await assert.rejects(f.pending, reason("timeout"));
});

test("Windows partial READY cannot extend the startup deadline", async (t) => {
  const f = await fixture(t);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.helper.kills, []);
  f.helper.stdout.write("REA");
  t.mock.timers.tick(49);
  assert.deepEqual(f.helper.kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  f.helper.stdout.write("DY\nLOCKED\n");
  f.helper.close();
  await assert.rejects(f.pending, reason("timeout"));
});

test("Windows capped startup still leaves the full 30s caller contention budget", async (t) => {
  const f = await fixture(t, 30_000);
  t.mock.timers.tick(9999);
  f.helper.stdout.write("READY\n");
  t.mock.timers.tick(29_999);
  assert.deepEqual(f.helper.kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  f.helper.close();
  await assert.rejects(f.pending, reason("timeout"));
});

for (const { name, chunks } of [
  { name: "coalesced LF", chunks: ["READY\nLOCKED\n"] },
  { name: "coalesced CRLF", chunks: ["READY\r\nLOCKED\r\n"] },
  { name: "byte-fragmented CRLF", chunks: ["R", "E", "A", "D", "Y", "\r", "\n", "L", "O", "C", "K", "E", "D", "\r", "\n"] },
]) {
  test(`Windows accepts complete READY/LOCKED frames: ${name}`, async (t) => {
    const f = await fixture(t);
    for (const chunk of chunks.slice(0, -1)) {
      f.helper.stdout.write(chunk);
      await flush();
      assert.equal(f.outcome(), "pending", "incomplete frames cannot grant a lease");
    }
    f.helper.stdout.write(chunks.at(-1)!);
    const lease = await f.pending;
    lease.assertHeld();
    t.mock.timers.tick(50);
    assert.deepEqual(f.helper.kills, [], "acquisition timer must be cancelled");
    let released = false;
    const release = lease.release().then(() => { released = true; });
    assert.equal(f.helper.stdin.read()?.toString(), "release\n");
    assert.equal(f.helper.stdin.writableEnded, true);
    assert.throws(() => lease.assertHeld(), reason("unavailable"));
    f.helper.exit(0);
    await flush();
    assert.equal(released, false);
    f.helper.close();
    await release;
    await lease.release();
    t.mock.timers.tick(2000);
    assert.deepEqual(f.helper.kills, [], "release must cancel its fallback kill");
  });
}

test("Windows delayed READY cancels the startup timer and can acquire in its full contention budget", async (t) => {
  const f = await fixture(t);
  t.mock.timers.tick(1040);
  assert.deepEqual(f.helper.kills, [], "startup must survive a short contention budget");
  f.helper.stdout.write("READY\n");
  t.mock.timers.tick(49);
  f.helper.stdout.write("LOCKED\n");
  const lease = await f.pending;
  lease.assertHeld();
  t.mock.timers.tick(100);
  assert.deepEqual(f.helper.kills, []);
  f.helper.exit(0);
  assert.throws(() => lease.assertHeld(), reason("unavailable"));
  f.helper.close();
  await lease.release();
});

for (const chunks of [["LOCKED\n"], ["READY\nREADY\n"], ["READY\n", "READY\n"], ["READY\n", "BOGUS\n"]]) {
  test(`Windows rejects missing/duplicate/invalid READY protocol: ${JSON.stringify(chunks)}`, async (t) => {
    const f = await fixture(t);
    for (const chunk of chunks) f.helper.stdout.write(chunk);
    assert.deepEqual(f.helper.kills, ["SIGKILL"]);
    await flush();
    assert.equal(f.outcome(), "pending");
    f.helper.close();
    await assert.rejects(f.pending, reason("unavailable"));
    t.mock.timers.tick(2000);
    assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  });
}

for (const phase of ["startup", "contention"] as const) {
  test(`Windows ${phase} close without LOCKED never grants a lease`, async (t) => {
    const f = await fixture(t);
    if (phase === "contention") f.helper.stdout.write("READY\n");
    f.helper.close();
    await assert.rejects(f.pending, reason("unavailable"));
    t.mock.timers.tick(2000);
    assert.deepEqual(f.helper.kills, []);
  });

  test(`Windows ${phase} timeout reports unavailable if helper never closes`, async (t) => {
    const f = await fixture(t);
    if (phase === "contention") f.helper.stdout.write("READY\n");
    t.mock.timers.tick(phase === "startup" ? 1050 : 50);
    assert.deepEqual(f.helper.kills, ["SIGKILL"]);
    t.mock.timers.tick(999);
    await flush();
    assert.equal(f.outcome(), "pending");
    t.mock.timers.tick(1);
    await assert.rejects(f.pending, reason("unavailable"));
  });

  for (const [code, expected] of [[24, "timeout"], [25, "unsafe"], [26, "unavailable"]] as const) {
    test(`Windows ${phase} exit ${code} preserves ${expected} only after close`, async (t) => {
      const f = await fixture(t);
      if (phase === "contention") f.helper.stdout.write("READY\n");
      f.helper.exit(code);
      await flush();
      assert.equal(f.outcome(), "pending");
      f.helper.close();
      await assert.rejects(f.pending, reason(expected));
    });
  }

  test(`Windows ${phase} diagnostics survive failure and helper closure`, async (t) => {
    const f = await fixture(t);
    if (phase === "contention") f.helper.stdout.write("READY\n");
    f.helper.stdout.write(phase === "startup" ? "ERR:compile\n" : "ERR:acquire\n");
    assert.deepEqual(f.helper.kills, ["SIGKILL"]);
    f.helper.close();
    await assert.rejects(f.pending, {
      reason: "unavailable",
      diagnostic: phase === "startup" ? "windows-lock-helper:compile" : "windows-lock-helper:acquire",
    });
  });
}

test("Windows release kills a stuck helper but does not resolve until it closes", async (t) => {
  const f = await fixture(t);
  f.helper.stdout.write("READY\nLOCKED\n");
  const lease = await f.pending;
  let released = false;
  const release = lease.release().then(() => { released = true; });
  t.mock.timers.tick(999);
  assert.deepEqual(f.helper.kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  f.helper.exit(null, "SIGKILL");
  await flush();
  assert.equal(released, false);
  f.helper.close();
  await release;
  await lease.release();
  t.mock.timers.tick(2000);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
});

test("Windows release reports unavailable when a killed helper never closes", async (t) => {
  const f = await fixture(t);
  f.helper.stdout.write("READY\nLOCKED\n");
  const lease = await f.pending;
  const rejected = assert.rejects(lease.release(), reason("unavailable"));
  t.mock.timers.tick(1000);
  assert.deepEqual(f.helper.kills, ["SIGKILL"]);
  t.mock.timers.tick(1000);
  await rejected;
  assert.throws(() => lease.assertHeld(), reason("unavailable"));
  await assert.rejects(lease.release(), reason("unavailable"));
});
