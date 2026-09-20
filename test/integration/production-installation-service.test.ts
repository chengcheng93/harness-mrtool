import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm} from "node:fs/promises";
import test from "node:test";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

import {authenticateReleaseSnapshot, createAuthenticatedReleaseSnapshot, createReleaseSetSnapshotVerifier} from "../../src/update/release-set-verifier.ts";
import {UpdateCache} from "../../src/update/cache.ts";
import {stageAuthenticatedManagedPosixCandidate, publishManagedPosixCandidate} from "../../src/update/managed-installation-posix.ts";
import {createProductionInstallationService, createInitialInstallationJournal} from "../../src/update/production-installation-service.ts";
import {exactReleaseFixture} from "../helpers/default-historical-fixture.ts";
import {nativeReleaseFixtureFamily} from "../helpers/native-release-fixture.ts";
import {canonicalPayload, signedEnvelope} from "../helpers/signing.ts";
import {createInstallationJournalStore} from "../../src/update/installation-journal-store.ts";
import {advanceInstallationJournalPhase} from "../../src/update/installation-journal-coordination.ts";
import {verifyManagedPosixStage} from "../../src/update/managed-installation-posix.ts";

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
      await service.recover();
      assert.equal(await lstat(resolve(stateDirectory, "installation-journal.json")).then(() => true, () => false), false);
    } finally {
      await removeTree(root);
    }
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
