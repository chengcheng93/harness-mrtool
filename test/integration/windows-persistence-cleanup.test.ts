import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { mock } from "node:test";

import * as cacheModule from "../../src/update/cache.ts";
import * as lockModule from "../../src/platform/lock.ts";
import * as processModule from "../../src/platform/process-identity.ts";
import * as storeModule from "../../src/update/installation-journal-store.ts";
import * as installedModule from "../../src/update/installed-release-verification.ts";
import { encodeInstallationJournal, validateInstallationJournal } from "../../src/update/installation-journal.ts";
import { advanceInstallationJournalPhase, sealInstallationSettlement } from "../../src/update/installation-journal-coordination.ts";
import { encodeWindowsPersistenceDescriptor } from "../../src/update/windows-persistence-descriptor.ts";
import * as handoffModule from "../../src/update/windows-persistence-handoff.ts";
const { WINDOWS_LAUNCH_DESCRIPTOR_FILENAME } = handoffModule;
import { journalFixture, withLaunch } from "../helpers/installation-journal-fixture.ts";

const cases = [
  "descriptor deletion failure preserves journal and is retryable",
  "journal deletion failure resumes after descriptor is already absent",
  "descriptor observation failure preserves both recovery files",
  "replaced descriptor is never deleted",
  "missing journal does not authenticate a coherent-looking orphan",
  "malformed orphan descriptor fails closed",
  "active tuple mismatch preserves cleanup evidence",
  "installed verification failure preserves cleanup evidence",
  "committed cleanup is idempotent",
  "live helper prevents descriptor-less committed cleanup",
  "descriptor reappearance preserves the committed journal",
  "descriptor-less cleanup still requires the active tuple",
] as const;
type CleanupCase = typeof cases[number];

// Isolate the platform shim and ESM mocks in a subprocess. The normal repository
// test runner needs no experimental flags. Real descriptor observation, journal
// codec/store, filesystem mutations and recovery entry point run in the child.
// Native process/lock and signed cache/installed verification boundaries are
// controlled doubles: these synthetic fixtures do NOT prove Windows or crypto.
async function runCase(scenario: CleanupCase): Promise<void> {
  const root = await fs.mkdtemp(resolve(await fs.realpath(tmpdir()), "windows-persistence-cleanup-"));
  const state = resolve(root, "state");
  const installation = resolve(root, "installation");
  await fs.mkdir(state, { mode: 0o700 });
  await fs.mkdir(installation, { mode: 0o700 });
  const journalPath = resolve(state, "installation-journal.json");
  const descriptorPath = resolve(installation, WINDOWS_LAUNCH_DESCRIPTOR_FILENAME);
  const identity = async (path: string) => {
    const info = await fs.lstat(path, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino) };
  };
  const draft = withLaunch(journalFixture("windows-x64", "execution-pending"), "completed");
  draft.roots = { state: await identity(state), installation: await identity(installation) };
  assert.ok(draft.windows?.inner);
  draft.windows.inner.roots = structuredClone(draft.roots);
  const launch = draft.windows.launch;
  assert.ok(launch?.child);
  const descriptor = Buffer.from(encodeWindowsPersistenceDescriptor({
    schemaVersion: 1, launchId: launch.launchId, reservationId: launch.reservationId,
    attemptId: launch.attemptId, transactionId: launch.transactionId,
    expectedRevision: launch.expectedRevision, parent: launch.parent,
  }));
  await fs.writeFile(descriptorPath, descriptor, { mode: 0o600 });
  const descriptorHash = createHash("sha256").update(descriptor).digest("hex");
  const slot = draft.slots.find((item) => item.name === "launch-descriptor");
  assert.ok(slot?.state === "created");
  slot.identity = await identity(descriptorPath);
  slot.expectedSha256 = descriptorHash;
  slot.expectedSize = descriptor.byteLength;
  launch.descriptorSha256 = descriptorHash;
  launch.settlement = sealInstallationSettlement({
    state: "settled", launchId: launch.launchId, reservationId: launch.reservationId,
    descriptorSha256: descriptorHash, targetIdentity: launch.targetIdentity,
    parent: launch.parent, child: launch.child,
  });
  let journal = validateInstallationJournal(draft);
  for (const phase of ["publish-intent", "canonical-published", "marker-published", "commit-intent", "committed"] as const) {
    journal = advanceInstallationJournalPhase(journal, phase, phase === "committed" ? "next" : null);
  }
  const journalBytes = Buffer.from(encodeInstallationJournal(journal));
  await fs.writeFile(journalPath, journalBytes, { mode: 0o600 });
  await fs.writeFile(resolve(state, "active-release-set.json"), JSON.stringify(journal.next), { mode: 0o600 });

  let failDescriptorDelete = scenario === cases[0];
  let failJournalDelete = scenario === cases[1];
  let failDescriptorRead = scenario === cases[2];
  let descriptorObservations = 0;
  let locked = false;
  let verified = false;
  const securityFailure = () => Object.assign(new Error("injected installed authentication failure"), { code: "UPDATE_SECURITY_ERROR" });
  const active = {
    record: scenario === cases[6] || scenario === cases[11] ? journal.previous : journal.next,
    cliBytes: new Uint8Array(), templateBytes: new Uint8Array(), receiptBytes: new Uint8Array(),
    releaseDirectory: resolve(state, "release"), writesBlocked: false, writeBlockReasons: [],
  };
  class CacheDouble {
    async loadStagedReleaseSet() { return { ...active, record: journal.next, kind: "staged-release-set" }; }
    async loadLastKnownGoodOrNull() { return active; }
  }
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    mock.module("../../src/update/cache.ts", { namedExports: { ...cacheModule, UpdateCache: CacheDouble } });
    mock.module("../../src/platform/lock.ts", { namedExports: {
      ...lockModule,
      withUpdateLock: async <T>(path: string, work: (lease: unknown) => Promise<T>) => {
        assert.equal(path, state);
        return lockModule.withUpdateLock(path, work, { provider: { async acquire() {
          assert.equal(locked, false);
          locked = true;
          return { assertHeld() { assert.ok(locked); }, async release() { locked = false; } };
        } } });
      },
    } });
    mock.module("../../src/platform/process-identity.ts", { namedExports: {
      ...processModule,
      systemProcessIdentityProvider: { async inspect(pid: number) {
        return scenario === cases[9] && pid === launch.child!.pid
          ? { state: "alive", startKey: launch.child!.startKey } : { state: "dead" };
      } },
    } });
    mock.module("../../src/update/installed-release-verification.ts", { namedExports: {
      ...installedModule,
      verifyInstalledRelease: async () => {
        assert.ok(locked);
        if (scenario === cases[7]) throw securityFailure();
        verified = true;
        return { verification: "signed-installed-bytes", releaseSetId: journal.next.releaseSetId,
          cliVersion: journal.next.cliVersion, channelPayloadSha256: journal.nextEvidence.authorizationPayloadSha256 };
      },
    } });
    mock.module("../../src/update/installation-journal-store.ts", { namedExports: {
      ...storeModule,
      createInstallationJournalStore: (...args: Parameters<typeof storeModule.createInstallationJournalStore>) => {
        const store = storeModule.createInstallationJournalStore(...args);
        return { ...store, async remove() {
          assert.ok(locked);
          if (failJournalDelete) throw Object.assign(new Error("injected journal removal failure"), { code: "EACCES" });
          await store.remove();
        } };
      },
    } });
    mock.module("../../src/update/windows-persistence-handoff.ts", { namedExports: {
      ...handoffModule,
      async observeWindowsPersistenceDescriptor(path: string) {
        // The initial read succeeds; fail the re-observation at cleanup itself.
        descriptorObservations += 1;
        if (failDescriptorRead && descriptorObservations === 2) throw securityFailure();
        return handoffModule.observeWindowsPersistenceDescriptor(path);
      },
    } });
    mock.module("node:fs/promises", { namedExports: {
      ...fs,
      async rm(path: Parameters<typeof fs.rm>[0], options?: Parameters<typeof fs.rm>[1]) {
        if (path === descriptorPath) {
          assert.ok(locked, "descriptor cleanup must hold the update lock");
          assert.ok(verified, "descriptor cleanup must follow installed verification");
          assert.deepEqual(await fs.readFile(journalPath), journalBytes, "journal must survive until descriptor cleanup");
          if (failDescriptorDelete) throw Object.assign(new Error("injected descriptor removal failure"), { code: "EACCES" });
        }
        await fs.rm(path, options);
        if (path === descriptorPath && scenario === cases[10]) {
          await fs.writeFile(descriptorPath, "{untrusted replacement}", { mode: 0o600 });
        }
      },
    } });
    const { recoverWindowsPersistence } = await import("../../src/update/windows-persistence-helper.ts");
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const recover = () => recoverWindowsPersistence(state, installation);
    const absent = async (path: string) => assert.rejects(fs.lstat(path), { code: "ENOENT" });
    const preserved = async () => {
      assert.deepEqual(await fs.readFile(journalPath), journalBytes);
      assert.deepEqual(await fs.readFile(descriptorPath), descriptor);
    };
    if (scenario === cases[0] || scenario === cases[2]) {
      await assert.rejects(recover());
      await preserved();
      failDescriptorDelete = false;
      failDescriptorRead = false;
      assert.equal(await recover(), true);
      await absent(journalPath);
      await absent(descriptorPath);
    } else if (scenario === cases[1]) {
      await assert.rejects(recover());
      await absent(descriptorPath);
      assert.deepEqual(await fs.readFile(journalPath), journalBytes);
      failJournalDelete = false;
      assert.equal(await recover(), true);
      await absent(journalPath);
      assert.equal(await recover(), false);
    } else if (scenario === cases[3]) {
      // Same bytes but a different identity are not the admitted descriptor.
      await fs.rename(descriptorPath, `${descriptorPath}.original`);
      await fs.writeFile(descriptorPath, descriptor, { mode: 0o600 });
      await assert.rejects(recover(), { code: "UPDATE_SECURITY_ERROR" });
      await preserved();
    } else if (scenario === cases[4] || scenario === cases[5]) {
      await fs.rm(journalPath);
      if (scenario === cases[5]) await fs.writeFile(descriptorPath, "{untrusted}");
      const before = await fs.readFile(descriptorPath);
      await assert.rejects(recover());
      assert.deepEqual(await fs.readFile(descriptorPath), before);
      await absent(journalPath);
    } else if (scenario === cases[6] || scenario === cases[7]) {
      await assert.rejects(recover(), { code: "UPDATE_SECURITY_ERROR" });
      await preserved();
    } else if (scenario === cases[9] || scenario === cases[11]) {
      await fs.rm(descriptorPath);
      await assert.rejects(recover(), { code: "UPDATE_SECURITY_ERROR" });
      assert.deepEqual(await fs.readFile(journalPath), journalBytes);
    } else if (scenario === cases[10]) {
      await assert.rejects(recover(), { code: "UPDATE_SECURITY_ERROR" });
      assert.deepEqual(await fs.readFile(journalPath), journalBytes);
      assert.equal(await fs.readFile(descriptorPath, "utf8"), "{untrusted replacement}");
    } else {
      assert.equal(await recover(), true);
      await absent(journalPath);
      await absent(descriptorPath);
      assert.equal(await recover(), false);
    }
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const scenario = process.argv[2];
if (scenario !== undefined && cases.includes(scenario as CleanupCase)) {
  await runCase(scenario as CleanupCase);
} else {
  for (const name of cases) {
    test(`Windows persistence cleanup: ${name}`, () => {
      const result = spawnSync(process.execPath, ["--experimental-transform-types", "--experimental-test-module-mocks", import.meta.filename, name], {
        encoding: "utf8", timeout: 30_000, env: process.env,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.error, undefined);
    });
  }
}
