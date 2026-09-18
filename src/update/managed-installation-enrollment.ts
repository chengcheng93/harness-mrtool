import { types } from "node:util";
import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";

export const INSTALLATION_ENROLLMENT_NAME = ".harness-mrtool-managed.json" as const;
export const STATE_ENROLLMENT_NAME = "installation-owner.json" as const;
export const MAX_MANAGED_INSTALLATION_ENROLLMENT_BYTES = 16 * 1024;

export type ManagedInstallationEnrollmentPhase = "preparing" | "enrolled";
export type ManagedInstallationPlatform = "darwin-arm64" | "windows-x64";

export interface ManagedInstallationFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

export interface ManagedInstallationEnrollment {
  readonly enrollmentVersion: 1;
  readonly phase: ManagedInstallationEnrollmentPhase;
  readonly enrollmentId: string;
  readonly installationId: string;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly platform: ManagedInstallationPlatform;
  readonly trustConfigSha256: string;
  readonly roots: {
    readonly installation: ManagedInstallationFileIdentity;
    readonly state: ManagedInstallationFileIdentity;
  };
  /** Data-only locators. They are equality witnesses, never authority to open a path. */
  readonly locators: { readonly installation: string; readonly state: string };
  readonly bootstrapPolicy: { readonly generation: number; readonly digest: string };
}

const ENROLLMENT_FIELDS = ["enrollmentVersion", "phase", "enrollmentId", "installationId", "repository",
  "platform", "trustConfigSha256", "roots", "locators", "bootstrapPolicy"] as const;
const REPOSITORY_FIELDS = ["owner", "name"] as const;
const ROOTS_FIELDS = ["installation", "state"] as const;
const IDENTITY_FIELDS = ["dev", "ino"] as const;
const LOCATOR_FIELDS = ["installation", "state"] as const;
const POLICY_FIELDS = ["generation", "digest"] as const;
const ID = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/u;
const DECIMAL_UINT64 = /^[1-9][0-9]{0,19}$/u;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_LOCATOR_BYTES = 4_096;

function failure(): never {
  throw new ToolError("UPDATE_SECURITY_ERROR", "Managed installation enrollment is invalid", {
    field: "managedInstallationEnrollment",
    expected: "a bounded canonical enrollment witness",
    actual: "invalid or unsafe enrollment data",
    safeNextStep: "Preserve the installation evidence and run explicit repair.",
  });
}

function record<const K extends readonly string[]>(value: unknown, keys: K): Record<K[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) failure();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) failure();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) ||
        descriptor.get !== undefined || descriptor.set !== undefined) failure();
    result[key] = descriptor.value;
  }
  return result as Record<K[number], unknown>;
}

function id(value: unknown): string {
  return typeof value === "string" && ID.test(value) ? value : failure();
}

function sha256(value: unknown): string {
  return typeof value === "string" && SHA256.test(value) ? value : failure();
}

function decimalUint64(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL_UINT64.test(value)) failure();
  try {
    if (BigInt(value) > MAX_UINT64) failure();
  } catch {
    failure();
  }
  return value;
}

function locator(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_LOCATOR_BYTES ||
      value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) failure();
  return value;
}

function repository(value: unknown): { readonly owner: string; readonly name: string } {
  const item = record(value, REPOSITORY_FIELDS);
  if (typeof item.owner !== "string" || !REPOSITORY_PART.test(item.owner) ||
      typeof item.name !== "string" || !REPOSITORY_PART.test(item.name)) failure();
  return Object.freeze({ owner: item.owner, name: item.name });
}

function fileIdentity(value: unknown): ManagedInstallationFileIdentity {
  const item = record(value, IDENTITY_FIELDS);
  return Object.freeze({ dev: decimalUint64(item.dev), ino: decimalUint64(item.ino) });
}

function read(value: unknown): ManagedInstallationEnrollment {
  const item = record(value, ENROLLMENT_FIELDS);
  if (item.enrollmentVersion !== 1 || item.phase !== "preparing" && item.phase !== "enrolled") failure();
  const roots = record(item.roots, ROOTS_FIELDS);
  const locators = record(item.locators, LOCATOR_FIELDS);
  const policy = record(item.bootstrapPolicy, POLICY_FIELDS);
  if (typeof item.platform !== "string" || !(["darwin-arm64", "windows-x64"] as const).includes(item.platform as ManagedInstallationPlatform) ||
      typeof policy.generation !== "number" || !Number.isSafeInteger(policy.generation) || policy.generation < 1 ||
      typeof policy.digest !== "string") failure();
  return Object.freeze({
    enrollmentVersion: 1,
    phase: item.phase as ManagedInstallationEnrollmentPhase,
    enrollmentId: id(item.enrollmentId),
    installationId: id(item.installationId),
    repository: repository(item.repository),
    platform: item.platform as ManagedInstallationPlatform,
    trustConfigSha256: sha256(item.trustConfigSha256),
    roots: Object.freeze({ installation: fileIdentity(roots.installation), state: fileIdentity(roots.state) }),
    locators: Object.freeze({ installation: locator(locators.installation), state: locator(locators.state) }),
    bootstrapPolicy: Object.freeze({ generation: policy.generation, digest: sha256(policy.digest) }),
  });
}

function encodeChecked(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`${canonicalizeJson(read(value))}\n`);
  if (bytes.byteLength > MAX_MANAGED_INSTALLATION_ENROLLMENT_BYTES) failure();
  return bytes;
}

export function validateManagedInstallationEnrollment(value: unknown): ManagedInstallationEnrollment {
  try {
    const enrollment = read(value);
    encodeChecked(enrollment);
    return enrollment;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return failure();
  }
}

export function encodeManagedInstallationEnrollment(value: unknown): Uint8Array {
  try {
    return encodeChecked(value);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return failure();
  }
}

function ownedBytes(value: unknown): Uint8Array {
  if (value === null || typeof value !== "object" || types.isProxy(value) || !types.isUint8Array(value)) failure();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) failure();
  const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!.call(value);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_MANAGED_INSTALLATION_ENROLLMENT_BYTES) failure();
  const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!.call(value);
  if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) failure();
  if (Reflect.ownKeys(value).length !== byteLength) failure();
  for (let index = 0; index < byteLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) failure();
  }
  const copy = new Uint8Array(byteLength);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}

export function parseManagedInstallationEnrollment(bytes: Uint8Array): ManagedInstallationEnrollment {
  try {
    const owned = ownedBytes(bytes);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(owned);
    const value = read(parseStrictJson(text));
    if (text !== new TextDecoder().decode(encodeChecked(value))) failure();
    return value;
  } catch {
    return failure();
  }
}
