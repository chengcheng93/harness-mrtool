import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createAuthenticatedReleaseSnapshot } from "../../src/update/release-set-verifier.ts";
import {
  stageAuthenticatedManagedWindowsCandidate,
  verifyManagedWindowsStage,
} from "../../src/update/managed-installation-windows.ts";
import { nativeReleaseFixture } from "../helpers/native-release-fixture.ts";

const windows = { skip: process.platform !== "win32" };
const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });

test("stages only the authenticated Windows native archive member", windows, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-mrtool-managed-win-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixture = await nativeReleaseFixture("windows-x64", { variantByte: 17 });
  const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
  const stage = await stageAuthenticatedManagedWindowsCandidate({
    installationDirectory: root,
    snapshot,
    platform: "windows-x64",
    trustConfig: fixture.signed.trustConfig,
    windowsAclVerifier: allowTestAcl,
  });
  assert.deepEqual(await readFile(stage.stagedExecutablePath), Buffer.from(fixture.native));
  const observed = await verifyManagedWindowsStage(stage);
  assert.equal(observed.executableSha256, stage.executableSha256);
  assert.equal(observed.markerSha256, stage.markerSha256);
});

test("Windows managed staging fails closed before touching a non-Windows root", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(
    stageAuthenticatedManagedWindowsCandidate({
      installationDirectory: resolve(tmpdir(), "must-not-be-created"),
      snapshot: {} as never,
      platform: "windows-x64",
    }),
    { code: "UPDATE_SECURITY_ERROR" },
  );
});
