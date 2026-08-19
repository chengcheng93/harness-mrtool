import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";


import { isToolError } from "../../src/contracts/errors.ts";


import {
  ACTIVATION_CRASH_POINTS,
  activateReleaseSet,
  recoverReleaseSet,
} from "../../src/update/activation.ts";
import type {
  LoadedReleaseSet,
  ReleaseSetRecord,
  ReleaseSetSnapshot,
} from "../../src/update/cache.ts";
import { UpdateCache } from "../../src/update/cache.ts";
import {
  readActivationJournal,
  validateActivationJournal,
  writeActivationJournal,
} from "../../src/update/journal.ts";
import {
  runUpdateHandoff,
  type HandoffChild,
} from "../../src/update/invocation-envelope.ts";
import {
  ASSET_UPDATE_BUDGET_MS,
  MANIFEST_UPDATE_BUDGET_MS,
  downloadBounded,
  validateArchiveEntries,
} from "../../src/update/download.ts";
import {
  runWindowsPersistence,
  type WindowsPersistenceResult,
} from "../../src/update/windows-helper.ts";


async function removeFixtureDirectory(directory: string): Promise<void> {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    await chmod(current, 0o700).catch(() => undefined);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(resolve(current, entry.name));
    }
  }
  await rm(directory, { recursive: true, force: true });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}


function releaseSnapshot(
  transactionId: string,
  releaseSetId: string,
  version: string,
  sequence: number,
): ReleaseSetSnapshot {
  const cliBytes = new TextEncoder().encode(`cli ${releaseSetId}\n`);
  const templateBytes = new TextEncoder().encode(`template ${releaseSetId}\n`);
  const receiptBytes = new TextEncoder().encode(`receipt ${releaseSetId}\n`);
  const record: ReleaseSetRecord = Object.freeze({
  cacheVersion: 1,
  recordType: "active-release-set",
    releaseSetId,
    transactionId,
    cliVersion: version,
    templateVersion: version,
    cliSha256: sha256(cliBytes),
    templateSha256: sha256(templateBytes),
  manifestVersion: 1,
  inputSchema: 1,
  policySchema: 1,
    manifestSequence: sequence,
    receiptSha256: sha256(receiptBytes),
  });
  return Object.freeze({ record, cliBytes, templateBytes, receiptBytes });
}


const OLD_RELEASE = releaseSnapshot("tx-41", "stable-41", "1.4.1", 41);
const NEW_RELEASE = releaseSnapshot("tx-42", "stable-42", "1.5.0", 42);
const SAME_SEQUENCE_RELEASE = releaseSnapshot("tx-42-alt", "stable-42-alt", "1.5.1", 42);
const allowTestAcl = { verify: async (_path: string): Promise<void> => undefined };
const allowTestVerification = { verify: async (_snapshot: ReleaseSetSnapshot): Promise<void> => undefined };


test("recovery rejects a missing or malformed snapshot verifier at runtime", async (t) => {
  const invalidVerifiers: readonly unknown[] = [
    undefined,
    {},
    { verify: null },
  ];
  for (const [index, verifier] of invalidVerifiers.entries()) {
    const directory = await mkdtemp(resolve(tmpdir(), `harness-mrtool-updater-verifier-${index}-`));
    t.after(async () => removeFixtureDirectory(directory));
    await assert.rejects(
      recoverReleaseSet(directory, {
        windowsAclVerifier: allowTestAcl,
        verifySnapshot: verifier as never,
      }),
      (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
    );
  }
});


test("recovery rejects a staging journal that rolls back the accepted sequence", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-sequence-rollback-"));
  t.after(async () => removeFixtureDirectory(directory));
  await activateReleaseSet({
    stateDirectory: directory,
    next: OLD_RELEASE,
    verifySnapshot: allowTestVerification,
    windowsAclVerifier: allowTestAcl,
  });
  await activateReleaseSet({
    stateDirectory: directory,
    next: NEW_RELEASE,
    verifySnapshot: allowTestVerification,
    windowsAclVerifier: allowTestAcl,
  });
  await writeActivationJournal(
    resolve(directory, "activation-journal.json"),
    validateActivationJournal({
      journalVersion: 1,
      phase: "staging",
      transactionId: OLD_RELEASE.record.transactionId,
      previous: NEW_RELEASE.record,
      next: OLD_RELEASE.record,
    }),
  );


  await assert.rejects(
    recoverReleaseSet(directory, {
      windowsAclVerifier: allowTestAcl,
      verifySnapshot: allowTestVerification,
    }),
    (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
  );
  const journal = await readActivationJournal(resolve(directory, "activation-journal.json"));
  assert.equal(journal?.next.manifestSequence, OLD_RELEASE.record.manifestSequence);
  const active = await new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
  }).loadLastKnownGood();
  assert.equal(active.record.manifestSequence, NEW_RELEASE.record.manifestSequence);
});


test("recovery preserves a staging journal when its next release assets are missing", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-missing-staged-"));
  t.after(async () => removeFixtureDirectory(directory));
  await activateReleaseSet({
    stateDirectory: directory,
    next: OLD_RELEASE,
    verifySnapshot: allowTestVerification,
    windowsAclVerifier: allowTestAcl,
  });
  await writeActivationJournal(
    resolve(directory, "activation-journal.json"),
    validateActivationJournal({
      journalVersion: 1,
      phase: "staging",
      transactionId: NEW_RELEASE.record.transactionId,
      previous: OLD_RELEASE.record,
      next: NEW_RELEASE.record,
    }),
  );
  await assert.rejects(
    recoverReleaseSet(directory, {
      windowsAclVerifier: allowTestAcl,
      verifySnapshot: allowTestVerification,
    }),
    (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
  );
  const journal = await readActivationJournal(resolve(directory, "activation-journal.json"));
  assert.equal(journal?.next.transactionId, NEW_RELEASE.record.transactionId);
  const active = await new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
  }).loadLastKnownGood();
  assert.equal(active.record.transactionId, OLD_RELEASE.record.transactionId);
});


test("activation rejects lower or same-sequence different release tuples but replays the exact tuple", async (t) => {
  for (const [index, candidate] of [OLD_RELEASE, SAME_SEQUENCE_RELEASE].entries()) {
    const directory = await mkdtemp(resolve(tmpdir(), `harness-mrtool-updater-activation-sequence-${index}-`));
    t.after(async () => removeFixtureDirectory(directory));
    await activateReleaseSet({
      stateDirectory: directory,
      next: OLD_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    });
    await activateReleaseSet({
      stateDirectory: directory,
      next: NEW_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    });
    await assert.rejects(
      activateReleaseSet({
        stateDirectory: directory,
        next: candidate,
        verifySnapshot: allowTestVerification,
        windowsAclVerifier: allowTestAcl,
      }),
      (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
    );
    const replayed = await activateReleaseSet({
      stateDirectory: directory,
      next: NEW_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    });
    assertExactRelease(replayed, NEW_RELEASE, `exact replay ${index}`);
  }
});


function assertExactRelease(
  actual: LoadedReleaseSet | null,
  expected: ReleaseSetSnapshot,
  crashPoint: string,
): void {
  assert.notEqual(actual, null, `missing active release after ${crashPoint}`);
  assert.deepEqual(actual?.record, expected.record, `record mismatch after ${crashPoint}`);
  assert.deepEqual(actual?.cliBytes, expected.cliBytes, `CLI mismatch after ${crashPoint}`);
  assert.deepEqual(actual?.templateBytes, expected.templateBytes, `template mismatch after ${crashPoint}`);
  assert.deepEqual(actual?.receiptBytes, expected.receiptBytes, `receipt mismatch after ${crashPoint}`);
}


test("activation exposes either old or new release tuple, never a mixed tuple", async (t) => {
  for (const crashPoint of ACTIVATION_CRASH_POINTS) {
    const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-"));
    t.after(async () => removeFixtureDirectory(directory));


    await activateReleaseSet({
      stateDirectory: directory,
      next: OLD_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    });
    await assert.rejects(
      activateReleaseSet({
        stateDirectory: directory,
        next: NEW_RELEASE,
        verifySnapshot: allowTestVerification,
        windowsAclVerifier: allowTestAcl,
        faultInjector: {
          hit(point) {
            if (point === crashPoint) throw new Error(`crash at ${point}`);
          },
        },
      }),
    );


    let recovered: LoadedReleaseSet | null;
    try {
      recovered = await recoverReleaseSet(directory, {
        windowsAclVerifier: allowTestAcl,
        verifySnapshot: allowTestVerification,
      });
    } catch (error) {
      // The journal-only window has no evidence that the next tuple was ever
      // staged. Recovery must stop and preserve the journal; this test models
      // an explicit repair decision before retrying the activation.
      assert.ok([
        "after-journal-staging",
        "before-cli-replace",
        "before-template-replace",
        "before-receipt-replace",
      ].includes(crashPoint as string));
      assert.equal(isToolError(error, "UPDATE_SECURITY_ERROR"), true);
      await rm(resolve(directory, "activation-journal.json"), { force: true });
      recovered = await recoverReleaseSet(directory, {
        windowsAclVerifier: allowTestAcl,
        verifySnapshot: allowTestVerification,
      });
    }
    const expected = recovered?.record.transactionId === OLD_RELEASE.record.transactionId
      ? OLD_RELEASE
      : NEW_RELEASE;
    assertExactRelease(recovered, expected, crashPoint);


    const retried = await activateReleaseSet({
      stateDirectory: directory,
      next: NEW_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    });
    assertExactRelease(retried, NEW_RELEASE, `${crashPoint} retry`);
  }
});


test("a committed activation journal cannot be discarded while the old pointer is active", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-phase-"));
  t.after(async () => removeFixtureDirectory(directory));
  await activateReleaseSet({
    stateDirectory: directory,
    next: OLD_RELEASE,
    verifySnapshot: allowTestVerification,
    windowsAclVerifier: allowTestAcl,
  });
  await writeActivationJournal(
    resolve(directory, "activation-journal.json"),
    validateActivationJournal({
      journalVersion: 1,
      phase: "committed",
      transactionId: NEW_RELEASE.record.transactionId,
      previous: OLD_RELEASE.record,
      next: NEW_RELEASE.record,
    }),
  );
  await assert.rejects(
    recoverReleaseSet(directory, {
      windowsAclVerifier: allowTestAcl,
      verifySnapshot: allowTestVerification,
    }),
    (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
  );
});


test("activation removes a bounded plain stale staging directory under the update lock", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-stale-"));
  t.after(async () => removeFixtureDirectory(directory));
  await activateReleaseSet({
    stateDirectory: directory,
    next: OLD_RELEASE,
    verifySnapshot: allowTestVerification,
    windowsAclVerifier: allowTestAcl,
  });
  const stale = resolve(directory, "releases", `.staging-${"a".repeat(24)}`);
  await mkdir(stale);


  const activated = await activateReleaseSet({
    stateDirectory: directory,
    next: NEW_RELEASE,
    verifySnapshot: allowTestVerification,
    windowsAclVerifier: allowTestAcl,
  });


  assertExactRelease(activated, NEW_RELEASE, "stale staging cleanup");
  await assert.rejects(lstat(stale), /ENOENT/u);
});


test("activation reclaims a rename-leftover stale directory on the next recovery", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-stale-leftover-"));
  t.after(async () => removeFixtureDirectory(directory));
  await activateReleaseSet({
    stateDirectory: directory,
    next: OLD_RELEASE,
    verifySnapshot: allowTestVerification,
    windowsAclVerifier: allowTestAcl,
  });
  const stale = resolve(directory, "releases", `.stale-${"b".repeat(24)}`);
  await mkdir(stale);


  await recoverReleaseSet(directory, {
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
  });
  await assert.rejects(lstat(stale), /ENOENT/u);
});


test("concurrent activation attempts serialize complete release sets", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-concurrent-"));
  t.after(async () => removeFixtureDirectory(directory));


  const outcomes = await Promise.allSettled([
    activateReleaseSet({
      stateDirectory: directory,
      next: OLD_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    }),
    activateReleaseSet({
      stateDirectory: directory,
      next: NEW_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    }),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      assert.equal(isToolError(outcome.reason, "UPDATE_SECURITY_ERROR"), true);
    }
  }


  const recovered = await recoverReleaseSet(directory, {
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
  });
  assertExactRelease(recovered, NEW_RELEASE, "concurrent activation");
  await assert.rejects(lstat(resolve(directory, "activation-journal.json")), /ENOENT/u);
});


test("activation rejects a linked state directory before writing its journal", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-mrtool-updater-linked-"));
  t.after(async () => removeFixtureDirectory(root));
  const target = resolve(root, "target");
  const linked = resolve(root, "state");
  await mkdir(target);
  try {
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating a directory link is not permitted on this host");
      return;
    }
    throw error;
  }


  await assert.rejects(
    activateReleaseSet({
      stateDirectory: linked,
      next: OLD_RELEASE,
      verifySnapshot: allowTestVerification,
      windowsAclVerifier: allowTestAcl,
    }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
  );
  await assert.rejects(lstat(resolve(target, "activation-journal.json")), /ENOENT/u);
});


class EchoChild implements HandoffChild {
  readonly writes: Uint8Array[] = [];
  async writeStdin(bytes: Uint8Array): Promise<void> {
    this.writes.push(Uint8Array.from(bytes));
  }
  async closeStdin(): Promise<void> {}
  async readStdout(): Promise<Uint8Array> {
    return Uint8Array.from(this.writes[0] ?? []);
  }
  async readStderr(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async wait(): Promise<{ readonly exitCode: number }> {
    return { exitCode: 17 };
  }
}


test("JSON stdin is consumed once and child exit/stdout are forwarded exactly", async () => {
  let reads = 0;
  const input = (async function* (): AsyncIterable<Uint8Array> {
    reads += 1;
    yield new TextEncoder().encode('{"schemaVersion":1}');
  })();
  const child = new EchoChild();
  const result = await runUpdateHandoff(input, async () => child);


  assert.equal(reads, 1);
  assert.deepEqual(result.parentStdout, result.childStdout);
  assert.equal(result.parentExit, result.childExit);
  assert.equal(result.parentExit, 17);
});


test("bounded downloads enforce byte and wall-clock budgets before accepting assets", async () => {
  let now = 0;
  async function* slow(): AsyncIterable<Uint8Array> {
    yield new Uint8Array([1, 2]);
    now = MANIFEST_UPDATE_BUDGET_MS + 1;
    yield new Uint8Array([3]);
  }
  await assert.rejects(
    downloadBounded(slow(), {
      maxBytes: 16,
      budgetMs: MANIFEST_UPDATE_BUDGET_MS,
      clock: () => now,
    }),
    /budget/u,
  );


  await assert.rejects(
    downloadBounded((async function* () {
      yield new Uint8Array(ASSET_UPDATE_BUDGET_MS > 0 ? 17 : 1);
    })(), { maxBytes: 16, budgetMs: ASSET_UPDATE_BUDGET_MS }),
    /size/u,
  );
});


test("archive entry validation rejects traversal, duplicates, and links", () => {
  assert.deepEqual(validateArchiveEntries([
    { name: "bin/cli.exe", kind: "file" },
    { name: "templates/", kind: "directory" },
  ]), [
    { name: "bin/cli.exe", kind: "file" },
    { name: "templates/", kind: "directory" },
  ]);
  for (const entries of [
    [{ name: "../escape", kind: "file" }],
    [{ name: "a", kind: "file" }, { name: "a", kind: "file" }],
    [{ name: "link", kind: "symlink" }],
  ] as const) {
    assert.throws(() => validateArchiveEntries(entries), /archive/u);
  }
});


test("Windows persistence waits for the parent and preserves the business exit on pending install", async () => {
  const order: string[] = [];
  let result: WindowsPersistenceResult = await runWindowsPersistence({
    parentExit: async () => { order.push("parent"); return 23; },
    rotate: async () => { order.push("rotate"); },
    commit: async () => { order.push("commit"); throw new Error("locked"); },
    isRecoverable: () => true,
  });
  assert.deepEqual(order, ["parent", "rotate", "commit"]);
  assert.equal(result.businessExit, 23);
  assert.equal(result.persistencePending, true);


  result = await runWindowsPersistence({
    parentExit: async () => 0,
    rotate: async () => { throw new Error("fatal"); },
    commit: async () => undefined,
    isRecoverable: () => false,
  });
  assert.equal(result.persistencePending, false);
  assert.equal(result.persistenceFailed, true);
});
