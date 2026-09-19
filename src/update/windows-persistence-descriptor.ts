import { types } from "node:util";

import { canonicalizeJson } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import { parseStrictJson } from "../input/strict-json.ts";

const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const ID = /^[a-f0-9]{32}$/u;
const TRANSACTION = /^release-[a-f0-9]{32}$/u;
const START_KEY = /^win:[1-9][0-9]{0,19}$/u;

export interface WindowsPersistenceParent {
  readonly pid: number;
  readonly startKey: string;
  readonly launchNonce: string;
}

export interface WindowsPersistenceDescriptor {
  readonly schemaVersion: 1;
  readonly launchId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly parent: WindowsPersistenceParent;
}

function invalid(): never {
  throw new ToolError("UPDATE_SECURITY_ERROR", "installation journal is invalid", {
    field: "windowsPersistenceDescriptor",
    expected: "bounded canonical launch evidence without paths or business payload",
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

function validate(value: unknown): WindowsPersistenceDescriptor {
  const item = exactRecord(value, ["schemaVersion", "launchId", "reservationId", "attemptId", "transactionId", "expectedRevision", "parent"]);
  if (item.schemaVersion !== 1) invalid();
  const parent = exactRecord(item.parent, ["pid", "startKey", "launchNonce"]);
  const result: WindowsPersistenceDescriptor = Object.freeze({
    schemaVersion: 1,
    launchId: text(item.launchId, ID, 32),
    reservationId: text(item.reservationId, ID, 32),
    attemptId: text(item.attemptId, ID, 32),
    transactionId: text(item.transactionId, TRANSACTION, 40),
    expectedRevision: integer(item.expectedRevision, 1_000_000),
    parent: Object.freeze({
      pid: integer(parent.pid, 0xffffffff),
      startKey: text(parent.startKey, START_KEY, 24),
      launchNonce: text(parent.launchNonce, ID, 32),
    }),
  });
  return result;
}

export function encodeWindowsPersistenceDescriptor(value: WindowsPersistenceDescriptor): Uint8Array {
  try {
    const checked = validate(value);
    const bytes = new TextEncoder().encode(`${canonicalizeJson(checked)}\n`);
    if (bytes.byteLength > MAX_DESCRIPTOR_BYTES) invalid();
    return Uint8Array.from(bytes);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    invalid();
  }
}

export function decodeWindowsPersistenceDescriptor(bytes: Uint8Array): WindowsPersistenceDescriptor {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_DESCRIPTOR_BYTES) invalid();
    const copy = Uint8Array.from(bytes);
    const value = validate(parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy)));
    const canonical = encodeWindowsPersistenceDescriptor(value);
    if (canonical.byteLength !== copy.byteLength || canonical.some((byte, index) => byte !== copy[index])) invalid();
    return value;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    invalid();
  }
}
