import assert from "node:assert/strict";
import test from "node:test";

import { createTestOnlyUpdateTrustConfig } from "../../src/update/trust-config.ts";
import {
  createUpdateService,
  type UpdateService,
} from "../../src/update/service.ts";
import type { LoadedReleaseSet } from "../../src/update/cache.ts";
import type { VerifiedChannelManifest } from "../../src/update/manifest.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { createSigningFixture } from "../helpers/signing.ts";
import { runProductionMain } from "../../src/production-main.ts";

const signingFixture = createSigningFixture("fixture-root");
const trustConfig = createTestOnlyUpdateTrustConfig({
  repository: { owner: "fixture", name: "harness-mrtool" },
  pagesOrigin: "http://127.0.0.1:43127",
  bootstrapKeys: [{
    keyId: signingFixture.keyId,
    publicKeySpki: signingFixture.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }],
});

function fakeRelease(sequence: number): LoadedReleaseSet {
  const bytes = new TextEncoder().encode(`release-${String(sequence)}\n`);
  const record = {
    cacheVersion: 1 as const,
    recordType: "active-release-set" as const,
    releaseSetId: `fixture-${String(sequence)}`,
    cliVersion: `1.0.${String(sequence)}`,
    cliSha256: "a".repeat(64),
    templateVersion: "1.0.0",
    templateSha256: "b".repeat(64),
    manifestVersion: 1 as const,
    inputSchema: 1,
    policySchema: 1,
    manifestSequence: sequence,
    transactionId: `tx-${String(sequence)}`,
    receiptSha256: "c".repeat(64),
  };
  return Object.freeze({
    record: Object.freeze(record),
    cliBytes: bytes,
    templateBytes: bytes,
    receiptBytes: bytes,
    releaseDirectory: "C:\\fixture\\release",
    cliPath: "C:\\fixture\\release\\harness-mrtool.exe",
    templatePath: "C:\\fixture\\release\\template.zip",
    receiptPath: "C:\\fixture\\release\\receipt.json",
    writesBlocked: false,
    writeBlockReasons: [],
  });
}

function serviceFixture(options: {
  readonly lkg?: LoadedReleaseSet | null;
  readonly channel?: (input: { readonly force: boolean }) => Promise<VerifiedChannelManifest | null>;
} = {}): UpdateService {
  return createUpdateService({
    trustConfig,
    loadLastKnownGoodOrNull: async () => options.lkg ?? null,
    ...(options.channel === undefined ? {} : { checkChannel: options.channel }),
  });
}

test("offline preflight uses only a verified last-known-good release", async () => {
  let channelCalls = 0;
  const service = serviceFixture({
    lkg: fakeRelease(7),
    channel: async () => {
      channelCalls += 1;
      throw new Error("network must not be touched in offline mode");
    },
  });

  const result = await service.preflight({ commandKind: "self-update.check", offline: true, noUpdate: false });
  assert.deepEqual(result, {
    mode: "offline",
    usingLastKnownGood: true,
    latestVersionConfirmed: false,
    manifestSequence: 7,
  });
  assert.equal(channelCalls, 0);
});

test("offline preflight fails safely when no last-known-good release exists", async () => {
  await assert.rejects(
    () => serviceFixture().preflight({ commandKind: "self-update.check", offline: true, noUpdate: false }),
    (error: unknown) => isToolError(error, "UPDATE_REQUIRED"),
  );
});

test("no-update preflight never reads the network or consumes the cache", async () => {
  let lkgCalls = 0;
  let channelCalls = 0;
  const service = createUpdateService({
    trustConfig,
    loadLastKnownGoodOrNull: async () => {
      lkgCalls += 1;
      return fakeRelease(8);
    },
    checkChannel: async () => {
      channelCalls += 1;
      return null;
    },
  });

  const result = await service.preflight({ commandKind: "version", offline: false, noUpdate: true });
  assert.deepEqual(result, {
    mode: "no-update",
    usingLastKnownGood: false,
    latestVersionConfirmed: false,
    manifestSequence: null,
  });
  assert.equal(lkgCalls, 0);
  assert.equal(channelCalls, 0);
});

test("ordinary preflight requires a signed channel port", async () => {
  await assert.rejects(
    () => serviceFixture().preflight({ commandKind: "doctor", offline: false, noUpdate: false }),
    (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
  );
});

test("not-modified signed checks fall back only to the verified LKG", async () => {
  let channelCalls = 0;
  const service = serviceFixture({
    lkg: fakeRelease(9),
    channel: async ({ force }) => {
      channelCalls += force ? 2 : 1;
      return null;
    },
  });

  const result = await service.check(true);
  assert.deepEqual(result, {
    mode: "checked",
    usingLastKnownGood: true,
    latestVersionConfirmed: false,
    manifestSequence: 9,
  });
  assert.equal(channelCalls, 2);
});

test("a verified changed channel is reflected without accepting an unbranded manifest", async () => {
  const service = serviceFixture({
    channel: async () => null,
  });
  await assert.rejects(
    () => service.check(false),
    (error: unknown) => isToolError(error, "UPDATE_REQUIRED"),
  );
});

test("an injected update service drives the check command through the same preflight", async () => {
  const service = serviceFixture({ lkg: fakeRelease(10), channel: async () => null });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runProductionMain(["self-update", "check", "--output", "json"], {
    updateService: service,
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk) => { stderr.push(chunk); return true; } },
  });

  assert.equal(exitCode, 0, stderr.join("") || stdout.join(""));
  const output = JSON.parse(stdout.join("")) as {
    readonly data: { readonly command: string; readonly mode: string; readonly manifestSequence: number };
  };
  assert.deepEqual(output.data, {
    command: "self-update.check",
    mode: "checked",
    usingLastKnownGood: true,
    latestVersionConfirmed: false,
    manifestSequence: 10,
  });
});
