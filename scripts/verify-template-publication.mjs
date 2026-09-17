import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TEMPLATE_BUNDLE_PAYLOAD_PATHS } from "../src/bundle/types.ts";
import {
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PAYLOAD_BYTES,
  MAX_BUNDLE_TOTAL_PAYLOAD_BYTES,
} from "../src/bundle/load.ts";
import { parseStrictJson } from "../src/input/strict-json.ts";
import { MAX_SIGNED_ENVELOPE_BYTES } from "../src/update/envelope.ts";
import { MAX_TEMPLATE_PUBLICATION_ARCHIVE_BYTES, verifyTemplatePublicationReceipt } from "../src/update/template-publication.ts";

const EXPECTED = ["bundle-manifest.json", ...TEMPLATE_BUNDLE_PAYLOAD_PATHS];
const DIRECTORIES = ["profiles", "registries"];
const key = (path) => process.platform === "win32" ? path.toLowerCase() : path;
function fail(message) { throw new Error(`Template publication verification failed: ${message}`); }
function same(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function absolute(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) fail("invalid path");
  return resolve(value);
}
async function plainDirectory(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || key(await realpath(path)) !== key(path)) {
    fail("directory is not a canonical plain directory");
  }
  return info;
}
async function stableDirectory(path, before) {
  if (!same(before, await plainDirectory(path))) fail("directory changed during verification");
}

/** Fixed-size reads with pre-open bounds and identity checks; never readFile an unbounded input. */
async function readBounded(path, limit) {
  await plainDirectory(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n ||
      before.size > BigInt(limit) || key(await realpath(path)) !== key(path)) {
    fail("input is not a bounded canonical regular file");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !same(before, opened)) fail("input changed while opening");
    await plainDirectory(dirname(path));
    if (key(await realpath(path)) !== key(path)) fail("input path changed while opening");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail("input shortened during verification");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!same(opened, after) || !same(opened, current) || current.isSymbolicLink() ||
        current.nlink !== 1n || key(await realpath(path)) !== key(path)) fail("input changed while reading");
    return bytes;
  } finally { await handle.close(); }
}

async function exactDirectory(path, expected) {
  const before = await plainDirectory(path);
  const found = new Set();
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (!expected.includes(entry.name) || found.has(entry.name)) fail("unexpected template tree entry");
    found.add(entry.name);
  }
  if (found.size !== expected.length) fail("template tree is incomplete");
  await stableDirectory(path, before);
  return before;
}

/** File acquisition only; this function does NOT authenticate a receipt. */
export async function readTemplatePublicationInputs({ directory, receipt, tag, archive }) {
  const root = absolute(directory);
  const receiptPath = absolute(receipt);
  const roots = new Map();
  roots.set(root, await exactDirectory(root, [...EXPECTED.filter((path) => !path.includes("/")), ...DIRECTORIES]));
  for (const subdirectory of DIRECTORIES) {
    const children = EXPECTED.filter((path) => path.startsWith(`${subdirectory}/`)).map((path) => path.slice(subdirectory.length + 1));
    const path = resolve(root, subdirectory);
    roots.set(path, await exactDirectory(path, children));
  }
  const files = new Map();
  let payloadBytes = 0;
  for (const path of EXPECTED) {
    const isManifest = path === "bundle-manifest.json";
    const remaining = MAX_BUNDLE_TOTAL_PAYLOAD_BYTES - payloadBytes;
    const bytes = await readBounded(resolve(root, path), isManifest ? MAX_BUNDLE_MANIFEST_BYTES : Math.min(MAX_BUNDLE_PAYLOAD_BYTES, remaining));
    if (!isManifest) payloadBytes += bytes.length;
    files.set(path, bytes);
  }
  const envelope = await readBounded(receiptPath, MAX_SIGNED_ENVELOPE_BYTES);
  const archiveBytes = archive === undefined ? undefined : await readBounded(absolute(archive), MAX_TEMPLATE_PUBLICATION_ARCHIVE_BYTES);
  for (const [path, before] of roots) await stableDirectory(path, before);
  const manifest = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(files.get("bundle-manifest.json")));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.version !== "string") fail("invalid manifest version");
  return { envelope, files, expectedTag: tag, expectedVersion: manifest.version,
    ...(archiveBytes === undefined ? {} : { archiveBytes }) };
}

function args(argv) {
  const fields = new Map([["--directory", "directory"], ["--receipt", "receipt"], ["--tag", "tag"], ["--archive", "archive"]]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = fields.get(argv[index]);
    const value = argv[index + 1];
    if (field === undefined || Object.hasOwn(result, field) || typeof value !== "string" || value.trim() === "" || value.startsWith("--")) fail("use --directory, --receipt, --tag and optional --archive at most once");
    result[field] = value;
  }
  if (["directory", "receipt", "tag"].some((field) => !Object.hasOwn(result, field))) fail("--directory, --receipt, and --tag are required");
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const inputs = await readTemplatePublicationInputs(args(process.argv.slice(2)));
    // Deliberately no trust/key/URL option: only the source-pinned production roots.
    const checked = verifyTemplatePublicationReceipt(inputs);
    process.stdout.write(`${JSON.stringify({ purpose: checked.purpose, tag: checked.receipt.releaseTag,
      version: checked.receipt.bundleVersion, signingKeyId: checked.signingKeyId,
      signingSequence: checked.receipt.signingSequence, receiptPayloadSha256: checked.payloadSha256,
      bundleManifestHash: checked.bundleManifestHash,
      ...(checked.archiveSha256 === undefined ? {} : { archiveSha256: checked.archiveSha256, archiveSize: checked.archiveSize }) })}\n`);
  } catch (error) {
    // Never echo file contents, arbitrary paths, or supplied envelope material.
    const message = error?.code === "UPDATE_SECURITY_ERROR" ? error.message : "input validation failed";
    process.stderr.write(`Template publication verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
