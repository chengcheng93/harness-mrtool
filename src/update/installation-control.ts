/**
 * Bounded, data-only control record for one enrolled managed installation.
 *
 * This codec carries no paths, tokens, business requests or mutation authority.
 * A native executor must still acquire the update lock and revalidate this
 * record against the current journal and policy before it can write anything.
 */
import { types } from "node:util";

import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";

export const MAX_INSTALLATION_CONTROL_BYTES = 16 * 1024;
export const MAX_QUEUED_INSTALLATION_OPERATIONS = 4;

const ID = /^[a-f0-9]{32}$/u;
const TRANSACTION = /^release-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_INTEGER = 1_000_000;
const MUTATION_SLOTS = new Set([
  "staged-executable", "staged-marker", "previous-executable", "previous-marker",
  "windows-inner-journal", "launch-descriptor", "canonical-executable", "canonical-marker",
  "active-pointer", "installation-journal", "installation-control", "retention-catalog",
]);

export interface InstallationControlRootIdentity {
  readonly dev: string;
  readonly ino: string;
}

export type InstallationControlOperationName = "apply" | "rollback" | "recover";
export type InstallationControlWorkerStatus = "scheduled" | "running" | "drained" | "revoked";
export type InstallationControlMutationSlot =
  | "staged-executable" | "staged-marker" | "previous-executable" | "previous-marker"
  | "windows-inner-journal" | "launch-descriptor" | "canonical-executable" | "canonical-marker"
  | "active-pointer" | "installation-journal" | "installation-control" | "retention-catalog";

export interface InstallationControlOperation {
  readonly workerId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly operation: InstallationControlOperationName;
  readonly tupleSha256: string;
  readonly admittedSlots: readonly InstallationControlMutationSlot[];
  readonly status: InstallationControlWorkerStatus;
}

export interface InstallationControl {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly enrollmentId: string;
  readonly authorityEpoch: number;
  readonly roots: { readonly installation: InstallationControlRootIdentity; readonly state: InstallationControlRootIdentity };
  readonly current: InstallationControlOperation | null;
  readonly queued: readonly InstallationControlOperation[];
}

function invalid(): never {
  throw new ToolError("UPDATE_SECURITY_ERROR", "installation control is invalid", {
    field: "installationControl",
    expected: "bounded canonical control state without paths or business payload",
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

function exactArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
  }
  if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) invalid();
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_INTEGER || Object.is(value, -0)) invalid();
  return value;
}

function text(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}

function operationName(value: unknown): InstallationControlOperationName {
  if (value !== "apply" && value !== "rollback" && value !== "recover") invalid();
  return value;
}

function rootIdentity(value: unknown): InstallationControlRootIdentity {
  const item = exactRecord(value, ["dev", "ino"]);
  const dev = text(item.dev, /^(?:0|[1-9][0-9]{0,19})$/u, 20);
  const ino = text(item.ino, /^[1-9][0-9]{0,19}$/u, 20);
  if (BigInt(dev) > 0xffffffffffffffffn || BigInt(ino) > 0xffffffffffffffffn) invalid();
  return Object.freeze({ dev, ino });
}

function roots(value: unknown): { readonly installation: InstallationControlRootIdentity; readonly state: InstallationControlRootIdentity } {
  const item = exactRecord(value, ["installation", "state"]);
  const installation = rootIdentity(item.installation);
  const state = rootIdentity(item.state);
  if (installation.dev === state.dev && installation.ino === state.ino) invalid();
  return Object.freeze({ installation, state });
}

function status(value: unknown): InstallationControlWorkerStatus {
  if (value !== "scheduled" && value !== "running" && value !== "drained" && value !== "revoked") invalid();
  return value;
}

function slots(value: unknown): readonly InstallationControlMutationSlot[] {
  const source = exactArray(value);
  if (source.length < 1 || source.length > MUTATION_SLOTS.size) invalid();
  const result: InstallationControlMutationSlot[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    if (typeof item !== "string" || !MUTATION_SLOTS.has(item) || seen.has(item)) invalid();
    seen.add(item);
    result.push(item as InstallationControlMutationSlot);
  }
  return Object.freeze(result);
}

function readOperation(value: unknown): InstallationControlOperation {
  const item = exactRecord(value, ["workerId", "operationId", "attemptId", "transactionId", "expectedRevision", "operation", "tupleSha256", "admittedSlots", "status"]);
  return Object.freeze({
    workerId: text(item.workerId, ID, 32),
    operationId: text(item.operationId, ID, 32),
    attemptId: text(item.attemptId, ID, 32),
    transactionId: text(item.transactionId, TRANSACTION, 40),
    expectedRevision: integer(item.expectedRevision),
    operation: operationName(item.operation),
    tupleSha256: text(item.tupleSha256, SHA256, 64),
    admittedSlots: slots(item.admittedSlots),
    status: status(item.status),
  });
}

function readControl(value: unknown): InstallationControl {
  const item = exactRecord(value, ["schemaVersion", "installationId", "enrollmentId", "authorityEpoch", "roots", "current", "queued"]);
  if (item.schemaVersion !== 1) invalid();
  const current = item.current === null ? null : readOperation(item.current);
  const queuedSource = exactArray(item.queued);
  if (queuedSource.length > MAX_QUEUED_INSTALLATION_OPERATIONS) invalid();
  const queued = Object.freeze(queuedSource.map((entry) => {
    const operation = readOperation(entry);
    if (operation.status !== "scheduled") invalid();
    return operation;
  }));
  const all = current === null ? queued : [current, ...queued];
  const workers = new Set<string>();
  const operations = new Set<string>();
  let running = 0;
  for (const operation of all) {
    if (workers.has(operation.workerId) || operations.has(operation.operationId)) invalid();
    workers.add(operation.workerId);
    operations.add(operation.operationId);
    if (operation.status === "running") running += 1;
  }
  if (running > 1) invalid();
  return Object.freeze({
    schemaVersion: 1,
    installationId: text(item.installationId, ID, 32),
    enrollmentId: text(item.enrollmentId, ID, 32),
    authorityEpoch: integer(item.authorityEpoch),
    roots: roots(item.roots),
    current,
    queued,
  });
}

function encodeChecked(value: unknown): Uint8Array {
  const checked = readControl(value);
  const bytes = new TextEncoder().encode(`${canonicalizeJson(checked)}\n`);
  if (bytes.byteLength > MAX_INSTALLATION_CONTROL_BYTES) invalid();
  return bytes;
}

export function validateInstallationControl(value: unknown): InstallationControl {
  try {
    return readControl(value);
  } catch {
    return invalid();
  }
}

export function encodeInstallationControl(value: unknown): Uint8Array {
  try {
    return encodeChecked(value);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return invalid();
  }
}

export function decodeInstallationControl(bytes: Uint8Array): InstallationControl {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_INSTALLATION_CONTROL_BYTES) invalid();
    const copy = Uint8Array.from(bytes);
    const value = readControl(parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy)));
    const canonical = encodeChecked(value);
    if (canonical.byteLength !== copy.byteLength || canonical.some((byte, index) => byte !== copy[index])) invalid();
    return value;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return invalid();
  }
}
