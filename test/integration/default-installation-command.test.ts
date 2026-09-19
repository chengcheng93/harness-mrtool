import assert from "node:assert/strict";
import test from "node:test";

import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runProductionMain } from "../../src/production-main.ts";
import { activateReleaseSet } from "../../src/update/activation.ts";
import { createAuthenticatedReleaseSnapshot, createReleaseSetSnapshotVerifier } from "../../src/update/release-set-verifier.ts";
import { nativeReleaseFixture } from "../helpers/native-release-fixture.ts";
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
