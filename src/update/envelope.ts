import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";

import { SemVer } from "semver";

import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson, copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";

export const MAX_SIGNED_ENVELOPE_BYTES = 256 * 1024;
const MAX_SIGNATURES = 16;
const KEY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BUNDLE_RECEIPT_ANCHORS = 2_048;
const MAX_KEY_ROTATION_PROOFS = 32;
// A serialized trust state is untrusted input.  Only states constructed by
// this module may omit the immutable bootstrap root supplied by production.
const trustedStateBrands = new WeakSet<object>();

export function requireCanonicalSemVer(value: unknown): string {
  if (typeof value !== "string") throw updateSecurityError("envelope is invalid");
  try {
    const parsed = new SemVer(value, { loose: false });
    const canonical = `${parsed.version}${parsed.build.length === 0 ? "" : `+${parsed.build.join(".")}`}`;
    if (canonical !== value) throw new TypeError("noncanonical");
    return value;
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
}

export function isCanonicalTemplateReleaseTag(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("templates-v")) return false;
  try {
    const version = value.slice("templates-v".length);
    return `templates-v${requireCanonicalSemVer(version)}` === value;
  } catch {
    return false;
  }
}

export interface TrustedSigningKey {
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly activeFromSequence: number;
  readonly revokedAtSequence: number | null;
}

export interface TrustedBundleReceiptAnchor {
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly releaseTag: string;
  readonly bundleManifestHash: string;
  readonly receiptPayloadSha256: string;
  readonly signingSequence: number;
  readonly signingKeyId: string;
}

export interface AcceptedTrustTransition {
  readonly priorHighestSequence: number;
  readonly priorAcceptedPayloadSha256: string | null;
  readonly priorKeys: readonly TrustedSigningKey[];
  readonly priorBundleReceiptAnchors: readonly TrustedBundleReceiptAnchor[];
  readonly transitionSha256: string;
}

export interface UpdateTrustState {
  readonly trustVersion: 2;
  readonly bootstrapKeys: readonly TrustedSigningKey[];
  readonly keyRotationProofs: readonly string[];
  readonly keys: readonly TrustedSigningKey[];
  readonly highestSequence: number;
  readonly acceptedPayloadSha256: string | null;
  readonly acceptedChannelEnvelope: string | null;
  readonly bundleReceiptAnchors: readonly TrustedBundleReceiptAnchor[];
  readonly acceptedTransition: AcceptedTrustTransition | null;
}

export interface VerifiedSignedEnvelope {
  readonly payloadBytes: Uint8Array;
  readonly payloadSha256: string;
  readonly verifiedKeyIds: readonly string[];
}

type SecurityReason =
  | "envelope is invalid"
  | "envelope exceeds the size limit"
  | "manifest sequence is not monotonic"
  | "signature validation failed"
  | "signed bundle receipt is missing"
  | "trusted key state is invalid";

export function updateSecurityError(
  reason: SecurityReason,
): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError(
    "UPDATE_SECURITY_ERROR",
    `Signed update metadata could not be verified: ${reason}`,
    {
      field: "update",
      expected: "canonical metadata signed by an active trusted Ed25519 key",
      actual: reason,
      safeNextStep: "Keep the last-known-good release set and retry only from the fixed official update origin.",
    },
  );
}

function exactFields(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((field, index) => field === sortedExpected[index]);
}

function record(value: JsonValue): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function requiredRecord(value: unknown): JsonObject {
  const result = value as JsonValue;
  const object = record(result);
  if (object === null) throw updateSecurityError("envelope is invalid");
  return object;
}

function safeInteger(value: JsonValue, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function decodeCanonicalBase64url(value: unknown, expectedBytes?: number): Uint8Array | null {
  if (typeof value !== "string" || !BASE64URL.test(value)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    return null;
  }
  if (
    bytes.byteLength === 0 ||
    (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) ||
    bytes.toString("base64url") !== value
  ) {
    return null;
  }
  return bytes;
}

function decodeEnvelopeText(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SIGNED_ENVELOPE_BYTES) {
    throw updateSecurityError(
      bytes.byteLength > MAX_SIGNED_ENVELOPE_BYTES
        ? "envelope exceeds the size limit"
        : "envelope is invalid",
    );
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
}

function validateKey(value: TrustedSigningKey): TrustedSigningKey {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactFields(value as unknown as JsonObject, [
      "keyId", "publicKeySpki", "activeFromSequence", "revokedAtSequence",
    ]) ||
    typeof value.keyId !== "string" ||
    !KEY_ID.test(value.keyId) ||
    typeof value.publicKeySpki !== "string" ||
    decodeCanonicalBase64url(value.publicKeySpki) === null ||
    !Number.isSafeInteger(value.activeFromSequence) ||
    value.activeFromSequence < 1 ||
    (value.revokedAtSequence !== null &&
      (!Number.isSafeInteger(value.revokedAtSequence) ||
        value.revokedAtSequence <= value.activeFromSequence))
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(value.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("not Ed25519");
    }
  } catch {
    throw updateSecurityError("trusted key state is invalid");
  }
  return {
    keyId: value.keyId,
    publicKeySpki: value.publicKeySpki,
    activeFromSequence: value.activeFromSequence,
    revokedAtSequence: value.revokedAtSequence,
  };
}

function freezeTrustState(value: UpdateTrustState): UpdateTrustState {
  for (const key of value.bootstrapKeys) Object.freeze(key);
  Object.freeze(value.bootstrapKeys);
  for (const key of value.keys) Object.freeze(key);
  for (const anchor of value.bundleReceiptAnchors) Object.freeze(anchor);
  if (value.acceptedTransition !== null) {
    for (const key of value.acceptedTransition.priorKeys) Object.freeze(key);
    for (const anchor of value.acceptedTransition.priorBundleReceiptAnchors) Object.freeze(anchor);
    Object.freeze(value.acceptedTransition.priorKeys);
    Object.freeze(value.acceptedTransition.priorBundleReceiptAnchors);
    Object.freeze(value.acceptedTransition);
  }
  Object.freeze(value.keyRotationProofs);
  Object.freeze(value.keys);
  Object.freeze(value.bundleReceiptAnchors);
  const frozen = Object.freeze(value);
  trustedStateBrands.add(frozen);
  return frozen;
}

function validateBundleReceiptAnchor(
  value: TrustedBundleReceiptAnchor,
): TrustedBundleReceiptAnchor {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactFields(value as unknown as JsonObject, [
      "repositoryOwner", "repositoryName", "releaseTag", "bundleManifestHash",
      "receiptPayloadSha256", "signingSequence", "signingKeyId",
    ]) ||
    typeof value.repositoryOwner !== "string" ||
    typeof value.repositoryName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value.repositoryOwner) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value.repositoryName) ||
    typeof value.releaseTag !== "string" ||
    !isCanonicalTemplateReleaseTag(value.releaseTag) ||
    typeof value.bundleManifestHash !== "string" ||
    !SHA256.test(value.bundleManifestHash) ||
    typeof value.receiptPayloadSha256 !== "string" ||
    !SHA256.test(value.receiptPayloadSha256) ||
    !Number.isSafeInteger(value.signingSequence) ||
    value.signingSequence < 1 ||
    typeof value.signingKeyId !== "string" ||
    !KEY_ID.test(value.signingKeyId)
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  return {
    repositoryOwner: value.repositoryOwner,
    repositoryName: value.repositoryName,
    releaseTag: value.releaseTag,
    bundleManifestHash: value.bundleManifestHash,
    receiptPayloadSha256: value.receiptPayloadSha256,
    signingSequence: value.signingSequence,
    signingKeyId: value.signingKeyId,
  };
}

interface NormalizedTrustCore {
  readonly keys: readonly TrustedSigningKey[];
  readonly highestSequence: number;
  readonly acceptedPayloadSha256: string | null;
  readonly bundleReceiptAnchors: readonly TrustedBundleReceiptAnchor[];
}

function normalizeTrustCore(
  keys: readonly TrustedSigningKey[],
  highestSequence: number,
  acceptedPayloadSha256: string | null,
  bundleReceiptAnchors: readonly TrustedBundleReceiptAnchor[],
): NormalizedTrustCore {
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > MAX_SIGNATURES ||
    !Number.isSafeInteger(highestSequence) ||
    highestSequence < 0 ||
    (acceptedPayloadSha256 !== null && !SHA256.test(acceptedPayloadSha256)) ||
    ((highestSequence === 0) !== (acceptedPayloadSha256 === null)) ||
    !Array.isArray(bundleReceiptAnchors) ||
    bundleReceiptAnchors.length > MAX_BUNDLE_RECEIPT_ANCHORS
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const normalized = keys.map(validateKey).sort((left, right) =>
    Buffer.compare(Buffer.from(left.keyId, "utf8"), Buffer.from(right.keyId, "utf8")));
  if (normalized.some((key, index) => index > 0 && key.keyId === normalized[index - 1]?.keyId)) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const anchors = bundleReceiptAnchors.map(validateBundleReceiptAnchor).sort((left, right) =>
    Buffer.compare(Buffer.from(left.releaseTag, "utf8"), Buffer.from(right.releaseTag, "utf8")));
  if (anchors.some((anchor, index) => index > 0 && anchor.releaseTag === anchors[index - 1]?.releaseTag)) {
    throw updateSecurityError("trusted key state is invalid");
  }
  if (anchors.some((anchor) => {
    const key = normalized.find((candidate) => candidate.keyId === anchor.signingKeyId);
    return anchor.signingSequence > highestSequence ||
      key === undefined ||
      !signingKeyIsActive(key, anchor.signingSequence);
  })) {
    throw updateSecurityError("trusted key state is invalid");
  }
  return {
    keys: normalized,
    highestSequence,
    acceptedPayloadSha256,
    bundleReceiptAnchors: anchors,
  };
}

function trustTransitionHash(
  prior: NormalizedTrustCore,
  accepted: NormalizedTrustCore,
): string {
  const value = {
    prior: {
      highestSequence: prior.highestSequence,
      acceptedPayloadSha256: prior.acceptedPayloadSha256,
      keys: prior.keys.map((key) => ({ ...key })),
      bundleReceiptAnchors: prior.bundleReceiptAnchors.map((anchor) => ({ ...anchor })),
    },
    accepted: {
      highestSequence: accepted.highestSequence,
      acceptedPayloadSha256: accepted.acceptedPayloadSha256,
      keys: accepted.keys.map((key) => ({ ...key })),
      bundleReceiptAnchors: accepted.bundleReceiptAnchors.map((anchor) => ({ ...anchor })),
    },
  } as unknown as JsonObject;
  return createHash("sha256").update(`${canonicalizeJson(value)}\n`, "utf8").digest("hex");
}

function acceptedTransition(
  value: AcceptedTrustTransition,
  accepted: NormalizedTrustCore,
): AcceptedTrustTransition {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactFields(value as unknown as JsonObject, [
      "priorHighestSequence", "priorAcceptedPayloadSha256", "priorKeys",
      "priorBundleReceiptAnchors", "transitionSha256",
    ]) ||
    typeof value.transitionSha256 !== "string" ||
    !SHA256.test(value.transitionSha256)
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const prior = normalizeTrustCore(
    value.priorKeys,
    value.priorHighestSequence,
    value.priorAcceptedPayloadSha256,
    value.priorBundleReceiptAnchors,
  );
  if (
    prior.highestSequence >= accepted.highestSequence ||
    trustTransitionHash(prior, accepted) !== value.transitionSha256
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  return {
    priorHighestSequence: prior.highestSequence,
    priorAcceptedPayloadSha256: prior.acceptedPayloadSha256,
    priorKeys: prior.keys,
    priorBundleReceiptAnchors: prior.bundleReceiptAnchors,
    transitionSha256: value.transitionSha256,
  };
}

function sameSigningKeys(
  left: readonly TrustedSigningKey[],
  right: readonly TrustedSigningKey[],
): boolean {
  const value = (keys: readonly TrustedSigningKey[]): string => canonicalizeJson({
    keys: keys.map((key) => ({ ...key })).sort((a, b) =>
      Buffer.compare(Buffer.from(a.keyId, "utf8"), Buffer.from(b.keyId, "utf8"))),
  } as unknown as JsonObject);
  return value(left) === value(right);
}

function sameAnchors(
  left: readonly TrustedBundleReceiptAnchor[],
  right: readonly TrustedBundleReceiptAnchor[],
): boolean {
  const value = (anchors: readonly TrustedBundleReceiptAnchor[]): string => canonicalizeJson({
    bundleReceiptAnchors: anchors.map((anchor) => ({ ...anchor })).sort((a, b) =>
      Buffer.compare(Buffer.from(a.releaseTag, "utf8"), Buffer.from(b.releaseTag, "utf8"))),
  } as unknown as JsonObject);
  return value(left) === value(right);
}

interface ParsedKeyRotationProof {
  readonly sequence: number;
  readonly add: readonly TrustedSigningKey[];
  readonly revoke: readonly { readonly keyId: string; readonly revokedAtSequence: number }[];
}

function parseKeyRotationProofPayload(payloadBytes: Uint8Array): ParsedKeyRotationProof {
  let text: string;
  let parsed: JsonValue;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    parsed = parseStrictJson(text);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  if (text !== `${canonicalizeJson(parsed)}\n`) throw updateSecurityError("envelope is invalid");
  const item = record(parsed);
  if (item === null || !safeInteger(item.sequence as JsonValue, 1) || !Object.hasOwn(item, "keyRotation")) {
    throw updateSecurityError("envelope is invalid");
  }
  const sequence = item.sequence as number;
  const rotation = record(item.keyRotation as JsonValue);
  if (
    rotation === null ||
    !exactFields(rotation, ["add", "revoke"]) ||
    !Array.isArray(rotation.add) ||
    !Array.isArray(rotation.revoke) ||
    rotation.add.length > MAX_SIGNATURES ||
    rotation.revoke.length > MAX_SIGNATURES
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const add = rotation.add.map((entry) => {
    const value = requiredRecord(entry);
    if (!exactFields(value, ["keyId", "algorithm", "publicKeySpki", "activeFromSequence"])) {
      throw updateSecurityError("envelope is invalid");
    }
    if (
      value.algorithm !== "Ed25519" ||
      typeof value.keyId !== "string" ||
      typeof value.publicKeySpki !== "string" ||
      !safeInteger(value.activeFromSequence as JsonValue, sequence + 1)
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    return validateKey({
      keyId: value.keyId,
      publicKeySpki: value.publicKeySpki,
      activeFromSequence: value.activeFromSequence as number,
      revokedAtSequence: null,
    });
  });
  const revoke = rotation.revoke.map((entry) => {
    const value = requiredRecord(entry);
    if (!exactFields(value, ["keyId", "revokedAtSequence"])) {
      throw updateSecurityError("envelope is invalid");
    }
    if (
      typeof value.keyId !== "string" ||
      !KEY_ID.test(value.keyId) ||
      !safeInteger(value.revokedAtSequence as JsonValue, sequence + 1)
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    return {
      keyId: value.keyId,
      revokedAtSequence: value.revokedAtSequence as number,
    };
  });
  if (
    add.some((entry, index) => index > 0 &&
      Buffer.compare(Buffer.from(add[index - 1]!.keyId, "utf8"), Buffer.from(entry.keyId, "utf8")) >= 0) ||
    revoke.some((entry, index) => index > 0 &&
      Buffer.compare(Buffer.from(revoke[index - 1]!.keyId, "utf8"), Buffer.from(entry.keyId, "utf8")) >= 0)
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  return { sequence, add, revoke };
}

function applyKeyRotationProof(
  priorKeys: readonly TrustedSigningKey[],
  proof: ParsedKeyRotationProof,
): readonly TrustedSigningKey[] {
  const keys = new Map(priorKeys.map((key) => [key.keyId, { ...key }]));
  for (const addition of proof.add) {
    if (keys.has(addition.keyId)) throw updateSecurityError("trusted key state is invalid");
    keys.set(addition.keyId, { ...addition });
  }
  for (const revocation of proof.revoke) {
    const existing = keys.get(revocation.keyId);
    if (existing === undefined || existing.revokedAtSequence !== null) {
      throw updateSecurityError("trusted key state is invalid");
    }
    keys.set(existing.keyId, { ...existing, revokedAtSequence: revocation.revokedAtSequence });
  }
  const result = [...keys.values()].sort((left, right) => Buffer.compare(
    Buffer.from(left.keyId, "utf8"), Buffer.from(right.keyId, "utf8"),
  ));
  if (!result.some((key) => signingKeyIsActive(key, proof.sequence + 1))) {
    throw updateSecurityError("trusted key state is invalid");
  }
  return result;
}

function verifyEnvelopeAgainstKeys(
  envelope: string | Uint8Array,
  keys: readonly TrustedSigningKey[],
): VerifiedSignedEnvelope {
  const text = decodeEnvelopeText(envelope);
  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(text);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  const outer = record(parsed);
  if (
    outer === null ||
    !exactFields(outer, ["payload", "signatures"]) ||
    text !== `${canonicalizeJson(parsed)}\n`
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const payloadBytes = decodeCanonicalBase64url(outer.payload);
  if (
    payloadBytes === null ||
    !Array.isArray(outer.signatures) ||
    outer.signatures.length === 0 ||
    outer.signatures.length > MAX_SIGNATURES
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const trustedById = new Map(keys.map((key) => [key.keyId, key]));
  const seen = new Set<string>();
  const verifiedKeyIds: string[] = [];
  for (const value of outer.signatures) {
    const signature = record(value);
    if (
      signature === null ||
      !exactFields(signature, ["keyId", "algorithm", "signature"]) ||
      typeof signature.keyId !== "string" ||
      !KEY_ID.test(signature.keyId) ||
      signature.algorithm !== "Ed25519" ||
      seen.has(signature.keyId)
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    seen.add(signature.keyId);
    const signatureBytes = decodeCanonicalBase64url(signature.signature, 64);
    if (signatureBytes === null) throw updateSecurityError("envelope is invalid");
    const key = trustedById.get(signature.keyId);
    if (key === undefined) continue;
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key.publicKeySpki, "base64url"),
        format: "der",
        type: "spki",
      });
      if (verify(null, payloadBytes, publicKey, signatureBytes)) verifiedKeyIds.push(key.keyId);
    } catch {
      throw updateSecurityError("trusted key state is invalid");
    }
  }
  if (verifiedKeyIds.length === 0) throw updateSecurityError("signature validation failed");
  const payloadSha256 = createHash("sha256").update(payloadBytes).digest("hex");
  const immutablePayload = Uint8Array.from(payloadBytes);
  const result = {
    payloadSha256,
    verifiedKeyIds: Object.freeze([...verifiedKeyIds].sort()),
  } as Omit<VerifiedSignedEnvelope, "payloadBytes"> & { readonly payloadBytes?: Uint8Array };
  Object.defineProperty(result, "payloadBytes", {
    enumerable: true,
    configurable: false,
    get: () => Uint8Array.from(immutablePayload),
  });
  return Object.freeze(result) as VerifiedSignedEnvelope;
}

function replayKeyRotationProofs(
  bootstrapKeys: readonly TrustedSigningKey[],
  proofs: readonly string[],
  highestSequence: number,
): readonly TrustedSigningKey[] {
  let keys = [...bootstrapKeys];
  let previousSequence = 0;
  for (const proofEnvelope of proofs) {
    const verified = verifyEnvelopeAgainstKeys(proofEnvelope, keys);
    const proof = parseKeyRotationProofPayload(verified.payloadBytes);
    if (proof.sequence <= previousSequence || proof.sequence > highestSequence) {
      throw updateSecurityError("trusted key state is invalid");
    }
    if (!verified.verifiedKeyIds.some((keyId) => {
      const key = keys.find((candidate) => candidate.keyId === keyId);
      return key !== undefined && signingKeyIsActive(key, proof.sequence);
    })) {
      throw updateSecurityError("trusted key state is invalid");
    }
    keys = [...applyKeyRotationProof(keys, proof)];
    previousSequence = proof.sequence;
  }
  return keys;
}

function validateAcceptedChannelEnvelope(
  envelope: string,
  accepted: NormalizedTrustCore,
  keys: readonly TrustedSigningKey[],
): void {
  const verified = verifyEnvelopeAgainstKeys(envelope, keys);
  if (accepted.acceptedPayloadSha256 === null || verified.payloadSha256 !== accepted.acceptedPayloadSha256) {
    throw updateSecurityError("trusted key state is invalid");
  }
  let text: string;
  let parsed: JsonValue;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(verified.payloadBytes);
    parsed = parseStrictJson(text);
  } catch {
    throw updateSecurityError("trusted key state is invalid");
  }
  if (text !== `${canonicalizeJson(parsed)}\n`) throw updateSecurityError("trusted key state is invalid");
  const item = record(parsed);
  if (
    item === null ||
    !safeInteger(item.sequence as JsonValue, 1) ||
    item.sequence !== accepted.highestSequence ||
    !Object.hasOwn(item, "repository") ||
    !Object.hasOwn(item, "templateHistory")
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const repository = requiredRecord(item.repository);
  if (
    !exactFields(repository, ["owner", "name"]) ||
    typeof repository.owner !== "string" ||
    typeof repository.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(repository.owner) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(repository.name)
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const history = item.templateHistory;
  if (!Array.isArray(history) || history.length === 0 || history.length > MAX_BUNDLE_RECEIPT_ANCHORS) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const anchors = history.map((entry) => {
    const value = requiredRecord(entry);
    if (!exactFields(value, [
      "releaseTag", "bundleManifestHash", "receiptPayloadSha256", "signingSequence", "signingKeyId",
    ])) {
      throw updateSecurityError("trusted key state is invalid");
    }
    if (
      !isCanonicalTemplateReleaseTag(value.releaseTag) ||
      typeof value.bundleManifestHash !== "string" ||
      !SHA256.test(value.bundleManifestHash) ||
      typeof value.receiptPayloadSha256 !== "string" ||
      !SHA256.test(value.receiptPayloadSha256) ||
      !safeInteger(value.signingSequence as JsonValue, 1) ||
      (value.signingSequence as number) > accepted.highestSequence ||
      typeof value.signingKeyId !== "string" ||
      !KEY_ID.test(value.signingKeyId)
    ) {
      throw updateSecurityError("trusted key state is invalid");
    }
    const key = keys.find((candidate) => candidate.keyId === value.signingKeyId);
    if (key === undefined || !signingKeyIsActive(key, value.signingSequence as number)) {
      throw updateSecurityError("trusted key state is invalid");
    }
    return {
      repositoryOwner: repository.owner as string,
      repositoryName: repository.name as string,
      releaseTag: value.releaseTag,
      bundleManifestHash: value.bundleManifestHash,
      receiptPayloadSha256: value.receiptPayloadSha256,
      signingSequence: value.signingSequence as number,
      signingKeyId: value.signingKeyId,
    };
  });
  if (anchors.some((anchor, index) => index > 0 &&
    Buffer.compare(Buffer.from(anchors[index - 1]!.releaseTag, "utf8"), Buffer.from(anchor.releaseTag, "utf8")) >= 0)) {
    throw updateSecurityError("trusted key state is invalid");
  }
  if (!sameAnchors(anchors, accepted.bundleReceiptAnchors)) {
    throw updateSecurityError("trusted key state is invalid");
  }
  if (!verified.verifiedKeyIds.some((keyId) => {
    const key = keys.find((candidate) => candidate.keyId === keyId);
    return key !== undefined && signingKeyIsActive(key, accepted.highestSequence);
  })) {
    throw updateSecurityError("trusted key state is invalid");
  }
}

export function createTrustState(
  keys: readonly TrustedSigningKey[],
  highestSequence = 0,
  acceptedPayloadSha256: string | null = null,
  bundleReceiptAnchors: readonly TrustedBundleReceiptAnchor[] = [],
): UpdateTrustState {
  if (
    highestSequence !== 0 ||
    acceptedPayloadSha256 !== null ||
    !Array.isArray(bundleReceiptAnchors) ||
    bundleReceiptAnchors.length !== 0
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const core = normalizeTrustCore(keys, highestSequence, acceptedPayloadSha256, bundleReceiptAnchors);
  return freezeTrustState({
    trustVersion: 2,
    bootstrapKeys: core.keys.map((key) => ({ ...key })),
    keyRotationProofs: [],
    ...core,
    acceptedChannelEnvelope: null,
    acceptedTransition: null,
  });
}

export function createAcceptedTrustState(
  priorValue: UpdateTrustState,
  keys: readonly TrustedSigningKey[],
  highestSequence: number,
  acceptedPayloadSha256: string,
  bundleReceiptAnchors: readonly TrustedBundleReceiptAnchor[],
  acceptedChannelEnvelope: string,
  keyRotationProof?: string,
): UpdateTrustState {
  const prior = validateTrustState(priorValue);
  const accepted = normalizeTrustCore(
    keys,
    highestSequence,
    acceptedPayloadSha256,
    bundleReceiptAnchors,
  );
  if (accepted.highestSequence <= prior.highestSequence) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const transition: AcceptedTrustTransition = {
    priorHighestSequence: prior.highestSequence,
    priorAcceptedPayloadSha256: prior.acceptedPayloadSha256,
    priorKeys: prior.keys.map((key) => ({ ...key })),
    priorBundleReceiptAnchors: prior.bundleReceiptAnchors.map((anchor) => ({ ...anchor })),
    transitionSha256: trustTransitionHash(prior, accepted),
  };
  const candidate = {
    trustVersion: 2,
    bootstrapKeys: prior.bootstrapKeys.map((key) => ({ ...key })),
    keyRotationProofs: [
      ...prior.keyRotationProofs,
      ...(keyRotationProof === undefined ? [] : [keyRotationProof]),
    ],
    ...accepted,
    acceptedChannelEnvelope,
    acceptedTransition: transition,
  } satisfies UpdateTrustState;
  trustedStateBrands.add(candidate);
  return validateTrustState(candidate);
}

function validateTrustState(
  value: UpdateTrustState,
  expectedBootstrapKeys?: readonly TrustedSigningKey[],
): UpdateTrustState {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactFields(value as unknown as JsonObject, [
      "trustVersion", "bootstrapKeys", "keyRotationProofs", "keys", "highestSequence",
      "acceptedPayloadSha256", "acceptedChannelEnvelope", "bundleReceiptAnchors",
      "acceptedTransition",
    ]) ||
    value.trustVersion !== 2
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  if (expectedBootstrapKeys === undefined && !trustedStateBrands.has(value as object)) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const core = normalizeTrustCore(
    value.keys,
    value.highestSequence,
    value.acceptedPayloadSha256,
    value.bundleReceiptAnchors,
  );
  if (
    !Array.isArray(value.keyRotationProofs) ||
    value.keyRotationProofs.length > MAX_KEY_ROTATION_PROOFS ||
    value.keyRotationProofs.some((proof) => typeof proof !== "string")
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const bootstrap = normalizeTrustCore(value.bootstrapKeys, 0, null, []);
  if (
    expectedBootstrapKeys !== undefined &&
    !sameSigningKeys(
      normalizeTrustCore(expectedBootstrapKeys, 0, null, []).keys,
      bootstrap.keys,
    )
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const authorized = replayKeyRotationProofs(bootstrap.keys, value.keyRotationProofs, core.highestSequence);
  if (!sameSigningKeys(authorized, core.keys)) {
    throw updateSecurityError("trusted key state is invalid");
  }
  if (
    (core.highestSequence === 0) !== (value.acceptedChannelEnvelope === null) ||
    (value.acceptedChannelEnvelope !== null && typeof value.acceptedChannelEnvelope !== "string")
  ) {
    throw updateSecurityError("trusted key state is invalid");
  }
  if (value.acceptedChannelEnvelope !== null) {
    validateAcceptedChannelEnvelope(value.acceptedChannelEnvelope, core, authorized);
  }
  if ((core.highestSequence === 0) !== (value.acceptedTransition === null)) {
    throw updateSecurityError("trusted key state is invalid");
  }
  const transition = value.acceptedTransition === null
    ? null
    : acceptedTransition(value.acceptedTransition, core);
  return freezeTrustState({
    trustVersion: 2,
    bootstrapKeys: bootstrap.keys,
    keyRotationProofs: [...value.keyRotationProofs],
    ...core,
    acceptedChannelEnvelope: value.acceptedChannelEnvelope,
    acceptedTransition: transition,
  });
}

/** Persisted-state callers must pass the immutable built-in bootstrap key set. */
export function verifySignedEnvelope(
  envelope: string | Uint8Array,
  trustState: UpdateTrustState,
  expectedBootstrapKeys?: readonly TrustedSigningKey[],
): VerifiedSignedEnvelope {
  const trusted = validateTrustState(trustState, expectedBootstrapKeys);
  return verifyEnvelopeAgainstKeys(envelope, trusted.keys);
}

export function signingKeyIsActive(
  key: TrustedSigningKey,
  sequence: number,
): boolean {
  return key.activeFromSequence <= sequence &&
    (key.revokedAtSequence === null || sequence < key.revokedAtSequence);
}

export function copyTrustState(
  value: UpdateTrustState,
  expectedBootstrapKeys?: readonly TrustedSigningKey[],
): UpdateTrustState {
  const trusted = validateTrustState(value, expectedBootstrapKeys);
  const copy = copyJsonValue(trusted) as unknown as UpdateTrustState;
  trustedStateBrands.add(copy as object);
  return validateTrustState(copy, expectedBootstrapKeys);
}
