import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

function invalidJson(path: string, reason: string): never {
  throw new TypeError(`Value must be valid JSON at ${path}: ${reason}`);
}

function assertWellFormedUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        invalidJson(path, "string contains a lone high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalidJson(path, "string contains a lone low surrogate");
    }
  }
}

function childPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

export function copyJsonValue(
  value: unknown,
  path = "$",
  ancestors: ReadonlySet<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalidJson(path, "number must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    invalidJson(path, `${typeof value} is not a JSON value`);
  }
  if (ancestors.has(value)) {
    invalidJson(path, "circular reference detected");
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    return copyJsonArray(value, path, nextAncestors);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidJson(path, "object must have Object.prototype or null prototype");
  }
  return copyJsonObject(value, path, nextAncestors);
}

function copyJsonArray(
  value: unknown[],
  path: string,
  ancestors: ReadonlySet<object>,
): JsonValue[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalidJson(path, "symbol keys are not permitted");
  }

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if ("get" in descriptor || "set" in descriptor) {
      invalidJson(childPath(path, key), "accessor properties are not permitted");
    }
    if (key === "length") {
      continue;
    }
    const index = Number(key);
    const isElement =
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < value.length &&
      String(index) === key;
    if (!isElement) {
      invalidJson(childPath(path, key), "extra array properties are not permitted");
    }
  }

  const copy: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined) {
      invalidJson(`${path}[${index}]`, "sparse arrays are not permitted");
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalidJson(`${path}[${index}]`, "array elements must be enumerable data properties");
    }
    copy.push(copyJsonValue(descriptor.value, `${path}[${index}]`, ancestors));
  }
  return copy;
}

function copyJsonObject(
  value: object,
  path: string,
  ancestors: ReadonlySet<object>,
): JsonObject {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalidJson(path, "symbol keys are not permitted");
  }

  const copy: Record<string, JsonValue> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    assertWellFormedUnicode(key, childPath(path, key));
    if ("get" in descriptor || "set" in descriptor) {
      invalidJson(childPath(path, key), "accessor properties are not permitted");
    }
    if (!descriptor.enumerable) {
      continue;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: copyJsonValue(descriptor.value, childPath(path, key), ancestors),
      writable: true,
    });
  }
  return copy;
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(copyJsonValue(value));
}

export function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Utf8(canonicalizeJson(value));
}
