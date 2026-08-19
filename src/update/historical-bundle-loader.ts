import { resolve } from "node:path";

import {
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PAYLOAD_BYTES,
  MAX_BUNDLE_TOTAL_PAYLOAD_BYTES,
  loadTemplateBundle,
  type BundleFileMetadata,
  type LoadedTemplateBundle,
  type TemplateBundleFileHandle,
  type TemplateBundleIo,
} from "../bundle/load.ts";
import { TEMPLATE_BUNDLE_PAYLOAD_PATHS } from "../bundle/types.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256Utf8,
  type JsonValue,
} from "../contracts/jcs.ts";
import type {
  HistoricalBundleLoader,
  TrustedHistoricalBundleLoad,
  VerificationBundleReference,
} from "../app/verify-mr.ts";
import {
  MAX_SIGNED_ENVELOPE_BYTES,
  copyTrustState,
  isCanonicalTemplateReleaseTag,
  requireCanonicalSemVer,
  updateSecurityError,
  type TrustedSigningKey,
  type UpdateTrustState,
} from "./envelope.ts";
import {
  verifyBundleReceiptEnvelope,
} from "./bundle-receipt.ts";
import type { ReleaseRepository } from "./manifest.ts";
import {
  canonicalUpdateTrustConfigJson,
  type UpdateTrustConfig,
} from "./trust-config.ts";

export const HISTORICAL_BUNDLE_RECEIPT_ASSET_NAME =
  "bundle-receipt.envelope.json";

const BUNDLE_FILE_PATHS = Object.freeze([
  "bundle-manifest.json",
  ...TEMPLATE_BUNDLE_PAYLOAD_PATHS,
]);
const BUNDLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const REFERENCE_FIELDS = [
  "releaseTag",
  "bundleId",
  "bundleVersion",
  "bundleManifestHash",
  "policySchema",
] as const;
const ASSET_FIELDS = [
  "repository",
  "releaseTag",
  "receiptEnvelope",
  "files",
] as const;
const REPOSITORY_FIELDS = ["owner", "name"] as const;
const MEMORY_ROOT = resolve(".harness-mrtool-historical-bundle-snapshot");

export interface HistoricalBundleReleaseAssetRequest {
  readonly repository: ReleaseRepository;
  readonly releaseTag: string;
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly bundleManifestHash: string;
  readonly policySchema: number;
  readonly receiptAssetName: typeof HISTORICAL_BUNDLE_RECEIPT_ASSET_NAME;
  readonly filePaths: readonly string[];
  readonly limits: {
    readonly receiptEnvelopeBytes: number;
    readonly manifestBytes: number;
    readonly payloadBytes: number;
    readonly totalPayloadBytes: number;
  };
}

export interface HistoricalBundleReleaseAssets {
  readonly repository: ReleaseRepository;
  readonly releaseTag: string;
  readonly receiptEnvelope: string | Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface HistoricalBundleReleaseAssetSource {
  loadExact(
    request: HistoricalBundleReleaseAssetRequest,
  ): Promise<HistoricalBundleReleaseAssets | null>;
}

export interface HistoricalBundleLoaderOptions {
  readonly trustConfig: UpdateTrustConfig;
  readonly trustState: UpdateTrustState;
  readonly releaseAssets: HistoricalBundleReleaseAssetSource;
}

function fail(): never {
  throw updateSecurityError("envelope is invalid");
}

function exactFields(value: object, expected: readonly string[]): void {
  if (Object.getOwnPropertySymbols(value).length !== 0) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index]) ||
    actual.some((field) => {
      const descriptor = descriptors[field];
      return descriptor === undefined || !descriptor.enumerable ||
        !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined;
    })
  ) {
    fail();
  }
}

function plainRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail();
  }
  exactFields(value, fields);
  return value as Record<string, unknown>;
}

function scalar(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    /[\r\n\u0000]/u.test(value)
  ) {
    return fail();
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail();
  return value as number;
}

function repository(value: unknown): ReleaseRepository {
  const item = plainRecord(value, REPOSITORY_FIELDS);
  if (
    typeof item.owner !== "string" ||
    typeof item.name !== "string" ||
    !REPOSITORY_PART.test(item.owner) ||
    !REPOSITORY_PART.test(item.name)
  ) {
    return fail();
  }
  return Object.freeze({ owner: item.owner, name: item.name });
}

function sameRepository(left: ReleaseRepository, right: ReleaseRepository): boolean {
  return left.owner === right.owner && left.name === right.name;
}

function strictReference(value: unknown): VerificationBundleReference {
  let copied: JsonValue;
  try {
    copied = copyJsonValue(value);
  } catch {
    return fail();
  }
  const item = plainRecord(copied, REFERENCE_FIELDS);
  const bundleVersion = scalar(item.bundleVersion);
  try {
    requireCanonicalSemVer(bundleVersion);
  } catch {
    return fail();
  }
  const releaseTag = scalar(item.releaseTag);
  const bundleId = scalar(item.bundleId);
  const bundleManifestHash = scalar(item.bundleManifestHash);
  if (
    !isCanonicalTemplateReleaseTag(releaseTag) ||
    releaseTag !== `templates-v${bundleVersion}` ||
    !BUNDLE_ID.test(bundleId) ||
    !SHA256.test(bundleManifestHash)
  ) {
    return fail();
  }
  return Object.freeze({
    releaseTag,
    bundleId,
    bundleVersion,
    bundleManifestHash,
    policySchema: positiveInteger(item.policySchema),
  });
}

function boundedEnvelope(value: unknown): string | Uint8Array {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_SIGNED_ENVELOPE_BYTES) return fail();
    return value;
  }
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_SIGNED_ENVELOPE_BYTES) {
    return fail();
  }
  return Uint8Array.from(value);
}

function boundedFileSnapshot(value: unknown): ReadonlyMap<string, Uint8Array> {
  if (
    !(value instanceof Map) ||
    Object.getPrototypeOf(value) !== Map.prototype ||
    value.size !== BUNDLE_FILE_PATHS.length
  ) {
    return fail();
  }
  const expectedPaths = new Set(BUNDLE_FILE_PATHS);
  const snapshot = new Map<string, Uint8Array>();
  let totalPayloadBytes = 0;
  for (const [path, bytes] of value.entries()) {
    if (
      typeof path !== "string" ||
      !expectedPaths.delete(path) ||
      !(bytes instanceof Uint8Array)
    ) {
      return fail();
    }
    const maximum = path === "bundle-manifest.json"
      ? MAX_BUNDLE_MANIFEST_BYTES
      : MAX_BUNDLE_PAYLOAD_BYTES;
    if (bytes.byteLength < 1 || bytes.byteLength > maximum) return fail();
    if (path !== "bundle-manifest.json") {
      totalPayloadBytes += bytes.byteLength;
      if (totalPayloadBytes > MAX_BUNDLE_TOTAL_PAYLOAD_BYTES) return fail();
    }
    snapshot.set(path, Uint8Array.from(bytes));
  }
  if (expectedPaths.size !== 0) return fail();
  return snapshot;
}

function assetSnapshot(
  value: unknown,
  expectedRepository: ReleaseRepository,
  expectedTag: string,
): {
  readonly receiptEnvelope: string | Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
} {
  const item = plainRecord(value, ASSET_FIELDS);
  if (
    !sameRepository(repository(item.repository), expectedRepository) ||
    scalar(item.releaseTag) !== expectedTag
  ) {
    return fail();
  }
  return Object.freeze({
    receiptEnvelope: boundedEnvelope(item.receiptEnvelope),
    files: boundedFileSnapshot(item.files),
  });
}

function fileMetadata(
  kind: "directory" | "file",
  size: number,
  ino: bigint,
): BundleFileMetadata {
  return Object.freeze({
    dev: 1n,
    ino,
    size: BigInt(size),
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => false,
  });
}

function memoryBundleIo(files: ReadonlyMap<string, Uint8Array>): TemplateBundleIo {
  const profiles = resolve(MEMORY_ROOT, "profiles");
  const registries = resolve(MEMORY_ROOT, "registries");
  const directories = new Map<string, readonly string[]>([
    [MEMORY_ROOT, Object.freeze([
      "bundle-manifest.json",
      "layout.md",
      "policy.yml",
      "profiles",
      "registries",
      "schema.json",
    ])],
    [profiles, Object.freeze(["code.yml", "docs.yml", "general.yml", "ops.yml"])],
    [registries, Object.freeze(["checkboxes.json", "fields.json"])],
  ]);
  const paths = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) paths.set(resolve(MEMORY_ROOT, path), Uint8Array.from(bytes));
  const metadata = new Map<string, BundleFileMetadata>();
  let ino = 1n;
  for (const path of directories.keys()) metadata.set(path, fileMetadata("directory", 0, ino++));
  for (const [path, bytes] of paths) metadata.set(path, fileMetadata("file", bytes.byteLength, ino++));

  const requiredMetadata = (path: string): BundleFileMetadata => {
    const result = metadata.get(path);
    if (result === undefined) throw new Error("historical bundle snapshot entry is unavailable");
    return result;
  };

  return Object.freeze({
    async openFile(path: string): Promise<TemplateBundleFileHandle> {
      const bytes = paths.get(path);
      const stats = metadata.get(path);
      if (bytes === undefined || stats === undefined) {
        throw new Error("historical bundle snapshot file is unavailable");
      }
      const snapshot = Uint8Array.from(bytes);
      let closed = false;
      return {
        async close(): Promise<void> {
          closed = true;
        },
        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ): Promise<{ readonly bytesRead: number }> {
          if (closed || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
              !Number.isSafeInteger(position) || offset < 0 || length < 0 || position < 0 ||
              offset + length > buffer.byteLength) {
            throw new Error("historical bundle snapshot read is invalid");
          }
          const bytesRead = Math.min(length, Math.max(0, snapshot.byteLength - position));
          if (bytesRead > 0) buffer.set(snapshot.subarray(position, position + bytesRead), offset);
          return { bytesRead };
        },
        async stat(): Promise<BundleFileMetadata> {
          if (closed) throw new Error("historical bundle snapshot handle is closed");
          return stats;
        },
      };
    },
    async listDirectory(path: string): Promise<readonly string[]> {
      const entries = directories.get(path);
      if (entries === undefined) throw new Error("historical bundle snapshot directory is unavailable");
      return [...entries];
    },
    async lstat(path: string): Promise<BundleFileMetadata> {
      return requiredMetadata(path);
    },
    async realpath(path: string): Promise<string> {
      requiredMetadata(path);
      return path;
    },
  });
}

function exactRequest(
  expectedRepository: ReleaseRepository,
  reference: VerificationBundleReference,
): HistoricalBundleReleaseAssetRequest {
  return Object.freeze({
    repository: expectedRepository,
    releaseTag: reference.releaseTag,
    bundleId: reference.bundleId,
    bundleVersion: reference.bundleVersion,
    bundleManifestHash: reference.bundleManifestHash,
    policySchema: reference.policySchema,
    receiptAssetName: HISTORICAL_BUNDLE_RECEIPT_ASSET_NAME,
    filePaths: BUNDLE_FILE_PATHS,
    limits: Object.freeze({
      receiptEnvelopeBytes: MAX_SIGNED_ENVELOPE_BYTES,
      manifestBytes: MAX_BUNDLE_MANIFEST_BYTES,
      payloadBytes: MAX_BUNDLE_PAYLOAD_BYTES,
      totalPayloadBytes: MAX_BUNDLE_TOTAL_PAYLOAD_BYTES,
    }),
  });
}

function assertExactLoadedBundle(
  bundle: LoadedTemplateBundle,
  reference: VerificationBundleReference,
  receipt: ReturnType<typeof verifyBundleReceiptEnvelope>["receipt"],
): void {
  const manifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest as unknown as JsonValue)}\n`);
  if (
    receipt.releaseTag !== reference.releaseTag ||
    receipt.bundleId !== reference.bundleId ||
    receipt.bundleVersion !== reference.bundleVersion ||
    receipt.bundleManifest.sha256 !== reference.bundleManifestHash ||
    receipt.policySchema !== reference.policySchema ||
    bundle.manifest.bundleId !== reference.bundleId ||
    bundle.manifest.version !== reference.bundleVersion ||
    bundle.manifest.inputSchema !== receipt.inputSchema ||
    bundle.manifest.policySchema !== reference.policySchema ||
    manifestHash !== reference.bundleManifestHash
  ) {
    fail();
  }
}

export function createHistoricalBundleLoader(
  options: HistoricalBundleLoaderOptions,
): HistoricalBundleLoader {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    options.releaseAssets === null ||
    typeof options.releaseAssets !== "object" ||
    typeof options.releaseAssets.loadExact !== "function"
  ) {
    return fail();
  }
  let expectedRepository: ReleaseRepository;
  let expectedBootstrapKeys: readonly TrustedSigningKey[];
  let trustState: UpdateTrustState;
  try {
    canonicalUpdateTrustConfigJson(options.trustConfig);
    expectedRepository = repository(options.trustConfig.repository);
    expectedBootstrapKeys = options.trustConfig.bootstrapKeys;
    trustState = copyTrustState(options.trustState, expectedBootstrapKeys);
  } catch {
    return fail();
  }
  const releaseAssets = options.releaseAssets;

  return Object.freeze({
    async loadVerifiedExact(referenceValue: VerificationBundleReference): Promise<TrustedHistoricalBundleLoad> {
      const reference = strictReference(referenceValue);
      let rawAssets: HistoricalBundleReleaseAssets | null;
      try {
        rawAssets = await releaseAssets.loadExact(exactRequest(expectedRepository, reference));
      } catch {
        return fail();
      }
      if (rawAssets === null) {
        return Object.freeze({ trusted: false as const, bundle: null });
      }
      const assets = assetSnapshot(rawAssets, expectedRepository, reference.releaseTag);
      let verifiedReceipt: ReturnType<typeof verifyBundleReceiptEnvelope>;
      try {
        verifiedReceipt = verifyBundleReceiptEnvelope(
          assets.receiptEnvelope,
          trustState,
          {
            repository: expectedRepository,
            releaseTag: reference.releaseTag,
            bundleManifestHash: reference.bundleManifestHash,
          },
          assets.files,
          expectedBootstrapKeys,
        );
      } catch {
        return fail();
      }
      const verifiedFiles = new Map<string, Uint8Array>();
      for (const path of BUNDLE_FILE_PATHS) {
        verifiedFiles.set(path, verifiedReceipt.readFile(path));
      }
      let bundle: LoadedTemplateBundle;
      try {
        bundle = await loadTemplateBundle(MEMORY_ROOT, memoryBundleIo(verifiedFiles));
        assertExactLoadedBundle(bundle, reference, verifiedReceipt.receipt);
      } catch {
        return fail();
      }
      return Object.freeze({ trusted: true as const, bundle });
    },
  });
}
