import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import {
  checkStableChannel,
  type ChannelHttpRequest,
  type ChannelHttpTransport,
} from "../../src/update/http.ts";
import {
  canonicalUpdateTrustConfigBytes,
  canonicalUpdateTrustConfigJson,
  createProductionUpdateTrustConfig,
  createTestOnlyUpdateTrustConfig,
  parseProductionUpdateTrustConfig,
  parseTestOnlyUpdateTrustConfig,
  PRODUCTION_UPDATE_BOOTSTRAP_KEY_FINGERPRINTS,
  PRODUCTION_UPDATE_BOOTSTRAP_KEYS,
  PRODUCTION_UPDATE_CHANNEL_URL,
  PRODUCTION_UPDATE_PAGES_ORIGIN,
  PRODUCTION_UPDATE_REPOSITORY,
  stableChannelEnvelopeUrl,
  updateTrustConfigSha256,
} from "../../src/update/trust-config.ts";
import { createSigningFixture } from "../helpers/signing.ts";

function signingKey(keyId = "release-key-1") {
  const fixture = createSigningFixture(keyId);
  return {
    keyId: fixture.keyId,
    publicKeySpki: fixture.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  } as const;
}

function assertSecurityError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"));
}

test("production trust is source-pinned and fails closed until reviewed roots exist", () => {
  assert.deepEqual(PRODUCTION_UPDATE_BOOTSTRAP_KEYS, []);
  assert.deepEqual(PRODUCTION_UPDATE_BOOTSTRAP_KEY_FINGERPRINTS, []);
  assert.equal(PRODUCTION_UPDATE_REPOSITORY.owner, "chengcheng93");
  assert.equal(PRODUCTION_UPDATE_REPOSITORY.name, "harness-mrtool");
  assert.equal(PRODUCTION_UPDATE_PAGES_ORIGIN, "https://chengcheng93.github.io");
  assert.equal(
    PRODUCTION_UPDATE_CHANNEL_URL,
    "https://chengcheng93.github.io/harness-mrtool/stable.envelope.json",
  );

  assertSecurityError(() => createProductionUpdateTrustConfig());
  assertSecurityError(() => (createProductionUpdateTrustConfig as (...args: unknown[]) => unknown)(
    [signingKey()],
  ));
  assertSecurityError(() => parseProductionUpdateTrustConfig({
    trustConfigVersion: 1,
    repository: PRODUCTION_UPDATE_REPOSITORY,
    pagesOrigin: PRODUCTION_UPDATE_PAGES_ORIGIN,
    bootstrapKeys: [signingKey()],
    testOnly: false,
  }));
});

test("explicit test-only construction accepts a random loopback origin and fake root", () => {
  const key = signingKey("fake-test-key");
  const config = createTestOnlyUpdateTrustConfig({
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:45123",
    bootstrapKeys: [key],
  });

  assert.deepEqual(config, {
    trustConfigVersion: 1,
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:45123",
    bootstrapKeys: [key],
    testOnly: true,
  });
});

test("production parser rejects schema, origin, mode, and root substitutions", () => {
  const plain = {
    trustConfigVersion: 1,
    repository: PRODUCTION_UPDATE_REPOSITORY,
    pagesOrigin: PRODUCTION_UPDATE_PAGES_ORIGIN,
    bootstrapKeys: [signingKey()],
    testOnly: false,
  };
  for (const invalid of [
    plain,
    { ...plain, extra: true },
    { ...plain, repository: { ...PRODUCTION_UPDATE_REPOSITORY, extra: true } },
    { ...plain, repository: { owner: "other", name: "harness-mrtool" } },
    { ...plain, pagesOrigin: "http://127.0.0.1:45123" },
    { ...plain, pagesOrigin: "https://10.0.0.1" },
    { ...plain, pagesOrigin: "https://localhost" },
    { ...plain, pagesOrigin: `${PRODUCTION_UPDATE_PAGES_ORIGIN}:443` },
    { ...plain, pagesOrigin: `${PRODUCTION_UPDATE_PAGES_ORIGIN}/other` },
    { ...plain, pagesOrigin: `${PRODUCTION_UPDATE_PAGES_ORIGIN}?testOnly=true` },
    { ...plain, testOnly: true },
  ]) {
    assertSecurityError(() => parseProductionUpdateTrustConfig(invalid));
  }
});

test("test-only parser is closed and limited to canonical literal loopback origins", () => {
  const input = {
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:45123",
    bootstrapKeys: [signingKey("fake-test-key")],
  } as const;
  const config = createTestOnlyUpdateTrustConfig(input);
  assert.deepEqual(
    parseTestOnlyUpdateTrustConfig(JSON.parse(JSON.stringify(config))),
    config,
  );
  assert.equal(
    createTestOnlyUpdateTrustConfig({ ...input, pagesOrigin: "http://[::1]:45124" })
      .pagesOrigin,
    "http://[::1]:45124",
  );

  for (const invalidOrigin of [
    "http://localhost:45123",
    "http://10.0.0.1:45123",
    "http://192.168.1.2:45123",
    "http://127.0.0.1",
    "https://127.0.0.1:45123",
    "http://user@127.0.0.1:45123",
    "http://127.0.0.1:45123/path",
    "http://127.0.0.1:45123?mode=test",
    "http://127.0.0.1:45123#test",
  ]) {
    assertSecurityError(() => createTestOnlyUpdateTrustConfig({
      ...input,
      pagesOrigin: invalidOrigin,
    }));
  }
  assertSecurityError(() => createTestOnlyUpdateTrustConfig({
    ...input,
    extra: true,
  } as never));
  assertSecurityError(() => parseTestOnlyUpdateTrustConfig({
    ...config,
    testOnly: false,
  }));
  assertSecurityError(() => parseTestOnlyUpdateTrustConfig({
    ...config,
    extra: true,
  }));
});

test("test-only origins enforce canonical port bounds", () => {
  const input = {
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    bootstrapKeys: [signingKey("fake-test-key")],
  } as const;
  for (const port of [1, 65_535]) {
    assert.equal(
      createTestOnlyUpdateTrustConfig({
        ...input,
        pagesOrigin: `http://127.0.0.1:${String(port)}`,
      }).pagesOrigin,
      `http://127.0.0.1:${String(port)}`,
    );
  }
  for (const invalidOrigin of [
    "http://127.0.0.1:0",
    "http://127.0.0.1:00001",
    "http://127.0.0.1:65536",
  ]) {
    assertSecurityError(() => createTestOnlyUpdateTrustConfig({
      ...input,
      pagesOrigin: invalidOrigin,
    }));
  }
});

test("bootstrap SPKI bytes must be the canonical Ed25519 DER encoding", () => {
  const key = signingKey("fake-test-key");
  const noncanonical = Buffer.concat([
    Buffer.from(key.publicKeySpki, "base64url"),
    Buffer.from([0]),
  ]).toString("base64url");

  assertSecurityError(() => createTestOnlyUpdateTrustConfig({
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:45123",
    bootstrapKeys: [{ ...key, publicKeySpki: noncanonical }],
  }));
});

test("branded trust derives the fixed channel path and production URL composes with HTTP", async () => {
  const config = createTestOnlyUpdateTrustConfig({
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:45123",
    bootstrapKeys: [signingKey("fake-test-key")],
  });
  assert.equal(
    stableChannelEnvelopeUrl(config),
    "http://127.0.0.1:45123/harness-mrtool/stable.envelope.json",
  );
  assertSecurityError(() => stableChannelEnvelopeUrl({ ...config }));

  const requests: ChannelHttpRequest[] = [];
  const transport: ChannelHttpTransport = {
    async request(request) {
      requests.push(request);
      return { status: 304, headers: {}, body: new Uint8Array() };
    },
  };
  const result = await checkStableChannel({
    url: PRODUCTION_UPDATE_CHANNEL_URL,
    transport,
    validators: { etag: null, lastModified: null },
    force: false,
  });
  assert.equal(result.kind, "not-modified");
  assert.equal(requests[0]?.url, PRODUCTION_UPDATE_CHANNEL_URL);
});

test("build input is canonical, copy-safe, and cannot relabel test trust", () => {
  const testOnly = createTestOnlyUpdateTrustConfig({
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:45123",
    bootstrapKeys: [signingKey("fake-test-key")],
  });
  const expectedJson = canonicalizeJson(testOnly);
  const firstBytes = canonicalUpdateTrustConfigBytes(testOnly);

  assert.equal(canonicalUpdateTrustConfigJson(testOnly), expectedJson);
  assert.equal(new TextDecoder().decode(firstBytes), expectedJson);
  assert.equal(updateTrustConfigSha256(testOnly), sha256Utf8(expectedJson));
  assert.match(expectedJson, /"testOnly":true/u);

  firstBytes.fill(0);
  assert.equal(
    new TextDecoder().decode(canonicalUpdateTrustConfigBytes(testOnly)),
    expectedJson,
  );
  assertSecurityError(() => canonicalUpdateTrustConfigBytes({
    ...testOnly,
    testOnly: false,
  }));
  assertSecurityError(() => parseProductionUpdateTrustConfig(JSON.parse(expectedJson)));
});

test("canonical digest changes on semantic trust drift and normalizes key ordering", () => {
  const first = signingKey("fake-test-key-1");
  const second = signingKey("fake-test-key-2");
  const build = (bootstrapKeys: readonly ReturnType<typeof signingKey>[]) =>
    createTestOnlyUpdateTrustConfig({
      repository: { owner: "fake-owner", name: "harness-mrtool" },
      pagesOrigin: "http://127.0.0.1:45123",
      bootstrapKeys,
    });
  const ordered = build([first, second]);
  const reversed = build([second, first]);
  const changedRoot = build([first, signingKey("fake-test-key-3")]);

  assert.equal(updateTrustConfigSha256(ordered), updateTrustConfigSha256(reversed));
  assert.notEqual(updateTrustConfigSha256(ordered), updateTrustConfigSha256(changedRoot));
  assert.match(canonicalUpdateTrustConfigJson(ordered), /"testOnly":true/u);
});

test("constructed configs are deep-frozen defensive copies", () => {
  const sourceKey = { ...signingKey("fake-test-key") };
  const sourceKeys = [sourceKey];
  const config = createTestOnlyUpdateTrustConfig({
    repository: { owner: "fake-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:45123",
    bootstrapKeys: sourceKeys,
  });
  sourceKey.keyId = "fake-test-key-mutated";
  sourceKeys.length = 0;

  assert.equal(config.bootstrapKeys[0]?.keyId, "fake-test-key");
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.repository), true);
  assert.equal(Object.isFrozen(config.bootstrapKeys), true);
  assert.equal(Object.isFrozen(config.bootstrapKeys[0]), true);
});

test("configuration failures never reflect supplied origins or keys", () => {
  const canaryOrigin = "http://127.0.0.1:45123/DO_NOT_REFLECT";
  const canaryKey = "fake-test-DO_NOT_REFLECT";
  let captured: unknown;
  try {
    parseProductionUpdateTrustConfig({
      trustConfigVersion: 1,
      repository: PRODUCTION_UPDATE_REPOSITORY,
      pagesOrigin: canaryOrigin,
      bootstrapKeys: [signingKey(canaryKey)],
      testOnly: false,
    });
  } catch (error) {
    captured = error;
  }
  assert.equal(isToolError(captured, "UPDATE_SECURITY_ERROR"), true);
  const publicError = JSON.stringify({
    message: (captured as Error).message,
    details: (captured as { details: unknown }).details,
  });
  assert.doesNotMatch(publicError, /DO_NOT_REFLECT/u);
  assert.doesNotMatch(publicError, /127\.0\.0\.1/u);
});

test("trust configuration has no runtime environment or argv override path", async () => {
  const source = await readFile(
    new URL("../../src/update/trust-config.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /process\s*\.\s*(?:env|argv)/u);
});
