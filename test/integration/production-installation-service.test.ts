import assert from "node:assert/strict";
import {chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm} from "node:fs/promises";
import test from "node:test";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

import {createAuthenticatedReleaseSnapshot, createReleaseSetSnapshotVerifier} from "../../src/update/release-set-verifier.ts";
import {UpdateCache} from "../../src/update/cache.ts";
import {stageAuthenticatedManagedPosixCandidate, publishManagedPosixCandidate} from "../../src/update/managed-installation-posix.ts";
import {createProductionInstallationService} from "../../src/update/production-installation-service.ts";
import {exactReleaseFixture} from "../helpers/default-historical-fixture.ts";
import {nativeReleaseFixtureFamily} from "../helpers/native-release-fixture.ts";
import {canonicalPayload, signedEnvelope} from "../helpers/signing.ts";

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
