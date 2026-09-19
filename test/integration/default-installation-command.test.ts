import assert from "node:assert/strict";
import test from "node:test";

import { chmod, lstat, mkdir, mkdtemp, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runProductionMain } from "../../src/production-main.ts";
import { activateReleaseSet } from "../../src/update/activation.ts";
import { createAuthenticatedReleaseSnapshot, createReleaseSetSnapshotVerifier } from "../../src/update/release-set-verifier.ts";
import { nativeReleaseFixture, nativeReleaseFixtureFamily } from "../helpers/native-release-fixture.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";
import { UpdateCache } from "../../src/update/cache.ts";
import { stageAuthenticatedManagedPosixCandidate, publishManagedPosixCandidate } from "../../src/update/managed-installation-posix.ts";
import { canonicalPayload, signedEnvelope } from "../helpers/signing.ts";
import type { ProductionInstallationService } from "../../src/update/managed-installation-types.ts";


async function cleanupPrivateTree(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await chmod(current, 0o700);
      for (const entry of await readdir(current, { withFileTypes: true })) {
        pending.push(resolve(current, entry.name));
      }
    } else {
      await chmod(current, 0o600).catch(() => undefined);
    }
  }
  await rm(root, { recursive: true, force: true });
}

function outputSink(chunks: string[]) {
  return { write(chunk: string): boolean { chunks.push(chunk); return true; } };
}

const darwin = { skip: process.platform !== "darwin" || process.arch !== "arm64" };

function installationService(recover: () => Promise<void>): ProductionInstallationService {
  return {
    apply: async () => { throw new Error("apply must not run"); },
    rollback: async () => { throw new Error("rollback must not run"); },
    recover,
  } as unknown as ProductionInstallationService;
}

test("default production entry recovers a durable installation journal before ordinary work", async () => {
  let recoveries = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runProductionMain(["version", "--no-update", "--output", "json"], {
    installationService: installationService(async () => { recoveries += 1; }),
    stdout: outputSink(stdout),
    stderr: outputSink(stderr),
  });

  assert.equal(exitCode, 0);
  assert.equal(recoveries, 1);
  assert.equal(stderr.join(""), "");
  assert.equal((JSON.parse(stdout.join("")) as { readonly code: string }).code, "OK");
});

test("self-update repair owns recovery and is not double-recovered by startup", async () => {
  let recoveries = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runProductionMain(["self-update", "repair", "--no-update", "--output", "json"], {
    installationService: installationService(async () => { recoveries += 1; }),
    stdout: outputSink(stdout),
    stderr: outputSink(stderr),
  });

  assert.equal(exitCode, 0);
  assert.equal(recoveries, 1);
  assert.equal(stderr.join(""), "");
  assert.equal((JSON.parse(stdout.join("")) as { readonly code: string }).code, "OK");
});


test("default production apply and rollback use the real installation coordinator", darwin, async (t) => {
  const origin = await exactReleaseFixture();
  const family = nativeReleaseFixtureFamily(origin);
  const previous = await family("darwin-arm64", { sequence: 43, cliVersion: "0.1.6", variantByte: 1, releaseSetId: "stable-0.1.6" });
  const candidate = await family("darwin-arm64", { sequence: 44, cliVersion: "0.1.7", variantByte: 2, releaseSetId: "stable-0.1.7" });
  const rollback = await family("darwin-arm64", { sequence: 45, cliVersion: "0.1.6", variantByte: 1, releaseSetId: "stable-0.1.6-rollback" });
  const previousSnapshot = await createAuthenticatedReleaseSnapshot(previous.options);
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "harness-mrtool-default-installation-"));
  t.after(() => cleanupPrivateTree(root));
  const stateDirectory = resolve(root, "state");
  const installationDirectory = resolve(root, "installation");
  await mkdir(installationDirectory, { mode: 0o700 });
  const verifier = createReleaseSetSnapshotVerifier({ platform: "darwin-arm64", trustConfig: origin.trustConfig });
  const cache = new UpdateCache({ stateDirectory, verifySnapshot: verifier });
  await cache.storeVerifiedReleaseSet(previousSnapshot);
  const previousStage = await stageAuthenticatedManagedPosixCandidate({
    installationDirectory, snapshot: previousSnapshot, platform: "darwin-arm64", trustConfig: origin.trustConfig,
  });
  await publishManagedPosixCandidate({ stage: previousStage, attemptId: "c".repeat(32), previous: { executable: null, marker: null } });

  const run = async (payload: typeof candidate.payload, assets: typeof candidate.options) => {
    const channelEnvelope = signedEnvelope(canonicalPayload(payload), [origin.signingKey]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runProductionMain(["self-update", payload.releaseSet.id.endsWith("rollback") ? "rollback" : "apply", ...(payload.releaseSet.id.endsWith("rollback") ? ["--version", "0.1.6"] : []), "--output", "json"], {
      updatePreflight: { run: async () => undefined },
      updateChannelDefaults: {
        stateDirectory, installationDirectory, platform: "darwin-arm64", trustConfig: origin.trustConfig,
        channelUrl: "https://fixture.example.test/stable.envelope.json",
        transport: { async request() { return { status: 200, headers: {}, body: Buffer.from(channelEnvelope) }; } },
        fetch: async (url) => {
          const value = String(url);
          const bytes = value.endsWith("harness-mr-templates.zip") ? assets.templateArchive
            : value.endsWith("bundle-receipt.envelope.json") ? assets.templateReceipt : assets.cliArchive;
          return new Response(Buffer.from(bytes));
        },
      },
      stdout: outputSink(stdout), stderr: outputSink(stderr),
    });
    assert.equal(stderr.join(""), "");
    return { exitCode, output: JSON.parse(stdout.join("")) as { readonly code: string; readonly data: Record<string, unknown> } };
  };

  const applied = await run(candidate.payload, candidate.options);
  assert.equal(applied.exitCode, 0);
  assert.equal(applied.output.code, "OK");
  assert.equal(applied.output.data.command, "self-update.apply");
  assert.equal(applied.output.data.status, "installed");
  assert.equal(applied.output.data.releaseSetId, "stable-0.1.7");

  const restored = await run(rollback.payload, rollback.options);
  assert.equal(restored.exitCode, 0);
  assert.equal(restored.output.code, "OK");
  assert.equal(restored.output.data.command, "self-update.rollback");
  assert.equal(restored.output.data.status, "installed");
  assert.equal(restored.output.data.releaseSetId, "stable-0.1.6-rollback");
});


test("default production entry selects the authenticated active Template Bundle", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-mrtool-default-bundle-"));
  t.after(() => cleanupPrivateTree(root));
  const fixture = await nativeReleaseFixture("darwin-arm64");
  const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
  await activateReleaseSet({
    stateDirectory: root,
    next: snapshot,
    verifySnapshot: createReleaseSetSnapshotVerifier(fixture.options),
    windowsAclVerifier: { verify: async () => undefined },
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runProductionMain(["version", "--no-update", "--output", "json"], {
    updateChannelDefaults: {
      stateDirectory: root,
      trustConfig: fixture.signed.trustConfig,
      platform: "darwin-arm64",
      windowsAclVerifier: { verify: async () => undefined },
    },
    stdout: outputSink(stdout),
    stderr: outputSink(stderr),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  const result = JSON.parse(stdout.join("")) as {
    readonly data: { readonly releaseTag: string };
    readonly versions: { readonly releaseSetId: string };
  };
  assert.equal(result.versions.releaseSetId, snapshot.record.releaseSetId);
  assert.equal(result.data.releaseTag, `templates-v${snapshot.record.templateVersion}`);
});
