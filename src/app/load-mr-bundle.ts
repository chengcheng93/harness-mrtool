import { canonicalizeJson, sha256CanonicalJson, sha256Utf8, type JsonValue } from "../contracts/jcs.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import type { LoadedTemplateBundle } from "../bundle/load.ts";
import {
  parseDiagnosticMarker,
  verifyDiagnosticMarker,
  type DiagnosticMarkerMetadata,
} from "../render/marker.ts";
import {
  validateVerificationReceipt,
  type HistoricalBundleLoader,
  type VerificationBundleReference,
  type VerificationReceiptV1,
} from "./verify-mr.ts";

const SHA256 = /^[a-f0-9]{64}$/u;

/** A small durable receipt adapter used by the application boundary. */
export interface HistoricalBundleReceipt {
  readonly receiptVersion: 1;
  readonly gitlabOrigin: string;
  readonly iid: number;
  readonly targetProjectId: string;
  readonly markerDigest: string;
  readonly bundle: VerificationBundleReference;
}

export type HistoricalBundleReceiptValue = HistoricalBundleReceipt | VerificationReceiptV1;

export interface HistoricalBundleReceiptLoad {
  readonly trusted: boolean;
  readonly receipt: unknown;
}

export interface HistoricalBundleReceiptLoader {
  loadVerified(locator: {
    readonly gitlabOrigin: string;
    readonly targetProjectId: string;
    readonly iid: number;
    readonly markerDigest: string;
  }): Promise<HistoricalBundleReceiptLoad | null>;
}

export interface HistoricalBundleSource {
  readonly gitlabOrigin: string;
  readonly receiptLoader: HistoricalBundleReceiptLoader;
  readonly bundleLoader: HistoricalBundleLoader;
  /** Optional compatibility probe. EOL Bundles may still be loaded for read-only verification. */
  readonly isBundleSupported?: (bundle: LoadedTemplateBundle) => boolean;
  /** Migration-only escape hatch: keep marker metadata binding while allowing body prose drift. */
  readonly allowManualDescriptionDrift?: boolean;
}

export interface MrBundleIdentity {
  readonly iid: number;
  readonly targetProjectId: string;
  readonly description: string;
}

export interface LoadMrBundleInputs {
  readonly current: MrBundleIdentity;
  readonly source: HistoricalBundleSource;
}

export interface LoadedMrBundle {
  readonly bundle: LoadedTemplateBundle;
  readonly marker: DiagnosticMarkerMetadata;
  readonly receipt: HistoricalBundleReceiptValue;
  readonly reference: VerificationBundleReference;
  readonly bundleManifestHash: string;
  readonly eol: boolean;
}

function unmanaged(reason: string): ToolError<"UNMANAGED_MR"> {
  return new ToolError("UNMANAGED_MR", "The merge request is not a verified harness-mrtool MR", {
    field: "mergeRequest.description",
    expected: "a final diagnostic marker with a matching durable verification receipt",
    actual: reason,
    safeNextStep: "Refresh the MR or explicitly adopt it through a future migration assistant; no description was changed.",
  });
}

function securityFailure(reason: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "The historical Template Bundle could not be trusted", {
    field: "bundle",
    expected: "the exact immutable release, signed receipt, and complete verified Bundle bytes",
    actual: reason,
    safeNextStep: "Restore the exact historical release asset or retry while online; no migration write was attempted.",
  });
}

function scalar(value: unknown, subject: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    throw securityFailure(`${subject} is invalid`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], subject: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw securityFailure(`${subject} fields are invalid`);
  }
}

function reference(value: unknown): VerificationBundleReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw securityFailure("durable receipt Bundle reference is invalid");
  }
  const item = value as Record<string, unknown>;
  exactKeys(item, ["releaseTag", "bundleId", "bundleVersion", "bundleManifestHash", "policySchema"], "Bundle reference");
  const hash = scalar(item.bundleManifestHash, "Bundle manifest hash");
  if (!SHA256.test(hash) || !Number.isSafeInteger(item.policySchema) || (item.policySchema as number) < 1) {
    throw securityFailure("durable receipt Bundle reference is invalid");
  }
  return Object.freeze({
    releaseTag: scalar(item.releaseTag, "Bundle release tag"),
    bundleId: scalar(item.bundleId, "Bundle ID"),
    bundleVersion: scalar(item.bundleVersion, "Bundle version"),
    bundleManifestHash: hash,
    policySchema: item.policySchema as number,
  });
}

function normalizeReceipt(
  value: unknown,
  current: MrBundleIdentity,
  marker: DiagnosticMarkerMetadata,
  source: HistoricalBundleSource,
): HistoricalBundleReceiptValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw securityFailure("durable verification receipt is not an object");
  }
  // Existing verification receipts carry stronger project/user/description bindings.
  if (Object.hasOwn(value, "expected") && Object.hasOwn(value, "marker")) {
    let receipt: VerificationReceiptV1;
    try {
      receipt = validateVerificationReceipt(value);
    } catch (error) {
      if (isToolError(error, "POSTCONDITION_ERROR")) throw securityFailure("durable verification receipt is invalid");
      throw securityFailure("durable verification receipt is invalid");
    }
    if (receipt.gitlabOrigin !== source.gitlabOrigin || receipt.iid !== current.iid ||
        receipt.targetProject.id !== current.targetProjectId ||
        canonicalizeJson(receipt.marker as unknown as JsonValue) !==
          canonicalizeJson(marker as unknown as JsonValue)) {
      throw securityFailure("durable verification receipt is bound to another merge request");
    }
    return receipt;
  }

  const item = value as Record<string, unknown>;
  exactKeys(item, ["receiptVersion", "gitlabOrigin", "iid", "targetProjectId", "markerDigest", "bundle"], "durable receipt");
  if (item.receiptVersion !== 1 || !Number.isSafeInteger(item.iid) || item.iid !== current.iid) {
    throw securityFailure("durable receipt MR binding is invalid");
  }
  const origin = scalar(item.gitlabOrigin, "durable receipt origin");
  const targetProjectId = scalar(item.targetProjectId, "durable receipt target project");
  const markerDigest = scalar(item.markerDigest, "durable receipt marker digest");
  if (origin !== source.gitlabOrigin || targetProjectId !== current.targetProjectId ||
      markerDigest !== sha256CanonicalJson(marker as unknown as JsonValue)) {
    throw securityFailure("durable receipt is bound to another merge request");
  }
  return Object.freeze({
    receiptVersion: 1,
    gitlabOrigin: origin,
    iid: item.iid as number,
    targetProjectId,
    markerDigest,
    bundle: reference(item.bundle),
  });
}

function receiptReference(receipt: HistoricalBundleReceiptValue): VerificationBundleReference {
  return reference(receipt.bundle);
}

function assertMarkerReference(
  marker: DiagnosticMarkerMetadata,
  expected: VerificationBundleReference,
): void {
  if (marker.renderPhase !== "final" || marker.releaseTag !== expected.releaseTag ||
      marker.bundleId !== expected.bundleId || marker.bundleVersion !== expected.bundleVersion ||
      marker.bundleManifestHash !== expected.bundleManifestHash || marker.policySchema !== expected.policySchema) {
    throw securityFailure("marker and durable receipt Bundle references differ");
  }
}

function bundleHash(bundle: LoadedTemplateBundle): string {
  return sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
}

/**
 * Resolve the immutable Bundle named by a managed MR. This function deliberately
 * never falls back to the current/stable Bundle when the pinned asset is absent.
 */
export async function loadMrBundle(inputs: LoadMrBundleInputs): Promise<LoadedMrBundle> {
  const current = inputs?.current;
  const source = inputs?.source;
  if (current === null || typeof current !== "object" ||
      !Number.isSafeInteger(current.iid) || current.iid < 1 ||
      typeof current.targetProjectId !== "string" || current.targetProjectId.trim() === "" ||
      typeof current.description !== "string") {
    throw unmanaged("merge request identity is invalid");
  }
  if (source === null || typeof source !== "object" ||
      typeof source.gitlabOrigin !== "string" || source.gitlabOrigin.trim() === "" ||
      source.receiptLoader === undefined || source.bundleLoader === undefined) {
    throw securityFailure("historical Bundle source is unavailable");
  }

  let marker: DiagnosticMarkerMetadata;
  try {
    marker = source.allowManualDescriptionDrift === true
      ? parseDiagnosticMarker(current.description)
      : verifyDiagnosticMarker(current.description);
  } catch {
    throw unmanaged("description marker is missing or malformed");
  }
  if (marker.renderPhase !== "final") throw unmanaged("description marker is not final");
  const markerDigest = sha256CanonicalJson(marker as unknown as JsonValue);
  let loadedReceipt: HistoricalBundleReceiptLoad | null;
  try {
    loadedReceipt = await source.receiptLoader.loadVerified(Object.freeze({
      gitlabOrigin: source.gitlabOrigin,
      targetProjectId: current.targetProjectId,
      iid: current.iid,
      markerDigest,
    }));
  } catch {
    throw securityFailure("durable verification receipt could not be read");
  }
  if (loadedReceipt === null || loadedReceipt.trusted !== true) {
    throw securityFailure("durable verification receipt is unavailable or untrusted");
  }
  const receipt = normalizeReceipt(loadedReceipt.receipt, current, marker, source);
  const expected = receiptReference(receipt);
  assertMarkerReference(marker, expected);

  let loadedBundle;
  try {
    loadedBundle = await source.bundleLoader.loadVerifiedExact(expected);
  } catch {
    throw securityFailure("exact historical Bundle asset could not be read");
  }
  if (loadedBundle.trusted !== true || loadedBundle.bundle === null || loadedBundle.bundle === undefined) {
    throw securityFailure("exact historical Bundle asset is missing or untrusted");
  }
  try {
    validateTemplateBundle(loadedBundle.bundle);
  } catch {
    throw securityFailure("historical Bundle validation failed");
  }
  const actualHash = bundleHash(loadedBundle.bundle);
  if (actualHash !== expected.bundleManifestHash) {
    throw securityFailure("historical Bundle manifest hash does not match its durable receipt");
  }
  if (loadedBundle.bundle.manifest.bundleId !== expected.bundleId ||
      loadedBundle.bundle.manifest.version !== expected.bundleVersion ||
      loadedBundle.bundle.manifest.policySchema !== expected.policySchema) {
    throw securityFailure("historical Bundle manifest identity does not match its receipt");
  }
  const eol = source.isBundleSupported?.(loadedBundle.bundle) === false;
  return Object.freeze({
    bundle: loadedBundle.bundle,
    marker,
    receipt,
    reference: expected,
    bundleManifestHash: expected.bundleManifestHash,
    eol,
  });
}

/** Compatibility name used by context/schema callers. */
export const contextFromMr = loadMrBundle;
