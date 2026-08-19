import { createHash } from "node:crypto";

import { canonicalizeJson, copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import {
  TEMPLATE_BUNDLE_PAYLOAD_PATHS,
  type TemplateBundleManifest,
} from "../bundle/types.ts";
import {
  copyTrustState,
  isCanonicalTemplateReleaseTag,
  requireCanonicalSemVer,
  signingKeyIsActive,
  updateSecurityError,
  verifySignedEnvelope,
  type TrustedSigningKey,
  type UpdateTrustState,
} from "./envelope.ts";
import type { ReleaseRepository } from "./manifest.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const BUNDLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_RECEIPT_FILES = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PAYLOAD_BYTES = 8 * 1024 * 1024;
const EXPECTED_PATHS = ["bundle-manifest.json", ...TEMPLATE_BUNDLE_PAYLOAD_PATHS] as const;

export interface BundleReceiptFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BundleReceipt {
  readonly receiptVersion: 1;
  readonly receiptType: "template-bundle";
  readonly signingSequence: number;
  readonly signingKeyId: string;
  readonly repository: ReleaseRepository;
  readonly releaseTag: string;
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly bundleManifest: {
    readonly sha256: string;
    readonly size: number;
  };
  readonly inputSchema: number;
  readonly policySchema: number;
  readonly skillProtocols: readonly number[];
  readonly files: readonly BundleReceiptFile[];
}

export interface BundleReceiptExpectation {
  readonly repository: ReleaseRepository;
  readonly releaseTag: string;
  readonly bundleManifestHash: string;
}

export interface VerifiedBundleReceipt {
  readonly receipt: BundleReceipt;
  readonly payloadSha256: string;
  readonly signingKeyId: string;
  readonly readFile: (path: string) => Uint8Array;
}

function record(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw updateSecurityError("envelope is invalid");
  }
  return value as JsonObject;
}

function exact(value: JsonObject, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw updateSecurityError("envelope is invalid");
  }
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw updateSecurityError("envelope is invalid");
  }
  return value;
}

function strictSemver(value: unknown): string {
  return requireCanonicalSemVer(value);
}

function repository(value: unknown): ReleaseRepository {
  const item = record(value);
  exact(item, ["owner", "name"]);
  if (
    typeof item.owner !== "string" ||
    typeof item.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(item.owner) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(item.name)
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  return { owner: item.owner, name: item.name };
}

function parseReceipt(value: unknown): BundleReceipt {
  const item = record(value);
  exact(item, [
    "receiptVersion", "receiptType", "signingSequence", "signingKeyId", "repository",
    "releaseTag", "bundleId", "bundleVersion", "bundleManifest", "inputSchema",
    "policySchema", "skillProtocols", "files",
  ]);
  if (
    item.receiptVersion !== 1 ||
    item.receiptType !== "template-bundle" ||
    typeof item.signingKeyId !== "string" ||
    !KEY_ID.test(item.signingKeyId) ||
    typeof item.releaseTag !== "string" ||
    !isCanonicalTemplateReleaseTag(item.releaseTag) ||
    typeof item.bundleId !== "string" ||
    !BUNDLE_ID.test(item.bundleId) ||
    typeof item.bundleVersion !== "string"
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const bundleVersion = strictSemver(item.bundleVersion);
  if (item.releaseTag !== `templates-v${bundleVersion}`) {
    throw updateSecurityError("envelope is invalid");
  }
  const bundleManifest = record(item.bundleManifest);
  exact(bundleManifest, ["sha256", "size"]);
  if (typeof bundleManifest.sha256 !== "string" || !SHA256.test(bundleManifest.sha256)) {
    throw updateSecurityError("envelope is invalid");
  }
  const inputSchema = positiveInteger(item.inputSchema);
  const policySchema = positiveInteger(item.policySchema);
  if (!Array.isArray(item.skillProtocols) || item.skillProtocols.length === 0) {
    throw updateSecurityError("envelope is invalid");
  }
  const skillProtocols = item.skillProtocols.map(positiveInteger);
  if (skillProtocols.some((entry, index) => index > 0 && skillProtocols[index - 1]! >= entry)) {
    throw updateSecurityError("envelope is invalid");
  }
  if (
    !Array.isArray(item.files) ||
    item.files.length !== EXPECTED_PATHS.length ||
    item.files.length > MAX_RECEIPT_FILES
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const files = item.files.map((entry, index) => {
    const file = record(entry);
    exact(file, ["path", "size", "sha256"]);
    const expectedPath = EXPECTED_PATHS[index];
    if (
      expectedPath === undefined ||
      file.path !== expectedPath ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256)
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    const size = positiveInteger(file.size);
    const maximum = index === 0 ? MAX_MANIFEST_BYTES : MAX_PAYLOAD_BYTES;
    if (size > maximum) throw updateSecurityError("envelope is invalid");
    return {
      path: expectedPath,
      size,
      sha256: file.sha256,
    };
  });
  const manifestFile = files[0]!;
  const totalPayloadBytes = files.slice(1).reduce((sum, file) => sum + file.size, 0);
  if (
    manifestFile.sha256 !== bundleManifest.sha256 ||
    manifestFile.size !== bundleManifest.size ||
    totalPayloadBytes > MAX_TOTAL_PAYLOAD_BYTES
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  return {
    receiptVersion: 1,
    receiptType: "template-bundle",
    signingSequence: positiveInteger(item.signingSequence),
    signingKeyId: item.signingKeyId,
    repository: repository(item.repository),
    releaseTag: item.releaseTag,
    bundleId: item.bundleId,
    bundleVersion,
    bundleManifest: {
      sha256: bundleManifest.sha256,
      size: positiveInteger(bundleManifest.size),
    },
    inputSchema,
    policySchema,
    skillProtocols,
    files,
  };
}

function decodeCanonicalPayload(payload: Uint8Array): JsonValue {
  let text: string;
  let parsed: JsonValue;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    parsed = parseStrictJson(text);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  if (text !== `${canonicalizeJson(parsed)}\n`) throw updateSecurityError("envelope is invalid");
  return parsed;
}

function sameRepository(left: ReleaseRepository, right: ReleaseRepository): boolean {
  return left.owner === right.owner && left.name === right.name;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function verifyBundleReceiptEnvelope(
  envelope: string | Uint8Array | undefined,
  trustState: UpdateTrustState,
  expected: BundleReceiptExpectation,
  actualFiles: ReadonlyMap<string, Uint8Array>,
  expectedBootstrapKeys?: readonly TrustedSigningKey[],
): VerifiedBundleReceipt {
  if (envelope === undefined) {
    throw updateSecurityError("signed bundle receipt is missing");
  }
  const trustedState = copyTrustState(trustState, expectedBootstrapKeys);
  let verified;
  try {
    verified = verifySignedEnvelope(envelope, trustedState, expectedBootstrapKeys);
  } catch (error) {
    throw error;
  }
  const receipt = parseReceipt(decodeCanonicalPayload(verified.payloadBytes));
  const key = trustedState.keys.find((candidate) => candidate.keyId === receipt.signingKeyId);
  const anchor = trustedState.bundleReceiptAnchors.find((candidate) =>
    candidate.repositoryOwner === receipt.repository.owner &&
    candidate.repositoryName === receipt.repository.name &&
    candidate.releaseTag === receipt.releaseTag);
  if (
    !verified.verifiedKeyIds.includes(receipt.signingKeyId) ||
    key === undefined ||
    !signingKeyIsActive(key, receipt.signingSequence) ||
    anchor === undefined ||
    anchor.bundleManifestHash !== receipt.bundleManifest.sha256 ||
    anchor.receiptPayloadSha256 !== verified.payloadSha256 ||
    anchor.signingSequence !== receipt.signingSequence ||
    anchor.signingKeyId !== receipt.signingKeyId ||
    !sameRepository(receipt.repository, expected.repository) ||
    receipt.releaseTag !== expected.releaseTag ||
    receipt.bundleManifest.sha256 !== expected.bundleManifestHash
  ) {
    throw updateSecurityError("signature validation failed");
  }
  const verifiedFiles = verifyBundleReceiptFiles(receipt, actualFiles);
  return Object.freeze({
    receipt: deepFreeze(copyJsonValue(receipt) as unknown as BundleReceipt),
    payloadSha256: verified.payloadSha256,
    signingKeyId: receipt.signingKeyId,
    readFile(path: string): Uint8Array {
      const bytes = verifiedFiles.get(path);
      if (bytes === undefined) throw updateSecurityError("envelope is invalid");
      return Uint8Array.from(bytes);
    },
  });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestRecord(value: unknown): TemplateBundleManifest {
  const item = record(value);
  exact(item, ["manifestVersion", "bundleId", "version", "inputSchema", "policySchema", "files"]);
  if (
    item.manifestVersion !== 1 ||
    typeof item.bundleId !== "string" ||
    !BUNDLE_ID.test(item.bundleId) ||
    typeof item.version !== "string" ||
    !Array.isArray(item.files) ||
    item.files.length !== TEMPLATE_BUNDLE_PAYLOAD_PATHS.length
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const version = strictSemver(item.version);
  const inputSchema = positiveInteger(item.inputSchema);
  const policySchema = positiveInteger(item.policySchema);
  const files = item.files.map((entry, index) => {
    const file = record(entry);
    exact(file, ["path", "size", "sha256"]);
    const expectedPath = TEMPLATE_BUNDLE_PAYLOAD_PATHS[index];
    if (
      expectedPath === undefined ||
      file.path !== expectedPath ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256)
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    const size = positiveInteger(file.size);
    if (size > MAX_PAYLOAD_BYTES) throw updateSecurityError("envelope is invalid");
    return { path: expectedPath, size, sha256: file.sha256 };
  });
  return {
    manifestVersion: 1,
    bundleId: item.bundleId,
    version,
    inputSchema,
    policySchema,
    files,
  };
}

function verifyBundleReceiptFiles(
  receipt: BundleReceipt,
  actualFiles: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Uint8Array> {
  if (
    !(actualFiles instanceof Map) ||
    Object.getPrototypeOf(actualFiles) !== Map.prototype ||
    actualFiles.size !== EXPECTED_PATHS.length
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const actualPaths = [...actualFiles.keys()];
  if (
    actualPaths.some((path) => typeof path !== "string" || !EXPECTED_PATHS.includes(path as never))
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const snapshot = new Map<string, Uint8Array>();
  for (const expected of receipt.files) {
    const bytes = actualFiles.get(expected.path);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== expected.size ||
      bytes.byteLength > (expected.path === "bundle-manifest.json"
        ? MAX_MANIFEST_BYTES
        : MAX_PAYLOAD_BYTES)
    ) {
      throw updateSecurityError("signature validation failed");
    }
    const copy = Uint8Array.from(bytes);
    if (sha256(copy) !== expected.sha256) {
      throw updateSecurityError("signature validation failed");
    }
    snapshot.set(expected.path, copy);
  }
  const manifestBytes = snapshot.get("bundle-manifest.json");
  if (
    !(manifestBytes instanceof Uint8Array) ||
    manifestBytes.byteLength > MAX_MANIFEST_BYTES ||
    manifestBytes.byteLength !== receipt.bundleManifest.size ||
    sha256(manifestBytes) !== receipt.bundleManifest.sha256
  ) {
    throw updateSecurityError("signature validation failed");
  }
  let text: string;
  let parsed: JsonValue;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    parsed = parseStrictJson(text);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  if (text !== `${canonicalizeJson(parsed)}\n`) throw updateSecurityError("envelope is invalid");
  const manifest = manifestRecord(parsed);
  if (
    receipt.bundleManifest.size !== manifestBytes.byteLength ||
    receipt.bundleManifest.sha256 !== sha256(manifestBytes) ||
    receipt.bundleId !== manifest.bundleId ||
    receipt.bundleVersion !== manifest.version ||
    receipt.inputSchema !== manifest.inputSchema ||
    receipt.policySchema !== manifest.policySchema ||
    manifest.files.length !== TEMPLATE_BUNDLE_PAYLOAD_PATHS.length
  ) {
    throw updateSecurityError("signature validation failed");
  }
  const expectedFiles = [
    { path: "bundle-manifest.json", size: manifestBytes.byteLength, sha256: sha256(manifestBytes) },
    ...manifest.files,
  ];
  if (
    receipt.files.length !== expectedFiles.length ||
    receipt.files.some((file, index) => {
      const expected = expectedFiles[index];
      return expected === undefined || file.path !== expected.path ||
        file.size !== expected.size || file.sha256 !== expected.sha256;
    })
  ) {
    throw updateSecurityError("signature validation failed");
  }
  return snapshot;
}
