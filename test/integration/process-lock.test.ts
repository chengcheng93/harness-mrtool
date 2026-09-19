import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ProcessLockError, systemProcessLockProvider as locks } from "../../src/platform/process-lock.ts";

async function fixture(t: TestContext): Promise<string> {
  // macOS /var is a symlink; exercise the real security checks with a physical path.
  const directory = await mkdtemp(join(await realpath(tmpdir()), "process-lock-"));
  if (process.platform !== "win32") {
    t.after(() => rm(directory, { recursive: true, force: true }));
  } else {
    // Node test after hooks run in registration order. The fixture hook is
    // registered before a test can register lease/child cleanup hooks, while
    // Windows refuses to remove a directory containing a still-open helper
    // handle. Retry asynchronously so later hooks can release those handles.
    t.after(() => {
      void (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            await rm(directory, { recursive: true, force: true });
            return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EBUSY" && code !== "EPERM") return;
            await delay(50);
          }
        }
      })();
    });
  }
  return join(directory, "receipt lock ' $;.lock");
}

function reason(expected: ProcessLockError["reason"]): (error: unknown) => boolean {
  return (error) => error instanceof ProcessLockError && error.reason === expected;
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    await new Promise<void>((resolve) => {
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([closed, delay(2_000)]);
}

async function owner(t: TestContext, path: string, waiting = false): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { systemProcessLockProvider } from ${JSON.stringify(new URL("../../src/platform/process-lock.ts", import.meta.url).href)};
    if (${waiting}) process.send("WAITING");
    const lease = await systemProcessLockProvider.acquire(process.argv[1], 4000);
    process.send("LOCKED");
    process.on("message", async () => {
      await lease.release();
      process.exit(0);
    });
  `, path], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout!.resume();
  t.after(() => terminateTree(child));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("lock owner did not start")), 6000);
    child.once("message", (message) => {
      clearTimeout(timeout);
      assert.equal(message, waiting ? "WAITING" : "LOCKED");
      resolve();
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`lock owner exited before readiness: ${stderr}`));
    });
  });
  return child;
}

test("system lock acquires, releases idempotently, and retains the same lock inode", async (t) => {
  const path = await fixture(t);
  const lease = await locks.acquire(path, 3000);
  t.after(() => lease.release());
  lease.assertHeld();
  const before = await lstat(path, { bigint: true });
  await lease.release();
  assert.throws(() => lease.assertHeld(), reason("unavailable"));
  await lease.release();
  const next = await locks.acquire(path, 3000);
  t.after(() => next.release());
  next.assertHeld();
  const after = await lstat(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  if (process.platform !== "win32") assert.equal(Number(after.mode & 0o777n), 0o600);
});

test("system lock excludes another process, bounds contention timeout, and leaves no waiter holding the lock", async (t) => {
  const path = await fixture(t);
  const child = await owner(t, path);
  const before = await lstat(path, { bigint: true });
  const started = performance.now();
  await assert.rejects(locks.acquire(path, 150), reason("timeout"));
  assert.ok(performance.now() - started < 2000, "contention must have a bounded wait");
  assert.equal((await lstat(path, { bigint: true })).ino, before.ino);
  const exited = once(child, "exit");
  child.send("exit");
  await exited;
  const lease = await locks.acquire(path, 3000);
  t.after(() => lease.release());
  lease.assertHeld();
});

for (const signal of [null, "SIGKILL"] as const) {
  test(`system lock releases on owner ${signal ?? "normal exit"} after exit without awaiting owner close`, async (t) => {
    const path = await fixture(t);
    const child = await owner(t, path);
    const before = await lstat(path, { bigint: true });
    const exited = once(child, "exit");
    if (signal === null) {
      child.send("exit");
      await exited;
    } else if (process.platform === "win32") {
      // Windows does not provide POSIX signal semantics for child.kill().
      // Kill the owner and its PowerShell lock helper as one process tree.
      await terminateTree(child);
    } else {
      child.kill(signal);
      await exited;
    }
    const lease = await locks.acquire(path, 3000);
    t.after(() => lease.release());
    lease.assertHeld();
    assert.equal((await lstat(path, { bigint: true })).ino, before.ino);
  });
}

test("system lock waits for a live owner to exit before acquiring", async (t) => {
  const path = await fixture(t);
  const child = await owner(t, path);
  let acquired = false;
  const waiting = locks.acquire(path, 4000).then((lease) => {
    acquired = true;
    t.after(() => lease.release());
    return lease;
  });
  // A negative assertion requires observing a live owner for a bounded interval.
  await delay(150);
  assert.equal(acquired, false);
  const exited = once(child, "exit");
  child.send("exit");
  await exited;
  const lease = await waiting;
  lease.assertHeld();
});

test("system lock rejects symlinks without modifying their target", async (t) => {
  const path = await fixture(t);
  const target = `${path}.target`;
  await writeFile(target, "untouched", { mode: 0o640 });
  const before = await lstat(target);
  await symlink(target, path, "file");
  await assert.rejects(locks.acquire(path, 1000), reason("unsafe"));
  assert.equal(await readFile(target, "utf8"), "untouched");
  assert.equal((await lstat(target)).mode, before.mode);
});

// Darwin's descriptor-based helper must fail closed when the pathname changes.
if (process.platform === "darwin") {
  for (const replacement of ["file", "symlink", "missing"] as const) {
    test(`macOS lock assertHeld rejects ${replacement} replacement and release never unlinks it`, async (t) => {
      const path = await fixture(t);
      const lease = await locks.acquire(path, 3000);
      t.after(() => lease.release());
      const moved = `${path}.old`;
      await rename(path, moved);
      if (replacement === "file") await writeFile(path, "replacement");
      if (replacement === "symlink") await symlink(moved, path);
      assert.throws(() => lease.assertHeld(), reason("unsafe"));
      await lease.release();
      if (replacement === "missing") await assert.rejects(lstat(path), { code: "ENOENT" });
      else if (replacement === "file") assert.equal(await readFile(path, "utf8"), "replacement");
      else assert.equal((await lstat(path)).isSymbolicLink(), true);
      assert.equal((await lstat(moved)).isFile(), true);
    });
  }
}

function helperPids(parent: number): number[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim().split("\n").flatMap((line) => {
      const [pid, ppid, command] = line.trim().split(/\s+/);
      return ppid === String(parent) && command === "/usr/bin/perl" ? [Number(pid)] : [];
    });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!check()) {
    assert.ok(performance.now() < deadline, "condition did not become true before deadline");
    await delay(10);
  }
}

if (process.platform === "darwin") {
  test("macOS release terminates even a stopped helper and frees the kernel lock", async (t) => {
    const path = await fixture(t);
    const lease = await locks.acquire(path, 3000);
    t.after(() => lease.release());
    const [pid] = helperPids(process.pid);
    assert.ok(pid);
    t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
    process.kill(pid, "SIGSTOP");
    const started = performance.now();
    await lease.release();
    assert.ok(performance.now() - started < 2000);
    assert.throws(() => lease.assertHeld(), reason("unavailable"));
    const next = await locks.acquire(path, 1500);
    t.after(() => next.release());
    next.assertHeld();
  });

  test("macOS waiting helper exits when its owner dies even while another lease stays held", async (t) => {
    const path = await fixture(t);
    const lease = await locks.acquire(path, 3000);
    t.after(() => lease.release());
    const child = await owner(t, path, true);
    let pids: number[] = [];
    await until(() => { pids = helperPids(child.pid!); return pids.length === 1; });
    const pid = pids[0]!;
    t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    lease.assertHeld();
  });

  test("macOS keeps a stable parent-directory fence across marker unlink and recreation", async (t) => {
    const path = await fixture(t);
    const lease = await locks.acquire(path, 3000);
    t.after(() => lease.release());
    const replacement = `${path}.old`;
    await rename(path, replacement);
    await writeFile(path, "replacement");

    let acquired = false;
    const waiting = locks.acquire(path, 4000).then((next) => {
      acquired = true;
      return next;
    });
    await delay(150);
    assert.equal(acquired, false);

    await lease.release();
    const next = await waiting;
    t.after(() => next.release());
    next.assertHeld();
    assert.equal(acquired, true);
  });

  test("macOS refuses a pathname replaced while waiting rather than returning a split lock", async (t) => {
    const path = await fixture(t);
    const child = await owner(t, path);
    const waiting = locks.acquire(path, 4000);
    // Attach the rejection handler before releasing the holder.
    const rejected = assert.rejects(waiting, reason("unsafe"));
    await until(() => helperPids(process.pid).length === 1);
    await rename(path, `${path}.old`);
    await writeFile(path, "replacement");
    const exited = once(child, "exit");
    child.send("exit");
    await exited;
    await rejected;
    assert.equal(await readFile(path, "utf8"), "replacement");
    const lease = await locks.acquire(path, 3000);
    t.after(() => lease.release());
    lease.assertHeld();
  });
}

if (process.platform === "darwin") {
  test("macOS release tolerates helper death before its exit event is delivered", async (t) => {
    const path = await fixture(t);
    const lease = await locks.acquire(path, 3000);
    t.after(() => lease.release());
    const [pid] = helperPids(process.pid);
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    // Let the OS close stdin without letting Node dispatch the child's exit event.
    execFileSync("/bin/sleep", ["0.05"]);
    await lease.release();
    assert.throws(() => lease.assertHeld(), reason("unavailable"));
    const next = await locks.acquire(path, 3000);
    t.after(() => next.release());
    next.assertHeld();
  });

  test("macOS helper ignores injected Perl startup options and module search paths", async (t) => {
    const path = await fixture(t);
    const previous = { PERL5OPT: process.env.PERL5OPT, PERL5LIB: process.env.PERL5LIB, PATH: process.env.PATH };
    t.after(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    process.env.PERL5OPT = "-MNonexistentInjectedLockModule";
    process.env.PERL5LIB = "/nonexistent/injected/modules";
    process.env.PATH = "/nonexistent/injected/bin";
    const lease = await locks.acquire(path, 3000);
    t.after(() => lease.release());
    lease.assertHeld();
  });
}
