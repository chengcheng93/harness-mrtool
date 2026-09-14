import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalizeJson, sha256Utf8, type JsonObject } from "../../src/contracts/jcs.ts";
import type { HistoricalBundleReleaseAssets } from "../../src/update/historical-bundle-loader.ts";
import { createTrustState } from "../../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import { createTestOnlyUpdateTrustConfig } from "../../src/update/trust-config.ts";
import { canonicalPayload, createSigningFixture, signedEnvelope } from "./signing.ts";
const bundleDirectory = resolve(import.meta.dirname, "../../template-bundle");
const repository = Object.freeze({ owner: "fixture-owner", name: "harness-mrtool" });
export async function exactReleaseFixture(directory = bundleDirectory): Promise<{
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
  const manifestText = await readFile(resolve(directory, "bundle-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as JsonObject;
  const manifestBytes = new TextEncoder().encode(manifestText);
  const bundleManifestHash = sha256Utf8(manifestText);
  const files = new Map<string, Uint8Array>([["bundle-manifest.json", manifestBytes]]);
  for (const file of manifest.files as JsonObject[]) {
    files.set(String(file.path), await readFile(resolve(directory, String(file.path))));
  }
  const receiptPayload: JsonObject = {
    receiptVersion: 1,
    receiptType: "template-bundle",
    signingSequence: 42,
    signingKeyId: key.keyId,
    repository,
    releaseTag: `templates-v${String(manifest.version)}`,
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
        version: manifest.version!,
        tag: `templates-v${String(manifest.version)}`,
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
    releaseSet: { id: "stable-42", cli: "1.2.3", templates: manifest.version! },
    security: {
      minimumAllowedCliVersion: "1.0.0",
      revokedCliVersions: [],
      revokedReleaseSetIds: [],
    },
    templateHistory: [{
      releaseTag: `templates-v${String(manifest.version)}`,
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
      releaseTag: `templates-v${String(manifest.version)}`,
      bundleId: String(manifest.bundleId),
      bundleVersion: String(manifest.version),
      bundleManifestHash,
      policySchema: Number(manifest.policySchema),
    },
    trustConfig,
    trustState,
    assets: {
      repository,
      releaseTag: `templates-v${String(manifest.version)}`,
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
