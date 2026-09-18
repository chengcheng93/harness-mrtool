import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { assertUpdateLockLease, withUpdateLock } from "../../src/platform/lock.ts";
import { ProcessLockError, systemProcessLockProvider, type ProcessLockLease } from "../../src/platform/process-lock.ts";
import { activateReleaseSet, recoverReleaseSet } from "../../src/update/activation.ts";
import { createNativeExecutableStore } from "../../src/update/native-executable-store.ts";
import { createAuthenticatedReleaseSnapshot, createReleaseSetSnapshotVerifier } from "../../src/update/release-set-verifier.ts";
import { UpdateStateStore, type UpdateStateStoreFaultInjector } from "../../src/update/state-store.ts";
import { updateTrustConfigSha256 } from "../../src/update/trust-config.ts";
import { nativeReleaseFixture } from "../helpers/native-release-fixture.ts";

const platform = "darwin-arm64" as const;
const windowsAclVerifier = { verify: async (): Promise<void> => undefined };
const staleName = `update-state.json.tmp.${"a".repeat(24)}`;

async function cleanup(root: string): Promise<void> {
  // Test teardown only: native/cache release directories are intentionally sealed.
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(resolve(path, entry.name));
    }
  }
  await rm(root, { recursive: true, force: true });
}

async function setup(t: TestContext) {
  const base = await mkdtemp(resolve(await realpath(tmpdir()), "update-transaction-lease-"));
  t.after(() => cleanup(base));
  const root = resolve(base, "state");
  const fixture = await nativeReleaseFixture(platform);
  const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
  const verifySnapshot = createReleaseSetSnapshotVerifier({ platform, trustConfig: fixture.signed.trustConfig });
  const store = (stateDirectory = root, faultInjector?: UpdateStateStoreFaultInjector) => new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: updateTrustConfigSha256(fixture.signed.trustConfig),
    bootstrapKeys: fixture.signed.bootstrapKeys,
    windowsAclVerifier,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
  const activation = { stateDirectory: root, next: snapshot, verifySnapshot, windowsAclVerifier };
  const native = createNativeExecutableStore({ stateDirectory: root, platform, trustConfig: fixture.signed.trustConfig, windowsAclVerifier });
  return { base, root, fixture, snapshot, verifySnapshot, store, activation, native };
}

// Exercise the real OS lock, but fail immediately if an operation tries to
// acquire it recursively instead of consuming its branded outer capability.
function countAcquisitions(t: TestContext) {
  const acquire = systemProcessLockProvider.acquire.bind(systemProcessLockProvider);
  let active = 0;
  let acquisitions = 0;
  t.mock.method(systemProcessLockProvider, "acquire", async (path: string, timeoutMs: number) => {
    assert.equal(active, 0, "nested update-lock acquisition");
    const underlying = await acquire(path, timeoutMs);
    acquisitions += 1;
    active += 1;
    return {
      assertHeld: () => underlying.assertHeld(),
      async release() {
        try { await underlying.release(); } finally { active -= 1; }
      },
    };
  });
  return () => acquisitions;
}

const operations = ["load", "activate", "recover"] as const;
type Operation = typeof operations[number];
type Fixture = Awaited<ReturnType<typeof setup>>;
function invoke(f: Fixture, operation: Operation, lease: ProcessLockLease) {
  if (operation === "load") return f.store().load(lease);
  if (operation === "activate") return activateReleaseSet({ ...f.activation, lease });
  return recoverReleaseSet(f.root, { verifySnapshot: f.verifySnapshot, windowsAclVerifier, lease });
}

for (const operation of operations) {
  test(`${operation} consumes its branded lease without acquiring or releasing another lock`, async (t) => {
    const f = await setup(t);
    const acquisitions = countAcquisitions(t);
    await withUpdateLock(f.root, async (lease) => {
      const result = await invoke(f, operation, lease);
      if (operation === "activate") assert.deepEqual(result && "record" in result ? result.record : null, f.snapshot.record);
      else assert.equal(result, null);
      assertUpdateLockLease(lease, f.root);
      assert.equal(acquisitions(), 1);
    });
    assert.equal(acquisitions(), 1);
  });
}

test("one lease spans latest persisted policy, native materialization, activation and recovery", async (t) => {
  const f = await setup(t);
  const saved = await f.store().save({ trustState: f.fixture.options.verified.nextTrustState, validators: { etag: '"latest"', lastModified: null } });
  await writeFile(resolve(f.root, staleName), "stale", { mode: 0o600 });
  const acquisitions = countAcquisitions(t);
  await withUpdateLock(f.root, async (lease) => {
    assert.deepEqual(await f.store().load(lease), saved);
    await assert.rejects(lstat(resolve(f.root, staleName)), { code: "ENOENT" });
    const installed = await f.native.materialize(f.snapshot, lease);
    assert.deepEqual(await readFile(installed.path), f.fixture.native);
    const stored = await activateReleaseSet({ ...f.activation, lease });
    assert.deepEqual(stored.record, f.snapshot.record);
    // Idempotent replay and fresh-object recovery still authenticate the cache.
    assert.deepEqual((await activateReleaseSet({ ...f.activation, lease })).record, stored.record);
    const recovered = await recoverReleaseSet(f.root, { verifySnapshot: f.verifySnapshot, windowsAclVerifier, lease });
    assert.deepEqual(recovered?.record, stored.record);
    assert.deepEqual(Buffer.from(recovered!.cliBytes), Buffer.from(f.fixture.options.cliArchive));
    assert.deepEqual(await f.native.verify(f.snapshot, lease), installed);
    await assert.rejects(lstat(resolve(f.root, "activation-journal.json")), { code: "ENOENT" });
    assertUpdateLockLease(lease, f.root);
  });
  assert.equal(acquisitions(), 1);
});

async function tree(path: string): Promise<unknown> {
  let stat;
  try { stat = await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const identity = { mode: stat.mode, ino: stat.ino, dev: stat.dev, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  if (!stat.isDirectory()) return { ...identity, bytes: await readFile(path) };
  const entries = await readdir(path);
  return { ...identity, entries: await Promise.all(entries.sort().map(async (name) => [name, await tree(resolve(path, name))])) };
}

for (const operation of operations) {
  for (const invalid of ["wrong-root", "expired", "forged", "copied"] as const) {
    for (const target of ["missing", "populated"] as const) {
      test(`${operation} rejects ${invalid} lease before touching ${target} target`, async (t) => {
        const f = await setup(t);
        let expired: ProcessLockLease | undefined;
        if (invalid === "expired") {
          await withUpdateLock(f.root, async (lease) => { expired = lease; });
          await rm(f.root, { recursive: true });
        }
        if (target === "populated") {
          // A permissive root and a removable stale file expose preparation and
          // cleanup, not merely final publication, as forbidden target changes.
          await mkdir(f.root, { mode: 0o755 });
          await chmod(f.root, 0o755);
          await writeFile(resolve(f.root, staleName), "preserve stale bytes");
          await writeFile(resolve(f.root, "sentinel"), "preserve target");
        }
        const before = await tree(f.root);
        const rejected = async (lease: ProcessLockLease) => {
          await assert.rejects(invoke(f, operation, lease), (error: unknown) =>
            error instanceof ProcessLockError && error.reason === "unsafe" ||
            error instanceof Error && "code" in error && error.code === "UPDATE_SECURITY_ERROR");
          assert.deepEqual(await tree(f.root), before);
        };
        if (invalid === "wrong-root" || invalid === "copied") {
          await withUpdateLock(resolve(f.base, "owner"), async (lease) => {
            await rejected(invalid === "copied" ? { ...lease } : lease);
            assertUpdateLockLease(lease, resolve(f.base, "owner"));
          });
        } else if (invalid === "expired") await rejected(expired!);
        else await rejected({ assertHeld() {}, async release() {} });
      });
    }
  }
}

for (const point of ["after-cache-commit", "after-journal-commit"] as const) {
  test(`leased recovery preserves journal protocol after ${point}`, async (t) => {
    const f = await setup(t);
    const acquisitions = countAcquisitions(t);
    await withUpdateLock(f.root, async (lease) => {
      await assert.rejects(activateReleaseSet({ ...f.activation, lease, faultInjector: {
        hit(actual) { if (actual === point) throw new Error("simulated crash"); },
      } }), /simulated crash/);
      await lstat(resolve(f.root, "activation-journal.json"));
      const recovered = await recoverReleaseSet(f.root, { verifySnapshot: f.verifySnapshot, windowsAclVerifier, lease });
      assert.deepEqual(recovered?.record, f.snapshot.record);
      await assert.rejects(lstat(resolve(f.root, "activation-journal.json")), { code: "ENOENT" });
      assertUpdateLockLease(lease, f.root);
    });
    assert.equal(acquisitions(), 1);
  });
}

test("leased load keeps root identity checks before stale-file cleanup", async (t) => {
  const f = await setup(t);
  await withUpdateLock(f.root, async (lease) => {
    const swapped = f.store(f.root, { async hit(point) {
      if (point !== "after-lock-acquired") return;
      await rename(f.root, resolve(f.base, "original"));
      await mkdir(f.root, { mode: 0o700 });
      await writeFile(resolve(f.root, staleName), "do not clean replacement");
    } });
    await assert.rejects(swapped.load(lease), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(resolve(f.root, staleName), "utf8"), "do not clean replacement");
  });
});

test("independent calls still acquire their own locks and preserve signed state/cache behavior", async (t) => {
  const f = await setup(t);
  const acquisitions = countAcquisitions(t);
  assert.equal(await f.store().load(), null);
  const saved = await f.store().save({ trustState: f.fixture.options.verified.nextTrustState, validators: { etag: null, lastModified: null } });
  assert.deepEqual(await f.store().load(), saved);
  await f.native.materialize(f.snapshot);
  const stored = await activateReleaseSet(f.activation);
  assert.deepEqual(stored.record, f.snapshot.record);
  const recovered = await recoverReleaseSet(f.root, { verifySnapshot: f.verifySnapshot, windowsAclVerifier });
  assert.deepEqual(recovered?.record, stored.record);
  assert.equal(acquisitions(), 6);
});

for (const operation of ["activate", "recover"] as const) {
  test(`${operation} captures the validated lease before caller options can change`, async (t) => {
    const f = await setup(t);
    const acquisitions = countAcquisitions(t);
    await withUpdateLock(f.root, async lease => {
      const options: typeof f.activation & { lease?: ProcessLockLease } = { ...f.activation, lease };
      const pending = operation === "activate"
        ? activateReleaseSet(options)
        : recoverReleaseSet(f.root, options);
      delete options.lease;
      await pending;
      assertUpdateLockLease(lease, f.root);
      assert.equal(acquisitions(), 1, "the validated outer capability must remain the selected lock");
    });
    assert.equal(acquisitions(), 1);
  });
}
