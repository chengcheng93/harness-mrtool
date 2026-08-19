import { createHash, createPublicKey } from "node:crypto";

import {
  createTrustState,
  updateSecurityError,
  type TrustedSigningKey,
} from "./envelope.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256Utf8,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";

const TEST_MARKER = /(?:^|[._-])(?:dev|development|example|fake|fixture|local|loopback|sample|test)(?:$|[._-])/iu;
const trustedConfigBrands = new WeakSet<object>();

export interface UpdateTrustConfig {
  readonly trustConfigVersion: 1;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
  };
  readonly pagesOrigin: string;
  readonly bootstrapKeys: readonly TrustedSigningKey[];
  readonly testOnly: boolean;
}

export interface TestOnlyUpdateTrustConfigInput {
  readonly repository: {
    readonly owner: string;
    readonly name: string;
  };
  readonly pagesOrigin: string;
  readonly bootstrapKeys: readonly TrustedSigningKey[];
}

export const PRODUCTION_UPDATE_REPOSITORY = Object.freeze({
  owner: "chengcheng93",
  name: "harness-mrtool",
});

export const PRODUCTION_UPDATE_PAGES_ORIGIN =
  "https://chengcheng93.github.io";

export const PRODUCTION_UPDATE_CHANNEL_URL =
  "https://chengcheng93.github.io/harness-mrtool/stable.envelope.json";

// A production root is added only by changing both reviewed source constants.
export const PRODUCTION_UPDATE_BOOTSTRAP_KEYS: readonly TrustedSigningKey[] =
  Object.freeze([]);
export const PRODUCTION_UPDATE_BOOTSTRAP_KEY_FINGERPRINTS: readonly string[] =
  Object.freeze([]);

const REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;

function configurationError(): never {
  throw updateSecurityError("trusted key state is invalid");
}

function copiedJson(value: unknown): JsonValue {
  try {
    return copyJsonValue(value);
  } catch {
    return configurationError();
  }
}

function exactRecord(value: JsonValue, fields: readonly string[]): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return configurationError();
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length ||
      actual.some((field, index) => field !== expected[index])) {
    return configurationError();
  }
  return value;
}

function normalizedRepository(value: JsonValue): UpdateTrustConfig["repository"] {
  const repository = exactRecord(value, ["owner", "name"]);
  if (
    typeof repository.owner !== "string" ||
    typeof repository.name !== "string" ||
    !REPOSITORY_PART.test(repository.owner) ||
    !REPOSITORY_PART.test(repository.name)
  ) {
    return configurationError();
  }
  return Object.freeze({ owner: repository.owner, name: repository.name });
}

function normalizedBootstrapKeys(
  value: JsonValue,
  allowTestMarkers: boolean,
): readonly TrustedSigningKey[] {
  if (!Array.isArray(value)) return configurationError();
  let keys: readonly TrustedSigningKey[];
  try {
    keys = createTrustState(value as unknown as readonly TrustedSigningKey[]).bootstrapKeys;
  } catch {
    return configurationError();
  }
  if (keys.some((key) =>
    key.activeFromSequence !== 1 ||
    key.revokedAtSequence !== null ||
    (!allowTestMarkers && TEST_MARKER.test(key.keyId))
  )) {
    return configurationError();
  }
  for (const key of keys) canonicalSpkiSha256(key);
  return keys;
}

function canonicalSpkiSha256(key: TrustedSigningKey): string {
  try {
    const supplied = Buffer.from(key.publicKeySpki, "base64url");
    const parsed = createPublicKey({ key: supplied, format: "der", type: "spki" });
    const exported = parsed.export({ format: "der", type: "spki" });
    if (!(exported instanceof Buffer) || !exported.equals(supplied)) {
      return configurationError();
    }
    return createHash("sha256").update(exported).digest("hex");
  } catch {
    return configurationError();
  }
}

function productionBootstrapKeys(): readonly TrustedSigningKey[] {
  const keys = normalizedBootstrapKeys(
    copiedJson(PRODUCTION_UPDATE_BOOTSTRAP_KEYS),
    false,
  );
  if (
    keys.length === 0 ||
    keys.length !== PRODUCTION_UPDATE_BOOTSTRAP_KEY_FINGERPRINTS.length ||
    keys.some((key, index) =>
      canonicalSpkiSha256(key) !== PRODUCTION_UPDATE_BOOTSTRAP_KEY_FINGERPRINTS[index])
  ) {
    return configurationError();
  }
  return keys;
}

function isCanonicalLoopbackOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "http:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname !== "localhost" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535 &&
      String(port) === parsed.port &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === value;
  } catch {
    return false;
  }
}

function frozenConfig(
  repository: UpdateTrustConfig["repository"],
  pagesOrigin: string,
  bootstrapKeys: readonly TrustedSigningKey[],
  testOnly: boolean,
): UpdateTrustConfig {
  const config = Object.freeze({
    trustConfigVersion: 1 as const,
    repository,
    pagesOrigin,
    bootstrapKeys,
    testOnly,
  });
  trustedConfigBrands.add(config);
  return config;
}

function requireTrustedConfig(value: UpdateTrustConfig): UpdateTrustConfig {
  if (!trustedConfigBrands.has(value as object)) return configurationError();
  return value;
}

export function createProductionUpdateTrustConfig(): UpdateTrustConfig {
  if (arguments.length !== 0) return configurationError();
  return frozenConfig(
    PRODUCTION_UPDATE_REPOSITORY,
    PRODUCTION_UPDATE_PAGES_ORIGIN,
    productionBootstrapKeys(),
    false,
  );
}

export function parseProductionUpdateTrustConfig(value: unknown): UpdateTrustConfig {
  const config = exactRecord(
    copiedJson(value),
    ["trustConfigVersion", "repository", "pagesOrigin", "bootstrapKeys", "testOnly"],
  );
  const repository = normalizedRepository(config.repository!);
  if (
    config.trustConfigVersion !== 1 ||
    repository.owner !== PRODUCTION_UPDATE_REPOSITORY.owner ||
    repository.name !== PRODUCTION_UPDATE_REPOSITORY.name ||
    config.pagesOrigin !== PRODUCTION_UPDATE_PAGES_ORIGIN ||
    config.testOnly !== false
  ) {
    return configurationError();
  }
  const expectedKeys = productionBootstrapKeys();
  const suppliedKeys = normalizedBootstrapKeys(config.bootstrapKeys!, false);
  if (canonicalizeJson(suppliedKeys) !== canonicalizeJson(expectedKeys)) {
    return configurationError();
  }
  return frozenConfig(
    PRODUCTION_UPDATE_REPOSITORY,
    PRODUCTION_UPDATE_PAGES_ORIGIN,
    expectedKeys,
    false,
  );
}

export function createTestOnlyUpdateTrustConfig(
  input: TestOnlyUpdateTrustConfigInput,
): UpdateTrustConfig {
  const value = exactRecord(
    copiedJson(input),
    ["repository", "pagesOrigin", "bootstrapKeys"],
  );
  if (typeof value.pagesOrigin !== "string" ||
      !isCanonicalLoopbackOrigin(value.pagesOrigin)) {
    return configurationError();
  }
  return frozenConfig(
    normalizedRepository(value.repository!),
    value.pagesOrigin,
    normalizedBootstrapKeys(value.bootstrapKeys!, true),
    true,
  );
}

export function parseTestOnlyUpdateTrustConfig(value: unknown): UpdateTrustConfig {
  const config = exactRecord(
    copiedJson(value),
    ["trustConfigVersion", "repository", "pagesOrigin", "bootstrapKeys", "testOnly"],
  );
  if (
    config.trustConfigVersion !== 1 ||
    config.testOnly !== true ||
    typeof config.pagesOrigin !== "string" ||
    !isCanonicalLoopbackOrigin(config.pagesOrigin)
  ) {
    return configurationError();
  }
  return frozenConfig(
    normalizedRepository(config.repository!),
    config.pagesOrigin,
    normalizedBootstrapKeys(config.bootstrapKeys!, true),
    true,
  );
}

export function canonicalUpdateTrustConfigJson(config: UpdateTrustConfig): string {
  return canonicalizeJson(requireTrustedConfig(config));
}

export function canonicalUpdateTrustConfigBytes(config: UpdateTrustConfig): Uint8Array {
  return new TextEncoder().encode(canonicalUpdateTrustConfigJson(config));
}

export function updateTrustConfigSha256(config: UpdateTrustConfig): string {
  return sha256Utf8(canonicalUpdateTrustConfigJson(config));
}

export function stableChannelEnvelopeUrl(
  config: UpdateTrustConfig,
): string {
  const trusted = requireTrustedConfig(config);
  const url = `${trusted.pagesOrigin}/${trusted.repository.name}/stable.envelope.json`;
  if (!trusted.testOnly && url !== PRODUCTION_UPDATE_CHANNEL_URL) {
    return configurationError();
  }
  return url;
}
