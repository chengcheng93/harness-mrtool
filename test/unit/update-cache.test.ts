import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";


import { isToolError, ToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import {
  MAX_CACHE_POINTER_BYTES,
  projectVerifiedManifestSecurity,
  UpdateCache,
  validateReleaseSetRecord,
  type ReleaseSetRecord,
  type ReleaseSetSnapshot,
  type VerifiedManifestSecurityView,
} from "../../src/update/cache.ts";
import { createTrustState } from "../../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import {
  canonicalPayload,
  createSigningFixture,
  signedEnvelope,
} from "../helpers/signing.ts";


const allowTestAcl = { verify: async (_path: string): Promise<void> => undefined };
const allowTestVerification = { verify: async (_snapshot: ReleaseSetSnapshot): Promise<void> => undefined };


function sha256(bytes: Uint8Array): string {
  return sha256Utf8(new TextDecoder().decode(bytes));
}


function record(overrides: Partial<ReleaseSetRecord> = {}): ReleaseSetRecord {
  const cli = new TextEncoder().encode("cli bytes\n");
  const template = new TextEncoder().encode("template bytes\n");
  const receipt = new TextEncoder().encode("signed receipt\n");
  return {
    cacheVersion: 1,
    recordType: "active-release-set",
    releaseSetId: "stable-42",
    cliVersion: "1.2.3",
    cliSha256: sha256(cli),
    templateVersion: "1.4.0",
    templateSha256: sha256(template),
    manifestVersion: 1,
    inputSchema: 1,
    policySchema: 1,
    manifestSequence: 42,
    transactionId: "tx-42",
    receiptSha256: sha256(receipt),
    ...overrides,
  };
}


function snapshot(overrides: {
  readonly record?: Partial<ReleaseSetRecord>;
  readonly cliBytes?: Uint8Array;
  readonly templateBytes?: Uint8Array;
  readonly receiptBytes?: Uint8Array;
} = {}) {
  const cliBytes = overrides.cliBytes ?? new TextEncoder().encode("cli bytes\n");
  const templateBytes = overrides.templateBytes ?? new TextEncoder().encode("template bytes\n");
  const receiptBytes = overrides.receiptBytes ?? new TextEncoder().encode("signed receipt\n");
  return {
    record: record(overrides.record),
    cliBytes,
    templateBytes,
    receiptBytes,
  };
}


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
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(resolve(current, entry.name));
      }
    }
  }
  await rm(directory, { recursive: true, force: true });
}

async function fixture(t: { after(callback: () => void | Promise<void>): void }): Promise<{
  readonly directory: string;
  readonly cache: UpdateCache;
}> {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-update-cache-"));
  t.after(async () => {
    await removeFixtureDirectory(directory);
  });
  return {
    directory,
    cache: new UpdateCache({ stateDirectory: directory, windowsAclVerifier: allowTestAcl, verifySnapshot: allowTestVerification }),
  };
}


function securityFailure(error: unknown): boolean {
  return isToolError(error, "UPDATE_SECURITY_ERROR");
}


function verifiedChannelSecurity(
  security: VerifiedManifestSecurityView["manifest"]["security"],
): ReturnType<typeof verifyChannelEnvelope> {
  const key = createSigningFixture("release-key-1");
  const payload = {
    manifestVersion: 1,
    sequence: 42,
    channel: "stable",
    issuedAt: "2026-08-13T08:00:00Z",
    repository: { owner: "example-owner", name: "harness-mrtool" },
    components: {
      cli: {
        version: "1.2.3",
        tag: "cli-v1.2.3",
        inputSchemas: [1],
        policySchemas: [1],
        skillProtocols: [1],
        artifacts: { "windows-x64": { name: "cli.zip", sha256: "a".repeat(64), size: 1 } },
      },
      templates: {
        version: "1.4.0",
        tag: "templates-v1.4.0",
        inputSchema: 1,
        policySchema: 1,
        minCliVersion: "1.2.0",
        asset: "templates.zip",
        sha256: "b".repeat(64),
        size: 1,
      },
      skill: {
        version: "1.1.0",
        tag: "skill-v1.1.0",
        skillProtocol: 1,
        cliVersionRange: ">=1.2.0 <2.0.0",
        asset: "skill.zip",
        sha256: "c".repeat(64),
        size: 1,
        activation: "explicit-host-refresh",
      },
    },
    releaseSet: { id: "stable-42", cli: "1.2.3", templates: "1.4.0" },
    security,
    recommendedSkillVersion: "1.1.0",
    templateHistory: [{
      releaseTag: "templates-v1.4.0",
      bundleManifestHash: "d".repeat(64),
      receiptPayloadSha256: "e".repeat(64),
      signingSequence: 1,
      signingKeyId: "release-key-1",
    }],
  } as unknown as import("../../src/contracts/jcs.ts").JsonObject;
  return verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(payload), [key]),
    createTrustState([{
      keyId: key.keyId,
      publicKeySpki: key.publicKeySpki,
      activeFromSequence: 1,
      revokedAtSequence: null,
    }]),
    { owner: "example-owner", name: "harness-mrtool" },
  );
}


test("exports the one exact frozen release-set record validator", () => {
  const input = record();
  const validated = validateReleaseSetRecord(input);
  assert.deepEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
  assert.notEqual(validated, input);
  assert.throws(() => validateReleaseSetRecord({ ...input, extra: true }), securityFailure);
});


test("release records reject numeric prerelease leading zeroes", () => {
  assert.throws(
    () => validateReleaseSetRecord(record({ cliVersion: "1.0.0-01" })),
    securityFailure,
  );
  assert.doesNotThrow(() => validateReleaseSetRecord(record({ cliVersion: "1.0.0-rc.1+build.7" })));
});


test("release records reject platform device names used as cache directories", () => {
  for (const value of ["CON", "AUX", "NUL", "COM1", "LPT9", "con.txt"]) {
    assert.throws(
      () => validateReleaseSetRecord(record({ transactionId: value })),
      securityFailure,
    );
    assert.throws(
      () => validateReleaseSetRecord(record({ releaseSetId: value })),
      securityFailure,
    );
  }
});


test("stores one canonical active record and returns locally verified snapshots", async (t) => {
  const { cache } = await fixture(t);
  const input = snapshot();


  const stored = await cache.storeVerifiedReleaseSet(input);
  assert.deepEqual(stored.record, input.record);
  assert.equal(stored.writesBlocked, false);
  assert.deepEqual(stored.cliBytes, input.cliBytes);
  assert.deepEqual(stored.templateBytes, input.templateBytes);
  assert.deepEqual(stored.receiptBytes, input.receiptBytes);


  const pointer = await readFile(cache.activeRecordPath, "utf8");
  assert.equal(pointer, `${canonicalizeJson(input.record)}\n`);
  assert.equal((await lstat(stored.releaseDirectory)).isDirectory(), true);
  assert.equal((await lstat(stored.cliPath)).isFile(), true);
  assert.equal((await lstat(stored.templatePath)).isFile(), true);
  assert.equal((await lstat(stored.receiptPath)).isFile(), true);


  const loaded = await cache.loadLastKnownGood();
  assert.deepEqual(loaded.record, input.record);
  assert.deepEqual(loaded.cliBytes, input.cliBytes);
  assert.deepEqual(loaded.templateBytes, input.templateBytes);
  assert.deepEqual(loaded.receiptBytes, input.receiptBytes);
});


test("passes only the four-field release snapshot to the verifier on reads", async (t) => {
  const { directory } = await fixture(t);
  const seen: string[][] = [];
  const strictVerifier = {
    verify(input: ReleaseSetSnapshot): void {
      seen.push(Object.keys(input).sort());
      const expected = ["cliBytes", "receiptBytes", "record", "templateBytes"];
      assert.deepEqual(Object.keys(input).sort(), expected);
    },
  };
  const cache = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: strictVerifier,
  });
  await cache.storeVerifiedReleaseSet(snapshot());
  await cache.loadLastKnownGood();
  assert.deepEqual(seen, [
    ["cliBytes", "receiptBytes", "record", "templateBytes"],
    ["cliBytes", "receiptBytes", "record", "templateBytes"],
  ]);
});


test("returns null only for a genuinely empty bootstrap cache", async (t) => {
  const { cache } = await fixture(t);


  assert.equal(await cache.loadLastKnownGoodOrNull(), null);
  const stored = await cache.storeVerifiedReleaseSet(snapshot());
  const loaded = await cache.loadLastKnownGoodOrNull();
  assert.notEqual(loaded, null);
  assert.deepEqual(loaded?.record, stored.record);
});


test("never presents a self-consistent but unverified release as LKG", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-cache-unverified-"));
  t.after(async () => removeFixtureDirectory(directory));
  const writer = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
  });
  await writer.storeVerifiedReleaseSet(snapshot());
  const reader = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
  });
  await assert.rejects(reader.loadLastKnownGood(), securityFailure);
  await assert.rejects(reader.loadLastKnownGoodOrNull(), securityFailure);
});


test("requires complete byte snapshots whose hashes match the canonical record", async (t) => {
  const { cache } = await fixture(t);
  const input = snapshot({ cliBytes: new TextEncoder().encode("different cli\n") });


  await assert.rejects(cache.storeVerifiedReleaseSet(input), securityFailure);
  await assert.rejects(lstat(cache.activeRecordPath), /ENOENT/u);


  const malformed = {
    ...snapshot(),
    record: { ...snapshot().record, unknown: true },
  } as never;
  await assert.rejects(cache.storeVerifiedReleaseSet(malformed), securityFailure);
});


test("rejects traversal, duplicate transaction publication, and noncanonical record bytes", async (t) => {
  const { cache } = await fixture(t);
  await assert.rejects(
    cache.storeVerifiedReleaseSet(snapshot({ record: { transactionId: "../outside" } })),
    securityFailure,
  );
  await cache.storeVerifiedReleaseSet(snapshot());
  await assert.rejects(cache.storeVerifiedReleaseSet(snapshot()), securityFailure);


  const noncanonical = snapshot();
  await assert.rejects(
    cache.storeVerifiedReleaseSet({
      ...noncanonical,
      canonicalRecord: `${JSON.stringify(noncanonical.record)}\n`,
    } as never),
    securityFailure,
  );
});


test("independent cache writers serialize through the shared update lock", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-cache-lock-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));


  let entered = 0;
  let maximumActive = 0;
  let active = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const injector = {
    async hit(point: string): Promise<void> {
      if (point !== "before-cli-replace") return;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered += 1;
      if (entered === 1) await firstGate;
      active -= 1;
    },
  };
  const first = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
    faultInjector: injector,
  });
  const second = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
    faultInjector: injector,
  });


  const firstWrite = first.storeVerifiedReleaseSet(snapshot({
    record: { transactionId: "tx-lock-a", releaseSetId: "stable-lock-a", manifestSequence: 51 },
  }));
  for (let attempt = 0; attempt < 100 && entered === 0; attempt += 1) {
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 1));
  }
  assert.equal(entered, 1, "first writer did not reach the guarded write");
  const secondWrite = second.storeVerifiedReleaseSet(snapshot({
    record: { transactionId: "tx-lock-b", releaseSetId: "stable-lock-b", manifestSequence: 52 },
  }));
  await new Promise<void>((resolveTick) => setTimeout(resolveTick, 25));
  assert.equal(maximumActive, 1, "second writer entered while first writer was active");
  releaseFirst();
  await Promise.all([firstWrite, secondWrite]);
});


test("quarantines a corrupt active pointer instead of treating it as an empty cache", async (t) => {
  const { cache } = await fixture(t);
  await mkdir(cache.cacheDirectory, { recursive: true });
  await writeFile(cache.activeRecordPath, "{not-json\n", "utf8");


  await assert.rejects(cache.loadLastKnownGood(), securityFailure);
  const entries = await readdir(cache.cacheDirectory);
  assert.equal(entries.some((entry) => entry.startsWith("active-release-set.json.corrupt.")), true);
  await assert.rejects(lstat(cache.activeRecordPath), /ENOENT/u);
});


test("never treats a corrupt active pointer as an empty bootstrap cache", async (t) => {
  const { cache } = await fixture(t);
  await mkdir(cache.cacheDirectory, { recursive: true });
  await writeFile(cache.activeRecordPath, "{not-json\n", "utf8");


  await assert.rejects(cache.loadLastKnownGoodOrNull(), securityFailure);
  const entries = await readdir(cache.cacheDirectory);
  assert.equal(entries.some((entry) => entry.startsWith("active-release-set.json.corrupt.")), true);
});


test("bounds pointer reads before parsing and isolates an oversized pointer", async (t) => {
  const { cache } = await fixture(t);
  await mkdir(cache.cacheDirectory, { recursive: true });
  await writeFile(cache.activeRecordPath, "{" + "x".repeat(MAX_CACHE_POINTER_BYTES) + "}", "utf8");


  await assert.rejects(cache.loadLastKnownGood(), securityFailure);
  const entries = await readdir(cache.cacheDirectory);
  assert.equal(entries.some((entry) => entry.startsWith("active-release-set.json.corrupt.")), true);
});


test("rejects duplicate JSON pointer keys and quarantines the pointer", async (t) => {
  const { cache } = await fixture(t);
  await mkdir(cache.cacheDirectory, { recursive: true });
  await writeFile(cache.activeRecordPath, '{"cacheVersion":1,"cacheVersion":1}\n', "utf8");


  await assert.rejects(cache.loadLastKnownGood(), securityFailure);
  const entries = await readdir(cache.cacheDirectory);
  assert.equal(entries.some((entry) => entry.startsWith("active-release-set.json.corrupt.")), true);
  await assert.rejects(lstat(cache.activeRecordPath), /ENOENT/u);
});


test("rejects an active pointer symlink without reading or changing its target", async (t) => {
  const { cache } = await fixture(t);
  await mkdir(cache.cacheDirectory, { recursive: true });
  const outside = resolve(cache.cacheDirectory, "outside-pointer.json");
  await writeFile(outside, "sentinel\n", "utf8");
  try {
    await symlink(outside, cache.activeRecordPath, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }


  await assert.rejects(cache.loadLastKnownGood(), securityFailure);
  assert.equal(await readFile(outside, "utf8"), "sentinel\n");
  const entries = await readdir(cache.cacheDirectory);
  assert.equal(entries.some((entry) => entry.startsWith("active-release-set.json.corrupt.")), true);
});


test("detects a tampered read-only release directory and quarantines it", async (t) => {
  const { cache } = await fixture(t);
  const stored = await cache.storeVerifiedReleaseSet(snapshot());
  await chmod(stored.cliPath, 0o600);
  await writeFile(stored.cliPath, "tampered\n", "utf8");


  await assert.rejects(cache.loadLastKnownGood(), securityFailure);
  const entries = await readdir(cache.releaseRoot);
  assert.equal(entries.some((entry) => entry.startsWith(`${stored.record.transactionId}.corrupt.`)), true);
});


test("bounds release-directory enumeration and quarantines unexpected entries", async (t) => {
  const { cache } = await fixture(t);
  const stored = await cache.storeVerifiedReleaseSet(snapshot());
  await writeFile(resolve(stored.releaseDirectory, "unexpected.tmp"), "unexpected\n", "utf8");


  await assert.rejects(cache.loadLastKnownGood(), securityFailure);
  const entries = await readdir(cache.releaseRoot);
  assert.equal(entries.some((entry) => entry.startsWith(`${stored.record.transactionId}.corrupt.`)), true);
});


test("rejects a release directory replaced with a symbolic link without touching its target", async (t) => {
  const { cache } = await fixture(t);
  const stored = await cache.storeVerifiedReleaseSet(snapshot());
  const outside = resolve(cache.cacheDirectory, "outside-release");
  await mkdir(outside);
  const original = stored.releaseDirectory;
  const moved = `${original}.moved`;
  await rename(original, moved);
  try {
    await symlink(outside, original, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rename(moved, original);
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }


  await assert.rejects(cache.loadLastKnownGood(), securityFailure);
  assert.equal((await lstat(outside)).isDirectory(), true);
});


test("fails closed when the initialized release root is replaced before a write", async (t) => {
  const { cache } = await fixture(t);
  await cache.storeVerifiedReleaseSet(snapshot());
  const outside = await mkdtemp(resolve(tmpdir(), "harness-mrtool-outside-root-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(outside, { recursive: true, force: true }));
  });
  const original = cache.releaseRoot;
  const moved = `${original}.moved`;
  await rename(original, moved);
  try {
    await symlink(outside, original, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rename(moved, original);
    if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }


  await assert.rejects(
    cache.storeVerifiedReleaseSet(snapshot({ record: { transactionId: "tx-43", manifestSequence: 43 } })),
    securityFailure,
  );
  assert.deepEqual(await readdir(outside), []);
});


test("derives writesBlocked only from a verified manifest security projection", async (t) => {
  const { cache } = await fixture(t);
  await cache.storeVerifiedReleaseSet(snapshot());
  const baseManifest: VerifiedManifestSecurityView["manifest"] = {
    manifestVersion: 1,
    sequence: 43,
    releaseSet: { id: "stable-43", cli: "9.9.9", templates: "9.9.9" },
    security: {
      minimumAllowedCliVersion: "1.0.0",
      revokedCliVersions: [],
      revokedReleaseSetIds: [],
    },
  };


  const project = (manifest: VerifiedManifestSecurityView["manifest"]["security"]): VerifiedManifestSecurityView =>
    projectVerifiedManifestSecurity(verifiedChannelSecurity(manifest));


  const allowed = await cache.loadLastKnownGood({ verifiedManifest: project(baseManifest.security) });
  assert.equal(allowed.writesBlocked, false);
  await assert.rejects(cache.loadLastKnownGood({ verifiedManifest: Object.freeze({
    manifest: baseManifest,
    payloadSha256: "a".repeat(64),
    signingKeyIds: ["release-key-1"],
    nextTrustState: {},
  }) as never }), securityFailure);
  const projection = project(baseManifest.security);
  assert.throws(() => {
    (projection.manifest.security.revokedReleaseSetIds as string[]).push("stable-42");
  }, TypeError);
  assert.equal((await cache.loadLastKnownGood({ verifiedManifest: projection })).writesBlocked, false);
  await assert.rejects(cache.loadLastKnownGood({ verifiedManifest: { manifest: baseManifest } }), securityFailure);
  const revoked = await cache.loadLastKnownGood({
    verifiedManifest: project({ ...baseManifest.security, revokedReleaseSetIds: ["stable-42"] }),
  });
  assert.equal(revoked.writesBlocked, true);
  assert.deepEqual(revoked.writeBlockReasons, ["active-release-set-revoked"]);


  const minimum = await cache.loadLastKnownGood({
    verifiedManifest: project({ ...baseManifest.security, minimumAllowedCliVersion: "2.0.0" }),
  });
  assert.equal(minimum.writesBlocked, true);
  assert.deepEqual(minimum.writeBlockReasons, ["active-cli-version-below-minimum"]);
});


test("preserves the active pointer when a release read reports transient I/O", async (t) => {
  const { directory } = await fixture(t);
  const base = new UpdateCache({ stateDirectory: directory, windowsAclVerifier: allowTestAcl, verifySnapshot: allowTestVerification });
  await base.storeVerifiedReleaseSet(snapshot());
  const faulted = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
    faultInjector: {
      hit(point: string): void {
        if (point === "after-cli-open") {
          throw new ToolError("INTERNAL_ERROR", "temporary read failure", {
            field: "cache",
            expected: "a readable release asset",
            actual: "transient I/O failure",
            safeNextStep: "Retry without quarantining the last-known-good release.",
          });
        }
      },
    },
  });
  await assert.rejects(faulted.loadLastKnownGood(), (error: unknown) => isToolError(error, "INTERNAL_ERROR"));
  assert.equal((await base.loadLastKnownGood()).record.transactionId, "tx-42");
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.includes(".corrupt.")), false);
});


test("failed pointer replacement leaves the previous active tuple intact", async (t) => {
  const { directory } = await fixture(t);
  const first = new UpdateCache({ stateDirectory: directory, windowsAclVerifier: allowTestAcl, verifySnapshot: allowTestVerification });
  await first.storeVerifiedReleaseSet(snapshot());
  const before = await readFile(first.activeRecordPath, "utf8");
  const second = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
    faultInjector: {
      async hit(point: string): Promise<void> {
        if (point === "before-active-replace") throw new Error("injected replace failure");
      },
    },
  });
  await assert.rejects(
    second.storeVerifiedReleaseSet(snapshot({
      record: {
        ...record(),
        releaseSetId: "stable-43",
        transactionId: "tx-43",
        manifestSequence: 43,
      },
    })),
    securityFailure,
  );
  assert.equal(await readFile(first.activeRecordPath, "utf8"), before);
  assert.deepEqual((await first.loadLastKnownGood()).record.releaseSetId, "stable-42");
});


test("a verified orphan release directory requires the explicit staged commit path", async (t) => {
  const { directory } = await fixture(t);
  const base = new UpdateCache({ stateDirectory: directory, windowsAclVerifier: allowTestAcl, verifySnapshot: allowTestVerification });
  await base.storeVerifiedReleaseSet(snapshot());
  const next = snapshot({
    record: {
      ...record(),
      releaseSetId: "stable-43",
      transactionId: "tx-43",
      manifestSequence: 43,
    },
  });
  const crashing = new UpdateCache({
    stateDirectory: directory,
    windowsAclVerifier: allowTestAcl,
    verifySnapshot: allowTestVerification,
    faultInjector: {
      hit(point) {
        if (point === "before-active-replace") throw new Error("crash before pointer commit");
      },
    },
  });
  await assert.rejects(crashing.storeVerifiedReleaseSet(next), securityFailure);
  assert.equal((await base.loadLastKnownGood()).record.releaseSetId, "stable-42");


  await assert.rejects(base.storeVerifiedReleaseSet(next), securityFailure);
  const recovered = await base.commitStagedReleaseSet(next.record);
  assert.ok(recovered !== null);
  assert.equal(recovered.record.releaseSetId, "stable-43");
  assert.equal((await base.loadLastKnownGood()).record.transactionId, "tx-43");
});
