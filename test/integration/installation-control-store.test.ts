import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolError } from "../../src/contracts/errors.ts";
import { withUpdateLock } from "../../src/platform/lock.ts";
import { createInstallationControlStore } from "../../src/update/installation-control-store.ts";
import type { InstallationControl } from "../../src/update/installation-control.ts";

const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });

async function withStateRoot<T>(callback: (stateRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "harness-mrtool-installation-control-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function controlForRoot(stateRoot: string, epoch = 1): Promise<InstallationControl> {
  const identity = await lstat(stateRoot, { bigint: true });
  return Object.freeze({
    schemaVersion: 1,
    installationId: "a".repeat(32),
    enrollmentId: "b".repeat(32),
    authorityEpoch: epoch,
    roots: Object.freeze({
      installation: Object.freeze({ dev: String(identity.dev), ino: String(identity.ino + 1n) }),
      state: Object.freeze({ dev: String(identity.dev), ino: String(identity.ino) }),
    }),
    current: null,
    queued: [],
  });
}

function assertSecurity(error: unknown): true {
  assert.ok(error instanceof ToolError);
  assert.equal(error.code, "UPDATE_SECURITY_ERROR");
  assert.equal(error.message, "installation control store is unsafe");
  return true;
}

test("persists and reloads canonical installation control under the fixed state root", async () => {
  await withStateRoot(async (stateRoot) => {
    const store = createInstallationControlStore(stateRoot, { windowsAclVerifier: allowTestAcl });
    const control = await controlForRoot(stateRoot);
    assert.deepEqual(await store.write(control), control);
    assert.deepEqual(await store.read(), control);
    assert.equal(new TextDecoder().decode(await readFile(store.path)), new TextDecoder().decode(store.encode(control)));
    assert.deepEqual(await readdir(stateRoot), ["installation-control.json"]);
  });
});

test("control store rejects symlinks and preserves their targets", async () => {
  await withStateRoot(async (stateRoot) => {
    const outside = join(stateRoot, "outside.json");
    await writeFile(outside, "outside\n", { mode: 0o600 });
    await symlink(outside, join(stateRoot, "installation-control.json"));
    const store = createInstallationControlStore(stateRoot, { windowsAclVerifier: allowTestAcl });
    await assert.rejects(() => store.read(), assertSecurity);
    const control = await controlForRoot(stateRoot);
    await assert.rejects(() => store.write(control), assertSecurity);
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  });
});

test("control store requires increasing authority epochs and supports the shared lease", async () => {
  await withStateRoot(async (stateRoot) => {
    await withUpdateLock(stateRoot, async (lease) => {
      const store = createInstallationControlStore(stateRoot, { lease, windowsAclVerifier: allowTestAcl });
      const first = await controlForRoot(stateRoot, 1);
      await store.write(first);
      await assert.rejects(() => store.write(first), assertSecurity);
      const next = await controlForRoot(stateRoot, 2);
      assert.deepEqual(await store.write(next), next);
      lease.assertHeld();
      await store.remove();
      assert.equal(await store.read(), null);
    });
  });
});
