import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { TEMPLATE_BUNDLE_PAYLOAD_PATHS } from "../../src/bundle/types.ts";
import {
  canonicalizeJson,
  sha256Utf8,
  type JsonObject,
} from "../../src/contracts/jcs.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import {
  createHistoricalBundleLoader,
  type HistoricalBundleReleaseAssetRequest,
  type HistoricalBundleReleaseAssets,
} from "../../src/update/historical-bundle-loader.ts";
import { createTrustState } from "../../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import { createTestOnlyUpdateTrustConfig } from "../../src/update/trust-config.ts";
import {
  canonicalPayload,
  createSigningFixture,
  signedEnvelope,
} from "../helpers/signing.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const bundleDirectory = resolve(repositoryRoot, "template-bundle");
const repository = Object.freeze({ owner: "fixture-owner", name: "harness-mrtool" });

async function exactReleaseFixture(): Promise<{
  readonly reference: {
    readonly releaseTag: string;
    readonly bundleId: string;
    readonly bundleVersion: string;
    readonly bundleManifestHash: string;
    readonly policySchema: number;
  };
  readonly trustConfig: ReturnType<typeof createTestOnlyUpdateTrustConfig>;
  readonly trustState: ReturnType<typeof verifyChannelEnvelope>["nextTrustState"];
  readonly assets: HistoricalBundleReleaseAssets;
  readonly mutableFiles: Map<string, Uint8Array>;
  readonly signingKey: ReturnType<typeof createSigningFixture>;
  readonly bootstrapKeys: ReturnType<typeof createTrustState>["bootstrapKeys"];
  readonly receiptPayload: JsonObject;
  readonly channelPayload: JsonObject;
}> {
  const key = createSigningFixture("fixture-release-key-1");
  const manifestText = await readFile(resolve(bundleDirectory, "bundle-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as JsonObject;
  const manifestBytes = new TextEncoder().encode(manifestText);
  const bundleManifestHash = sha256Utf8(manifestText);
  const files = new Map<string, Uint8Array>([["bundle-manifest.json", manifestBytes]]);
  for (const file of manifest.files as JsonObject[]) {
    files.set(String(file.path), await readFile(resolve(bundleDirectory, String(file.path))));
  }
  const receiptPayload: JsonObject = {
    receiptVersion: 1,
    receiptType: "template-bundle",
    signingSequence: 42,
    signingKeyId: key.keyId,
    repository,
    releaseTag: "templates-v1.0.0",
    bundleId: manifest.bundleId!,
    bundleVersion: manifest.version!,
    bundleManifest: {
      sha256: bundleManifestHash,
      size: manifestBytes.byteLength,
    },
    inputSchema: manifest.inputSchema!,
    policySchema: manifest.policySchema!,
    skillProtocols: [1],
    files: [
      {
        path: "bundle-manifest.json",
        size: manifestBytes.byteLength,
        sha256: bundleManifestHash,
      },
      ...(manifest.files as JsonObject[]),
    ],
  };
  const channelPayload: JsonObject = {
    manifestVersion: 1,
    sequence: 42,
    channel: "stable",
    issuedAt: "2026-08-16T00:00:00Z",
    repository,
    components: {
      cli: {
        version: "1.2.3",
        tag: "cli-v1.2.3",
        inputSchemas: [1],
        policySchemas: [1],
        skillProtocols: [1],
        artifacts: {
          "windows-x64": {
            name: "harness-mrtool-windows-x64.zip",
            sha256: "a".repeat(64),
            size: 1,
          },
        },
      },
      templates: {
        version: "1.0.0",
        tag: "templates-v1.0.0",
        inputSchema: 1,
        policySchema: 1,
        minCliVersion: "1.2.0",
        asset: "harness-mr-templates.zip",
        sha256: "b".repeat(64),
        size: 1,
      },
      skill: {
        version: "1.1.0",
        tag: "skill-v1.1.0",
        skillProtocol: 1,
        cliVersionRange: ">=1.2.0 <2.0.0",
        asset: "harness-mr-skill.zip",
        sha256: "c".repeat(64),
        size: 1,
        activation: "explicit-host-refresh",
      },
    },
    releaseSet: { id: "stable-42", cli: "1.2.3", templates: "1.0.0" },
    security: {
      minimumAllowedCliVersion: "1.0.0",
      revokedCliVersions: [],
      revokedReleaseSetIds: [],
    },
    templateHistory: [{
      releaseTag: "templates-v1.0.0",
      bundleManifestHash,
      receiptPayloadSha256: sha256Utf8(`${canonicalizeJson(receiptPayload)}\n`),
      signingSequence: 42,
      signingKeyId: key.keyId,
    }],
    recommendedSkillVersion: "1.1.0",
  };
  const bootstrapKeys = Object.freeze([Object.freeze({
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  })]);
  const trustConfig = createTestOnlyUpdateTrustConfig({
    repository,
    pagesOrigin: "http://127.0.0.1:43123",
    bootstrapKeys,
  });
  const trustState = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(channelPayload), [key]),
    createTrustState(bootstrapKeys),
    repository,
    bootstrapKeys,
  ).nextTrustState;
  return {
    reference: {
      releaseTag: "templates-v1.0.0",
      bundleId: String(manifest.bundleId),
      bundleVersion: String(manifest.version),
      bundleManifestHash,
      policySchema: Number(manifest.policySchema),
    },
    trustConfig,
    trustState,
    assets: {
      repository,
      releaseTag: "templates-v1.0.0",
      receiptEnvelope: signedEnvelope(canonicalPayload(receiptPayload), [key]),
      files,
    },
    mutableFiles: files,
    signingKey: key,
    bootstrapKeys,
    receiptPayload,
    channelPayload,
  };
}

function withAssets(
  fixture: Awaited<ReturnType<typeof exactReleaseFixture>>,
  overrides: Partial<HistoricalBundleReleaseAssets>,
): HistoricalBundleReleaseAssets {
  return { ...fixture.assets, ...overrides };
}

function loaderFor(
  fixture: Awaited<ReturnType<typeof exactReleaseFixture>>,
  assets: HistoricalBundleReleaseAssets | null,
  trustState = fixture.trustState,
) {
  return createHistoricalBundleLoader({
    trustConfig: fixture.trustConfig,
    trustState,
    releaseAssets: { loadExact: async () => assets },
  });
}

async function assertUpdateSecurity(
  operation: () => Promise<unknown>,
  forbidden: readonly string[] = [],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(isToolError(error, "UPDATE_SECURITY_ERROR"), true);
    const serialized = JSON.stringify(error);
    for (const value of forbidden) assert.equal(serialized.includes(value), false);
    return true;
  });
}

test("loads an exact historical Bundle only after the signed history, receipt, manifest, and bytes verify", async () => {
  const fixture = await exactReleaseFixture();
  const requests: HistoricalBundleReleaseAssetRequest[] = [];
  const loader = createHistoricalBundleLoader({
    trustConfig: fixture.trustConfig,
    trustState: fixture.trustState,
    releaseAssets: {
      loadExact: async (request) => {
        requests.push(request);
        return fixture.assets;
      },
    },
  });

  const loaded = await loader.loadVerifiedExact(fixture.reference);

  assert.equal(loaded.trusted, true);
  if (!loaded.trusted) assert.fail("expected a trusted historical Bundle");
  assert.equal(loaded.bundle.manifest.bundleId, fixture.reference.bundleId);
  assert.equal(loaded.bundle.manifest.version, fixture.reference.bundleVersion);
  assert.equal(loaded.bundle.manifest.policySchema, fixture.reference.policySchema);
  assert.equal(loaded.bundle.layout.h2Headings.length, 8);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.bundle), true);
  assert.equal(Object.isFrozen(loaded.bundle.manifest.files), true);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    repository,
    releaseTag: fixture.reference.releaseTag,
    bundleId: fixture.reference.bundleId,
    bundleVersion: fixture.reference.bundleVersion,
    bundleManifestHash: fixture.reference.bundleManifestHash,
    policySchema: fixture.reference.policySchema,
    receiptAssetName: "bundle-receipt.envelope.json",
    filePaths: ["bundle-manifest.json", ...TEMPLATE_BUNDLE_PAYLOAD_PATHS],
    limits: {
      receiptEnvelopeBytes: 256 * 1024,
      manifestBytes: 64 * 1024,
      payloadBytes: 2 * 1024 * 1024,
      totalPayloadBytes: 8 * 1024 * 1024,
    },
  });
  assert.equal(Object.isFrozen(requests[0]), true);
  assert.equal(Object.isFrozen(requests[0]!.repository), true);
  assert.equal(Object.isFrozen(requests[0]!.filePaths), true);
  assert.equal(Object.isFrozen(requests[0]!.limits), true);

  const originalMarkdown = loaded.bundle.layout.markdown;
  const mutableLayout = fixture.mutableFiles.get("layout.md")!;
  mutableLayout[0] = mutableLayout[0]! ^ 0xff;
  assert.equal(loaded.bundle.layout.markdown, originalMarkdown);
});

test("rejects release snapshots from another repository or tag", async () => {
  const fixture = await exactReleaseFixture();
  const cases = [
    withAssets(fixture, {
      repository: { owner: "other-owner", name: repository.name },
    }),
    withAssets(fixture, { releaseTag: "templates-v1.0.1" }),
  ];

  for (const assets of cases) {
    await assertUpdateSecurity(() => loaderFor(fixture, assets).loadVerifiedExact(fixture.reference));
  }
});

test("rejects missing, extra, oversized, and tampered Bundle files", async () => {
  const fixture = await exactReleaseFixture();
  const missing = new Map(fixture.mutableFiles);
  missing.delete("layout.md");
  const extra = new Map(fixture.mutableFiles);
  extra.set("profiles/current.yml", new TextEncoder().encode("id: current\n"));
  const oversized = new Map(fixture.mutableFiles);
  oversized.set("layout.md", new Uint8Array(2 * 1024 * 1024 + 1));
  const tampered = new Map(fixture.mutableFiles);
  const original = tampered.get("layout.md")!;
  const changed = Uint8Array.from(original);
  changed[0] = changed[0]! ^ 0xff;
  tampered.set("layout.md", changed);

  for (const files of [missing, extra, oversized, tampered]) {
    await assertUpdateSecurity(() => loaderFor(
      fixture,
      withAssets(fixture, { files }),
    ).loadVerifiedExact(fixture.reference));
  }
});

test("rejects an unknown signer and a trust state without the signed history anchor", async () => {
  const fixture = await exactReleaseFixture();
  const attacker = createSigningFixture("unknown-release-key");
  const unknownSignerAssets = withAssets(fixture, {
    receiptEnvelope: signedEnvelope(canonicalPayload(fixture.receiptPayload), [attacker]),
  });

  await assertUpdateSecurity(() => loaderFor(
    fixture,
    unknownSignerAssets,
  ).loadVerifiedExact(fixture.reference));
  await assertUpdateSecurity(() => loaderFor(
    fixture,
    fixture.assets,
    createTrustState(fixture.bootstrapKeys),
  ).loadVerifiedExact(fixture.reference));
});

test("rejects a historical anchor signed at a sequence where its key is revoked before loader use", async () => {
  const fixture = await exactReleaseFixture();
  const replacement = createSigningFixture("fixture-release-key-2");
  const revokedReceipt = {
    ...fixture.receiptPayload,
    signingSequence: 43,
  } satisfies JsonObject;
  const oldAnchor = {
    releaseTag: "templates-v0.9.0",
    bundleManifestHash: "1".repeat(64),
    receiptPayloadSha256: "2".repeat(64),
    signingSequence: 42,
    signingKeyId: fixture.signingKey.keyId,
  };
  const firstChannel = {
    ...fixture.channelPayload,
    components: {
      ...(fixture.channelPayload.components as JsonObject),
      templates: {
        ...((fixture.channelPayload.components as JsonObject).templates as JsonObject),
        version: "0.9.0",
        tag: "templates-v0.9.0",
      },
    },
    releaseSet: { id: "stable-42", cli: "1.2.3", templates: "0.9.0" },
    templateHistory: [oldAnchor],
    keyRotation: {
      add: [{
        keyId: replacement.keyId,
        algorithm: "Ed25519",
        publicKeySpki: replacement.publicKeySpki,
        activeFromSequence: 43,
      }],
      revoke: [{ keyId: fixture.signingKey.keyId, revokedAtSequence: 43 }],
    },
  } satisfies JsonObject;
  const firstState = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(firstChannel), [fixture.signingKey]),
    createTrustState(fixture.bootstrapKeys),
    repository,
    fixture.bootstrapKeys,
  ).nextTrustState;
  const secondChannel = {
    ...fixture.channelPayload,
    sequence: 43,
    issuedAt: "2026-08-16T00:00:01Z",
    releaseSet: { id: "stable-43", cli: "1.2.3", templates: "1.0.0" },
    templateHistory: [
      oldAnchor,
      {
        releaseTag: fixture.reference.releaseTag,
        bundleManifestHash: fixture.reference.bundleManifestHash,
        receiptPayloadSha256: sha256Utf8(`${canonicalizeJson(revokedReceipt)}\n`),
        signingSequence: 43,
        signingKeyId: fixture.signingKey.keyId,
      },
    ],
  } satisfies JsonObject;
  assert.throws(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(secondChannel), [replacement]),
    firstState,
    repository,
    fixture.bootstrapKeys,
  ), (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"));
});

test("rejects every Bundle reference identity drift including a cached current-version substitution", async () => {
  const fixture = await exactReleaseFixture();
  const references = [
    { ...fixture.reference, bundleId: "other-bundle" },
    {
      ...fixture.reference,
      releaseTag: "templates-v1.0.1",
      bundleVersion: "1.0.1",
    },
    { ...fixture.reference, policySchema: 2 },
    { ...fixture.reference, bundleManifestHash: "d".repeat(64) },
  ];

  for (const reference of references) {
    await assertUpdateSecurity(() => loaderFor(
      fixture,
      fixture.assets,
    ).loadVerifiedExact(reference));
  }
});

test("returns untrusted for an absent exact release and never asks for a current or stable fallback", async () => {
  const fixture = await exactReleaseFixture();
  const requests: HistoricalBundleReleaseAssetRequest[] = [];
  const loader = createHistoricalBundleLoader({
    trustConfig: fixture.trustConfig,
    trustState: fixture.trustState,
    releaseAssets: {
      loadExact: async (request) => {
        requests.push(request);
        return null;
      },
    },
  });

  assert.deepEqual(await loader.loadVerifiedExact(fixture.reference), {
    trusted: false,
    bundle: null,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.releaseTag, fixture.reference.releaseTag);
  assert.equal(requests[0]!.bundleVersion, fixture.reference.bundleVersion);
  assert.equal(requests[0]!.bundleManifestHash, fixture.reference.bundleManifestHash);
});

test("fails closed without reflecting a release URL or credential-shaped source error", async () => {
  const fixture = await exactReleaseFixture();
  const secret = "glpat-source-error-canary-12345678";
  const url = `https://attacker.invalid/releases?token=${secret}`;
  const loader = createHistoricalBundleLoader({
    trustConfig: fixture.trustConfig,
    trustState: fixture.trustState,
    releaseAssets: {
      loadExact: async () => {
        throw new Error(`download failed at ${url}`);
      },
    },
  });

  await assertUpdateSecurity(
    () => loader.loadVerifiedExact(fixture.reference),
    [secret, url, "attacker.invalid"],
  );
});

test("rejects a persisted trust state rooted in different bootstrap keys", async () => {
  const fixture = await exactReleaseFixture();
  const other = createSigningFixture("other-bootstrap-key");
  const mismatchedConfig = createTestOnlyUpdateTrustConfig({
    repository,
    pagesOrigin: "http://127.0.0.1:43124",
    bootstrapKeys: [{
      keyId: other.keyId,
      publicKeySpki: other.publicKeySpki,
      activeFromSequence: 1,
      revokedAtSequence: null,
    }],
  });

  assert.throws(() => createHistoricalBundleLoader({
    trustConfig: mismatchedConfig,
    trustState: fixture.trustState,
    releaseAssets: { loadExact: async () => fixture.assets },
  }), (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"));
});
