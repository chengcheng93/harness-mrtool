/**
 * Bounded, path-free intent for one Windows managed publication.
 *
 * This record is data only. It does not grant mutation authority, carry a
 * path, or contain executable/business payload. A native coordinator must
 * revalidate it against the outer installation journal, control record, and
 * current authenticated candidate while holding the installation lease.
 */
import { types } from "node:util";

import { canonicalizeJson } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import { parseStrictJson } from "../input/strict-json.ts";

export const MAX_WINDOWS_MUTATION_PLAN_BYTES = 16 * 1024;

const ID = /^[a-f0-9]{32}$/u;
const TRANSACTION = /^release-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_REVISION = 1_000_000;

export interface WindowsMutationFileEvidence {
  readonly executableSha256: string;
  readonly executableSize: number;
  readonly markerSha256: string;
  readonly markerSize: number;
}

export interface WindowsMutationPlan {
  readonly schemaVersion: 1;
  readonly operation: "apply" | "rollback";
  readonly installationId: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly transactionId: string;
  readonly journalRevision: number;
  readonly authorityEpoch: number;
  readonly previous: WindowsMutationFileEvidence;
  readonly next: WindowsMutationFileEvidence;
}

function invalid(): never {
  throw new ToolError("UPDATE_SECURITY_ERROR", "windows mutation plan is invalid", {
    field: "windowsMutationPlan",
    expected: "bounded canonical path-free Windows publication intent",
    actual: "invalid",
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum || Object.is(value, -0)) invalid();
  return value;
}

function text(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}

function evidence(value: unknown): WindowsMutationFileEvidence {
  const item = exactRecord(value, ["executableSha256", "executableSize", "markerSha256", "markerSize"]);
  return Object.freeze({
    executableSha256: text(item.executableSha256, SHA256, 64),
    executableSize: integer(item.executableSize, MAX_FILE_BYTES),
    markerSha256: text(item.markerSha256, SHA256, 64),
    markerSize: integer(item.markerSize, 8 * 1024),
  });
}

function validate(value: unknown): WindowsMutationPlan {
  const item = exactRecord(value, [
    "schemaVersion", "operation", "installationId", "enrollmentId", "attemptId", "transactionId",
    "journalRevision", "authorityEpoch", "previous", "next",
  ]);
  if (item.schemaVersion !== 1 || (item.operation !== "apply" && item.operation !== "rollback")) invalid();
  return Object.freeze({
    schemaVersion: 1,
    operation: item.operation,
    installationId: text(item.installationId, ID, 32),
    enrollmentId: text(item.enrollmentId, ID, 32),
    attemptId: text(item.attemptId, ID, 32),
    transactionId: text(item.transactionId, TRANSACTION, 40),
    journalRevision: integer(item.journalRevision, MAX_REVISION),
    authorityEpoch: integer(item.authorityEpoch, MAX_REVISION),
    previous: evidence(item.previous),
    next: evidence(item.next),
  });
}

export function encodeWindowsMutationPlan(value: WindowsMutationPlan): Uint8Array {
  try {
    const checked = validate(value);
    const bytes = new TextEncoder().encode(`${canonicalizeJson(checked)}\n`);
    if (bytes.byteLength > MAX_WINDOWS_MUTATION_PLAN_BYTES) invalid();
    return Uint8Array.from(bytes);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    invalid();
  }
}

export function decodeWindowsMutationPlan(bytes: Uint8Array): WindowsMutationPlan {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_WINDOWS_MUTATION_PLAN_BYTES) invalid();
    const copy = Uint8Array.from(bytes);
    const value = validate(parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy)));
    const canonical = encodeWindowsMutationPlan(value);
    if (canonical.byteLength !== copy.byteLength || canonical.some((byte, index) => byte !== copy[index])) invalid();
    return value;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    invalid();
  }
}
