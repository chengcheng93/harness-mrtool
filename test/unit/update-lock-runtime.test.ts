import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { withUpdateLock } from "../../src/platform/lock.ts";
import {
  ProcessLockError,
  systemProcessLockProvider,
  type ProcessLockProvider,
} from "../../src/platform/process-lock.ts";

test("update locking rejects a linked state directory before acquiring a lock", async (t) => {
  const container = await mkdtemp(resolve(tmpdir(), "harness-mrtool-lock-link-"));
  const target = await mkdtemp(resolve(tmpdir(), "harness-mrtool-lock-target-"));
  t.after(async () => Promise.all([
    rm(container, { recursive: true, force: true }),
    rm(target, { recursive: true, force: true }),
  ]).then(() => undefined));
  const linked = resolve(container, "state");
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  let acquisitions = 0;
  const provider: ProcessLockProvider = {
    async acquire() {
      acquisitions += 1;
      throw new Error("provider must not be reached");
    },
  };

  await assert.rejects(
    withUpdateLock(linked, async () => undefined, { provider }),
    (error: unknown) => error instanceof ProcessLockError && error.reason === "unsafe",
  );
  assert.equal(acquisitions, 0);
});

test("the callback can assert that its update lease remains held", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-lock-held-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  let held = true;
  let assertions = 0;
  let releases = 0;
  const provider: ProcessLockProvider = {
    async acquire() {
      return {
        assertHeld() {
          assertions += 1;
          if (!held) throw new ProcessLockError("unavailable");
        },
        async release() {
          held = false;
          releases += 1;
        },
      };
    },
  };

  const result = await withUpdateLock(directory, async (lease) => {
    lease.assertHeld();
    await Promise.resolve();
    lease.assertHeld();
    return 42;
  }, { provider });

  assert.equal(result, 42);
  assert.equal(assertions, 3);
  assert.equal(releases, 1);
  assert.equal(held, false);
});

test("system lock contention never exceeds its declared timeout by a helper grace period", async (t) => {
  if (process.platform !== "linux" && process.platform !== "win32") {
    t.skip("system process lock provider is not available on this platform");
    return;
  }
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-lock-timeout-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "update.lock");
  const held = await systemProcessLockProvider.acquire(path, 2_000);
  try {
    const started = performance.now();
    await assert.rejects(
      systemProcessLockProvider.acquire(path, 50),
      (error: unknown) => error instanceof ProcessLockError && error.reason === "timeout",
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_500, `lock timeout exceeded declared budget: ${elapsed}ms`);
  } finally {
    await held.release();
  }
});
