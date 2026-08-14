import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { SemVer, satisfies } from "semver";

import { canonicalizeJson, sha256Utf8, type JsonValue } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import type { SkillComponent } from "../update/manifest.ts";

const MAX_SKILL_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const SECRET_SHAPE = /(?:glpat-[A-Za-z0-9_-]+|hmr[ctx]1_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|(?:authorization|bearer)\s*[:=]\s*[^\s]+|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/iu;
const MANIFEST_NAME = ".harness-skill-manifest.json";
const JOURNAL_NAME = ".harness-skill-activation.json";
const VERSIONS_NAME = "versions";
const TEMP_PREFIX = ".harness-skill-tmp-";
const BACKUP_PREFIX = ".harness-skill-old-";
const READ_ONLY_FLAGS = constants.O_RDONLY | ((constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

export type SkillReleaseComponent = SkillComponent;

export interface SkillFile {
  readonly path: string;
  readonly contents: string | Uint8Array;
}

/**
 * A release returned by the injected signed-asset verifier. `verified` is a
 * hand-off marker from that verifier; this module still validates every
 * version, protocol, path, size and content boundary before writing.
 */
export interface SkillRelease {
  readonly version: string;
  readonly tag: string;
  readonly skillProtocol: number;
  readonly cliVersionRange: string;
  readonly activation: "explicit-host-refresh";
  readonly verified: true;
  readonly files: readonly SkillFile[];
  readonly assetSha256?: string;
  readonly assetSize?: number;
}

export interface SkillInvocationPin {
  readonly loadedSkillVersion: string | null;
  readonly loadedSkillProtocol: number | null;
}

export interface SkillStatus {
  readonly loadedSkillVersion: string | null;
  readonly loadedSkillProtocol: number | null;
  readonly installedSkillVersion: string | null;
  readonly installedSkillProtocol: number | null;
  readonly stagedSkillVersion: string | null;
  readonly stagedSkillProtocol: number | null;
  readonly activationRequired: boolean;
  readonly hostRefreshMayBeRequired: boolean;
  readonly persistencePending: boolean;
}

export interface SkillStageResult extends SkillStatus {
  readonly stagedPath: string;
}

export interface SkillActivationResult extends SkillStatus {
  readonly activatedVersion: string;
}

export interface SkillRepairResult extends SkillStatus {
  readonly repaired: boolean;
}

export interface SkillFaultInjector {
  hit(point: string): void | Promise<void>;
}

export interface SkillManagerOptions {
  readonly activePath: string;
  readonly stagingPath: string;
  readonly cliVersion: string;
  readonly supportedProtocols: readonly number[];
  readonly faultInjector?: SkillFaultInjector;
}

export type SkillReleaseFetcher = (
  component: SkillReleaseComponent,
) => Promise<SkillRelease>;

interface StoredFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface StoredManifest {
  readonly manifestVersion: 1;
  readonly version: string;
  readonly tag: string;
  readonly skillProtocol: number;
  readonly cliVersionRange: string;
  readonly activation: "explicit-host-refresh";
  readonly treeSha256: string;
  readonly files: readonly StoredFile[];
}

interface ActivationJournal {
  readonly journalVersion: 1;
  readonly state: "prepared" | "old-moved" | "published";
  readonly temporaryPath: string;
  readonly backupPath: string | null;
  readonly activePath: string;
  readonly version: string;
}

function managerError(
  code: "INPUT_ERROR" | "UPDATE_REQUIRED" | "UPDATE_SECURITY_ERROR" | "INTERNAL_ERROR",
  reason: string,
): ToolError {
  // Keep reasons from external assets out of errors. In particular, never
  // interpolate paths, downloaded bytes, headers or credential-shaped text.
  const safeReasons = new Set([
    "invalid manager options",
    "unsupported Skill protocol",
    "Skill CLI compatibility range is not satisfied",
    "Skill release metadata is invalid",
    "Skill release is not verified",
    "Skill release files are invalid",
    "Skill release contains sensitive material",
    "Skill release asset does not match the signed component",
    "Skill staging failed",
    "Skill activation failed",
    "Skill activation journal is invalid",
    "Skill state is unavailable",
    "Skill repair failed",
  ]);
  const actual = safeReasons.has(reason) ? reason : "Skill operation failed";
  return new ToolError(code, `Skill operation could not proceed: ${actual}`, {
    field: "skill",
    expected: "a verified, protocol-compatible Skill with atomic activation",
    actual,
    safeNextStep: "Refresh the signed Skill release or repair the pending Skill activation, then retry.",
  });
}

function fail(
  code: "INPUT_ERROR" | "UPDATE_REQUIRED" | "UPDATE_SECURITY_ERROR" | "INTERNAL_ERROR",
  reason: string,
): never {
  throw managerError(code, reason);
}

function strictVersion(value: unknown): string {
  if (typeof value !== "string" || !VERSION.test(value)) fail("UPDATE_SECURITY_ERROR", "Skill release metadata is invalid");
  try {
    const parsed = new SemVer(value, { loose: false });
    if (parsed.version !== value) fail("UPDATE_SECURITY_ERROR", "Skill release metadata is invalid");
  } catch {
    fail("UPDATE_SECURITY_ERROR", "Skill release metadata is invalid");
  }
  return value as string;
}

function safeSingleLine(value: unknown): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    fail("UPDATE_SECURITY_ERROR", "Skill release metadata is invalid");
  }
  return value;
}

function safePath(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 256 ||
      value.includes("\\") || value.includes("//") || !SAFE_PATH.test(value) ||
      isAbsolute(value) || value.endsWith("/") || value.startsWith(".")) {
    fail("UPDATE_SECURITY_ERROR", "Skill release files are invalid");
  }
  return value;
}

function bytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (!(value instanceof Uint8Array)) fail("UPDATE_SECURITY_ERROR", "Skill release files are invalid");
  return Uint8Array.from(value as Uint8Array);
}

function safeRoot(value: unknown): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    fail("INPUT_ERROR", "invalid manager options");
  }
  const root = resolve(value);
  if (root === dirname(root)) fail("INPUT_ERROR", "invalid manager options");
  return root;
}

function within(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function randomSuffix(): string {
  return randomBytes(12).toString("hex");
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function treeHash(files: readonly StoredFile[]): string {
  return sha256Utf8(`${canonicalizeJson(files as unknown as JsonValue)}\n`);
}

function canonicalManifest(manifest: StoredManifest): Uint8Array {
  return new TextEncoder().encode(`${canonicalizeJson(manifest as unknown as JsonValue)}\n`);
}

function secretIn(value: Uint8Array): boolean {
  return SECRET_SHAPE.test(new TextDecoder("utf-8", { fatal: false }).decode(value));
}

async function assertDirectory(path: string, create = false): Promise<void> {
  try {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("INPUT_ERROR", "invalid manager options");
    const canonical = await realpath(path);
    if (canonical !== path && process.platform !== "win32") fail("INPUT_ERROR", "invalid manager options");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    fail("INPUT_ERROR", "invalid manager options");
  }
}

async function assertParentChain(path: string): Promise<void> {
  let current = dirname(path);
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(current)) fail("INPUT_ERROR", "invalid manager options");
    visited.add(current);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail("INPUT_ERROR", "invalid manager options");
      const canonical = await realpath(current);
      if (process.platform !== "win32" && canonical !== current) fail("INPUT_ERROR", "invalid manager options");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) fail("INPUT_ERROR", "invalid manager options");
        current = parent;
        continue;
      }
      if (error instanceof ToolError) throw error;
      fail("INPUT_ERROR", "invalid manager options");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not available on every supported filesystem. The
    // file fsync and atomic rename still provide the required ordering.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeAtomic(path: string, content: Uint8Array, mode = 0o600): Promise<void> {
  const parent = dirname(path);
  await assertDirectory(parent);
  const temporary = `${path}.tmp-${randomSuffix()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof ToolError) throw error;
    fail("INTERNAL_ERROR", "Skill staging failed");
  }
}

async function writeFileSecure(path: string, content: Uint8Array): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertDirectory(parent);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    fail("INTERNAL_ERROR", "Skill staging failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRegularFile(path: string, maximum: number): Promise<Uint8Array> {
  let info;
  let canonical;
  try {
    info = await lstat(path);
    canonical = await realpath(path);
  } catch {
    return fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
  if (!info!.isFile() || info!.isSymbolicLink() || (process.platform !== "win32" && canonical !== path) ||
      info!.size < 1 || info!.size > maximum) {
    fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== info!.size || opened.size > maximum) {
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
    const result = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < result.byteLength) {
      const read = await handle.read(result, offset, result.byteLength - offset, offset);
      if (read.bytesRead <= 0) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
      offset += read.bytesRead;
    }
    return result;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function exactManifest(value: unknown): StoredManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  const expected = ["activation", "cliVersionRange", "files", "manifestVersion", "skillProtocol", "tag", "treeSha256", "version"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  const version = strictVersion(item.version);
  const tag = safeSingleLine(item.tag);
  const range = safeSingleLine(item.cliVersionRange);
  if (tag !== `skill-v${version}` || item.manifestVersion !== 1 || item.activation !== "explicit-host-refresh" ||
      !Number.isSafeInteger(item.skillProtocol) || (item.skillProtocol as number) < 1 ||
      typeof item.treeSha256 !== "string" || !SHA256.test(item.treeSha256) || !Array.isArray(item.files)) {
    fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
  const files = item.files.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    const file = entry as Record<string, unknown>;
    const fileKeys = Object.keys(file).sort();
    if (fileKeys.join(",") !== "path,sha256,size" || typeof file.sha256 !== "string" || !SHA256.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || (file.size as number) < 1 || (file.size as number) > MAX_SKILL_FILE_BYTES) {
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
    return Object.freeze({ path: safePath(file.path), size: file.size as number, sha256: file.sha256 });
  });
  if (files.length === 0 || files.length > MAX_SKILL_FILES || new Set(files.map((file) => file.path)).size !== files.length ||
      files.some((file, index) => index > 0 && files[index - 1]!.path >= file.path)) {
    fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
  if (treeHash(files) !== item.treeSha256) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  try {
    satisfies("0.0.0", range, { loose: false });
  } catch {
    fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
  return Object.freeze({
    manifestVersion: 1,
    version,
    tag,
    skillProtocol: item.skillProtocol as number,
    cliVersionRange: range,
    activation: "explicit-host-refresh",
    treeSha256: item.treeSha256 as string,
    files: Object.freeze(files),
  });
}

async function verifyTree(root: string, manifest: StoredManifest): Promise<void> {
  const actual: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
    for (const entry of entries!) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        actual.push(relativePath);
      } else {
        fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
      }
    }
  };
  await visit(root, "");
  const expected = [...manifest.files.map((file) => file.path), MANIFEST_NAME].sort();
  actual.sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
  for (const file of manifest.files) {
    const path = resolve(root, file.path);
    if (!within(root, path)) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    const content = await readRegularFile(path, MAX_SKILL_FILE_BYTES);
    if (content.byteLength !== file.size || sha(content) !== file.sha256 || secretIn(content)) {
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
  }
}

async function loadManifest(root: string): Promise<StoredManifest | null> {
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ToolError) throw error;
    fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
  try {
    const content = await readRegularFile(resolve(root, MANIFEST_NAME), 64 * 1024);
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      parsed = parseStrictJson(text);
      if (text !== `${canonicalizeJson(parsed)}\n`) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    } catch (error) {
      if (error instanceof ToolError) throw error;
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
    const manifest = exactManifest(parsed);
    await verifyTree(root, manifest);
    return manifest;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
  }
}

function normalizeRelease(release: SkillRelease, cliVersion: string, protocols: ReadonlySet<number>): {
  readonly manifest: StoredManifest;
  readonly files: readonly { readonly path: string; readonly content: Uint8Array }[];
} {
  if (release === null || typeof release !== "object" || release.verified !== true) fail("UPDATE_SECURITY_ERROR", "Skill release is not verified");
  const version = strictVersion(release.version);
  if (release.tag !== `skill-v${version}` || release.activation !== "explicit-host-refresh" ||
      !Number.isSafeInteger(release.skillProtocol) || release.skillProtocol < 1) {
    fail("UPDATE_SECURITY_ERROR", "Skill release metadata is invalid");
  }
  if (!protocols.has(release.skillProtocol)) fail("UPDATE_REQUIRED", "unsupported Skill protocol");
  const range = safeSingleLine(release.cliVersionRange);
  try {
    if (!satisfies(cliVersion, range, { loose: false })) fail("UPDATE_REQUIRED", "Skill CLI compatibility range is not satisfied");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    fail("UPDATE_SECURITY_ERROR", "Skill release metadata is invalid");
  }
  if (!Array.isArray(release.files) || release.files.length === 0 || release.files.length > MAX_SKILL_FILES) {
    fail("UPDATE_SECURITY_ERROR", "Skill release files are invalid");
  }
  const files = release.files.map((entry) => {
    if (entry === null || typeof entry !== "object") fail("UPDATE_SECURITY_ERROR", "Skill release files are invalid");
    const path = safePath(entry.path);
    const content = bytes(entry.contents);
    if (content.byteLength === 0 || content.byteLength > MAX_SKILL_FILE_BYTES || secretIn(content)) {
      fail("UPDATE_SECURITY_ERROR", secretIn(content) ? "Skill release contains sensitive material" : "Skill release files are invalid");
    }
    return { path, content };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length || !files.some((file) => file.path === "SKILL.md")) {
    fail("UPDATE_SECURITY_ERROR", "Skill release files are invalid");
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const total = files.reduce((sum, file) => sum + file.content.byteLength, 0);
  if (total > MAX_SKILL_BYTES) fail("UPDATE_SECURITY_ERROR", "Skill release files are invalid");
  if (release.assetSha256 !== undefined && (!SHA256.test(release.assetSha256) || release.assetSize === undefined ||
      !Number.isSafeInteger(release.assetSize) || release.assetSize < 1)) {
    fail("UPDATE_SECURITY_ERROR", "Skill release asset does not match the signed component");
  }
  const storedFiles = files.map((file) => Object.freeze({ path: file.path, size: file.content.byteLength, sha256: sha(file.content) }));
  const manifest: StoredManifest = Object.freeze({
    manifestVersion: 1,
    version,
    tag: release.tag,
    skillProtocol: release.skillProtocol,
    cliVersionRange: range,
    activation: "explicit-host-refresh",
    treeSha256: treeHash(storedFiles),
    files: Object.freeze(storedFiles),
  });
  return { manifest, files: Object.freeze(files) };
}

function emptyStatus(pin: SkillInvocationPin | undefined, pending = false): SkillStatus {
  return Object.freeze({
    loadedSkillVersion: pin?.loadedSkillVersion ?? null,
    loadedSkillProtocol: pin?.loadedSkillProtocol ?? null,
    installedSkillVersion: null,
    installedSkillProtocol: null,
    stagedSkillVersion: null,
    stagedSkillProtocol: null,
    activationRequired: false,
    hostRefreshMayBeRequired: false,
    persistencePending: pending,
  });
}

export class SkillManager {
  readonly activePath: string;
  readonly stagingPath: string;
  readonly cliVersion: string;
  readonly supportedProtocols: readonly number[];
  private readonly faultInjector: SkillFaultInjector | undefined;
  private ready: Promise<void> | undefined;

  constructor(options: SkillManagerOptions) {
    this.activePath = safeRoot(options?.activePath);
    this.stagingPath = safeRoot(options?.stagingPath);
    this.cliVersion = strictVersion(options?.cliVersion);
    if (!Array.isArray(options?.supportedProtocols) || options.supportedProtocols.length === 0 ||
        options.supportedProtocols.some((value) => !Number.isSafeInteger(value) || value < 1)) {
      fail("INPUT_ERROR", "invalid manager options");
    }
    this.supportedProtocols = Object.freeze([...new Set(options.supportedProtocols)].sort((a, b) => a - b));
    if (this.activePath === this.stagingPath || within(this.activePath, this.stagingPath) || within(this.stagingPath, this.activePath)) {
      fail("INPUT_ERROR", "invalid manager options");
    }
    this.faultInjector = options.faultInjector;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = (async () => {
        await assertParentChain(this.stagingPath);
        await assertDirectory(this.stagingPath, true);
        await assertParentChain(this.activePath);
        await assertDirectory(dirname(this.activePath), true);
        const versions = resolve(this.stagingPath, VERSIONS_NAME);
        await assertDirectory(versions, true);
      })().catch((error) => {
        this.ready = undefined;
        if (error instanceof ToolError) throw error;
        fail("INPUT_ERROR", "invalid manager options");
      });
    }
    await this.ready;
  }

  pinInvocation(pin: SkillInvocationPin): SkillInvocationPin {
    if (pin === null || typeof pin !== "object") fail("INPUT_ERROR", "invalid manager options");
    const version = pin.loadedSkillVersion === null ? null : strictVersion(pin.loadedSkillVersion);
    const protocol = pin.loadedSkillProtocol;
    if ((version === null) !== (protocol === null) ||
        (protocol !== null && (!Number.isSafeInteger(protocol) || protocol < 1))) {
      fail("INPUT_ERROR", "invalid manager options");
    }
    if (protocol !== null && !this.supportedProtocols.includes(protocol)) fail("UPDATE_REQUIRED", "unsupported Skill protocol");
    return Object.freeze({ loadedSkillVersion: version, loadedSkillProtocol: protocol });
  }

  private async readStaged(version: string): Promise<{ readonly root: string; readonly manifest: StoredManifest } | null> {
    const root = resolve(this.stagingPath, VERSIONS_NAME, version);
    if (!within(this.stagingPath, root)) fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    const manifest = await loadManifest(root);
    return manifest === null ? null : { root, manifest };
  }

  private async readActive(): Promise<{ readonly root: string; readonly manifest: StoredManifest } | null> {
    const manifest = await loadManifest(this.activePath);
    return manifest === null ? null : { root: this.activePath, manifest };
  }

  private async statusFor(pin: SkillInvocationPin | undefined): Promise<SkillStatus> {
    await this.ensureReady();
    const [active, staged, pending] = await Promise.all([
      this.readActive(),
      this.latestStaged(),
      this.hasJournal(),
    ]);
    const loaded = pin;
    const installedVersion = active?.manifest.version ?? null;
    const installedProtocol = active?.manifest.skillProtocol ?? null;
    const stagedVersion = staged?.manifest.version ?? null;
    const stagedProtocol = staged?.manifest.skillProtocol ?? null;
    return Object.freeze({
      loadedSkillVersion: loaded?.loadedSkillVersion ?? null,
      loadedSkillProtocol: loaded?.loadedSkillProtocol ?? null,
      installedSkillVersion: installedVersion,
      installedSkillProtocol: installedProtocol,
      stagedSkillVersion: stagedVersion,
      stagedSkillProtocol: stagedProtocol,
      activationRequired: stagedVersion !== null && stagedVersion !== installedVersion,
      hostRefreshMayBeRequired: loaded !== undefined &&
        (loaded.loadedSkillVersion !== installedVersion || loaded.loadedSkillProtocol !== installedProtocol),
      persistencePending: pending,
    });
  }

  private async latestStaged(): Promise<{ readonly root: string; readonly manifest: StoredManifest } | null> {
    const versionsRoot = resolve(this.stagingPath, VERSIONS_NAME);
    let names: string[];
    try {
      names = (await readdir(versionsRoot)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
    let latest: { readonly root: string; readonly manifest: StoredManifest } | null = null;
    for (const name of names) {
      if (!VERSION.test(name)) continue;
      const candidate = await this.readStaged(name);
      if (candidate !== null && (latest === null || new SemVer(candidate.manifest.version).compare(new SemVer(latest.manifest.version)) > 0)) {
        latest = candidate;
      }
    }
    return latest;
  }

  private async hasJournal(): Promise<boolean> {
    try {
      const info = await lstat(resolve(this.stagingPath, JOURNAL_NAME));
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
  }

  async status(pin?: SkillInvocationPin): Promise<SkillStatus> {
    const normalized = pin === undefined ? undefined : this.pinInvocation(pin);
    return this.statusFor(normalized);
  }

  async stage(release: SkillRelease): Promise<SkillStageResult> {
    await this.ensureReady();
    const normalized = normalizeRelease(release, this.cliVersion, new Set(this.supportedProtocols));
    const target = resolve(this.stagingPath, VERSIONS_NAME, normalized.manifest.version);
    if (!within(this.stagingPath, target)) fail("UPDATE_SECURITY_ERROR", "Skill staging failed");
    const existing = await this.readStaged(normalized.manifest.version);
    if (existing !== null) {
      if (existing.manifest.treeSha256 !== normalized.manifest.treeSha256) fail("UPDATE_SECURITY_ERROR", "Skill release metadata is invalid");
      const status = await this.statusFor(undefined);
      return Object.freeze({ ...status, stagedPath: existing.root });
    }
    const temporary = resolve(this.stagingPath, `${TEMP_PREFIX}${randomSuffix()}`);
    try {
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await assertDirectory(temporary);
      for (const file of normalized.files) {
        const destination = resolve(temporary, file.path);
        if (!within(temporary, destination)) fail("UPDATE_SECURITY_ERROR", "Skill staging failed");
        await writeFileSecure(destination, file.content);
      }
      await writeAtomic(resolve(temporary, MANIFEST_NAME), canonicalManifest(normalized.manifest));
      await this.faultInjector?.hit("before-stage-publish");
      await rename(temporary, target);
      await syncDirectory(resolve(this.stagingPath, VERSIONS_NAME));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ToolError) throw error;
      fail("INTERNAL_ERROR", "Skill staging failed");
    }
    const status = await this.statusFor(undefined);
    return Object.freeze({ ...status, stagedPath: target });
  }

  async bootstrap(component: SkillReleaseComponent, fetch: SkillReleaseFetcher): Promise<SkillStageResult> {
    if (component === null || typeof component !== "object" || typeof fetch !== "function") fail("INPUT_ERROR", "invalid manager options");
    const expectedVersion = strictVersion(component.version);
    if (component.tag !== `skill-v${expectedVersion}` || component.activation !== "explicit-host-refresh" ||
        !Number.isSafeInteger(component.skillProtocol) || component.skillProtocol < 1 ||
        !this.supportedProtocols.includes(component.skillProtocol)) {
      fail("UPDATE_REQUIRED", "unsupported Skill protocol");
    }
    let fetched: SkillRelease;
    try {
      fetched = await fetch(component);
    } catch {
      fail("UPDATE_SECURITY_ERROR", "Skill release is not verified");
    }
    if (fetched.version !== component.version || fetched.tag !== component.tag ||
        fetched.skillProtocol !== component.skillProtocol || fetched.cliVersionRange !== component.cliVersionRange ||
        fetched.activation !== component.activation || fetched.assetSha256 !== component.sha256 ||
        fetched.assetSize !== component.size) {
      fail("UPDATE_SECURITY_ERROR", "Skill release asset does not match the signed component");
    }
    return this.stage(fetched);
  }

  async install(release: SkillRelease, pin?: SkillInvocationPin): Promise<SkillActivationResult> {
    const staged = await this.stage(release);
    return this.activate(staged.stagedSkillVersion!, pin);
  }

  async activate(version: string, pin?: SkillInvocationPin): Promise<SkillActivationResult> {
    await this.ensureReady();
    const normalizedPin = pin === undefined ? undefined : this.pinInvocation(pin);
    const requestedVersion = strictVersion(version);
    const staged = await this.readStaged(requestedVersion);
    if (staged === null) fail("UPDATE_REQUIRED", "Skill state is unavailable");
    if (!this.supportedProtocols.includes(staged.manifest.skillProtocol)) fail("UPDATE_REQUIRED", "unsupported Skill protocol");
    try {
      if (!satisfies(this.cliVersion, staged.manifest.cliVersionRange, { loose: false })) fail("UPDATE_REQUIRED", "Skill CLI compatibility range is not satisfied");
    } catch (error) {
      if (error instanceof ToolError) throw error;
      fail("UPDATE_SECURITY_ERROR", "Skill state is unavailable");
    }
    const temporary = resolve(dirname(this.activePath), `${TEMP_PREFIX}${randomSuffix()}`);
    const backup = resolve(dirname(this.activePath), `${BACKUP_PREFIX}${randomSuffix()}`);
    const journalPath = resolve(this.stagingPath, JOURNAL_NAME);
    const journal: ActivationJournal = {
      journalVersion: 1,
      state: "prepared",
      temporaryPath: temporary,
      backupPath: null,
      activePath: this.activePath,
      version: requestedVersion,
    };
    try {
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await assertDirectory(temporary);
      for (const file of staged.manifest.files) {
        const source = resolve(staged.root, file.path);
        const content = await readRegularFile(source, MAX_SKILL_FILE_BYTES);
        const destination = resolve(temporary, file.path);
        if (!within(temporary, destination)) fail("UPDATE_SECURITY_ERROR", "Skill activation failed");
        await writeFileSecure(destination, content);
      }
      await writeAtomic(resolve(temporary, MANIFEST_NAME), canonicalManifest(staged.manifest));
      await writeAtomic(journalPath, new TextEncoder().encode(`${canonicalizeJson(journal as unknown as JsonValue)}\n`));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ToolError) throw error;
      fail("INTERNAL_ERROR", "Skill activation failed");
    }
    try {
      await this.faultInjector?.hit("before-active-publish");
      let activeExists = false;
      try {
        const info = await lstat(this.activePath);
        if (info.isSymbolicLink() || !info.isDirectory()) fail("UPDATE_SECURITY_ERROR", "Skill activation failed");
        activeExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const committedJournal: ActivationJournal = {
        ...journal,
        state: "old-moved",
        backupPath: activeExists ? backup : null,
      };
      await writeAtomic(journalPath, new TextEncoder().encode(`${canonicalizeJson(committedJournal as unknown as JsonValue)}\n`));
      if (activeExists) {
        await rename(this.activePath, backup);
        await syncDirectory(dirname(this.activePath));
        await this.faultInjector?.hit("after-active-old-move");
      }
      await rename(temporary, this.activePath);
      await syncDirectory(dirname(this.activePath));
      const publishedJournal: ActivationJournal = { ...committedJournal, state: "published" };
      await writeAtomic(journalPath, new TextEncoder().encode(`${canonicalizeJson(publishedJournal as unknown as JsonValue)}\n`));
      await rm(journalPath, { force: true });
      if (committedJournal.backupPath !== null) await rm(committedJournal.backupPath, { recursive: true, force: true });
      await syncDirectory(dirname(this.activePath));
    } catch (error) {
      // Keep the journal for the next startup repair. If the old directory was
      // moved, put it back immediately when possible; repair remains the final
      // authority when a process dies in this window.
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ToolError) throw error;
      fail("INTERNAL_ERROR", "Skill activation failed");
    }
    const status = await this.statusFor(normalizedPin);
    return Object.freeze({ ...status, hostRefreshMayBeRequired: true, activatedVersion: requestedVersion });
  }

  async repair(): Promise<SkillRepairResult> {
    await this.ensureReady();
    const journalPath = resolve(this.stagingPath, JOURNAL_NAME);
    let content: Uint8Array;
    try {
      content = await readRegularFile(journalPath, 64 * 1024);
    } catch (error) {
      if (error instanceof ToolError && error.details.actual === "Skill state is unavailable") {
        const status = await this.statusFor(undefined);
        return Object.freeze({ ...status, repaired: false });
      }
      throw error;
    }
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      parsed = parseStrictJson(text);
    } catch {
      fail("UPDATE_SECURITY_ERROR", "Skill activation journal is invalid");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("UPDATE_SECURITY_ERROR", "Skill activation journal is invalid");
    const journal = parsed as Record<string, unknown>;
    if (journal.journalVersion !== 1 || !["prepared", "old-moved", "published"].includes(journal.state as string) ||
        typeof journal.temporaryPath !== "string" || typeof journal.activePath !== "string" || journal.activePath !== this.activePath ||
        (journal.backupPath !== null && typeof journal.backupPath !== "string")) {
      fail("UPDATE_SECURITY_ERROR", "Skill activation journal is invalid");
    }
    const temporaryPath = resolve(journal.temporaryPath as string);
    const backupPath = journal.backupPath === null ? null : resolve(journal.backupPath as string);
    if (!within(dirname(this.activePath), temporaryPath) || (backupPath !== null && !within(dirname(this.activePath), backupPath))) {
      fail("UPDATE_SECURITY_ERROR", "Skill activation journal is invalid");
    }
    try {
      const active = await lstat(this.activePath).catch(() => null);
      const backup = backupPath === null ? null : await lstat(backupPath).catch(() => null);
      if (backup !== null && backup.isDirectory() && !backup.isSymbolicLink()) {
        if (active !== null) await rm(this.activePath, { recursive: true, force: true });
        await rename(backupPath!, this.activePath);
      }
      await rm(temporaryPath, { recursive: true, force: true });
      await rm(journalPath, { force: true });
      await syncDirectory(dirname(this.activePath));
    } catch (error) {
      if (error instanceof ToolError) throw error;
      fail("INTERNAL_ERROR", "Skill repair failed");
    }
    const status = await this.statusFor(undefined);
    return Object.freeze({ ...status, repaired: true });
  }
}
