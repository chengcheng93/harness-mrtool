import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { SemVer } from "semver";

import { isToolError, ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import { parseStrictYaml } from "../input/strict-yaml.ts";
import {
  TEMPLATE_BUNDLE_PAYLOAD_PATHS,
  type TemplateBundleManifest,
  type TemplateBundlePayloadPath,
} from "./types.ts";
import { validateTemplateBundle } from "./validate.ts";

export const MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024;
export const MAX_BUNDLE_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_TOTAL_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const REQUIRED_H2_HEADINGS = [
  "## 1. Changes",
  "## 2. Motivation",
  "## 3. Related Issue / Work Item",
  "## 4. Impact Scope",
  "## 5. Verification",
  "## 6. Documentation",
  "## 7. Risks and Rollback",
  "## 8. Review / CI Checklist",
] as const;

export interface BundleFileMetadata {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface TemplateBundleFileHandle {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  stat(): Promise<BundleFileMetadata>;
}

export interface TemplateBundleIo {
  openFile(path: string): Promise<TemplateBundleFileHandle>;
  listDirectory(path: string): Promise<readonly string[]>;
  lstat(path: string): Promise<BundleFileMetadata>;
  realpath(path: string): Promise<string>;
}

export const nodeTemplateBundleIo: TemplateBundleIo = {
  openFile: async (path) => {
    const handle = await open(path, "r");
    return {
      close: () => handle.close(),
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      stat: () => handle.stat({ bigint: true }) as Promise<BigIntStats>,
    };
  },
  listDirectory: (path) => readdir(path),
  lstat: (path) => lstat(path, { bigint: true }) as Promise<BigIntStats>,
  realpath,
};

export interface LoadedTemplateBundle {
  readonly manifest: TemplateBundleManifest;
  readonly layout: {
    readonly markdown: string;
    readonly h2Headings: readonly string[];
  };
  readonly schema: JsonValue;
  readonly policy: JsonObject;
  readonly registries: {
    readonly checkboxes: JsonObject;
    readonly fields: JsonObject;
  };
  readonly profiles: Readonly<Record<"code" | "docs" | "general" | "ops", JsonObject>>;
}

const MANIFEST_PATH = "bundle-manifest.json";
const EXPECTED_DIRECTORIES = new Set(["profiles", "registries"]);
const EXPECTED_FILES = new Set<string>([
  MANIFEST_PATH,
  ...TEMPLATE_BUNDLE_PAYLOAD_PATHS,
]);
const MANIFEST_FIELDS = new Set([
  "manifestVersion",
  "bundleId",
  "version",
  "inputSchema",
  "policySchema",
  "files",
]);
const MANIFEST_FILE_FIELDS = new Set(["path", "size", "sha256"]);
const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const BUNDLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUEST_SCHEMA_V1_BYTES_SHA256 =
  "b1b8fd17c81119946abae5c4c30ed7b6b64fca9b72a8bbc939628294ba300e0e";

function templateError(
  reason: string,
  field: string | null = null,
): ToolError<"TEMPLATE_ERROR"> {
  return new ToolError("TEMPLATE_ERROR", `Invalid template bundle: ${reason}`, {
    field,
    expected: "a verified HMR template bundle",
    actual: reason,
    safeNextStep: "Restore or refresh the complete verified template bundle.",
  });
}

function asRecord(value: JsonValue, subject: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw templateError(`${subject} must be an object`, subject);
  }
  return value;
}

function assertExactFields(
  value: JsonObject,
  fields: ReadonlySet<string>,
  subject: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw templateError(`${subject} has missing or unknown fields`, subject);
  }
}

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw templateError(`${subject} must not contain a UTF-8 BOM`, subject);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw templateError(`${subject} is not valid UTF-8`, subject);
  }
}

function parseBundleJson(bytes: Uint8Array, subject: string): JsonValue {
  try {
    return parseStrictJson(decodeUtf8(bytes, subject));
  } catch (error) {
    if (isToolError(error, "TEMPLATE_ERROR")) {
      throw error;
    }
    throw templateError(`${subject} is not strict JSON`, subject);
  }
}

function parseBundleYaml(bytes: Uint8Array, subject: string): JsonObject {
  try {
    return asRecord(parseStrictYaml(decodeUtf8(bytes, subject)), subject);
  } catch (error) {
    if (isToolError(error, "TEMPLATE_ERROR")) {
      throw error;
    }
    throw templateError(`${subject} is not strict YAML`, subject);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function assertPlainPath(
  root: string,
  path: string,
  expectedKind: "file" | "directory",
  io: TemplateBundleIo,
): Promise<BundleFileMetadata> {
  let metadata: BundleFileMetadata;
  let canonicalPath: string;
  try {
    [metadata, canonicalPath] = await Promise.all([io.lstat(path), io.realpath(path)]);
  } catch {
    throw templateError("bundle file set is missing an expected entry");
  }
  if (metadata.isSymbolicLink() || !samePath(canonicalPath, path)) {
    throw templateError("bundle contains a symbolic link, reparse point, or path escape");
  }
  if (
    (expectedKind === "file" && !metadata.isFile()) ||
    (expectedKind === "directory" && !metadata.isDirectory())
  ) {
    throw templateError(`bundle ${expectedKind} entry is not a regular ${expectedKind}`);
  }
  return metadata;
}

async function scanExactFileSet(
  root: string,
  io: TemplateBundleIo,
): Promise<Map<string, BundleFileMetadata>> {
  const entries = new Map<string, BundleFileMetadata>();
  const visit = async (directory: string): Promise<void> => {
    let names: readonly string[];
    try {
      names = await io.listDirectory(directory);
    } catch {
      throw templateError("bundle file set cannot be enumerated");
    }
    for (const name of [...names].sort()) {
      if (
        typeof name !== "string" ||
        name === "" ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\")
      ) {
        throw templateError("bundle file set contains an invalid entry name");
      }
      const path = resolve(directory, name);
      const relativePath = portableRelative(root, path);
      const isExpectedDirectory = EXPECTED_DIRECTORIES.has(relativePath);
      const isExpectedFile = EXPECTED_FILES.has(relativePath);
      if (!isExpectedDirectory && !isExpectedFile) {
        throw templateError("bundle file set contains an unknown entry");
      }
      const metadata = await assertPlainPath(
        root,
        path,
        isExpectedDirectory ? "directory" : "file",
        io,
      );
      if (isExpectedDirectory) {
        await visit(path);
      } else {
        entries.set(relativePath, metadata);
      }
    }
  };
  await visit(root);
  if (
    entries.size !== EXPECTED_FILES.size ||
    [...EXPECTED_FILES].some((path) => !entries.has(path))
  ) {
    throw templateError("bundle file set is missing an expected payload");
  }
  return entries;
}

function validateManifest(value: JsonValue, serialized: string): TemplateBundleManifest {
  const record = asRecord(value, "bundle-manifest.json");
  assertExactFields(record, MANIFEST_FIELDS, "bundle-manifest.json");
  if (serialized !== `${canonicalizeJson(record)}\n`) {
    throw templateError("bundle manifest must use canonical JSON and one LF");
  }
  if (record.manifestVersion !== 1) {
    throw templateError("bundle manifest version must be 1", "manifestVersion");
  }
  if (typeof record.bundleId !== "string" || !BUNDLE_ID.test(record.bundleId)) {
    throw templateError("bundleId is invalid", "bundleId");
  }
  let strictVersion: string | null = null;
  if (typeof record.version === "string") {
    try {
      const parsedVersion = new SemVer(record.version, { loose: false });
      strictVersion = `${parsedVersion.version}${
        parsedVersion.build.length === 0 ? "" : `+${parsedVersion.build.join(".")}`
      }`;
    } catch {
      strictVersion = null;
    }
  }
  if (strictVersion === null || strictVersion !== record.version) {
    throw templateError("bundle version must be strict SemVer", "version");
  }
  for (const field of ["inputSchema", "policySchema"] as const) {
    const fieldValue = record[field];
    if (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 1) {
      throw templateError(`${field} must be a positive integer`, field);
    }
  }
  if (!Array.isArray(record.files) || record.files.length !== TEMPLATE_BUNDLE_PAYLOAD_PATHS.length) {
    throw templateError("manifest files must contain the exact payload allowlist", "files");
  }
  let totalSize = 0;
  const files = record.files.map((entry, index) => {
    const file = asRecord(entry, `files[${String(index)}]`);
    assertExactFields(file, MANIFEST_FILE_FIELDS, `files[${String(index)}]`);
    const expectedPath = TEMPLATE_BUNDLE_PAYLOAD_PATHS[index];
    if (file.path !== expectedPath) {
      throw templateError("manifest file paths must match the sorted payload allowlist", "files");
    }
    if (
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 1 ||
      (file.size as number) > MAX_BUNDLE_PAYLOAD_BYTES
    ) {
      throw templateError("manifest payload size is invalid", "files");
    }
    totalSize += file.size as number;
    if (totalSize > MAX_BUNDLE_TOTAL_PAYLOAD_BYTES) {
      throw templateError("manifest total payload size exceeds the bundle limit", "files");
    }
    if (typeof file.sha256 !== "string" || !LOWER_SHA256.test(file.sha256)) {
      throw templateError("manifest SHA-256 must be lowercase hexadecimal", "files");
    }
    return {
      path: file.path as TemplateBundlePayloadPath,
      size: file.size as number,
      sha256: file.sha256,
    };
  });
  return {
    manifestVersion: 1,
    bundleId: record.bundleId,
    version: record.version,
    inputSchema: record.inputSchema as number,
    policySchema: record.policySchema as number,
    files,
  };
}

async function readBounded(
  root: string,
  relativePath: string,
  expectedMetadata: BundleFileMetadata,
  limit: number,
  io: TemplateBundleIo,
): Promise<Uint8Array> {
  const expectedSize = Number(expectedMetadata.size);
  if (
    expectedMetadata.size < 1n ||
    expectedMetadata.size > BigInt(limit) ||
    !Number.isSafeInteger(expectedSize)
  ) {
    throw templateError("bundle file exceeds its size limit");
  }
  let handle: TemplateBundleFileHandle;
  try {
    handle = await io.openFile(resolve(root, relativePath));
  } catch {
    throw templateError("bundle file could not be read");
  }
  let bytes: Uint8Array | undefined;
  let failure: unknown;
  try {
    const before = await handle.stat();
    assertSameRegularFile(expectedMetadata, before);
    bytes = new Uint8Array(expectedSize);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 ||
          result.bytesRead > bytes.byteLength - offset) {
        throw templateError("bundle reader returned an invalid byte count");
      }
      if (result.bytesRead === 0) {
        throw templateError("bundle file size changed while loading");
      }
      offset += result.bytesRead;
    }
    const probe = new Uint8Array(1);
    const extra = await handle.read(probe, 0, 1, offset);
    if (extra.bytesRead !== 0) {
      throw templateError("bundle file size changed while loading");
    }
    assertSameRegularFile(expectedMetadata, await handle.stat());
  } catch (error) {
    failure = isToolError(error, "TEMPLATE_ERROR")
      ? error
      : templateError("bundle file could not be read safely");
  }
  try {
    await handle.close();
  } catch {
    failure ??= templateError("bundle file handle could not be closed safely");
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (bytes === undefined) {
    throw templateError("bundle file could not be read safely");
  }
  return bytes;
}

function assertSameRegularFile(
  expected: BundleFileMetadata,
  actual: BundleFileMetadata,
): void {
  if (
    !actual.isFile() ||
    actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size
  ) {
    throw templateError("bundle file changed identity while loading");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadVerifiedBundle(
  bundleDirectory: string,
  io: TemplateBundleIo,
): Promise<LoadedTemplateBundle> {
  if (typeof bundleDirectory !== "string" || bundleDirectory.trim() === "") {
    throw templateError("bundle directory must be a non-empty path");
  }
  const root = resolve(bundleDirectory);
  await assertPlainPath(root, root, "directory", io);
  const metadata = await scanExactFileSet(root, io);
  const manifestMetadata = metadata.get(MANIFEST_PATH);
  if (manifestMetadata === undefined) {
    throw templateError("bundle manifest is missing");
  }
  const manifestBytes = await readBounded(
    root,
    MANIFEST_PATH,
    manifestMetadata,
    MAX_BUNDLE_MANIFEST_BYTES,
    io,
  );
  const manifestText = decodeUtf8(manifestBytes, MANIFEST_PATH);
  const manifest = validateManifest(
    parseBundleJson(manifestBytes, MANIFEST_PATH),
    manifestText,
  );

  const payloadBytes = new Map<TemplateBundlePayloadPath, Uint8Array>();
  for (const file of manifest.files) {
    const fileMetadata = metadata.get(file.path);
    if (fileMetadata === undefined) {
      throw templateError("bundle payload is missing");
    }
    const bytes = await readBounded(
      root,
      file.path,
      fileMetadata,
      MAX_BUNDLE_PAYLOAD_BYTES,
      io,
    );
    if (bytes.byteLength !== file.size) {
      throw templateError("bundle payload size does not match the manifest");
    }
    if (sha256(bytes) !== file.sha256) {
      throw templateError("bundle payload hash does not match the manifest");
    }
    payloadBytes.set(file.path, bytes);
  }

  // A second metadata-only scan catches additions and path swaps during loading.
  await scanExactFileSet(root, io);

  const payload = (path: TemplateBundlePayloadPath): Uint8Array => {
    const bytes = payloadBytes.get(path);
    if (bytes === undefined) {
      throw templateError("verified payload snapshot is incomplete");
    }
    return bytes;
  };
  const markdown = decodeUtf8(payload("layout.md"), "layout.md");
  const schemaBytes = payload("schema.json");
  if (sha256(schemaBytes) !== REQUEST_SCHEMA_V1_BYTES_SHA256) {
    throw templateError("request schema payload does not match the exact V1 byte contract");
  }
  const schema = parseBundleJson(schemaBytes, "schema.json");
  const policy = parseBundleYaml(payload("policy.yml"), "policy.yml");
  const checkboxes = asRecord(
    parseBundleJson(payload("registries/checkboxes.json"), "registries/checkboxes.json"),
    "registries/checkboxes.json",
  );
  const fields = asRecord(
    parseBundleJson(payload("registries/fields.json"), "registries/fields.json"),
    "registries/fields.json",
  );
  const profiles = {
    code: parseBundleYaml(payload("profiles/code.yml"), "profiles/code.yml"),
    docs: parseBundleYaml(payload("profiles/docs.yml"), "profiles/docs.yml"),
    general: parseBundleYaml(payload("profiles/general.yml"), "profiles/general.yml"),
    ops: parseBundleYaml(payload("profiles/ops.yml"), "profiles/ops.yml"),
  };

  const loaded = {
    manifest: copyJsonValue(manifest) as unknown as TemplateBundleManifest,
    layout: {
      markdown,
      h2Headings: markdown.match(/^## .+$/gm) ?? [],
    },
    schema,
    policy,
    registries: { checkboxes, fields },
    profiles,
  };
  validateTemplateBundle(loaded);
  return deepFreeze(loaded);
}

export async function loadTemplateBundle(
  bundleDirectory: string,
  io: TemplateBundleIo = nodeTemplateBundleIo,
): Promise<LoadedTemplateBundle> {
  try {
    return await loadVerifiedBundle(bundleDirectory, io);
  } catch (error) {
    if (isToolError(error, "TEMPLATE_ERROR")) {
      throw error;
    }
    throw templateError("bundle loading failed safely");
  }
}
