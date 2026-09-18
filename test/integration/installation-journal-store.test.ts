import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolError } from "../../src/contracts/errors.ts";
import { createInstallationJournalStore } from "../../src/update/installation-journal-store.ts";
import { withUpdateLock } from "../../src/platform/lock.ts";
import { ProcessLockError, type ProcessLockLease } from "../../src/platform/process-lock.ts";
import { journalFixture, type JournalFixture } from "../helpers/installation-journal-fixture.ts";

async function withStateRoot<T>(callback: (stateRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "harness-mrtool-installation-journal-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fixtureForRoot(stateRoot: string): Promise<JournalFixture> {
  const journal = journalFixture("darwin-arm64", "prepared");
  const identity = await lstat(stateRoot, { bigint: true });
  journal.roots.state = { dev: String(identity.dev), ino: String(identity.ino) };
  return journal;
}

function assertSecurity(error: unknown): true {
  assert.ok(error instanceof ToolError);
  assert.equal(error.code, "UPDATE_SECURITY_ERROR");
  assert.equal(error.message, "installation journal store is unsafe");
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}

test("persists and reloads a canonical journal under the fixed state root", async () => {
  await withStateRoot(async (stateRoot) => {
    const store = createInstallationJournalStore(stateRoot);
    const journal = await fixtureForRoot(stateRoot);

    const written = await store.write(journal);
    assert.deepEqual(written, journal);
    const loaded = await store.read();
    assert.deepEqual(loaded, journal);

    const bytes = await readFile(store.path);
    assert.equal(new TextDecoder().decode(bytes), new TextDecoder().decode(store.encode(journal)));
    const info = await lstat(store.path);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(await readdir(stateRoot), ["installation-journal.json"]);
  });
});

test("does not follow a journal symlink and leaves the target untouched", async () => {
  await withStateRoot(async (stateRoot) => {
    const outside = join(stateRoot, "outside.json");
    await writeFile(outside, "outside\n", { mode: 0o600 });
    await symlink(outside, join(stateRoot, "installation-journal.json"));
    const store = createInstallationJournalStore(stateRoot);

    await assert.rejects(() => store.read(), assertSecurity);
    const journal = await fixtureForRoot(stateRoot);
    await assert.rejects(() => store.write(journal), assertSecurity);
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  });
});

test("rejects a journal with an external hard-link witness", async () => {
  if (process.platform === "win32") return;
  await withStateRoot(async (stateRoot) => {
    const store = createInstallationJournalStore(stateRoot);
    const journal = await fixtureForRoot(stateRoot);
    await store.write(journal);
    await link(store.path, join(stateRoot, "journal-alias"));

    await assert.rejects(() => store.read(), assertSecurity);
    await assert.rejects(() => store.write(journal), assertSecurity);
  });
});

test("rejects a relative or NUL-containing state root before any I/O", () => {
  assert.throws(() => createInstallationJournalStore("relative/state"), assertSecurity);
  assert.throws(() => createInstallationJournalStore("/tmp/unsafe\0state"), assertSecurity);
});


test("can bind persistence to the shared branded update lease", async () => {
  await withStateRoot(async (stateRoot) => {
    const journal = await fixtureForRoot(stateRoot);
    await withUpdateLock(stateRoot, async (lease) => {
      const store = createInstallationJournalStore(stateRoot, { lease });
      await store.write(journal);
      assert.ok(await store.read());
      await store.remove();
      lease.assertHeld();
    });
  });
});

test("a bound store rejects a forged lease before touching the journal root", async () => {
  await withStateRoot(async (stateRoot) => {
    const forged: ProcessLockLease = { assertHeld() {}, async release() {} };
    const store = createInstallationJournalStore(stateRoot, { lease: forged });
    await assert.rejects(() => store.read(), (error: unknown) => {
      assert.ok(error instanceof ProcessLockError);
      assert.equal(error.reason, "unsafe");
      return true;
    });
  });
});

test("removes only the owned canonical journal and treats absence as idempotent", async () => {
  await withStateRoot(async (stateRoot) => {
    const store = createInstallationJournalStore(stateRoot);
    const journal = await fixtureForRoot(stateRoot);
    await store.write(journal);
    await store.remove();
    assert.equal(await store.read(), null);
    await store.remove();
    assert.deepEqual(await readdir(stateRoot), []);
  });
});
