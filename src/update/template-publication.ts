import { createHash } from "node:crypto";
import { MAX_BUNDLE_MANIFEST_BYTES, MAX_BUNDLE_PAYLOAD_BYTES, MAX_BUNDLE_TOTAL_PAYLOAD_BYTES } from "../bundle/load.ts";
import { unpackTemplatePublicationArchive } from "./production-historical-source.ts";

import {
  parseCanonicalBundleReceiptPayload,
  verifyBundleReceiptFiles,
  type BundleReceipt,
} from "./bundle-receipt.ts";
import {
  MAX_SIGNED_ENVELOPE_BYTES,
  createTrustState,
  requireCanonicalSemVer,
  signingKeyIsActive,
  updateSecurityError,
  verifySignedEnvelope,
} from "./envelope.ts";
import {
  createProductionUpdateTrustConfig,
  updateTrustConfigSha256,
  type UpdateTrustConfig,
} from "./trust-config.ts";

export const MAX_TEMPLATE_PUBLICATION_ARCHIVE_BYTES =
  MAX_BUNDLE_MANIFEST_BYTES + MAX_BUNDLE_TOTAL_PAYLOAD_BYTES + 1024 * 1024;

export interface TemplatePublicationReceiptOptions {
  readonly envelope: string | Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Optional actual publication ZIP; hash/size are returned only after its tree is authenticated. */
  readonly archiveBytes?: Uint8Array;
  /** Explicit branded in-process seam; never supplied through CLI, request, or environment. */
  readonly trustConfig?: UpdateTrustConfig;
  readonly expectedTag: string;
  readonly expectedVersion: string;
}

export interface VerifiedTemplatePublicationReceipt {
  readonly purpose: "template-publication-only";
  readonly receipt: BundleReceipt;
  readonly payloadSha256: string;
  readonly signingKeyId: string;
  readonly bundleManifestHash: string;
  readonly archiveSha256?: string;
  readonly archiveSize?: number;
}

function rejectBom(bytes: Uint8Array): void {
  // TextDecoder strips a BOM by default. Publication requires canonical bytes,
  // not merely canonical text after decoding.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw updateSecurityError("envelope is invalid");
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Prepublication verification, NOT runtime authorization. The signed channel
 * can later anchor this receipt's payload hash. Historical/runtime loading must
 * still use verifyBundleReceiptEnvelope with accepted channel history anchors.
 */
export function verifyTemplatePublicationReceipt(
  options: TemplatePublicationReceiptOptions,
): VerifiedTemplatePublicationReceipt {
  const trustConfig = options.trustConfig ?? createProductionUpdateTrustConfig();
  updateTrustConfigSha256(trustConfig); // Enforce the runtime brand, not just its shape.
  const trust = createTrustState(trustConfig.bootstrapKeys);
  const signed = verifySignedEnvelope(options.envelope, trust, trustConfig.bootstrapKeys);
  rejectBom(signed.payloadBytes);
  const receipt = parseCanonicalBundleReceiptPayload(signed.payloadBytes);
  const version = requireCanonicalSemVer(options.expectedVersion);
  const key = trust.keys.find((candidate) => candidate.keyId === receipt.signingKeyId);
  if (
    options.expectedTag !== `templates-v${version}` ||
    receipt.releaseTag !== options.expectedTag ||
    receipt.bundleVersion !== version ||
    receipt.repository.owner !== trustConfig.repository.owner ||
    receipt.repository.name !== trustConfig.repository.name ||
    !signed.verifiedKeyIds.includes(receipt.signingKeyId) ||
    key === undefined || !signingKeyIsActive(key, receipt.signingSequence)
  ) {
    throw updateSecurityError("signature validation failed");
  }
  const verifiedFiles = verifyBundleReceiptFiles(receipt, options.files);
  const manifest = verifiedFiles.get("bundle-manifest.json");
  if (manifest === undefined) throw updateSecurityError("envelope is invalid");
  rejectBom(manifest);
  let archiveIdentity: { archiveSha256: string; archiveSize: number } | undefined;
  if (options.archiveBytes !== undefined) {
    if (!(options.archiveBytes instanceof Uint8Array) || options.archiveBytes.length < 22 ||
        options.archiveBytes.length > MAX_TEMPLATE_PUBLICATION_ARCHIVE_BYTES) {
      throw updateSecurityError("envelope is invalid");
    }
    const archive = Uint8Array.from(options.archiveBytes);
    const archivedFiles = unpackTemplatePublicationArchive(archive, {
      filePaths: receipt.files.map((file) => file.path),
      limits: {
        receiptEnvelopeBytes: MAX_SIGNED_ENVELOPE_BYTES,
        manifestBytes: MAX_BUNDLE_MANIFEST_BYTES,
        payloadBytes: MAX_BUNDLE_PAYLOAD_BYTES,
        totalPayloadBytes: MAX_BUNDLE_TOTAL_PAYLOAD_BYTES,
      },
    });
    // Reuse the exact receipt binding on decoded artifact bytes as well as the
    // authenticated source snapshot; unsigned archive checksums cannot replace it.
    const verifiedArchiveFiles = verifyBundleReceiptFiles(receipt, archivedFiles);
    for (const [path, bytes] of verifiedFiles) {
      const archived = verifiedArchiveFiles.get(path);
      if (archived === undefined || !Buffer.from(bytes).equals(archived)) {
        throw updateSecurityError("signature validation failed");
      }
    }
    archiveIdentity = { archiveSha256: createHash("sha256").update(archive).digest("hex"), archiveSize: archive.length };
  }
  return freeze({
    purpose: "template-publication-only" as const,
    receipt,
    payloadSha256: signed.payloadSha256,
    signingKeyId: receipt.signingKeyId,
    bundleManifestHash: createHash("sha256").update(manifest).digest("hex"),
    ...archiveIdentity,
  });
}
