import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { validRange } from "semver";
import { isToolError } from "../contracts/errors.ts";
import { canonicalizeJson, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import { MAX_ARCHIVE_ENTRIES, validateArchiveEntries } from "../update/download.ts";
import { createTrustState, requireCanonicalSemVer, signingKeyIsActive, updateSecurityError, verifySignedEnvelope } from "../update/envelope.ts";
import { createProductionUpdateTrustConfig, updateTrustConfigSha256, type UpdateTrustConfig } from "../update/trust-config.ts";

export const MAX_SKILL_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_MANIFEST_BYTES = 64 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 128;
const MANIFEST = ".harness-skill-manifest.json";
const SHA256 = /^[a-f0-9]{64}$/u;
// Preserve BOMs: canonical JSON/path checks must validate bytes, not normalized text.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface SkillPublicationFile { readonly path: string; readonly sha256: string; readonly size: number }
export interface SkillPublicationReceipt {
  readonly receiptType: "skill-bundle";
  readonly receiptVersion: 1;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly releaseTag: string;
  readonly version: string;
  readonly signingKeyId: string;
  readonly signingSequence: number;
  readonly asset: { readonly name: "harness-mr-skill.zip"; readonly sha256: string; readonly size: number };
  readonly skillProtocol: number;
  readonly cliVersionRange: string;
  readonly treeSha256: string;
  readonly files: readonly SkillPublicationFile[];
}
export interface SkillPublicationReceiptOptions {
  readonly envelope: string | Uint8Array;
  readonly archiveBytes: Uint8Array;
  readonly expectedTag: string;
  readonly expectedVersion: string;
  /** Explicit branded in-process seam only; never read roots from flags or environment. */
  readonly trustConfig?: UpdateTrustConfig;
}
export interface VerifiedSkillPublicationReceipt {
  readonly purpose: "skill-publication-only";
  readonly receipt: SkillPublicationReceipt;
  readonly payloadSha256: string;
  readonly signingKeyId: string;
  /** Defensive snapshots of authenticated payload files, excluding the packed manifest. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}
function fail(): never { throw updateSecurityError("envelope is invalid"); }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function exact(value: JsonValue | undefined, fields: readonly string[]): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) fail();
  return value;
}
function integer(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}
function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function pathName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9._/-]+$/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.endsWith(".") &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part));
}
function canonicalJson(bytes: Uint8Array): JsonValue {
  const text = decoder.decode(bytes), parsed = parseStrictJson(text);
  if (text !== `${canonicalizeJson(parsed)}\n`) fail();
  return parsed;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function parseReceipt(bytes: Uint8Array): SkillPublicationReceipt {
  const p = exact(canonicalJson(bytes), ["asset", "cliVersionRange", "files", "receiptType", "receiptVersion", "releaseTag",
    "repository", "signingKeyId", "signingSequence", "skillProtocol", "treeSha256", "version"]);
  const repository = exact(p.repository, ["owner", "name"]), asset = exact(p.asset, ["name", "sha256", "size"]);
  if (p.receiptType !== "skill-bundle" || p.receiptVersion !== 1 || typeof p.signingKeyId !== "string" ||
      !integer(p.signingSequence, Number.MAX_SAFE_INTEGER) || !integer(p.skillProtocol, Number.MAX_SAFE_INTEGER) ||
      typeof p.cliVersionRange !== "string" || p.cliVersionRange.trim() === "" || p.cliVersionRange.length > 1024 ||
      validRange(p.cliVersionRange, { loose: false }) === null || !sha(p.treeSha256) ||
      typeof repository.owner !== "string" || typeof repository.name !== "string" ||
      asset.name !== "harness-mr-skill.zip" || !sha(asset.sha256) || !integer(asset.size, MAX_SKILL_ARCHIVE_BYTES) ||
      !Array.isArray(p.files) || p.files.length === 0 || p.files.length > MAX_FILES) fail();
  const version = requireCanonicalSemVer(p.version);
  if (p.releaseTag !== `skill-v${version}`) fail();
  let previous = "", total = 0;
  for (const value of p.files) {
    const file = exact(value, ["path", "sha256", "size"]);
    if (!pathName(file.path) || file.path.toLowerCase() === MANIFEST || file.path <= previous ||
        !sha(file.sha256) || !integer(file.size, MAX_SKILL_FILE_BYTES)) fail();
    previous = file.path;
    total += file.size;
  }
  if (!p.files.some((file) => (file as JsonObject).path === "SKILL.md") ||
      total > MAX_SKILL_TOTAL_BYTES || hash(new TextEncoder().encode(`${canonicalizeJson(p.files)}\n`)) !== p.treeSha256) fail();
  validateArchiveEntries([...p.files.map((file) => ({ name: (file as JsonObject).path as string, kind: "file" as const })),
    { name: MANIFEST, kind: "file" }]);
  return freeze(p as unknown as SkillPublicationReceipt);
}

interface ZipEntry {
  readonly name: string; readonly directory: boolean; readonly flags: number; readonly method: number;
  readonly crc: number; readonly compressed: number; readonly size: number; readonly offset: number;
  readonly needed: number; readonly timestamp: number;
}
// Parse ZIP metadata before any inflation. Only standard single-disk stored/deflate
// ZIPs are supported; ZIP64, alternate names, link extras, encryption and special files fail closed.
function unpack(bytes: Uint8Array, receipt: SkillPublicationReceipt): Map<string, Uint8Array> {
  if (bytes.length < 22) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  let end = bytes.length - 22;
  const first = Math.max(0, bytes.length - 65_557);
  while (end >= first && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;
  if (end < first || u16(end + 4) !== 0 || u16(end + 6) !== 0) fail();
  const count = u16(end + 10), central = u32(end + 16);
  if (count === 0 || count > MAX_ARCHIVE_ENTRIES || count !== u16(end + 8) || central + u32(end + 12) !== end) fail();
  const extras = (start: number, length: number) => {
    const seen = new Set<number>(), limit = start + length;
    for (let at = start; at < limit;) {
      if (at + 4 > limit) fail();
      const id = u16(at), size = u16(at + 2);
      // Timestamp/UID/NTFS metadata only: none can supply an alternate path or link.
      if (![0x5455, 0x7875, 0x000a].includes(id) || seen.has(id) || at + 4 + size > limit) fail();
      seen.add(id); at += 4 + size;
    }
  };
  const wanted = new Map(receipt.files.map((file) => [file.path, file]));
  const directories = new Set<string>();
  for (const file of receipt.files) {
    const parts = file.path.split("/");
    for (let n = 1; n < parts.length; n++) directories.add(`${parts.slice(0, n).join("/")}/`);
  }
  const entries: ZipEntry[] = [];
  let cursor = central, total = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail();
    const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30);
    const next = cursor + 46 + nameLength + extraLength + u16(cursor + 32);
    if (next > end || u16(cursor + 34) !== 0) fail();
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const directory = name.endsWith("/"), mode = (u32(cursor + 38) >>> 16) & 0xf000;
    if (!pathName(directory ? name.slice(0, -1) : name) ||
        ![0, 0x8000, 0x4000].includes(mode) || (mode === 0x4000 && !directory) || (mode === 0x8000 && directory) ||
        ((u32(cursor + 38) & 0x10) !== 0 && !directory)) fail();
    extras(cursor + 46 + nameLength, extraLength);
    const entry: ZipEntry = { name, directory, needed: u16(cursor + 6), flags: u16(cursor + 8), method: u16(cursor + 10),
      timestamp: u32(cursor + 12), crc: u32(cursor + 16), compressed: u32(cursor + 20), size: u32(cursor + 24), offset: u32(cursor + 42) };
    if (entry.needed > 20 || (entry.flags & ~0x080e) !== 0 || ![0, 8].includes(entry.method) ||
        (entry.method === 0 && (entry.flags & 6) !== 0) || entry.compressed > bytes.length || entry.offset >= central) fail();
    if (directory ? !directories.has(name) || entry.size !== 0 : name === MANIFEST
      ? !integer(entry.size, MAX_SKILL_MANIFEST_BYTES)
      : !wanted.has(name) || entry.size !== wanted.get(name)!.size) fail();
    total += entry.size;
    if (total > MAX_SKILL_TOTAL_BYTES) fail();
    entries.push(entry); cursor = next;
  }
  if (cursor !== end || entries.filter((entry) => !entry.directory).length !== wanted.size + 1 || !entries.some((entry) => entry.name === MANIFEST)) fail();
  validateArchiveEntries(entries.map((entry) => ({ name: entry.name, kind: entry.directory ? "directory" : "file" })));
  const files = new Map<string, Uint8Array>();
  let expectedOffset = 0;
  for (const entry of entries.sort((a, b) => a.offset - b.offset)) {
    const at = entry.offset;
    if (at !== expectedOffset || at + 30 > central || u32(at) !== 0x04034b50 || u16(at + 4) !== entry.needed ||
        u16(at + 6) !== entry.flags || u16(at + 8) !== entry.method || u32(at + 10) !== entry.timestamp) fail();
    const nameLength = u16(at + 26), extraLength = u16(at + 28), start = at + 30 + nameLength + extraLength;
    if (start > central || start + entry.compressed > central ||
        decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength)) !== entry.name) fail();
    extras(at + 30 + nameLength, extraLength);
    const descriptor = (entry.flags & 8) !== 0;
    for (const [local, actual] of [[u32(at + 14), entry.crc], [u32(at + 18), entry.compressed], [u32(at + 22), entry.size]]) {
      if (local !== actual && !(descriptor && local === 0)) fail();
    }
    expectedOffset = start + entry.compressed;
    if (descriptor) {
      const signed = expectedOffset + 16 <= central && u32(expectedOffset) === 0x08074b50 &&
        u32(expectedOffset + 4) === entry.crc && u32(expectedOffset + 8) === entry.compressed && u32(expectedOffset + 12) === entry.size;
      const position = expectedOffset + (signed ? 4 : 0);
      if (position + 12 > central || u32(position) !== entry.crc || u32(position + 4) !== entry.compressed || u32(position + 8) !== entry.size) fail();
      expectedOffset = position + 12;
    }
    const compressed = bytes.subarray(start, start + entry.compressed);
    let content: Uint8Array;
    if (entry.method === 0) content = compressed;
    else {
      // zlib enforces the authenticated/limited declared output size even if DEFLATE lies.
      const inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size), info: true }) as unknown as
        { buffer: Uint8Array; engine: { bytesWritten: number } };
      if (inflated.engine.bytesWritten !== compressed.length) fail();
      content = inflated.buffer;
    }
    if (content.length !== entry.size || crc32(content) !== entry.crc) fail();
    if (!entry.directory) files.set(entry.name, Uint8Array.from(content));
  }
  if (expectedOffset !== central) fail();
  return files;
}

/** Authenticates publication bytes, NOT installation, activation, or signed-channel authorization. */
export function verifySkillPublicationReceipt(options: SkillPublicationReceiptOptions): VerifiedSkillPublicationReceipt {
  try {
    // Keep publication's canonical outer-byte requirement explicit without changing runtime verification.
    const envelope = options.envelope;
    if (typeof envelope === "string" ? envelope.startsWith("\uFEFF") :
      envelope[0] === 0xef && envelope[1] === 0xbb && envelope[2] === 0xbf) fail();
    const config = options.trustConfig ?? createProductionUpdateTrustConfig();
    updateTrustConfigSha256(config);
    const trust = createTrustState(config.bootstrapKeys);
    const signed = verifySignedEnvelope(options.envelope, trust, config.bootstrapKeys);
    const receipt = parseReceipt(signed.payloadBytes);
    const version = requireCanonicalSemVer(options.expectedVersion);
    const key = trust.keys.find((item) => item.keyId === receipt.signingKeyId);
    if (options.expectedTag !== `skill-v${version}` || receipt.releaseTag !== options.expectedTag || receipt.version !== version ||
        receipt.repository.owner !== config.repository.owner || receipt.repository.name !== config.repository.name ||
        !signed.verifiedKeyIds.includes(receipt.signingKeyId) || key === undefined || !signingKeyIsActive(key, receipt.signingSequence)) fail();
    if (!(options.archiveBytes instanceof Uint8Array) || options.archiveBytes.length !== receipt.asset.size ||
        options.archiveBytes.length > MAX_SKILL_ARCHIVE_BYTES) fail();
    const archive = Uint8Array.from(options.archiveBytes);
    if (hash(archive) !== receipt.asset.sha256) fail(); // Authenticate compressed bytes BEFORE parsing/inflating.
    const files = unpack(archive, receipt);
    const packed = files.get(MANIFEST);
    if (packed === undefined) fail();
    const manifest = exact(canonicalJson(packed), ["activation", "cliVersionRange", "files", "manifestVersion", "skillProtocol", "tag", "treeSha256", "version"]);
    if (manifest.activation !== "explicit-host-refresh" || manifest.manifestVersion !== 1 || manifest.version !== receipt.version ||
        manifest.tag !== receipt.releaseTag || manifest.skillProtocol !== receipt.skillProtocol || manifest.cliVersionRange !== receipt.cliVersionRange ||
        manifest.treeSha256 !== receipt.treeSha256 || canonicalizeJson(manifest.files!) !== canonicalizeJson(receipt.files as unknown as JsonValue)) fail();
    files.delete(MANIFEST);
    for (const file of receipt.files) {
      const bytes = files.get(file.path);
      if (bytes === undefined || bytes.length !== file.size || hash(bytes) !== file.sha256) fail();
    }
    return Object.freeze({ purpose: "skill-publication-only" as const, receipt, payloadSha256: signed.payloadSha256,
      signingKeyId: receipt.signingKeyId,
      get files(): ReadonlyMap<string, Uint8Array> { return new Map([...files].map(([path, bytes]) => [path, Uint8Array.from(bytes)])); },
    });
  } catch (error) {
    if (isToolError(error, "UPDATE_SECURITY_ERROR")) throw error;
    return fail();
  }
}
