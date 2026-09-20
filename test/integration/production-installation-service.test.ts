import {createHash} from "node:crypto";
import {swapAnchoredFile} from "../../src/platform/anchored-file-mover.ts";
import {spawnSync} from "node:child_process";
import assert from "node:assert/strict";
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile} from "node:fs/promises";
import test, {mock} from "node:test";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

import {authenticateReleaseSnapshot, createAuthenticatedReleaseSnapshot, createReleaseSetSnapshotVerifier} from "../../src/update/release-set-verifier.ts";
import {UpdateCache} from "../../src/update/cache.ts";
import {UpdateStateStore} from "../../src/update/state-store.ts";
import {canonicalUpdateTrustConfigJson, updateTrustConfigSha256} from "../../src/update/trust-config.ts";
import {stageAuthenticatedManagedPosixCandidate, publishManagedPosixCandidate, publishManagedPosixCandidateAtomic} from "../../src/update/managed-installation-posix.ts";
import {createProductionInstallationService, createInitialInstallationJournal} from "../../src/update/production-installation-service.ts";
import {exactReleaseFixture} from "../helpers/default-historical-fixture.ts";
import {nativeReleaseFixtureFamily} from "../helpers/native-release-fixture.ts";
import {canonicalPayload, signedEnvelope} from "../helpers/signing.ts";
import {createInstallationJournalStore} from "../../src/update/installation-journal-store.ts";
import {advanceInstallationJournalPhase} from "../../src/update/installation-journal-coordination.ts";
import {verifyManagedPosixStage} from "../../src/update/managed-installation-posix.ts";

import * as posixModule from "../../src/update/managed-installation-posix.ts";
import * as preparationModule from "../../src/update/production-release-preparation.ts";
import * as channelModule from "../../src/update/production-channel.ts";

const darwin = {skip: process.platform !== "darwin" || process.arch !== "arm64"};

async function removeTree(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info === null) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path)) await removeTree(resolve(path, entry));
  } else {
    await chmod(path, 0o600).catch(() => undefined);
  }
  await rm(path, {recursive: true, force: true});
}

test("production installation coordinates authenticated staging, journal, cache commit and final observation", darwin, async () => {
  const origin = await exactReleaseFixture();
  const family = nativeReleaseFixtureFamily(origin);
  const previous = await family("darwin-arm64", {sequence: 43, cliVersion: "0.1.6", variantByte: 1, releaseSetId: "stable-0.1.6"});
  const candidate = await family("darwin-arm64", {sequence: 44, cliVersion: "0.1.7", variantByte: 2, releaseSetId: "stable-0.1.7"});
  const previousSnapshot = await createAuthenticatedReleaseSnapshot(previous.options);
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "production-installation-service-"));
  const stateDirectory = resolve(root, "state");
  const installationDirectory = resolve(root, "installation");
  await mkdir(installationDirectory, {mode: 0o700});

  try {
    const verifier = createReleaseSetSnapshotVerifier({platform: "darwin-arm64", trustConfig: origin.trustConfig});
    const cache = new UpdateCache({stateDirectory, verifySnapshot: verifier});
    await cache.storeVerifiedReleaseSet(previousSnapshot);
    const previousStage = await stageAuthenticatedManagedPosixCandidate({
      installationDirectory,
      snapshot: previousSnapshot,
      platform: "darwin-arm64",
      trustConfig: origin.trustConfig,
    });
    await publishManagedPosixCandidate({stage: previousStage, attemptId: "a".repeat(32), previous: {executable: null, marker: null}});

    const channelEnvelope = signedEnvelope(canonicalPayload(candidate.payload), [origin.signingKey]);
    const service = createProductionInstallationService({
      stateDirectory,
      installationDirectory,
      platform: "darwin-arm64",
      trustConfig: origin.trustConfig,
      channelUrl: "https://fixture.example.test/stable.envelope.json",
      transport: {async request() { return {status: 200, headers: {}, body: Buffer.from(channelEnvelope)}; }},
      fetch: async (url) => {
        const value = String(url);
        const bytes = value.endsWith("harness-mr-templates.zip")
          ? candidate.options.templateArchive
          : value.endsWith("bundle-receipt.envelope.json")
            ? candidate.options.templateReceipt
            : candidate.options.cliArchive;
        return new Response(Buffer.from(bytes));
      },
    });

    const installed = await service.apply(false);
    assert.equal(installed.status, "installed");
    if (installed.status !== "installed") return;
    assert.equal(installed.active.cliVersion, "0.1.7");
    assert.equal(installed.observed.cliVersion, "0.1.7");
    assert.equal(installed.observed.releaseSetId, "stable-0.1.7");
    assert.equal(await lstat(resolve(stateDirectory, "installation-journal.json")).then(() => true, () => false), false);

    const retried = await service.apply(false);
    assert.equal(retried.status, "unchanged");
    await service.recover();
  } finally {
    await removeTree(root);
  }
});

async function createPrecommitRecoveryFixture(prefix: string) {
  const origin = await exactReleaseFixture();
  const family = nativeReleaseFixtureFamily(origin);
  const previous = await family("darwin-arm64", {sequence: 43, cliVersion: "0.1.6", variantByte: 1, releaseSetId: "stable-0.1.6"});
  const candidate = await family("darwin-arm64", {sequence: 44, cliVersion: "0.1.7", variantByte: 2, releaseSetId: "stable-0.1.7"});
  const previousSnapshot = await createAuthenticatedReleaseSnapshot(previous.options);
  const candidateSnapshot = await createAuthenticatedReleaseSnapshot(candidate.options);
  const root = await mkdtemp(resolve(await realpath(tmpdir()), prefix));
  const stateDirectory = resolve(root, "state");
  const installationDirectory = resolve(root, "installation");
  await mkdir(installationDirectory, {mode: 0o700});

  const verifier = createReleaseSetSnapshotVerifier({platform: "darwin-arm64", trustConfig: origin.trustConfig});
  const cache = new UpdateCache({stateDirectory, verifySnapshot: verifier});
  const previousActive = await cache.storeVerifiedReleaseSet(previousSnapshot);
  const previousStage = await stageAuthenticatedManagedPosixCandidate({
    installationDirectory,
    snapshot: previousSnapshot,
    platform: "darwin-arm64",
    trustConfig: origin.trustConfig,
  });
  await publishManagedPosixCandidate({stage: previousStage, attemptId: "d".repeat(32), previous: {executable: null, marker: null}});

  const previousAuth = await authenticateReleaseSnapshot(previousSnapshot, {platform: "darwin-arm64", trustConfig: origin.trustConfig});
  const candidateAuth = await authenticateReleaseSnapshot(candidateSnapshot, {platform: "darwin-arm64", trustConfig: origin.trustConfig});
  const stateRoot = await lstat(stateDirectory, {bigint: true});
  const installRoot = await lstat(installationDirectory, {bigint: true});
  const journal = createInitialInstallationJournal(
    "darwin-arm64",
    "apply",
    "1".repeat(32),
    "2".repeat(32),
    {installation: {dev: String(installRoot.dev), ino: String(installRoot.ino)}, state: {dev: String(stateRoot.dev), ino: String(stateRoot.ino)}},
    previousActive,
    previousAuth,
    candidateSnapshot,
    candidateAuth,
  );
  const store = createInstallationJournalStore(stateDirectory);
  const service = createProductionInstallationService({
    stateDirectory,
    installationDirectory,
    platform: "darwin-arm64",
    trustConfig: origin.trustConfig,
  });
  return {root, stateDirectory, installationDirectory, origin, cache, candidateSnapshot, journal, store, service};
}

async function writePreparedJournal(fixture: Awaited<ReturnType<typeof createPrecommitRecoveryFixture>>): Promise<Awaited<ReturnType<typeof stageAuthenticatedManagedPosixCandidate>>> {
  const stage = await stageAuthenticatedManagedPosixCandidate({
    installationDirectory: fixture.installationDirectory,
    stageDirectory: resolve(fixture.installationDirectory, `.harness-mrtool-stage-${fixture.journal.attemptId}`),
    snapshot: fixture.candidateSnapshot,
    platform: "darwin-arm64",
    trustConfig: fixture.origin.trustConfig,
  });
  const observation = await verifyManagedPosixStage(stage);
  const executable = await lstat(resolve(fixture.installationDirectory, "harness-mrtool"), {bigint: true});
  const marker = await lstat(resolve(fixture.installationDirectory, ".harness-mrtool-install.json"), {bigint: true});
  const slots = fixture.journal.slots.map(slot => {
    if (slot.name === "staged-executable") return {...slot, state: "created" as const, identity: {dev: observation.executableIdentity.dev, ino: observation.executableIdentity.ino}};
    if (slot.name === "staged-marker") return {...slot, state: "created" as const, identity: {dev: observation.markerIdentity.dev, ino: observation.markerIdentity.ino}};
    if (slot.name === "previous-executable") return {...slot, state: "created" as const, identity: {dev: String(executable.dev), ino: String(executable.ino)}};
    if (slot.name === "previous-marker") return {...slot, state: "created" as const, identity: {dev: String(marker.dev), ino: String(marker.ino)}};
    return slot;
  });
  await fixture.store.write(advanceInstallationJournalPhase(fixture.journal, "prepared", null, slots));
  return stage;
}

test("recovery aborts only an intact precommit journal for the active previous release", darwin, async () => {
  for (const phase of ["preparing", "prepared"] as const) {
    const origin = await exactReleaseFixture();
    const family = nativeReleaseFixtureFamily(origin);
    const previous = await family("darwin-arm64", {sequence: 43, cliVersion: "0.1.6", variantByte: 1, releaseSetId: "stable-0.1.6"});
    const candidate = await family("darwin-arm64", {sequence: 44, cliVersion: "0.1.7", variantByte: 2, releaseSetId: "stable-0.1.7"});
    const previousSnapshot = await createAuthenticatedReleaseSnapshot(previous.options);
    const candidateSnapshot = await createAuthenticatedReleaseSnapshot(candidate.options);
    const root = await mkdtemp(resolve(await realpath(tmpdir()), `production-installation-precommit-${phase}-`));
    const stateDirectory = resolve(root, "state");
    const installationDirectory = resolve(root, "installation");
    await mkdir(installationDirectory, {mode: 0o700});

    try {
      const verifier = createReleaseSetSnapshotVerifier({platform: "darwin-arm64", trustConfig: origin.trustConfig});
      const cache = new UpdateCache({stateDirectory, verifySnapshot: verifier});
      const previousActive = await cache.storeVerifiedReleaseSet(previousSnapshot);
      const previousStage = await stageAuthenticatedManagedPosixCandidate({
        installationDirectory,
        snapshot: previousSnapshot,
        platform: "darwin-arm64",
        trustConfig: origin.trustConfig,
      });
      await publishManagedPosixCandidate({stage: previousStage, attemptId: "b".repeat(32), previous: {executable: null, marker: null}});

      const previousAuth = await authenticateReleaseSnapshot(previousSnapshot, {platform: "darwin-arm64", trustConfig: origin.trustConfig});
      const candidateAuth = await authenticateReleaseSnapshot(candidateSnapshot, {platform: "darwin-arm64", trustConfig: origin.trustConfig});
      const stateRoot = await lstat(stateDirectory, {bigint: true});
      const installRoot = await lstat(installationDirectory, {bigint: true});
      const journal = createInitialInstallationJournal(
        "darwin-arm64",
        "apply",
        "c".repeat(32),
        "d".repeat(32),
        {installation: {dev: String(installRoot.dev), ino: String(installRoot.ino)}, state: {dev: String(stateRoot.dev), ino: String(stateRoot.ino)}},
        previousActive,
        previousAuth,
        candidateSnapshot,
        candidateAuth,
      );
      const store = createInstallationJournalStore(stateDirectory);
      if (phase === "preparing") {
        await store.write(journal);
      } else {
        const stage = await stageAuthenticatedManagedPosixCandidate({
          installationDirectory,
          snapshot: candidateSnapshot,
          platform: "darwin-arm64",
          trustConfig: origin.trustConfig,
        });
        const observation = await verifyManagedPosixStage(stage);
        const executable = await lstat(resolve(installationDirectory, "harness-mrtool"), {bigint: true});
        const marker = await lstat(resolve(installationDirectory, ".harness-mrtool-install.json"), {bigint: true});
        const slots = journal.slots.map(slot => {
          if (slot.name === "staged-executable") return {...slot, state: "created" as const, identity: {dev: observation.executableIdentity.dev, ino: observation.executableIdentity.ino}};
          if (slot.name === "staged-marker") return {...slot, state: "created" as const, identity: {dev: observation.markerIdentity.dev, ino: observation.markerIdentity.ino}};
          if (slot.name === "previous-executable") return {...slot, state: "created" as const, identity: {dev: String(executable.dev), ino: String(executable.ino)}};
          if (slot.name === "previous-marker") return {...slot, state: "created" as const, identity: {dev: String(marker.dev), ino: String(marker.ino)}};
          return slot;
        });
        await store.write(advanceInstallationJournalPhase(journal, "prepared", null, slots));
      }

      const service = createProductionInstallationService({
        stateDirectory,
        installationDirectory,
        platform: "darwin-arm64",
        trustConfig: origin.trustConfig,
      });
      const beforeExecutable = await readFile(resolve(installationDirectory, "harness-mrtool"));
      const beforeMarker = await readFile(resolve(installationDirectory, ".harness-mrtool-install.json"));
      const beforeActive = await readFile(resolve(stateDirectory, "active-release-set.json"));
      await service.recover();
      assert.equal(await lstat(resolve(stateDirectory, "installation-journal.json")).then(() => true, () => false), false);
      assert.deepEqual(await readFile(resolve(installationDirectory, "harness-mrtool")), beforeExecutable);
      assert.deepEqual(await readFile(resolve(installationDirectory, ".harness-mrtool-install.json")), beforeMarker);
      assert.deepEqual(await readFile(resolve(stateDirectory, "active-release-set.json")), beforeActive);
    } finally {
      await removeTree(root);
    }
  }
});

test("recovery preserves a precommit journal when active cache points to another transaction", darwin, async () => {
  const fixture = await createPrecommitRecoveryFixture("production-installation-precommit-pointer-mismatch-");
  try {
    await fixture.store.write(fixture.journal);
    await fixture.cache.storeVerifiedReleaseSet(fixture.candidateSnapshot);
    const beforeJournal = await readFile(fixture.store.path);
    const beforeExecutable = await readFile(resolve(fixture.installationDirectory, "harness-mrtool"));
    const beforeMarker = await readFile(resolve(fixture.installationDirectory, ".harness-mrtool-install.json"));

    await assert.rejects(fixture.service.recover(), {code: "UPDATE_SECURITY_ERROR"});
    assert.deepEqual(await readFile(fixture.store.path), beforeJournal);
    assert.deepEqual(await readFile(resolve(fixture.installationDirectory, "harness-mrtool")), beforeExecutable);
    assert.deepEqual(await readFile(resolve(fixture.installationDirectory, ".harness-mrtool-install.json")), beforeMarker);
  } finally {
    await removeTree(fixture.root);
  }
});

test("recovery preserves a precommit journal when canonical marker evidence is tampered", darwin, async () => {
  const fixture = await createPrecommitRecoveryFixture("production-installation-precommit-marker-mismatch-");
  try {
    await fixture.store.write(fixture.journal);
    const markerPath = resolve(fixture.installationDirectory, ".harness-mrtool-install.json");
    const tamperedMarker = Buffer.concat([await readFile(markerPath), Buffer.from("tampered")]);
    await writeFile(markerPath, tamperedMarker);
    const beforeJournal = await readFile(fixture.store.path);

    await assert.rejects(fixture.service.recover(), {code: "UPDATE_SECURITY_ERROR"});
    assert.deepEqual(await readFile(fixture.store.path), beforeJournal);
    assert.deepEqual(await readFile(markerPath), tamperedMarker);
  } finally {
    await removeTree(fixture.root);
  }
});

test("recovery preserves a precommit journal when canonical executable evidence is tampered", darwin, async () => {
  const fixture = await createPrecommitRecoveryFixture("production-installation-precommit-executable-mismatch-");
  try {
    await fixture.store.write(fixture.journal);
    const executablePath = resolve(fixture.installationDirectory, "harness-mrtool");
    await chmod(executablePath, 0o700);
    const tamperedExecutable = Buffer.concat([await readFile(executablePath), Buffer.from("tampered")]);
    await writeFile(executablePath, tamperedExecutable);
    const beforeJournal = await readFile(fixture.store.path);

    await assert.rejects(fixture.service.recover(), {code: "UPDATE_SECURITY_ERROR"});
    assert.deepEqual(await readFile(fixture.store.path), beforeJournal);
    assert.deepEqual(await readFile(executablePath), tamperedExecutable);
  } finally {
    await removeTree(fixture.root);
  }
});

test("recovery preserves publication intents without authenticated next-pair evidence", darwin, async () => {
  for (const phase of ["publish-intent", "canonical-published", "marker-published", "commit-intent"] as const) {
    const fixture = await createPrecommitRecoveryFixture(`production-installation-${phase}-recovery-`);
    try {
      await writePreparedJournal(fixture);
      let current = await fixture.store.read();
      assert.ok(current);
      for (const next of ["publish-intent", "canonical-published", "marker-published", "commit-intent"] as const) {
        current = advanceInstallationJournalPhase(current, next, null, current.slots);
        if (next === phase) break;
      }
      await fixture.store.write(current);
      const beforeJournal = await readFile(fixture.store.path);

      await assert.rejects(fixture.service.recover(), {code: "UPDATE_SECURITY_ERROR"});
      assert.deepEqual(await readFile(fixture.store.path), beforeJournal);
    } finally {
      await removeTree(fixture.root);
    }
  }
});

test("recovery preserves a precommit journal when the installation root is replaced", darwin, async () => {
  const fixture = await createPrecommitRecoveryFixture("production-installation-precommit-root-mismatch-");
  try {
    await fixture.store.write(fixture.journal);
    const before = await readFile(fixture.store.path);
    await rm(fixture.installationDirectory, {recursive: true, force: true});
    await mkdir(fixture.installationDirectory, {mode: 0o700});

    await assert.rejects(fixture.service.recover(), {code: "UPDATE_SECURITY_ERROR"});
    assert.deepEqual(await readFile(fixture.store.path), before);
  } finally {
    await removeTree(fixture.root);
  }
});

test("recovery is a no-op before the first managed release is installed", darwin, async (t) => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "production-installation-recovery-empty-"));
  t.after(() => removeTree(root));
  const service = createProductionInstallationService({
    stateDirectory: resolve(root, "state"),
    installationDirectory: resolve(root, "installation"),
    platform: "darwin-arm64",
  });

  await service.recover();
  assert.equal(await lstat(resolve(root, "state", "installation-journal.json")).then(() => true, () => false), false);
});

test("production rollback installs exact previously released bytes only through a later signed sequence", darwin, async (t) => {
  const origin = await exactReleaseFixture();
  const family = nativeReleaseFixtureFamily(origin);
  const previous = await family("darwin-arm64", {sequence: 43, cliVersion: "0.1.6", variantByte: 1, releaseSetId: "stable-0.1.6"});
  const rollback = await family("darwin-arm64", {sequence: 44, cliVersion: "0.1.6", variantByte: 1, releaseSetId: "stable-0.1.6-rollback"});
  const previousSnapshot = await createAuthenticatedReleaseSnapshot(previous.options);
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "production-installation-rollback-"));
  const stateDirectory = resolve(root, "state");
  const installationDirectory = resolve(root, "installation");
  await mkdir(installationDirectory, {mode: 0o700});

  try {
    const verifier = createReleaseSetSnapshotVerifier({platform: "darwin-arm64", trustConfig: origin.trustConfig});
    const cache = new UpdateCache({stateDirectory, verifySnapshot: verifier});
    await cache.storeVerifiedReleaseSet(previousSnapshot);
    const previousStage = await stageAuthenticatedManagedPosixCandidate({
      installationDirectory,
      snapshot: previousSnapshot,
      platform: "darwin-arm64",
      trustConfig: origin.trustConfig,
    });
    await publishManagedPosixCandidate({stage: previousStage, attemptId: "b".repeat(32), previous: {executable: null, marker: null}});

    const channelEnvelope = signedEnvelope(canonicalPayload(rollback.payload), [origin.signingKey]);
    const service = createProductionInstallationService({
      stateDirectory,
      installationDirectory,
      platform: "darwin-arm64",
      trustConfig: origin.trustConfig,
      channelUrl: "https://fixture.example.test/stable.envelope.json",
      transport: {async request() { return {status: 200, headers: {}, body: Buffer.from(channelEnvelope)}; }},
      fetch: async (url) => {
        const value = String(url);
        const bytes = value.endsWith("harness-mr-templates.zip")
          ? rollback.options.templateArchive
          : value.endsWith("bundle-receipt.envelope.json")
            ? rollback.options.templateReceipt
            : rollback.options.cliArchive;
        return new Response(Buffer.from(bytes));
      },
    });

    const installed = await service.rollback("0.1.6");
    assert.equal(installed.status, "installed");
    if (installed.status !== "installed") return;
    assert.equal(installed.active.cliVersion, "0.1.6");
    assert.equal(installed.active.releaseSetId, "stable-0.1.6-rollback");
    assert.equal(installed.active.manifestSequence, 44);
    assert.equal(installed.observed.executableSha256, createHash("sha256").update(rollback.native).digest("hex"));
    assert.equal(await lstat(resolve(stateDirectory, "installation-journal.json")).then(() => true, () => false), false);
  } finally {
    await removeTree(root);
  }
});

// Each fixture performs real native publication, then starts a fresh process
// at a durable boundary rather than treating a phase string as filesystem truth.
test("recovery completes an authenticated published pair at each commit boundary", darwin, async () => {
  for (const boundary of ["publish-intent", "canonical-published", "marker-published", "commit-intent", "active-published"] as const) {
    const fixture = await createPrecommitRecoveryFixture(`production-published-${boundary}-`);
    try {
      await fixture.cache.stageVerifiedReleaseSet(fixture.candidateSnapshot);
      const authenticated = await authenticateReleaseSnapshot(fixture.candidateSnapshot, {platform: "darwin-arm64", trustConfig: fixture.origin.trustConfig});
      await new UpdateStateStore({stateDirectory: fixture.stateDirectory, trustConfigSha256: updateTrustConfigSha256(fixture.origin.trustConfig), bootstrapKeys: fixture.origin.trustConfig.bootstrapKeys})
        .save({trustState: authenticated.verified.nextTrustState, validators: {etag: null, lastModified: null}});
      const stage = await writePreparedJournal(fixture);
      let journal = await fixture.store.read();
      assert.ok(journal);
      journal = advanceInstallationJournalPhase(journal, "publish-intent", null);
      await fixture.store.write(journal);
      const identity = async (name: string) => {
        const info = await lstat(resolve(fixture.installationDirectory, name), {bigint: true});
        return {dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid};
      };
      await publishManagedPosixCandidateAtomic({stage, attemptId: journal.attemptId, previous: {
        executable: await identity("harness-mrtool"), marker: await identity(".harness-mrtool-install.json"),
      }});
      if (boundary !== "publish-intent") {
        for (const phase of ["canonical-published", "marker-published", "commit-intent"] as const) {
          journal = advanceInstallationJournalPhase(journal, phase, null);
          await fixture.store.write(journal);
          if (phase === boundary) break;
        }
      }
      if (boundary === "active-published") await fixture.cache.commitStagedReleaseSet(fixture.candidateSnapshot.record);
      const executableBefore = await readFile(resolve(fixture.installationDirectory, "harness-mrtool"));
      const markerBefore = await readFile(resolve(fixture.installationDirectory, ".harness-mrtool-install.json"));
      const freshService = () => createProductionInstallationService({
        stateDirectory: fixture.stateDirectory, installationDirectory: fixture.installationDirectory,
        platform: "darwin-arm64", trustConfig: fixture.origin.trustConfig,
      });
      if (boundary === "publish-intent") {
        // Identical signed bytes at a substituted inode are not this journal's
        // published slot. A failed observation must leave all durable intent.
        const executable = resolve(fixture.installationDirectory, "harness-mrtool");
        const displaced = resolve(fixture.installationDirectory, "displaced-original");
        const journalBefore = await readFile(fixture.store.path);
        await rename(executable, displaced);
        await writeFile(executable, executableBefore, {mode: 0o500});
        await assert.rejects(freshService().recover(), {code: "UPDATE_SECURITY_ERROR"});
        assert.deepEqual(await readFile(fixture.store.path), journalBefore);
        assert.equal((await fixture.cache.loadLastKnownGoodOrNull())?.record.transactionId, fixture.journal.previous.transactionId);
        await rm(executable); await rename(displaced, executable);
      }
      const recovered = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import {createProductionInstallationService} from ${JSON.stringify(new URL("../../src/update/production-installation-service.ts", import.meta.url).href)};
        import {parseTestOnlyUpdateTrustConfig} from ${JSON.stringify(new URL("../../src/update/trust-config.ts", import.meta.url).href)};
        await createProductionInstallationService({
          stateDirectory: ${JSON.stringify(fixture.stateDirectory)}, installationDirectory: ${JSON.stringify(fixture.installationDirectory)},
          platform: "darwin-arm64", trustConfig: parseTestOnlyUpdateTrustConfig(JSON.parse(process.env.TEST_RECOVERY_CONFIG)),
        }).recover();
      `], {encoding: "utf8", timeout: 30_000, env: {...process.env, TEST_RECOVERY_CONFIG: canonicalUpdateTrustConfigJson(fixture.origin.trustConfig)}});
      assert.equal(recovered.status, 0, recovered.stderr || String(recovered.error ?? recovered.signal));
      const assertRecovered = async () => {
        assert.equal(await fixture.store.read(), null);
        assert.equal((await fixture.cache.loadLastKnownGoodOrNull())?.record.transactionId, fixture.candidateSnapshot.record.transactionId);
        assert.deepEqual(await readFile(resolve(fixture.installationDirectory, "harness-mrtool")), executableBefore);
        assert.deepEqual(await readFile(resolve(fixture.installationDirectory, ".harness-mrtool-install.json")), markerBefore);
      };
      // The parent must not rescue a child that silently did no recovery.
      await assertRecovered();
      await freshService().recover();
      await assertRecovered();
    } finally { await removeTree(fixture.root); }
  }
});



test("fresh-process recovery completes the swap after executable publication only", darwin, async () => {
  const fixture = await createPrecommitRecoveryFixture("production-partial-swap-recovery-");
  try {
    await fixture.cache.stageVerifiedReleaseSet(fixture.candidateSnapshot);
    const auth = await authenticateReleaseSnapshot(fixture.candidateSnapshot, {platform: "darwin-arm64", trustConfig: fixture.origin.trustConfig});
    await new UpdateStateStore({stateDirectory: fixture.stateDirectory, trustConfigSha256: updateTrustConfigSha256(fixture.origin.trustConfig), bootstrapKeys: fixture.origin.trustConfig.bootstrapKeys})
      .save({trustState: auth.verified.nextTrustState, validators: {etag: null, lastModified: null}});
    const stage = await writePreparedJournal(fixture);
    const prepared = await fixture.store.read(); assert.ok(prepared);
    const journal = advanceInstallationJournalPhase(prepared, "publish-intent", null);
    await fixture.store.write(journal);
    const root = await lstat(fixture.installationDirectory, {bigint: true});
    const stageRoot = await lstat(stage.stageDirectory, {bigint: true});
    const canonical = await lstat(resolve(fixture.installationDirectory, "harness-mrtool"), {bigint: true});
    const staged = await lstat(stage.executablePath, {bigint: true});
    await swapAnchoredFile({
      rootDirectory: fixture.installationDirectory,
      rootIdentity: {dev: root.dev, ino: root.ino},
      sourceDirectory: stage.stageDirectory,
      sourceDirectoryIdentity: {dev: stageRoot.dev, ino: stageRoot.ino},
      sourceName: "harness-mrtool",
      sourceIdentity: {dev: staged.dev, ino: staged.ino, size: staged.size, mode: staged.mode, uid: staged.uid},
      destinationName: "harness-mrtool",
      destination: {kind: "identity", identity: {dev: canonical.dev, ino: canonical.ino, size: canonical.size, mode: canonical.mode, uid: canonical.uid}},
    });
    const recovered = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import {createProductionInstallationService} from ${JSON.stringify(new URL("../../src/update/production-installation-service.ts", import.meta.url).href)};
      import {parseTestOnlyUpdateTrustConfig} from ${JSON.stringify(new URL("../../src/update/trust-config.ts", import.meta.url).href)};
      await createProductionInstallationService({stateDirectory:${JSON.stringify(fixture.stateDirectory)}, installationDirectory:${JSON.stringify(fixture.installationDirectory)}, platform:"darwin-arm64", trustConfig:parseTestOnlyUpdateTrustConfig(JSON.parse(process.env.TEST_RECOVERY_CONFIG))}).recover();
    `], {encoding: "utf8", timeout: 30_000, env: {...process.env, TEST_RECOVERY_CONFIG: canonicalUpdateTrustConfigJson(fixture.origin.trustConfig)}});
    assert.equal(recovered.status, 0, recovered.stderr || String(recovered.error ?? recovered.signal));
    assert.equal(await fixture.store.read(), null);
    assert.equal((await fixture.cache.loadLastKnownGoodOrNull())?.record.transactionId, fixture.candidateSnapshot.record.transactionId);
    assert.deepEqual(await readFile(resolve(fixture.installationDirectory, "harness-mrtool")), Buffer.from(auth.executableBytes));
    assert.match(await readFile(resolve(fixture.installationDirectory, ".harness-mrtool-install.json"), "utf8"), /0\.1\.7/u);
    await fixture.service.recover();
    await assert.rejects(lstat(stage.stageDirectory), {code: "ENOENT"});
  } finally { await removeTree(fixture.root); }
});

test("fresh-process recovery restores both canonical files when a partial publisher left them absent", darwin, async () => {
  const fixture = await createPrecommitRecoveryFixture("production-absent-canonical-recovery-");
  try {
    const previousExecutable = await readFile(resolve(fixture.installationDirectory, "harness-mrtool"));
    const previousMarker = await readFile(resolve(fixture.installationDirectory, ".harness-mrtool-install.json"));
    await fixture.cache.stageVerifiedReleaseSet(fixture.candidateSnapshot);
    const auth = await authenticateReleaseSnapshot(fixture.candidateSnapshot, {platform: "darwin-arm64", trustConfig: fixture.origin.trustConfig});
    await new UpdateStateStore({stateDirectory: fixture.stateDirectory, trustConfigSha256: updateTrustConfigSha256(fixture.origin.trustConfig), bootstrapKeys: fixture.origin.trustConfig.bootstrapKeys})
      .save({trustState: auth.verified.nextTrustState, validators: {etag: null, lastModified: null}});
    const stage = await writePreparedJournal(fixture);
    const prepared = await fixture.store.read();
    assert.ok(prepared);
    const journal = advanceInstallationJournalPhase(prepared, "publish-intent", null);
    await fixture.store.write(journal);
    const identity = async (name: string) => {
      const info = await lstat(resolve(fixture.installationDirectory, name), {bigint: true});
      return {dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid};
    };
    await publishManagedPosixCandidateAtomic({stage, attemptId: journal.attemptId, previous: {
      executable: await identity("harness-mrtool"), marker: await identity(".harness-mrtool-install.json"),
    }});
    await rm(resolve(fixture.installationDirectory, "harness-mrtool"));
    await rm(resolve(fixture.installationDirectory, ".harness-mrtool-install.json"));

    const recovered = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import {createProductionInstallationService} from ${JSON.stringify(new URL("../../src/update/production-installation-service.ts", import.meta.url).href)};
      import {parseTestOnlyUpdateTrustConfig} from ${JSON.stringify(new URL("../../src/update/trust-config.ts", import.meta.url).href)};
      await createProductionInstallationService({stateDirectory:${JSON.stringify(fixture.stateDirectory)}, installationDirectory:${JSON.stringify(fixture.installationDirectory)}, platform:"darwin-arm64", trustConfig:parseTestOnlyUpdateTrustConfig(JSON.parse(process.env.TEST_RECOVERY_CONFIG))}).recover();
    `], {encoding: "utf8", timeout: 30_000, env: {...process.env, TEST_RECOVERY_CONFIG: canonicalUpdateTrustConfigJson(fixture.origin.trustConfig)}});
    assert.equal(recovered.status, 0, recovered.stderr || String(recovered.error ?? recovered.signal));
    assert.equal(await fixture.store.read(), null);
    assert.deepEqual(await readFile(resolve(fixture.installationDirectory, "harness-mrtool")), previousExecutable);
    assert.deepEqual(await readFile(resolve(fixture.installationDirectory, ".harness-mrtool-install.json")), previousMarker);
    assert.equal((await fixture.cache.loadLastKnownGoodOrNull())?.record.transactionId, fixture.journal.previous.transactionId);
    await assert.rejects(lstat(stage.stageDirectory), {code: "ENOENT"});
  } finally { await removeTree(fixture.root); }
});

test("published-pair recovery preserves journal and active pointer if predecessor backup is tampered", darwin, async () => {
  const fixture = await createPrecommitRecoveryFixture("production-published-tampered-backup-");
  try {
    await fixture.cache.stageVerifiedReleaseSet(fixture.candidateSnapshot);
    const auth = await authenticateReleaseSnapshot(fixture.candidateSnapshot, {platform: "darwin-arm64", trustConfig: fixture.origin.trustConfig});
    await new UpdateStateStore({stateDirectory: fixture.stateDirectory, trustConfigSha256: updateTrustConfigSha256(fixture.origin.trustConfig), bootstrapKeys: fixture.origin.trustConfig.bootstrapKeys})
      .save({trustState: auth.verified.nextTrustState, validators: {etag: null, lastModified: null}});
    const stage = await writePreparedJournal(fixture);
    const prepared = await fixture.store.read();
    assert.ok(prepared);
    const journal = advanceInstallationJournalPhase(prepared, "publish-intent", null);
    await fixture.store.write(journal);
    const identity = async (name: string) => {
      const info = await lstat(resolve(fixture.installationDirectory, name), {bigint: true});
      return {dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid};
    };
    await publishManagedPosixCandidateAtomic({stage, attemptId: journal.attemptId, previous: {
      executable: await identity("harness-mrtool"), marker: await identity(".harness-mrtool-install.json"),
    }});
    const backup = resolve(stage.stageDirectory, "harness-mrtool");
    await chmod(backup, 0o700);
    const tampered = await readFile(backup); tampered[0] = tampered[0]! ^ 0xff;
    await writeFile(backup, tampered); await chmod(backup, 0o500);
    const before = await readFile(fixture.store.path);
    const pointer = await fixture.cache.loadLastKnownGoodOrNull();
    await assert.rejects(fixture.service.recover(), {code: "UPDATE_SECURITY_ERROR"});
    assert.deepEqual(await readFile(fixture.store.path), before);
    assert.equal((await fixture.cache.loadLastKnownGoodOrNull())?.record.transactionId, pointer?.record.transactionId);
  } finally { await removeTree(fixture.root); }
});


test("failed partial publication retains its journal-owned stage", darwin, async () => {
  if (process.env.MRTOOL_TEST_PARTIAL_PUBLICATION !== "1") {
    const env = {...process.env, MRTOOL_TEST_PARTIAL_PUBLICATION: "1"};
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--experimental-transform-types", "--experimental-test-module-mocks", "--test", "--test-name-pattern=failed partial publication retains", import.meta.filename], {
      encoding: "utf8", timeout: 30_000, env,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /partial-native-boundary-reached/u, child.stdout + child.stderr);
    return;
  }
  const fixture = await createPrecommitRecoveryFixture("production-partial-stage-retention-");
  let capturedStage: posixModule.ManagedPosixStage | undefined;
  try {
    const authenticated = await authenticateReleaseSnapshot(fixture.candidateSnapshot, {platform: "darwin-arm64", trustConfig: fixture.origin.trustConfig});
    mock.module("../../src/update/production-release-preparation.ts", {namedExports: {...preparationModule,
      createProductionReleasePreparer: () => ({prepare: async () => ({snapshot: fixture.candidateSnapshot, authenticated})}),
    }});
    mock.module("../../src/update/production-channel.ts", {namedExports: {...channelModule,
      createProductionChannelClient: () => ({check: async () => ({verified: authenticated.verified, latestVersionConfirmed: true, reachable: true})}),
    }});
    mock.module("../../src/update/managed-installation-posix.ts", {namedExports: {...posixModule,
      publishManagedPosixCandidateAtomic: async (input: posixModule.ManagedPosixAtomicPublicationInput) => {
        capturedStage = input.stage;
        console.log("partial-native-boundary-reached");
        await rename(resolve(fixture.installationDirectory, "harness-mrtool"), resolve(fixture.installationDirectory, "harness-mrtool.previous-" + input.attemptId));
        await rename(input.stage.executablePath, resolve(fixture.installationDirectory, "harness-mrtool"));
        throw new Error("injected failure between native leaf publications");
      },
    }});
    // Fresh import uses the controlled publication boundary; actual journal,
    // signed snapshots, staging, cache and cleanup remain production code.
    const {createProductionInstallationService: createService} = await import(new URL("../../src/update/production-installation-service.ts?partial-retention", import.meta.url).href);
    const service = createService({stateDirectory: fixture.stateDirectory, installationDirectory: fixture.installationDirectory,
      platform: "darwin-arm64", trustConfig: fixture.origin.trustConfig});
    await assert.rejects(service.apply(false), {code: "UPDATE_SECURITY_ERROR"});
    assert.ok(capturedStage);
    assert.equal((await fixture.store.read())?.phase, "publish-intent");
    assert.equal((await fixture.cache.loadLastKnownGoodOrNull())?.record.transactionId, fixture.journal.previous.transactionId);
    assert.ok((await lstat(capturedStage.stageDirectory)).isDirectory());
    assert.ok((await readFile(capturedStage.markerPath)).length > 0);
  } finally { mock.restoreAll(); await removeTree(fixture.root); }
});
