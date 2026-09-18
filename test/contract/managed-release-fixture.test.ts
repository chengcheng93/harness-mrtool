import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { unzipSync } from "fflate";

import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import {
  authenticateReleaseSnapshot,
  createAuthenticatedReleaseSnapshot,
} from "../../src/update/release-set-verifier.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";
import {
  nativeReleaseFixture,
  type NativeReleaseFixtureOptions,
} from "../helpers/native-release-fixture.ts";
import * as nativeFixtures from "../helpers/native-release-fixture.ts";
import { canonicalPayload, signedEnvelope } from "../helpers/signing.ts";

// These 512-byte header fixtures exercise authentication, not runnable SEA
// binaries, self-tests, or successful native OS installation.
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const platforms = ["darwin-arm64", "windows-x64"] as const;
type Fixture = Awaited<ReturnType<typeof nativeReleaseFixture>>;

function releaseFamily(origin: Awaited<ReturnType<typeof exactReleaseFixture>>) {
  assert.equal(typeof nativeFixtures.nativeReleaseFixtureFamily, "function", "explicit fixture family is required");
  return nativeFixtures.nativeReleaseFixtureFamily(origin);
}

function advance(fixture: Fixture, prior: Fixture["signed"]["trustState"]) {
  return verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(fixture.payload), [fixture.signed.signingKey]),
    prior,
    fixture.signed.trustConfig.repository,
    fixture.signed.bootstrapKeys,
  ).nextTrustState;
}

function assertHeader(fixture: Fixture, platform: (typeof platforms)[number]) {
  assert.equal(fixture.native.length, 512);
  if (platform === "darwin-arm64") {
    assert.equal(fixture.native.readUInt32LE(0), 0xfeedfacf);
    assert.equal(fixture.native.readUInt32LE(4), 0x0100000c);
    assert.equal(fixture.native.readUInt32LE(12), 2);
  } else {
    assert.equal(fixture.native.readUInt16LE(0), 0x5a4d);
    assert.equal(fixture.native.readUInt32LE(0x3c), 128);
    assert.equal(fixture.native.readUInt32LE(128), 0x4550);
    assert.equal(fixture.native.readUInt16LE(132), 0x8664);
    assert.equal(fixture.native.readUInt16LE(152), 0x20b);
  }
}

for (const platform of platforms) {
  test(`${platform}: distinct native variants authenticate under one root with append-only history`, async () => {
    const origin = await exactReleaseFixture();
    const family = releaseFamily(origin);
    const a = await family(platform, {
      variantByte: 17, sequence: 43, releaseSetId: "fixture-A",
    });
    const b = await family(platform, {
      variantByte: 34, sequence: 44, cliVersion: "0.1.7", releaseSetId: "fixture-B",
    });
    assert.equal(a.native[511], 17);
    assert.equal(b.native[511], 34);
    assert.deepEqual(a.native.subarray(0, 511), b.native.subarray(0, 511));
    assert.notDeepEqual(a.native, b.native);
    assert.notDeepEqual(a.options.cliArchive, b.options.cliArchive);
    assert.deepEqual(a.options.templateArchive, b.options.templateArchive);
    const snapshots = [];
    for (const fixture of [a, b]) {
      assertHeader(fixture, platform);
      assert.notEqual(fixture.signed, origin);
      assert.deepEqual(fixture.signed.channelPayload, origin.channelPayload);
      assert.equal(fixture.options.trustConfig, origin.trustConfig);
      const snapshot = await createAuthenticatedReleaseSnapshot({
        ...fixture.options, trustConfig: origin.trustConfig,
      });
      // Re-authenticate a data-only copy; fixture-local verifier brands are not evidence.
      const authenticated = await authenticateReleaseSnapshot(structuredClone(snapshot), {
        platform, trustConfig: origin.trustConfig,
      });
      assert.deepEqual(Buffer.from(authenticated.executableBytes), fixture.native);
      const manifest = authenticated.verified.manifest;
      const artifact = manifest.components.cli.artifacts[platform]!;
      assert.equal(artifact.sha256, hash(fixture.options.cliArchive));
      assert.equal(artifact.size, fixture.options.cliArchive.length);
      assert.equal(manifest.components.templates.sha256, hash(fixture.options.templateArchive));
      assert.equal(manifest.components.templates.size, fixture.options.templateArchive.length);
      assert.equal(snapshot.record.cliSha256, artifact.sha256);
      assert.notEqual(snapshot.record.cliSha256, hash(fixture.native), "archive hash is not member hash");
      assert.deepEqual(manifest.templateHistory, origin.channelPayload.templateHistory);
      assert.equal(manifest.templateHistory[0]!.signingSequence, 42);
      const members = unzipSync(fixture.options.cliArchive);
      assert.deepEqual(Buffer.from(members[authenticated.executableName]!), fixture.native);
      assert.equal(Buffer.from(members["bundle-receipt.envelope.json"]!).toString(), origin.assets.receiptEnvelope);
      const checksums = Object.keys(members).filter(name => name !== "SHA256SUMS").sort()
        .map(name => `${hash(members[name]!)}  ${name}`).join("\n") + "\n";
      assert.equal(Buffer.from(members.SHA256SUMS!).toString(), checksums);
      snapshots.push(snapshot);
    }
    assert.notEqual(snapshots[0]!.record.cliSha256, snapshots[1]!.record.cliSha256);
    assert.deepEqual(snapshots.map(snapshot => snapshot.record.manifestSequence), [43, 44]);
    assert.deepEqual(snapshots.map(snapshot => snapshot.record.releaseSetId), ["fixture-A", "fixture-B"]);
    assert.deepEqual(snapshots.map(snapshot => snapshot.record.cliVersion), ["0.1.6", "0.1.7"]);
    assert.equal(a.verify().manifest.components.cli.tag, "cli-v0.1.6");
    assert.equal(b.verify().manifest.components.cli.tag, "cli-v0.1.7");
    const acceptedA = advance(a, origin.trustState);
    const acceptedB = advance(b, acceptedA);
    assert.equal(acceptedB.highestSequence, 44);
    assert.deepEqual(acceptedB.bundleReceiptAnchors, origin.trustState.bundleReceiptAnchors);
  });

  test(`${platform}: later rollback authorization reuses exact old assets across clocks and timezones`, async t => {
    const origin = await exactReleaseFixture();
    const family = releaseFamily(origin);
    let now = Date.parse("2026-09-18T10:11:12Z");
    t.mock.method(Date, "now", () => now);
    const priorTimezone = process.env.TZ;
    t.after(() => {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
    });
    process.env.TZ = "UTC";
    const a = await family(platform, {
      variantByte: 1, sequence: 43, cliVersion: "0.1.6", releaseSetId: "original-A",
    });
    const b = await family(platform, {
      variantByte: 2, sequence: 44, cliVersion: "0.1.7", releaseSetId: "upgrade-B",
    });
    now = Date.parse("2031-03-04T20:21:22Z");
    process.env.TZ = "Asia/Shanghai";
    const rollback = await family(platform, {
      variantByte: 1, sequence: 45, cliVersion: "0.1.6", releaseSetId: "rollback-A",
    });
    assert.ok(Buffer.from(rollback.options.cliArchive).equals(Buffer.from(a.options.cliArchive)), "immutable CLI archive must be byte-identical");
    assert.deepEqual(rollback.options.templateArchive, a.options.templateArchive);
    assert.deepEqual(rollback.options.templateReceipt, a.options.templateReceipt);
    assert.deepEqual(rollback.native, a.native);
    assert.equal(rollback.verify().manifest.components.cli.tag, a.verify().manifest.components.cli.tag);
    assert.equal(rollback.verify().manifest.components.cli.tag, "cli-v0.1.6");
    assert.notDeepEqual(rollback.native, b.native);
    const snapshots = [];
    let trust = origin.trustState;
    for (const fixture of [a, b, rollback]) {
      trust = advance(fixture, trust);
      const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
      await authenticateReleaseSnapshot(structuredClone(snapshot), { platform, trustConfig: origin.trustConfig });
      snapshots.push(snapshot);
    }
    assert.deepEqual(snapshots.map(snapshot => snapshot.record.manifestSequence), [43, 44, 45]);
    assert.deepEqual(snapshots.map(snapshot => snapshot.record.cliVersion), ["0.1.6", "0.1.7", "0.1.6"]);
    assert.equal(snapshots[2]!.record.releaseSetId, "rollback-A");
    assert.equal(snapshots[2]!.record.cliSha256, snapshots[0]!.record.cliSha256);
    assert.notEqual(snapshots[2]!.record.cliSha256, snapshots[1]!.record.cliSha256);
    assert.notEqual(snapshots[2]!.record.receiptSha256, snapshots[0]!.record.receiptSha256);
    assert.notEqual(snapshots[2]!.record.transactionId, snapshots[0]!.record.transactionId);
    assert.deepEqual(trust.bundleReceiptAnchors, origin.trustState.bundleReceiptAnchors);
  });
}

test("candidate creation and payload edits leave the shared origin and sibling history unchanged", async () => {
  const origin = await exactReleaseFixture();
  const family = releaseFamily(origin);
  const before = structuredClone({
    channel: origin.channelPayload, receipt: origin.receiptPayload, trust: origin.trustState,
    reference: origin.reference, assets: origin.assets, files: origin.mutableFiles,
  });
  const a = await family("darwin-arm64", { variantByte: 1, sequence: 43 });
  const b = await family("darwin-arm64", { variantByte: 2, sequence: 44, cliVersion: "0.1.7" });
  await family("darwin-arm64", { variantByte: 1, sequence: 45 });
  assert.notEqual(a.payload.templateHistory, origin.channelPayload.templateHistory);
  assert.deepEqual(a.payload.templateHistory, before.channel.templateHistory);
  assert.deepEqual(b.payload.templateHistory, before.channel.templateHistory);
  a.payload.templateHistory[0].signingSequence = 99;
  assert.deepEqual(b.payload.templateHistory, before.channel.templateHistory);
  // Normalize both byte snapshots: structuredClone turns Buffer into Uint8Array.
  assert.deepEqual(structuredClone({
    channel: origin.channelPayload, receipt: origin.receiptPayload, trust: origin.trustState,
    reference: origin.reference, assets: origin.assets, files: origin.mutableFiles,
  }), before);
});

test("default callers retain fields, zero variant and sequence 42, with independent roots", async () => {
  const a = await nativeReleaseFixture();
  const b = await nativeReleaseFixture();
  assert.deepEqual(Object.keys(a).sort(), ["native", "options", "payload", "signed", "verify"]);
  assert.equal(a.options.platform, "darwin-arm64");
  assert.equal(a.native[511], 0);
  assert.equal(a.verify().manifest.sequence, 42);
  assert.equal(a.verify().manifest.components.cli.version, "0.1.6");
  assert.equal(a.verify().manifest.releaseSet.id, "stable-0.1.6");
  assert.notEqual(a.signed.signingKey.publicKeySpki, b.signed.signingKey.publicKeySpki);
  for (const fixture of [a, b]) {
    const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
    await authenticateReleaseSnapshot(snapshot, { platform: "darwin-arm64", trustConfig: fixture.signed.trustConfig });
    const other = fixture === a ? b : a;
    await assert.rejects(authenticateReleaseSnapshot(snapshot, {
      platform: "darwin-arm64", trustConfig: other.signed.trustConfig,
    }), { code: "UPDATE_SECURITY_ERROR" });
  }
});

test("typed overrides and byte boundaries produce coherent authenticated metadata", async () => {
  const origin = await exactReleaseFixture();
  const family = releaseFamily(origin);
  for (const variantByte of [0, 255]) {
    const options: NativeReleaseFixtureOptions = {
      variantByte, sequence: variantByte === 0 ? 43 : 44,
      cliVersion: variantByte === 0 ? "2.3.4" : "2.3.5", releaseSetId: "custom:2.3",
    };
    const fixture = await family("darwin-arm64", options);
    assert.equal(fixture.native[511], variantByte);
    const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
    const manifest = fixture.verify().manifest;
    assert.equal(snapshot.record.cliVersion, options.cliVersion);
    assert.equal(snapshot.record.releaseSetId, options.releaseSetId);
    assert.equal(manifest.components.cli.tag, `cli-v${options.cliVersion}`);
    assert.equal(manifest.components.templates.minCliVersion, options.cliVersion);
    assert.equal(manifest.releaseSet.cli, options.cliVersion);
  }
});

test("malformed fixture configuration is rejected rather than silently defaulted or coerced", async t => {
  const origin = await exactReleaseFixture();
  const invalidFields: Record<string, readonly unknown[]> = {
    variantByte: [-1, 256, 1.5, NaN, Infinity, "1", null],
    sequence: [41, 0, -1, 43.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "43", null],
    cliVersion: ["v0.1.6", "01.1.6", "0.1", "bogus", " 0.1.6", "0.0.0", 1, null],
    releaseSetId: ["", " ", "../release", "release!", "x".repeat(129), 1, null, "release\n", "release\r\n"],
    variantBytes: [1],
  };
  for (const [field, values] of Object.entries(invalidFields)) {
    for (const [index, value] of values.entries()) {
      await t.test(`${field} invalid case ${index + 1}`, async () => {
        const options = { sequence: 43, [field]: value } as NativeReleaseFixtureOptions;
        await assert.rejects(nativeReleaseFixture("darwin-arm64", options));
      });
    }
  }
  for (const invalidOrigin of [
    null, {},
    { ...origin, channelPayload: { ...origin.channelPayload, templateHistory: [] } },
    { ...origin, assets: { ...origin.assets, receiptEnvelope: "{}\n" } },
  ]) {
    assert.throws(() => releaseFamily(invalidOrigin as typeof origin));
  }
  for (const options of [null, [], 7, "options"]) {
    await assert.rejects(nativeReleaseFixture("darwin-arm64", options as unknown as NativeReleaseFixtureOptions));
  }
  await assert.rejects(nativeReleaseFixture("linux-x64" as "darwin-arm64"));
});

test("shared-root candidates still reject tampered archives, receipts, channel payloads and history", async () => {
  const origin = await exactReleaseFixture();
  const family = releaseFamily(origin);
  const fixture = await family("darwin-arm64", { variantByte: 1, sequence: 43 });
  const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
  for (const member of ["cliBytes", "templateBytes"] as const) {
    const tampered = structuredClone(snapshot);
    tampered[member][35] = tampered[member][35]! ^ 1;
    const recordKey = member === "cliBytes" ? "cliSha256" : "templateSha256";
    const record = { ...tampered.record, [recordKey]: hash(tampered[member]) };
    await assert.rejects(authenticateReleaseSnapshot({ ...tampered, record }, {
      platform: "darwin-arm64", trustConfig: origin.trustConfig,
    }), { code: "UPDATE_SECURITY_ERROR" });
  }
  await assert.rejects(createAuthenticatedReleaseSnapshot({
    ...fixture.options, templateReceipt: Buffer.from("{}\n"),
  }), { code: "UPDATE_SECURITY_ERROR" });
  const envelope = JSON.parse(signedEnvelope(canonicalPayload(fixture.payload), [origin.signingKey]));
  envelope.payload = Buffer.from(canonicalPayload({ ...fixture.payload, sequence: 44 })).toString("base64url");
  assert.throws(() => verifyChannelEnvelope(JSON.stringify(envelope), origin.trustState,
    origin.trustConfig.repository, origin.bootstrapKeys), { code: "UPDATE_SECURITY_ERROR" });
  const badHistory = structuredClone(fixture.payload);
  badHistory.templateHistory[0].signingSequence = 41;
  assert.throws(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(badHistory), [origin.signingKey]), origin.trustState,
    origin.trustConfig.repository, origin.bootstrapKeys,
  ), { code: "UPDATE_SECURITY_ERROR" });
});

for (const platform of platforms) {
  test(`${platform}: a valid family rejects different bytes under an already used immutable CLI tag`, async () => {
    const origin = await exactReleaseFixture();
    const family = releaseFamily(origin);
    const a = await family(platform, { variantByte: 1, sequence: 43, cliVersion: "0.1.6" });
    await assert.rejects(family(platform, { variantByte: 2, sequence: 44, cliVersion: "0.1.6" }), /immutable.*cli-v0\.1\.6/i);
    // Rejection must not consume authorization sequence 44 or poison old assets.
    const b = await family(platform, { variantByte: 2, sequence: 44, cliVersion: "0.1.7" });
    const rollback = await family(platform, { variantByte: 1, sequence: 45, cliVersion: "0.1.6" });
    assert.ok(Buffer.from(rollback.options.cliArchive).equals(Buffer.from(a.options.cliArchive)));
    assert.equal(advance(rollback, advance(b, advance(a, origin.trustState))).highestSequence, 45);
  });
}

test("a family permits platform-specific assets for one immutable CLI tag but never rewrites accepted channel 42", async () => {
  const origin = await exactReleaseFixture();
  const family = releaseFamily(origin);
  await assert.rejects(family("darwin-arm64", { sequence: 42 }));
  const mac = await family("darwin-arm64", { variantByte: 1, sequence: 43 });
  const windows = await family("windows-x64", { variantByte: 2, sequence: 44 });
  const accepted = advance(windows, advance(mac, origin.trustState));
  assert.equal(accepted.highestSequence, 44);
  assert.equal(mac.verify().manifest.components.cli.tag, windows.verify().manifest.components.cli.tag);
  for (const fixture of [mac, windows]) await createAuthenticatedReleaseSnapshot(fixture.options);
});

type Origin = Awaited<ReturnType<typeof exactReleaseFixture>>;
function originData(origin: Origin) {
  // Compare data snapshots without cloning KeyObject or using a cloned config as authority.
  return structuredClone({
    reference: origin.reference, assets: origin.assets, files: origin.mutableFiles,
    channel: origin.channelPayload, receipt: origin.receiptPayload,
    trust: origin.trustState, config: origin.trustConfig, bootstrapKeys: origin.bootstrapKeys,
    keyId: origin.signingKey.keyId, publicKeySpki: origin.signingKey.publicKeySpki,
  });
}

// Object.assign deliberately bypasses readonly property slots, as a JS caller can.
// Raw map and Uint8Array mutations do not require bypassing TypeScript readonly.
const signedMutations: Record<string, (target: Origin, other: Origin) => void> = {
  "asset file bytes": target => { const bytes = target.assets.files.get("bundle-manifest.json")!; bytes[0] = bytes[0]! ^ 1; },
  "mutableFiles bytes": target => { const bytes = target.mutableFiles.get("schema.json")!; bytes[0] = bytes[0]! ^ 1; },
  "asset map entries": target => {
    const files = target.assets.files as Map<string, Uint8Array>;
    files.set("bundle-manifest.json", Buffer.from("{}"));
    files.delete("schema.json");
  },
  "mutableFiles map entries": target => { target.mutableFiles.clear(); },
  "file map property": target => { Object.assign(target.assets, { files: new Map() }); },
  "assets container": (target, other) => { Object.assign(target, { assets: other.assets }); },
  "receiptEnvelope property": target => { Object.assign(target.assets, { receiptEnvelope: "{}\n" }); },
  "reference fields": target => { Object.assign(target.reference, { bundleVersion: "9.9.9" }); },
  "receipt payload fields": target => { Object.assign(target.receiptPayload, { signingSequence: 99 }); },
  "channel payload container": (target, other) => { Object.assign(target, { channelPayload: other.channelPayload }); },
  "signing wrapper fields": (target, other) => { Object.assign(target.signingKey, other.signingKey); },
  "trustConfig property": (target, other) => { Object.assign(target, { trustConfig: other.trustConfig }); },
  "trust and bootstrap properties": (target, other) => {
    Object.assign(target, { trustState: other.trustState, bootstrapKeys: other.bootstrapKeys });
  },
};

for (const phase of ["caller origin after capture", "returned A before B"] as const) {
  for (const [damage, mutate] of Object.entries(signedMutations)) {
    test(`fix1: isolates ${phase}: ${damage}`, async () => {
      const origin = await exactReleaseFixture();
      const other = await exactReleaseFixture();
      const before = originData(origin);
      const config = origin.trustConfig;
      const privateKey = origin.signingKey.privateKey;
      let trust = origin.trustState;
      const family = releaseFamily(origin);
      if (phase === "caller origin after capture") mutate(origin, other);
      const a = await family("darwin-arm64", { sequence: 43, variantByte: 1, cliVersion: "0.1.6" });
      const snapshotA = await createAuthenticatedReleaseSnapshot(a.options);
      if (phase === "returned A before B") mutate(a.signed, other);

      // A rejected attempt must not consume sequence44 or register a conflicting asset.
      await assert.rejects(family("darwin-arm64", {
        sequence: 44, variantByte: 2, cliVersion: "0.1.6",
      }), /immutable.*cli-v0\.1\.6/i);
      const b = await family("darwin-arm64", { sequence: 44, variantByte: 2, cliVersion: "0.1.7" });
      const snapshotB = await createAuthenticatedReleaseSnapshot(b.options);
      const rollback = await family("darwin-arm64", { sequence: 45, variantByte: 1, cliVersion: "0.1.6" });
      const snapshotRollback = await createAuthenticatedReleaseSnapshot(rollback.options);
      for (const [fixture, snapshot] of [[a, snapshotA], [b, snapshotB], [rollback, snapshotRollback]] as const) {
        const authenticated = await authenticateReleaseSnapshot(structuredClone(snapshot), {
          platform: "darwin-arm64", trustConfig: config,
        });
        assert.deepEqual(Buffer.from(authenticated.executableBytes), fixture.native);
        // Authenticate the retained envelope, not the intentionally damaged signed wrapper.
        trust = verifyChannelEnvelope(fixture.options.verified.nextTrustState.acceptedChannelEnvelope!,
          trust, config.repository, config.bootstrapKeys).nextTrustState;
      }
      assert.equal(trust.highestSequence, 45);
      assert.ok(Buffer.from(snapshotRollback.cliBytes).equals(Buffer.from(snapshotA.cliBytes)));
      assert.deepEqual(originData(b.signed), before, "later signed data must come from captured origin");
      assert.deepEqual(originData(rollback.signed), before);
      if (phase === "returned A before B") assert.deepEqual(originData(origin), before, "A must not mutate caller origin");
      else assert.deepEqual(originData(a.signed), before, "caller mutation must not alter A's signed data");
      assert.notEqual(a.signed, b.signed);
      assert.notEqual(b.signed.assets, rollback.signed.assets);
      assert.notEqual(b.signed.assets.files, rollback.signed.assets.files);
      assert.notEqual(b.signed.mutableFiles.get("schema.json"), rollback.signed.mutableFiles.get("schema.json"));
      assert.equal(b.signed.signingKey.privateKey, privateKey, "share immutable KeyObject, not a generic clone");
      assert.equal(b.signed.trustConfig, config, "preserve branded immutable trustConfig");
      assert.equal(Object.isFrozen(config), true);
    });
  }
}

test("fix1: captures and detaches Uint8Array receipt envelopes as bytes, not comma-separated strings", async t => {
  for (const phase of ["caller origin", "returned A"] as const) {
    await t.test(phase, async () => {
      const origin = await exactReleaseFixture();
      const receipt = Uint8Array.from(Buffer.from(String(origin.assets.receiptEnvelope)));
      Object.assign(origin.assets, { receiptEnvelope: receipt });
      const config = origin.trustConfig;
      const family = releaseFamily(origin);
      if (phase === "caller origin") receipt.fill(0);
      const a = await family("windows-x64", { sequence: 43, variantByte: 1 });
      const snapshotA = await createAuthenticatedReleaseSnapshot(a.options);
      if (phase === "returned A") {
        const exposed = a.signed.assets.receiptEnvelope;
        assert.ok(exposed instanceof Uint8Array);
        exposed.fill(0);
      }
      const b = await family("windows-x64", { sequence: 44, variantByte: 2, cliVersion: "0.1.7" });
      const snapshotB = await createAuthenticatedReleaseSnapshot(b.options);
      for (const snapshot of [snapshotA, snapshotB]) {
        await authenticateReleaseSnapshot(snapshot, { platform: "windows-x64", trustConfig: config });
      }
      assert.deepEqual(b.options.templateReceipt, a.options.templateReceipt);
      if (phase === "returned A") assert.deepEqual(Buffer.from(receipt), a.options.templateReceipt);
    });
  }
});

test("fix1: mutable payload/verify and returned top-level fields cannot register or poison family state", async () => {
  const origin = await exactReleaseFixture();
  const config = origin.trustConfig;
  const family = releaseFamily(origin);
  const a = await family("darwin-arm64", { sequence: 43, variantByte: 1 });
  const savedA = await createAuthenticatedReleaseSnapshot(a.options);
  a.payload.sequence = 44;
  a.payload.components.cli.artifacts["darwin-arm64"].sha256 = "f".repeat(64);
  const malicious = a.verify(); // Deliberate re-signing still works but is not a family publication.
  await assert.rejects(createAuthenticatedReleaseSnapshot({ ...a.options, verified: malicious }), { code: "UPDATE_SECURITY_ERROR" });
  a.options.verified = malicious;
  a.options.cliArchive.fill(0);
  a.options.templateArchive.fill(0);
  a.options.templateReceipt.fill(0);
  a.native.fill(0);
  Object.assign(a, { signed: await exactReleaseFixture() });
  const b = await family("darwin-arm64", { sequence: 44, variantByte: 2, cliVersion: "0.1.7" });
  const snapshotB = await createAuthenticatedReleaseSnapshot(b.options);
  await authenticateReleaseSnapshot(snapshotB, { platform: "darwin-arm64", trustConfig: config });
  const rollback = await family("darwin-arm64", { sequence: 45, variantByte: 1 });
  const snapshotRollback = await createAuthenticatedReleaseSnapshot(rollback.options);
  assert.ok(Buffer.from(snapshotRollback.cliBytes).equals(Buffer.from(savedA.cliBytes)));
  // Use A's retained authenticated trust, not any replaced output fields.
  const retainedTrust = (await authenticateReleaseSnapshot(savedA, { platform: "darwin-arm64", trustConfig: config })).verified.nextTrustState;
  assert.equal(advance(rollback, advance(b, retainedTrust)).highestSequence, 45);
});

test("fix1: origin-published Windows CLI tag conflicts reject without consuming sequence43", async () => {
  const origin = await exactReleaseFixture();
  const family = releaseFamily(origin);
  const accepted = verifyChannelEnvelope(origin.trustState.acceptedChannelEnvelope!, origin.trustState,
    origin.trustConfig.repository, origin.bootstrapKeys).manifest;
  assert.equal(accepted.components.cli.tag, "cli-v1.2.3");
  assert.equal(accepted.components.cli.artifacts["windows-x64"]!.sha256, "a".repeat(64));
  await assert.rejects(family("windows-x64", {
    sequence: 43, cliVersion: "1.2.3", variantByte: 7,
  }), /immutable.*windows-x64\/cli-v1\.2\.3/i);
  const valid = await family("windows-x64", { sequence: 43, cliVersion: "1.2.4", variantByte: 7 });
  const snapshot = await createAuthenticatedReleaseSnapshot(valid.options);
  await authenticateReleaseSnapshot(snapshot, { platform: "windows-x64", trustConfig: origin.trustConfig });
  assert.equal(advance(valid, origin.trustState).highestSequence, 43);
  assert.equal(snapshot.record.manifestSequence, 43);
});

test("fix1: seeded origin commitments remain platform-specific", async () => {
  const origin = await exactReleaseFixture();
  const family = releaseFamily(origin);
  const mac = await family("darwin-arm64", { sequence: 43, cliVersion: "1.2.3", variantByte: 7 });
  const snapshot = await createAuthenticatedReleaseSnapshot(mac.options);
  await authenticateReleaseSnapshot(snapshot, { platform: "darwin-arm64", trustConfig: origin.trustConfig });
  assert.equal(advance(mac, origin.trustState).highestSequence, 43);
});
