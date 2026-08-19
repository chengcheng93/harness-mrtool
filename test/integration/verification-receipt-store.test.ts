import assert from "node:assert/strict";
import { link, lstat, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  type VerificationReceiptLocator,
  type VerificationReceiptV1,
  validateVerificationReceipt,
} from "../../src/app/verify-mr.ts";
import {
  canonicalizeJson,
  sha256CanonicalJson,
  sha256Utf8,
  type JsonValue,
} from "../../src/contracts/jcs.ts";
import {
  systemProcessLockProvider,
  type ProcessLockLease,
  type ProcessLockProvider,
} from "../../src/platform/process-lock.ts";
import {
  type VerificationReceiptPublisher,
  VerificationReceiptStore,
} from "../../src/platform/verification-receipt-store.ts";

const REVIEW_STATE_IDS = [
  "source-branch-synced",
  "commit-convention",
  "work-item-reviewed",
  "metadata-reviewed",
  "secret-scan-reviewed",
  "repository-hygiene-reviewed",
  "ci-status",
  "reviewer-requested",
  "high-risk-reviewers",
  "blocking-issues",
] as const;

function receiptFixture(overrides: Record<string, unknown> = {}): VerificationReceiptV1 {
  const bundleManifestHash = "a".repeat(64);
  const stateMap = Object.fromEntries(REVIEW_STATE_IDS.map((id) => [id, "pending"]));
  const marker = {
    releaseTag: "templates-v1.0.0",
    bundleId: "harness-mr-default",
    bundleVersion: "1.0.0",
    bundleManifestHash,
    profileIds: ["general"],
    policySchema: 1,
    cliVersion: "0.1.0-dev",
    renderPhase: "final",
    stateMap,
    requestDigest: "b".repeat(64),
    snapshotDigest: "c".repeat(64),
    writePlanDigest: "d".repeat(64),
    bodyDigest: sha256Utf8("Managed description\n"),
  };
  const encodedMarker = Buffer.from(canonicalizeJson(marker), "utf8").toString("base64url");
  const description = `Managed description\n<!-- harness-mrtool:v1 ${encodedMarker} -->\n`;
  return validateVerificationReceipt({
    receiptVersion: 1,
    gitlabOrigin: "https://gitlab.example.test",
    iid: 88,
    webUrl: "https://gitlab.example.test/group/project/-/merge_requests/88",
    sourceProject: { id: "project:90", path: "fork/project" },
    targetProject: { id: "project:100", path: "group/project" },
    sourceBranch: "fix/receipt-store",
    targetBranch: "main",
    sourceHeadSha: "e".repeat(40),
    authorUserId: "user:7",
    lifecycle: "ready",
    riskLevel: "medium",
    expected: {
      title: "Store durable verification receipt",
      description,
      labelIds: [],
      assigneeUserId: null,
      reviewerUserIds: [],
      squash: true,
      removeSourceBranch: true,
    },
    labelBindings: [],
    userBindings: [{ id: "user:7", username: "author", displayName: "Author" }],
    marker,
    bundle: {
      releaseTag: marker.releaseTag,
      bundleId: marker.bundleId,
      bundleVersion: marker.bundleVersion,
      bundleManifestHash,
      policySchema: marker.policySchema,
    },
    ...overrides,
  });
}

function locatorFor(receipt: VerificationReceiptV1): VerificationReceiptLocator {
  return Object.freeze({
    gitlabOrigin: receipt.gitlabOrigin,
    targetProjectId: receipt.targetProject.id,
    iid: receipt.iid,
    markerDigest: sha256CanonicalJson(receipt.marker as unknown as JsonValue),
  });
}

function receiptNames(locator: VerificationReceiptLocator): {
  readonly final: string;
  readonly pending: string;
} {
  const digest = sha256CanonicalJson(locator);
  return Object.freeze({ final: `${digest}.json`, pending: `${digest}.pending.json` });
}

function serializedRecord(receipt: VerificationReceiptV1): Buffer {
  return Buffer.from(`${canonicalizeJson({
    storeVersion: 1,
    locator: locatorFor(receipt),
    receipt,
  })}\n`, "utf8");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for concurrent store operation")), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class ObservedSystemLockProvider implements ProcessLockProvider {
  acquisitions = 0;
  active = 0;
  maximumActive = 0;

  async acquire(path: string, timeoutMs: number): Promise<ProcessLockLease> {
    const lease = await systemProcessLockProvider.acquire(path, timeoutMs);
    this.acquisitions += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    let released = false;
    return {
      assertHeld: () => lease.assertHeld(),
      release: async () => {
        if (released) return;
        released = true;
        this.active -= 1;
        try {
          await lease.release();
        } catch (error) {
          this.active += 1;
          throw error;
        }
      },
    };
  }
}

const hardLinkPublisher: VerificationReceiptPublisher = Object.freeze({
  strategy: "hard-link",
  publishNoReplace: link,
});

function observedMovePublisher(
  moves: Array<readonly [string, string]> = [],
): VerificationReceiptPublisher {
  return Object.freeze({
    strategy: "windows-write-through-move" as const,
    async publishNoReplace(sourcePath: string, destinationPath: string): Promise<void> {
      moves.push([sourcePath, destinationPath]);
      try {
        await lstat(destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await rename(sourcePath, destinationPath);
          return;
        }
        throw error;
      }
      throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    },
  });
}

test("rejects a blank state directory before resolving or touching disk", () => {
  for (const stateDirectory of ["", " ", "\t\r\n"]) {
    assert.throws(
      () => new VerificationReceiptStore({ stateDirectory }),
      (error: unknown) => error instanceof TypeError,
    );
  }
});

test("stores and reloads a validated receipt under its exact locator digest", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-store-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const aclChecks: string[] = [];
  const store = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async (path) => { aclChecks.push(path); } },
  });

  await store.stageAuthenticated(receipt);

  const loaded = await store.loadVerified(locator);
  assert.deepEqual(loaded, { trusted: true, receipt });
  const names = receiptNames(locator);
  const entries = (await readdir(store.receiptDirectory)).sort();
  const finalPath = resolve(store.receiptDirectory, names.final);
  const pendingPath = resolve(store.receiptDirectory, names.pending);
  const finalIdentity = await lstat(finalPath, { bigint: true });
  const serialized = await readFile(finalPath, "utf8");
  if (process.platform === "win32") {
    assert.deepEqual(entries, [names.final]);
    assert.equal(finalIdentity.nlink, 1n);
    await assert.rejects(readFile(pendingPath), hasCode("ENOENT"));
  } else {
    assert.deepEqual(entries, [names.final, names.pending].sort());
    const pendingIdentity = await lstat(pendingPath, { bigint: true });
    assert.equal(finalIdentity.dev, pendingIdentity.dev);
    assert.equal(finalIdentity.ino, pendingIdentity.ino);
    assert.equal(finalIdentity.nlink, 2n);
    assert.equal(pendingIdentity.nlink, 2n);
    assert.equal(await readFile(pendingPath, "utf8"), serialized);
  }
  assert.equal(serialized, `${canonicalizeJson(JSON.parse(serialized))}\n`);
  assert.equal(serialized.toLowerCase().includes("bearer"), false);
  assert.equal(process.platform === "win32" ? aclChecks.length >= 2 : aclChecks.length, process.platform === "win32" ? true : 0);
});

test("records safe corruption evidence without moving non-canonical receipt bytes", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-corrupt-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const store = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const corrupt = '{ "storeVersion": 1 }\n';
  const path = resolve(store.receiptDirectory, filename);
  await writeFile(path, corrupt, "utf8");

  await assert.rejects(
    store.loadVerified(locator),
    hasCode("UPDATE_SECURITY_ERROR"),
  );

  const entries = await readdir(store.receiptDirectory);
  assert.equal(entries.includes(filename), true);
  assert.equal(entries.some((entry) => entry.startsWith(`${filename}.corrupt.`)), true);
  assert.equal(await readFile(path, "utf8"), corrupt);
});

test("records one deterministic evidence file for repeated reads of the same corruption", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-evidence-once-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const store = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  await writeFile(resolve(store.receiptDirectory, filename), '{ "storeVersion": 1 }\n', "utf8");

  await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  const afterFirst = (await readdir(store.receiptDirectory)).filter((entry) => entry.startsWith(`${filename}.corrupt.`));
  await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  const afterSecond = (await readdir(store.receiptDirectory)).filter((entry) => entry.startsWith(`${filename}.corrupt.`));

  assert.equal(afterFirst.length, 1);
  assert.deepEqual(afterSecond, afterFirst);
});

test("preserves and resumes a pending evidence file after a handled write failure", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-evidence-failure-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const receiptDirectory = resolve(stateDirectory, "verification-receipts");
  const base = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await base.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  await writeFile(resolve(receiptDirectory, filename), '{ "storeVersion": 1 }\n', "utf8");
  let injected = false;
  const failing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-evidence-create-open") {
          injected = true;
          throw new Error("simulated evidence sync failure");
        }
      },
    },
  });

  await assert.rejects(failing.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(injected, true);
  const afterFailure = (await readdir(receiptDirectory)).filter((entry) => entry.includes(".corrupt."));
  assert.equal(afterFailure.length, 1);
  assert.equal(await readFile(resolve(receiptDirectory, afterFailure[0] as string), "utf8"), "");

  await assert.rejects(base.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  const afterRetry = (await readdir(receiptDirectory)).filter((entry) => entry.includes(".corrupt."));
  assert.deepEqual(afterRetry, afterFailure);
  assert.notEqual(await readFile(resolve(receiptDirectory, afterRetry[0] as string), "utf8"), "");
});

test("caps store-wide corruption evidence without moving repeatedly tampered source bytes", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-evidence-cap-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const processLockProvider: ProcessLockProvider = {
    async acquire() {
      let held = true;
      return {
        assertHeld() {
          if (!held) throw new Error("test lease was released");
        },
        async release() {
          held = false;
        },
      };
    },
  };
  const store = new VerificationReceiptStore({
    stateDirectory,
    processLockProvider,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const path = resolve(store.receiptDirectory, filename);
  let activeCorruption = "";

  for (let index = 0; index < 40; index += 1) {
    activeCorruption = `${canonicalizeJson({ invalid: "x".repeat(index + 1) })}\n`;
    await writeFile(path, activeCorruption, "utf8");
    await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
    assert.equal(await readFile(path, "utf8"), activeCorruption);
  }

  const evidence = (await readdir(store.receiptDirectory))
    .filter((entry) => entry.includes(".corrupt."));
  assert.equal(evidence.length, 32);
  assert.equal(await readFile(path, "utf8"), activeCorruption);
});

test("fails closed before creating evidence when the directory scan hard limit is exceeded", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-scan-cap-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const processLockProvider: ProcessLockProvider = {
    async acquire() {
      return { assertHeld() {}, async release() {} };
    },
  };
  const store = new VerificationReceiptStore({
    stateDirectory,
    processLockProvider,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);
  const finalPath = resolve(store.receiptDirectory, receiptNames(locator).final);
  const corruption = '{"invalid":"directory-overflow"}\n';
  await writeFile(finalPath, corruption, "utf8");
  for (let index = 0; index < 257; index += 1) {
    await writeFile(resolve(store.receiptDirectory, `unrelated-${index}.txt`), "sentinel", "utf8");
  }

  await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));

  assert.equal(await readFile(finalPath, "utf8"), corruption);
  assert.equal((await readdir(store.receiptDirectory)).some((entry) => entry.includes(".corrupt.")), false);
});

test("never moves an active replacement when identity diverges at the evidence boundary", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-evidence-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const base = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await base.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const path = resolve(base.receiptDirectory, filename);
  const original = `${path}.original-corrupt`;
  const corrupt = '{ "storeVersion": 1 }\n';
  const replacement = "replacement remains active\n";
  await writeFile(path, corrupt, "utf8");
  let injected = false;
  const racing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "before-corrupt-evidence") {
          injected = true;
          await rename(path, original);
          await writeFile(path, replacement, "utf8");
        }
      },
    },
  });

  await assert.rejects(racing.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(injected, true);
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.equal(await readFile(original, "utf8"), corrupt);
  assert.equal((await readdir(base.receiptDirectory)).some((entry) => entry.includes(".corrupt.")), false);
});

test("detects a receipt path replacement after opening without quarantining the replacement", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const base = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await base.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const path = resolve(base.receiptDirectory, filename);
  const openedPath = `${path}.opened`;
  const original = await readFile(path, "utf8");
  let injected = false;
  const raced = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-read-open" && !injected) {
          injected = true;
          await rename(path, openedPath);
          await writeFile(path, "replacement\n", "utf8");
        }
      },
    },
  });

  await assert.rejects(
    raced.loadVerified(locator),
    hasCode("UPDATE_SECURITY_ERROR"),
  );
  assert.equal(injected, true);
  assert.equal(await readFile(path, "utf8"), "replacement\n");
  assert.equal(await readFile(openedPath, "utf8"), original);
  assert.equal((await readdir(base.receiptDirectory)).some((entry) => entry.includes(".corrupt.")), false);
});

test("detects same-inode timestamp mutation after opening and does not record stale evidence", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-in-place-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const base = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await base.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const path = resolve(base.receiptDirectory, filename);
  const original = await readFile(path, "utf8");
  let injected = false;
  const racing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-read-open" && !injected) {
          injected = true;
          await utimes(path, new Date(0), new Date(0));
        }
      },
    },
  });

  await assert.rejects(racing.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(injected, true);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await readdir(base.receiptDirectory)).some((entry) => entry.includes(".corrupt.")), false);
});

test("rejects a hard-linked receipt while preserving both links and recording evidence", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-hardlink-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const store = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const path = resolve(store.receiptDirectory, filename);
  const outside = resolve(stateDirectory, "receipt-hardlink.json");
  const original = await readFile(path, "utf8");
  await link(path, outside);

  await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readFile(outside, "utf8"), original);
  assert.equal((await lstat(path, { bigint: true })).nlink, process.platform === "win32" ? 2n : 3n);
  assert.equal((await readdir(store.receiptDirectory)).some((entry) => entry.startsWith(`${filename}.corrupt.`)), true);
});

test("create-once storage is idempotent for an exact receipt and rejects a conflicting receipt", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-immutable-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const original = receiptFixture();
  const conflicting = validateVerificationReceipt({
    ...structuredClone(original),
    webUrl: "https://gitlab.example.test/group/project/-/merge_requests/88-conflict",
  });
  const locator = locatorFor(original);
  const base = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await base.stageAuthenticated(original);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const path = resolve(base.receiptDirectory, filename);
  const before = await readFile(path, "utf8");
  const idempotent = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });

  await idempotent.stageAuthenticated(structuredClone(original));
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(base.stageAuthenticated(conflicting), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(
    (await readdir(base.receiptDirectory)).sort(),
    process.platform === "win32" ? [filename] : [filename, receiptNames(locator).pending].sort(),
  );
});

test("re-establishes file and directory durability before idempotent hard-link success after restart", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-idempotent-sync-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  let crashed = false;
  const afterLinkCrash = new VerificationReceiptStore({
    stateDirectory,
    publisher: hardLinkPublisher,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      hit(point) {
        if (point === "after-publication-link" && !crashed) {
          crashed = true;
          throw new Error("simulated process loss after publication link");
        }
      },
    },
  });

  await assert.rejects(afterLinkCrash.stageAuthenticated(receipt), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(crashed, true);

  const barriers: string[] = [];
  const restarted = new VerificationReceiptStore({
    stateDirectory,
    publisher: hardLinkPublisher,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      hit(point) {
        if (point === "after-idempotent-file-sync" || point === "after-idempotent-directory-sync") {
          barriers.push(point);
        }
      },
    },
  });

  await restarted.stageAuthenticated(receipt);
  assert.deepEqual(barriers, ["after-idempotent-file-sync", "after-idempotent-directory-sync"]);
  assert.deepEqual(await restarted.loadVerified(locatorFor(receipt)), { trusted: true, receipt });
});

test("write-through move publishes once and refreshes an exact final without republishing", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-move-publish-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const names = receiptNames(locatorFor(receipt));
  const moves: Array<readonly [string, string]> = [];
  const barriers: string[] = [];
  const store = new VerificationReceiptStore({
    stateDirectory,
    publisher: observedMovePublisher(moves),
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      hit(point) {
        if (point === "after-idempotent-file-sync" || point === "after-idempotent-final-revalidation") {
          barriers.push(point);
        }
      },
    },
  });

  await store.stageAuthenticated(receipt);
  await store.stageAuthenticated(structuredClone(receipt));

  const finalPath = resolve(store.receiptDirectory, names.final);
  const pendingPath = resolve(store.receiptDirectory, names.pending);
  assert.deepEqual(moves, [[pendingPath, finalPath]]);
  assert.deepEqual(barriers, ["after-idempotent-file-sync", "after-idempotent-final-revalidation"]);
  assert.deepEqual(await readdir(store.receiptDirectory), [names.final]);
  assert.deepEqual(await readFile(finalPath), serializedRecord(receipt));
  await assert.rejects(readFile(pendingPath), hasCode("ENOENT"));
});

test("recovers an initial durable write-through pending receipt after restart", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-move-recovery-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const finalPath = resolve(stateDirectory, "verification-receipts", names.final);
  const pendingPath = resolve(stateDirectory, "verification-receipts", names.pending);
  const publisher = observedMovePublisher();
  let interrupted = false;
  const crashingPublication = new VerificationReceiptStore({
    stateDirectory,
    publisher,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      hit(point) {
        if (point === "before-publication") {
          interrupted = true;
          throw new Error("simulated restart before initial write-through publication");
        }
      },
    },
  });
  await assert.rejects(crashingPublication.stageAuthenticated(receipt), hasCode("INTERNAL_ERROR"));
  assert.equal(interrupted, true);
  await assert.rejects(readFile(finalPath), hasCode("ENOENT"));
  assert.deepEqual(await readFile(pendingPath), serializedRecord(receipt));
  assert.equal(await crashingPublication.loadVerified(locator), null);

  const restarted = new VerificationReceiptStore({
    stateDirectory,
    publisher,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await restarted.stageAuthenticated(receipt);
  assert.deepEqual(await readFile(finalPath), serializedRecord(receipt));
  await assert.rejects(readFile(pendingPath), hasCode("ENOENT"));
  assert.deepEqual(await restarted.loadVerified(locator), { trusted: true, receipt });
});

test("idempotent write-through durability faults leave the final loadable without republishing", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-final-recovery-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const finalPath = resolve(stateDirectory, "verification-receipts", names.final);
  const pendingPath = resolve(stateDirectory, "verification-receipts", names.pending);
  const moves: Array<readonly [string, string]> = [];
  const publisher = observedMovePublisher(moves);
  const initial = new VerificationReceiptStore({
    stateDirectory,
    publisher,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await initial.stageAuthenticated(receipt);

  let interrupted = false;
  const crashingRefresh = new VerificationReceiptStore({
    stateDirectory,
    publisher,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      hit(point) {
        if (point === "after-idempotent-final-revalidation") {
          interrupted = true;
          throw new Error("simulated restart after idempotent final revalidation");
        }
      },
    },
  });
  await assert.rejects(crashingRefresh.stageAuthenticated(receipt), hasCode("INTERNAL_ERROR"));
  assert.equal(interrupted, true);
  assert.deepEqual(await readFile(finalPath), serializedRecord(receipt));
  await assert.rejects(readFile(pendingPath), hasCode("ENOENT"));
  assert.deepEqual(await crashingRefresh.loadVerified(locator), { trusted: true, receipt });
  assert.deepEqual(moves, [[pendingPath, finalPath]]);

  const restarted = new VerificationReceiptStore({
    stateDirectory,
    publisher,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await restarted.stageAuthenticated(receipt);
  assert.deepEqual(await restarted.loadVerified(locator), { trusted: true, receipt });
  assert.deepEqual(moves, [[pendingPath, finalPath]]);
});

test("preserves an exact pending prefix after failure and resumes it without deletion", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-create-failure-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const finalPath = resolve(stateDirectory, "verification-receipts", names.final);
  const pendingPath = resolve(stateDirectory, "verification-receipts", names.pending);
  const complete = serializedRecord(receipt);
  const prefix = complete.subarray(0, Math.floor(complete.length / 2));
  const failing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-pending-create-open") {
          await writeFile(pendingPath, prefix);
          throw new Error("simulated write failure");
        }
      },
    },
  });

  await assert.rejects(failing.stageAuthenticated(receipt), hasCode("INTERNAL_ERROR"));
  await assert.rejects(readFile(finalPath), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  assert.deepEqual(await readFile(pendingPath), prefix);

  const retry = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await retry.stageAuthenticated(receipt);
  assert.deepEqual(
    (await readdir(retry.receiptDirectory)).sort(),
    process.platform === "win32" ? [names.final] : [names.final, names.pending].sort(),
  );
  assert.deepEqual(await readFile(finalPath), complete);
  if (process.platform === "win32") {
    await assert.rejects(readFile(pendingPath), hasCode("ENOENT"));
  } else {
    assert.deepEqual(await readFile(pendingPath), complete);
  }
  assert.deepEqual(await retry.loadVerified(locator), { trusted: true, receipt });
});

test("never writes through or removes a replacement installed at the pending path", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-pending-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const receiptDirectory = resolve(stateDirectory, "verification-receipts");
  const finalPath = resolve(receiptDirectory, names.final);
  const pendingPath = resolve(receiptDirectory, names.pending);
  const openedPending = `${pendingPath}.opened`;
  const replacement = "untrusted replacement remains active\n";
  let injected = false;
  const racing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-pending-open" && !injected) {
          injected = true;
          await rename(pendingPath, openedPending);
          await writeFile(pendingPath, replacement, "utf8");
        }
      },
    },
  });

  await assert.rejects(racing.stageAuthenticated(receipt), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(injected, true);
  assert.equal(await readFile(pendingPath, "utf8"), replacement);
  assert.equal((await lstat(openedPending)).isFile(), true);
  await assert.rejects(readFile(finalPath), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
});

test("atomic publication never overwrites or removes an existing final-path replacement", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-publish-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const receiptDirectory = resolve(stateDirectory, "verification-receipts");
  const finalPath = resolve(receiptDirectory, names.final);
  const pendingPath = resolve(receiptDirectory, names.pending);
  const replacement = "untrusted final replacement remains active\n";
  let injected = false;
  const racing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "before-publication") {
          injected = true;
          await writeFile(finalPath, replacement, "utf8");
        }
      },
    },
  });

  await assert.rejects(racing.stageAuthenticated(receipt), hasCode("UPDATE_SECURITY_ERROR"));

  assert.equal(injected, true);
  assert.equal(await readFile(finalPath, "utf8"), replacement);
  assert.deepEqual(await readFile(pendingPath), serializedRecord(receipt));
});

test("never links, overwrites, or removes a replacement installed at the link source", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-link-source-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const receiptDirectory = resolve(stateDirectory, "verification-receipts");
  const finalPath = resolve(receiptDirectory, names.final);
  const pendingPath = resolve(receiptDirectory, names.pending);
  const preparedPending = `${pendingPath}.prepared-original`;
  const replacement = "untrusted pending replacement before link\n";
  let injected = false;
  const racing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "before-publication") {
          injected = true;
          await rename(pendingPath, preparedPending);
          await writeFile(pendingPath, replacement, "utf8");
        }
      },
    },
  });

  await assert.rejects(racing.stageAuthenticated(receipt), hasCode("UPDATE_SECURITY_ERROR"));

  assert.equal(injected, true);
  assert.equal(await readFile(pendingPath, "utf8"), replacement);
  assert.deepEqual(await readFile(preparedPending), serializedRecord(receipt));
  await assert.rejects(readFile(finalPath), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
});

test("never accepts or removes a source replacement installed inside the publisher gap", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-publisher-source-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const receiptDirectory = resolve(stateDirectory, "verification-receipts");
  const finalPath = resolve(receiptDirectory, names.final);
  const pendingPath = resolve(receiptDirectory, names.pending);
  const preparedPending = `${pendingPath}.verified-original`;
  const replacement = "replacement installed after the verified handle closed\n";
  let injected = false;
  const publisher: VerificationReceiptPublisher = Object.freeze({
    strategy: "windows-write-through-move",
    async publishNoReplace(sourcePath: string, destinationPath: string) {
      injected = true;
      await rename(sourcePath, preparedPending);
      await writeFile(sourcePath, replacement, "utf8");
      await rename(sourcePath, destinationPath);
    },
  });
  const racing = new VerificationReceiptStore({
    stateDirectory,
    publisher,
    windowsAclVerifier: { verify: async () => undefined },
  });

  await assert.rejects(racing.stageAuthenticated(receipt), hasCode("UPDATE_SECURITY_ERROR"));

  assert.equal(injected, true);
  assert.equal(await readFile(finalPath, "utf8"), replacement);
  assert.deepEqual(await readFile(preparedPending), serializedRecord(receipt));
  await assert.rejects(readFile(pendingPath), hasCode("ENOENT"));
});

test("preserves every path and fails closed when final diverges after a successful link", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-post-link-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const receiptDirectory = resolve(stateDirectory, "verification-receipts");
  const finalPath = resolve(receiptDirectory, names.final);
  const pendingPath = resolve(receiptDirectory, names.pending);
  const linkedFinal = `${finalPath}.linked-original`;
  const replacement = "replacement after successful publication link\n";
  let injected = false;
  const racing = new VerificationReceiptStore({
    stateDirectory,
    publisher: hardLinkPublisher,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-publication-link") {
          injected = true;
          await rename(finalPath, linkedFinal);
          await writeFile(finalPath, replacement, "utf8");
        }
      },
    },
  });

  await assert.rejects(racing.stageAuthenticated(receipt), hasCode("UPDATE_SECURITY_ERROR"));

  assert.equal(injected, true);
  assert.equal(await readFile(finalPath, "utf8"), replacement);
  assert.deepEqual(await readFile(pendingPath), serializedRecord(receipt));
  assert.deepEqual(await readFile(linkedFinal), serializedRecord(receipt));
});

test("rechecks the publication witness after directory sync and preserves a late replacement", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-post-sync-race-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const receiptDirectory = resolve(stateDirectory, "verification-receipts");
  const finalPath = resolve(receiptDirectory, names.final);
  const pendingPath = resolve(receiptDirectory, names.pending);
  const linkedPending = `${pendingPath}.linked-original`;
  const replacement = "replacement after directory sync\n";
  let injected = false;
  const racing = new VerificationReceiptStore({
    stateDirectory,
    publisher: hardLinkPublisher,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-publication-directory-sync") {
          injected = true;
          await rename(pendingPath, linkedPending);
          await writeFile(pendingPath, replacement, "utf8");
        }
      },
    },
  });

  await assert.rejects(racing.stageAuthenticated(receipt), hasCode("UPDATE_SECURITY_ERROR"));

  assert.equal(injected, true);
  assert.equal(await readFile(pendingPath, "utf8"), replacement);
  assert.deepEqual(await readFile(finalPath), serializedRecord(receipt));
  assert.deepEqual(await readFile(linkedPending), serializedRecord(receipt));
});

test("does not load a full-length pending receipt until a restart fsyncs and publishes it", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-prefsync-crash-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const finalPath = resolve(stateDirectory, "verification-receipts", names.final);
  const pendingPath = resolve(stateDirectory, "verification-receipts", names.pending);
  const complete = serializedRecord(receipt);
  const crashing = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      hit(point) {
        if (point === "after-pending-write-before-sync") {
          throw new Error("simulated crash before file fsync");
        }
      },
    },
  });

  await assert.rejects(crashing.stageAuthenticated(receipt), hasCode("INTERNAL_ERROR"));
  assert.deepEqual(await readFile(pendingPath), complete);
  await assert.rejects(readFile(finalPath), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  assert.equal(await crashing.loadVerified(locator), null);

  const restarted = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await restarted.stageAuthenticated(receipt);
  assert.deepEqual(await readFile(finalPath), complete);
  assert.deepEqual(await restarted.loadVerified(locator), { trusted: true, receipt });
});

test("rejects a final receipt whose required pending publication witness is missing", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-missing-witness-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const names = receiptNames(locator);
  const store = new VerificationReceiptStore({
    stateDirectory,
    publisher: hardLinkPublisher,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);
  const finalPath = resolve(store.receiptDirectory, names.final);
  const pendingPath = resolve(store.receiptDirectory, names.pending);
  const published = await readFile(finalPath);
  await rm(pendingPath);

  await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));

  assert.deepEqual(await readFile(finalPath), published);
});

test("concurrent writers share one OS lock and cannot overwrite a published receipt", async (t) => {
  if (process.platform !== "win32" && process.platform !== "linux") {
    t.skip("system process locks are unavailable on this platform");
    return;
  }
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-writers-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const original = receiptFixture();
  const conflicting = validateVerificationReceipt({
    ...structuredClone(original),
    webUrl: "https://gitlab.example.test/group/project/-/merge_requests/88-concurrent-conflict",
  });
  const locator = locatorFor(original);
  const provider = new ObservedSystemLockProvider();
  const entered = deferred();
  const releaseFirst = deferred();
  const first = new VerificationReceiptStore({
    stateDirectory,
    processLockProvider: provider,
    lockTimeoutMs: 5_000,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-lock-acquired") {
          entered.resolve();
          await releaseFirst.promise;
        }
      },
    },
  });
  const second = new VerificationReceiptStore({
    stateDirectory,
    processLockProvider: provider,
    lockTimeoutMs: 5_000,
    windowsAclVerifier: { verify: async () => undefined },
  });

  const firstWrite = first.stageAuthenticated(original);
  await within(entered.promise);
  let secondSettled = false;
  const secondWrite = second.stageAuthenticated(conflicting).then(
    () => null,
    (error: unknown) => error,
  ).finally(() => { secondSettled = true; });
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(secondSettled, false);
  releaseFirst.resolve();
  await within(firstWrite);
  const conflict = await within(secondWrite);

  assert.equal(hasCode("UPDATE_SECURITY_ERROR")(conflict), true);
  assert.equal(provider.acquisitions, 2);
  assert.equal(provider.maximumActive, 1);
  const loaded = await second.loadVerified(locator);
  assert.equal(validateVerificationReceipt(loaded?.receipt).webUrl, original.webUrl);
});

test("a reader waits for the writer's OS-lock publication before loading", async (t) => {
  if (process.platform !== "win32" && process.platform !== "linux") {
    t.skip("system process locks are unavailable on this platform");
    return;
  }
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-reader-writer-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const provider = new ObservedSystemLockProvider();
  const entered = deferred();
  const releaseWriter = deferred();
  const writer = new VerificationReceiptStore({
    stateDirectory,
    processLockProvider: provider,
    lockTimeoutMs: 5_000,
    windowsAclVerifier: { verify: async () => undefined },
    faultInjector: {
      async hit(point) {
        if (point === "after-lock-acquired") {
          entered.resolve();
          await releaseWriter.promise;
        }
      },
    },
  });
  const reader = new VerificationReceiptStore({
    stateDirectory,
    processLockProvider: provider,
    lockTimeoutMs: 5_000,
    windowsAclVerifier: { verify: async () => undefined },
  });

  const write = writer.stageAuthenticated(receipt);
  await within(entered.promise);
  let readSettled = false;
  const read = reader.loadVerified(locator).finally(() => { readSettled = true; });
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(readSettled, false);
  releaseWriter.resolve();
  await within(write);
  const loaded = await within(read);

  assert.deepEqual(loaded, { trusted: true, receipt });
  assert.equal(provider.acquisitions, 2);
  assert.equal(provider.maximumActive, 1);
});

test("returns null unless origin, target project, IID, and marker digest locate an exact receipt", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-locator-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const store = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);

  for (const mismatched of [
    { ...locator, gitlabOrigin: "https://other-gitlab.example.test" },
    { ...locator, targetProjectId: "project:101" },
    { ...locator, iid: 89 },
    { ...locator, markerDigest: "0".repeat(64) },
  ]) {
    assert.equal(await store.loadVerified(mismatched), null);
  }
  assert.deepEqual(await store.loadVerified(locator), { trusted: true, receipt });
});

test("rejects standard bearer credentials before opening any store file", async (t) => {
  for (const title of [
    "Bearer persisted-secret-value",
    "Authorization: Bearer persisted-secret-value",
    "authorization=Bearer persisted-secret-value",
    "Private-Token: persisted-secret-value",
    "private-token = persisted-secret-value",
    "JOB-TOKEN: persisted-secret-value",
    "Job-Token = persisted-secret-value",
  ]) {
    const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-secret-"));
    t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
    const receipt = receiptFixture();
    const unsafe = {
      ...structuredClone(receipt),
      expected: { ...structuredClone(receipt.expected), title },
    } as VerificationReceiptV1;
    const store = new VerificationReceiptStore({
      stateDirectory,
      windowsAclVerifier: { verify: async () => undefined },
    });

    let caught: unknown;
    try {
      await store.stageAuthenticated(unsafe);
    } catch (error) {
      caught = error;
    }
    assert.equal(hasCode("POSTCONDITION_ERROR")(caught), true, title);
    assert.equal(`${String(caught)}${JSON.stringify(caught)}`.includes("persisted-secret-value"), false);
    assert.deepEqual(await readdir(stateDirectory), []);
  }
});

test("records evidence for duplicate keys, locator-bound receipt tampering, and oversized bytes", async (t) => {
  const scenarios = ["duplicate", "binding", "oversized"] as const;
  for (const scenario of scenarios) {
    const stateDirectory = await mkdtemp(resolve(tmpdir(), `harness-mrtool-receipt-${scenario}-`));
    t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
    const receipt = receiptFixture();
    const locator = locatorFor(receipt);
    const store = new VerificationReceiptStore({
      stateDirectory,
      windowsAclVerifier: { verify: async () => undefined },
    });
    await store.stageAuthenticated(receipt);
    const filename = `${sha256CanonicalJson(locator)}.json`;
    const path = resolve(store.receiptDirectory, filename);
    if (scenario === "duplicate") {
      await writeFile(path, '{"storeVersion":1,"storeVersion":1}\n', "utf8");
    } else if (scenario === "binding") {
      const document = JSON.parse(await readFile(path, "utf8")) as {
        receipt: { iid: number };
      };
      document.receipt.iid += 1;
      await writeFile(path, `${canonicalizeJson(document)}\n`, "utf8");
    } else {
      await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    }

    await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
    const entries = await readdir(store.receiptDirectory);
    assert.equal(entries.includes(filename), true, scenario);
    assert.equal(entries.some((entry) => entry.startsWith(`${filename}.corrupt.`)), true, scenario);
  }
});

test("records linked-receipt evidence without reading, moving, or changing its target", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-receipt-link-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receipt = receiptFixture();
  const locator = locatorFor(receipt);
  const store = new VerificationReceiptStore({
    stateDirectory,
    windowsAclVerifier: { verify: async () => undefined },
  });
  await store.stageAuthenticated(receipt);
  const filename = `${sha256CanonicalJson(locator)}.json`;
  const path = resolve(store.receiptDirectory, filename);
  const original = `${path}.original`;
  const outside = resolve(stateDirectory, "outside-receipt.json");
  await rename(path, original);
  await writeFile(outside, "outside sentinel\n", "utf8");
  try {
    await symlink(outside, path, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    await rename(original, path);
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }

  await assert.rejects(store.loadVerified(locator), hasCode("UPDATE_SECURITY_ERROR"));
  assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
  const entries = await readdir(store.receiptDirectory);
  assert.equal(entries.includes(filename), true);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(entries.some((entry) => entry.startsWith(`${filename}.corrupt.`)), true);
});
