import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ProcessLockError, systemProcessLockProvider as locks } from "../../src/platform/process-lock.ts";

interface HelperTrace {
  child: childProcess.ChildProcess;
  output: string;
  closed: boolean;
}

// Unlike the deterministic protocol unit tests, these cases launch the actual
// Windows PowerShell/C# helper. Observing spawn does not replace the process.
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "windows-lock-native-"));
  const path = join(directory, "receipt lock ' $;.lock");
  const traces: HelperTrace[] = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    const trace: HelperTrace = { child, output: "", closed: false };
    traces.push(trace);
    child.stdout!.on("data", (chunk: Buffer | string) => { trace.output += chunk.toString(); });
    child.once("close", () => { trace.closed = true; });
    return child;
  }) as typeof spawn);
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const trace of traces) {
      if (trace.closed) continue;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1000);
        trace.child.once("close", () => { clearTimeout(timeout); resolve(); });
        trace.child.kill("SIGKILL");
      });
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { path, traces };
}

const windowsOnly = { skip: process.platform !== "win32", timeout: 20_000 };
const frames = (trace: HelperTrace): string[] => trace.output.trimEnd().split(/\r?\n/u);

test("Windows native helper emits READY then LOCKED, and release awaits process closure", windowsOnly, async (t) => {
  const f = await fixture(t);
  const lease = await locks.acquire(f.path, 4000);
  try {
    assert.equal(f.traces.length, 1);
    assert.deepEqual(frames(f.traces[0]!), ["READY", "LOCKED"]);
    lease.assertHeld();
    assert.equal(f.traces[0]!.closed, false);
    await lease.release();
    assert.equal(f.traces[0]!.closed, true, "release must await actual child close");
    assert.throws(() => lease.assertHeld(), (error) => error instanceof ProcessLockError && error.reason === "unavailable");
  } finally {
    await lease.release();
  }
});

test("Windows native contention reaches READY and closes its waiter before reporting timeout", windowsOnly, async (t) => {
  const f = await fixture(t);
  const holder = await locks.acquire(f.path, 4000);
  try {
    await assert.rejects(locks.acquire(f.path, 4000), (error) => error instanceof ProcessLockError && error.reason === "timeout");
    assert.equal(f.traces.length, 2);
    assert.deepEqual(frames(f.traces[1]!), ["READY"], "startup timeout cannot substitute for contention coverage");
    assert.equal(f.traces[1]!.closed, true, "timeout must await actual waiter close");
    holder.assertHeld();
  } finally {
    await holder.release();
  }
  const next = await locks.acquire(f.path, 4000);
  try {
    next.assertHeld();
    assert.deepEqual(frames(f.traces[2]!), ["READY", "LOCKED"]);
  } finally {
    await next.release();
  }
  assert.ok(f.traces.every((trace) => trace.closed));
});
