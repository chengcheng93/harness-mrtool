import { sha256Utf8, canonicalizeJson, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import type { LoadedTemplateBundle } from "../bundle/load.ts";
import {
  buildMigrationPlan,
  mergeManagedDescriptions,
  type DescriptionMergeResult,
  type MigrationDescriptionInput,
  type MigrationPlan,
  type MarkdownDiffEntry,
} from "../bundle/migration.ts";
import {
  parseDiagnosticMarker,
  verifyDiagnosticMarker,
  type DiagnosticMarkerMetadata,
} from "../render/marker.ts";
import type { LoadedMrBundle, MrBundleIdentity } from "./load-mr-bundle.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET_SHAPE = /(?:glpat-[A-Za-z0-9_-]+|hmr[ctx]1_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|(?:authorization|bearer)\s*[:=]\s*[^\s]+|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/giu;

export interface MigrationBackup {
  readonly description: string;
  readonly marker: DiagnosticMarkerMetadata;
  readonly bundleManifestHash: string;
}

export interface MigrationTransactionInput {
  readonly current: MrBundleIdentity;
  readonly oldBundle: LoadedMrBundle;
  readonly currentBundle: LoadedTemplateBundle;
  readonly oldBundleHash: string;
  readonly newBundleHash: string;
  readonly description: string;
  readonly plan: MigrationPlan;
  readonly backup: MigrationBackup;
}

export interface MigrationTransactionResult {
  readonly readbackVerified: boolean;
  readonly receiptStaged: boolean;
  readonly [key: string]: unknown;
}

/** Adapter boundary for the existing full MR transaction/readback/receipt path. */
export interface MigrationTransaction {
  readonly backup: (backup: MigrationBackup) => Promise<void> | void;
  readonly execute: (
    input: MigrationTransactionInput,
  ) => Promise<MigrationTransactionResult> | MigrationTransactionResult;
}

export interface MigrateTemplateInputs {
  readonly current: MrBundleIdentity;
  readonly historical: LoadedMrBundle;
  readonly currentBundle: LoadedTemplateBundle;
  readonly newBundleHash: string;
  readonly newDescription: string;
  readonly baseDescription?: string;
  readonly oldValues?: JsonObject;
  readonly newValues?: JsonObject;
  readonly currentValues?: JsonObject;
  readonly proposedValues?: JsonObject;
  readonly oldSchema?: JsonValue;
  readonly newSchema?: JsonValue;
  readonly nonInteractive?: boolean;
  readonly confirmation?: string | null;
  readonly confirm?: () => Promise<boolean> | boolean;
  readonly transaction: MigrationTransaction;
}

export interface MigrateTemplateResult {
  readonly committed: true;
  readonly oldBundleHash: string;
  readonly newBundleHash: string;
  readonly oldReleaseTag: string;
  readonly newReleaseTag: string;
  readonly description: string;
  readonly plan: MigrationPlan;
  readonly diff: readonly MarkdownDiffEntry[];
  readonly conflicts: readonly string[];
  readonly missingFields: readonly string[];
  readonly backup: {
    readonly markerDigest: string;
    readonly bundleManifestHash: string;
  };
  readonly transaction: MigrationTransactionResult;
}

function error(
  code: "INPUT_ERROR" | "TEMPLATE_ERROR" | "UPDATE_REQUIRED" | "MANUAL_DESCRIPTION_CHANGE" | "CONCURRENT_UPDATE" | "POSTCONDITION_ERROR",
  reason: string,
): ToolError {
  return new ToolError(code, `Template migration could not proceed: ${reason}`, {
    field: "migration",
    expected: "an explicit, lossless migration with verified old/new Bundles",
    actual: reason,
    safeNextStep: "Resolve the reported migration blocker and retry with the exact immutable Bundle hashes.",
  });
}

function redact(value: string): string {
  return value.replace(SECRET_SHAPE, "[REDACTED]");
}

function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJson(child)]));
  }
  return value;
}

function normalizedBody(value: string): string {
  return `${value.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "")}\n`;
}

function markerSuffix(description: string): string {
  const match = /<!-- harness-mrtool:v1 ([A-Za-z0-9_-]+) -->\n$/u.exec(description);
  if (match === null || match[1] === undefined) throw error("TEMPLATE_ERROR", "new description marker is missing");
  return match[1];
}

function markerBody(description: string): string {
  const match = /<!-- harness-mrtool:v1 [A-Za-z0-9_-]+ -->\n$/u.exec(description);
  if (match === null) throw error("TEMPLATE_ERROR", "new description marker is missing");
  return description.slice(0, match.index);
}

function rewriteMarkerBody(body: string, proposedDescription: string): string {
  const encoded = markerSuffix(proposedDescription);
  let metadata: Record<string, unknown>;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata");
    metadata = { ...(parsed as Record<string, unknown>) };
  } catch {
    throw error("TEMPLATE_ERROR", "new description marker is not canonical metadata");
  }
  metadata.bodyDigest = sha256Utf8(normalizedBody(body));
  const canonical = canonicalizeJson(metadata as unknown as JsonValue);
  return `${normalizedBody(body)}<!-- harness-mrtool:v1 ${Buffer.from(canonical, "utf8").toString("base64url")} -->\n`;
}

function manifestHash(bundle: LoadedTemplateBundle): string {
  return sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
}

function exactConfirmation(value: string | null | undefined, oldHash: string, newHash: string): boolean {
  return value === `${oldHash}:${newHash}`;
}

function receiptDescription(historical: LoadedMrBundle): string | undefined {
  const receipt = historical.receipt;
  if (receipt !== null && typeof receipt === "object" && !Array.isArray(receipt) &&
      Object.hasOwn(receipt, "expected")) {
    const expected = (receipt as unknown as Record<string, unknown>).expected;
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected) &&
        typeof (expected as Record<string, unknown>).description === "string") {
      return (expected as Record<string, unknown>).description as string;
    }
  }
  return undefined;
}

function safePlanWithDescription(
  input: MigrateTemplateInputs,
  baseDescription: string,
): MigrationPlan {
  const descriptionInput: MigrationDescriptionInput = {
    base: baseDescription,
    current: input.current.description,
    proposed: input.newDescription,
  };
  const hasSchemaValues = input.oldValues !== undefined || input.newValues !== undefined ||
    input.currentValues !== undefined || input.proposedValues !== undefined;
  if (hasSchemaValues) {
    return buildMigrationPlan({
      oldSchema: input.oldSchema ?? {},
      newSchema: input.newSchema ?? {},
      ...(input.oldValues === undefined ? {} : { oldValues: input.oldValues }),
      ...(input.newValues === undefined ? {} : { newValues: input.newValues }),
      ...(input.currentValues === undefined ? {} : { currentValues: input.currentValues }),
      ...(input.proposedValues === undefined ? {} : { proposedValues: input.proposedValues }),
      description: descriptionInput,
    });
  }
  let description: DescriptionMergeResult;
  try {
    description = mergeManagedDescriptions(descriptionInput);
  } catch (caught) {
    if (isToolError(caught)) throw caught;
    throw error("TEMPLATE_ERROR", "description merge failed");
  }
  return Object.freeze({
    oldSchema: input.oldSchema ?? {},
    newSchema: input.newSchema ?? {},
    mappedFields: [],
    unmappedFields: [],
    missingFields: [],
    reports: description.reports,
    conflicts: description.conflicts,
    manualFields: description.manualFields,
    description,
    diff: description.diff,
    blocked: description.conflicts.length > 0,
  });
}

function validateNewDescription(
  description: string,
  bundle: LoadedTemplateBundle,
  expectedHash: string,
): DiagnosticMarkerMetadata {
  let marker: DiagnosticMarkerMetadata;
  try {
    marker = verifyDiagnosticMarker(description);
  } catch {
    throw error("TEMPLATE_ERROR", "new description marker is invalid");
  }
  if (marker.renderPhase !== "final" || marker.bundleManifestHash !== expectedHash ||
      marker.bundleId !== bundle.manifest.bundleId || marker.bundleVersion !== bundle.manifest.version ||
      marker.policySchema !== bundle.manifest.policySchema) {
    throw error("TEMPLATE_ERROR", "new description marker does not identify the current Bundle");
  }
  return marker;
}

/** Execute an explicit, hash-confirmed, lossless Template Bundle migration. */
export async function migrateTemplate(input: MigrateTemplateInputs): Promise<MigrateTemplateResult> {
  if (input === null || typeof input !== "object" || input.transaction === undefined) {
    throw error("INPUT_ERROR", "migration transaction is unavailable");
  }
  const oldHash = input.historical.bundleManifestHash;
  const newHash = input.newBundleHash;
  if (!SHA256.test(oldHash) || !SHA256.test(newHash) || oldHash === newHash) {
    throw error("INPUT_ERROR", "old and new Bundle hashes are invalid or identical");
  }
  try {
    validateTemplateBundle(input.currentBundle);
  } catch {
    throw error("TEMPLATE_ERROR", "current Bundle is not verified");
  }
  if (manifestHash(input.currentBundle) !== newHash) {
    throw error("TEMPLATE_ERROR", "current Bundle hash does not match the requested new hash");
  }
  if (input.historical.eol) {
    throw error("UPDATE_REQUIRED", "the historical Bundle is end-of-life and cannot run an ordinary update");
  }
  const proposedMarker = validateNewDescription(input.newDescription, input.currentBundle, newHash);
  const baseDescription = input.baseDescription ?? receiptDescription(input.historical) ?? input.current.description;
  try {
    let currentMarker: DiagnosticMarkerMetadata;
    try {
      currentMarker = verifyDiagnosticMarker(input.current.description);
    } catch {
      // Explicit migration may carry a manually edited body; the marker metadata
      // must still remain byte-for-byte bound to the historical receipt.
      currentMarker = parseDiagnosticMarker(input.current.description);
    }
    if (canonicalizeJson(currentMarker as unknown as JsonValue) !==
        canonicalizeJson(input.historical.marker as unknown as JsonValue)) {
      throw error("CONCURRENT_UPDATE", "the current marker drifted after historical loading");
    }
  } catch (caught) {
    if (isToolError(caught, "CONCURRENT_UPDATE")) throw caught;
    throw error("CONCURRENT_UPDATE", "the current marker or description drifted after historical loading");
  }
  // All read-only validation, including marker drift and merge blockers, happens before backup.
  let plan = safePlanWithDescription(input, baseDescription);
  if (plan.conflicts.length > 0) {
    throw error("MANUAL_DESCRIPTION_CHANGE", "managed fields contain unresolved manual conflicts");
  }
  if (plan.missingFields.length > 0) {
    throw error("INPUT_ERROR", "new required fields need explicit user values");
  }
  if (input.current.description !== baseDescription && input.baseDescription === undefined &&
      receiptDescription(input.historical) === undefined) {
    throw error("CONCURRENT_UPDATE", "the current description changed without a durable migration base");
  }
  const confirmation = input.confirmation ?? null;
  if (input.nonInteractive === true) {
    if (!exactConfirmation(confirmation, oldHash, newHash)) {
      throw error("INPUT_ERROR", "non-interactive migration requires exact old:new hash confirmation");
    }
  } else if (confirmation !== null && !exactConfirmation(confirmation, oldHash, newHash)) {
    throw error("INPUT_ERROR", "migration confirmation must be the exact old:new hash pair");
  } else if (confirmation === null) {
    if (input.confirm === undefined) {
      throw error("INPUT_ERROR", "interactive migration requires an explicit confirmation");
    }
    if (!(await input.confirm())) throw error("INPUT_ERROR", "migration confirmation was declined");
  }

  const mergedBody = plan.description?.description ?? markerBody(input.newDescription);
  const mergedDescription = rewriteMarkerBody(mergedBody, input.newDescription);
  // Re-check the generated marker after merging, before any durable backup write.
  validateNewDescription(mergedDescription, input.currentBundle, newHash);
  const backup: MigrationBackup = Object.freeze({
    description: input.current.description,
    marker: input.historical.marker,
    bundleManifestHash: oldHash,
  });
  await input.transaction.backup(backup);
  let transaction: MigrationTransactionResult;
  try {
    transaction = await input.transaction.execute({
      current: input.current,
      oldBundle: input.historical,
      currentBundle: input.currentBundle,
      oldBundleHash: oldHash,
      newBundleHash: newHash,
      description: mergedDescription,
      plan,
      backup,
    });
  } catch (caught) {
    if (isToolError(caught)) throw caught;
    throw error("POSTCONDITION_ERROR", "the migration transaction failed");
  }
  if (transaction.readbackVerified !== true || transaction.receiptStaged !== true) {
    throw error("POSTCONDITION_ERROR", "migration readback or durable receipt was not verified");
  }
  // Keep this assignment explicit: it documents that the transaction consumed the final plan.
  plan = Object.freeze(plan);
  const safePlan = redactJson(plan) as MigrationPlan;
  return Object.freeze({
    committed: true,
    oldBundleHash: oldHash,
    newBundleHash: newHash,
    oldReleaseTag: input.historical.reference.releaseTag,
    newReleaseTag: proposedMarker.releaseTag,
    description: redact(mergedDescription),
    plan: safePlan,
    diff: Object.freeze(plan.diff.map((entry) => Object.freeze({
      ...entry,
      before: redact(entry.before),
      after: redact(entry.after),
    }))),
    conflicts: Object.freeze(plan.conflicts.map((entry) => entry.field)),
    missingFields: Object.freeze([...plan.missingFields]),
    backup: Object.freeze({
      markerDigest: sha256Utf8(canonicalizeJson(input.historical.marker as unknown as JsonValue)),
      bundleManifestHash: backup.bundleManifestHash,
    }),
    transaction,
  });
}

/** Alias used by application composition roots; calling it is always explicit. */
export const migrate = migrateTemplate;
