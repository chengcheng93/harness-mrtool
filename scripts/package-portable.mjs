import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { zipSync } from "fflate";
import { canonicalize } from "json-canonicalize";

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXPECTED_NAMES = Object.freeze([
  "SHA256SUMS",
  "THIRD_PARTY_NOTICES.md",
  "bundle-receipt.envelope.json",
  "harness-mrtool.exe",
  "licenses/Node.txt",
]);
const CHECKSUM_NAMES = Object.freeze(EXPECTED_NAMES.filter((name) => name !== "SHA256SUMS"));

function fail(message, cause) {
  throw new Error(`Portable release packaging failed: ${message}`, cause === undefined ? undefined : { cause });
}

function assertStringPath(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${name} is invalid.`);
  }
  return resolve(value);
}

function assertSafeArchiveName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 256 ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.includes("\0") ||
    name.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("archive contains an unsafe path.");
  }
  const segments = name.split("/");
  for (const segment of segments) {
    const stem = segment.replace(/[. ]+$/u, "").toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
      fail("archive contains a reserved device name.");
    }
  }
  return name;
}

async function readRegularFile(path, name) {
  const absolute = assertStringPath(path, name);
  let handle;
  let before;
  try {
    const link = await lstat(absolute, { bigint: true });
    before = link;
    if (!link.isFile() || link.size > BigInt(MAX_INPUT_BYTES)) {
      fail(`${name} is not a bounded regular file.`);
    }
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail(`${name} changed while it was opened.`);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.byteLength !== Number(before.size)) {
      fail(`${name} changed while it was read.`);
    }
    return bytes;
  } catch (error) {
    if (error?.message?.startsWith("Portable release packaging failed:")) throw error;
    fail(`could not read ${name}.`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertCanonicalReceipt(bytes) {
  let value;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    value = JSON.parse(text);
    if (text !== `${canonicalize(value)}\n`) fail("bundle receipt is not canonical JSON.");
  } catch (error) {
    if (error?.message?.startsWith("Portable release packaging failed:")) throw error;
    fail("bundle receipt is not valid UTF-8 JSON.", error);
  }
}

function checksumText(entries) {
  return `${entries
    .filter(([name]) => name !== "SHA256SUMS")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    .join("\n")}\n`;
}

function assertByteMap(entries) {
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    fail("archive entries are not an object.");
  }
  const names = Object.keys(entries);
  if (names.length !== EXPECTED_NAMES.length) fail("archive tree is not exact.");
  for (const name of names) {
    assertSafeArchiveName(name);
    if (!EXPECTED_NAMES.includes(name) || !(entries[name] instanceof Uint8Array)) {
      fail("archive tree contains an unexpected or non-file entry.");
    }
    if (entries[name].byteLength > MAX_INPUT_BYTES) fail("archive entry is too large.");
  }
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...EXPECTED_NAMES].sort())) {
    fail("archive tree is not exact.");
  }
}

export function validateReleaseArchive(entries) {
  assertByteMap(entries);
  const sums = Buffer.from(entries["SHA256SUMS"]).toString("utf8");
  if (!sums.endsWith("\n") || sums.includes("\r")) fail("SHA256SUMS must use LF line endings.");
  const lines = sums.slice(0, -1).split("\n");
  if (lines.length !== CHECKSUM_NAMES.length || new Set(lines).size !== lines.length) {
    fail("SHA256SUMS has the wrong entry count.");
  }
  const seen = new Set();
  for (const line of lines) {
    const match = /^(?<hash>[a-f0-9]{64})  (?<name>[^\s].*)$/u.exec(line);
    if (!match || !CHECKSUM_NAMES.includes(match.groups.name) || seen.has(match.groups.name)) {
      fail("SHA256SUMS contains an invalid line.");
    }
    if (!SHA256.test(match.groups.hash) || match.groups.hash !== sha256(entries[match.groups.name])) {
      fail(`SHA256SUMS does not match ${match.groups.name}.`);
    }
    seen.add(match.groups.name);
  }
  if (seen.size !== CHECKSUM_NAMES.length) fail("SHA256SUMS is incomplete.");
  assertCanonicalReceipt(entries["bundle-receipt.envelope.json"]);
  return true;
}

async function assertOutputIsAbsent(outputPath) {
  try {
    await access(outputPath, fsConstants.F_OK);
    fail("output already exists; refusing to overwrite it.");
  } catch (error) {
    if (error?.message?.startsWith("Portable release packaging failed:")) throw error;
    if (error?.code !== "ENOENT") fail("could not inspect output path.", error);
  }
}

export async function packagePortableRelease({
  executablePath,
  receiptPath,
  noticesPath,
  nodeLicensePath,
  outputPath,
}) {
  const output = assertStringPath(outputPath, "outputPath");
  const sources = [
    ["harness-mrtool.exe", executablePath],
    ["bundle-receipt.envelope.json", receiptPath],
    ["THIRD_PARTY_NOTICES.md", noticesPath],
    ["licenses/Node.txt", nodeLicensePath],
  ];
  const resolvedSources = sources.map(([name, path]) => [name, assertStringPath(path, name)]);
  if (resolvedSources.some(([, path]) => path === output)) fail("output must not replace an input file.");
  await mkdir(dirname(output), { recursive: true });
  await assertOutputIsAbsent(output);

  const entries = {};
  for (const [name, path] of resolvedSources) entries[name] = await readRegularFile(path, name);
  assertCanonicalReceipt(entries["bundle-receipt.envelope.json"]);
  entries["SHA256SUMS"] = Buffer.from(checksumText(Object.entries(entries)), "utf8");
  validateReleaseArchive(entries);
  const archive = zipSync(entries, {
    level: 0,
    mtime: new Date("1980-01-01T00:00:00.000Z"),
  });
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) fail("archive is outside the size bound.");

  const temporary = `${output}.${process.pid}.${cryptoRandomSuffix()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(archive);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link() is a same-directory, no-replace publication primitive on supported release filesystems.
    await link(temporary, output);
    await rm(temporary, { force: true });
    return output;
  } catch (error) {
    fail("could not publish the release archive atomically.", error);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function cryptoRandomSuffix() {
  return randomBytes(16).toString("hex");
}

function commandArguments(argv) {
  const allowed = new Map([
    ["--executable", "executablePath"],
    ["--receipt", "receiptPath"],
    ["--notices", "noticesPath"],
    ["--node-license", "nodeLicensePath"],
    ["--output", "outputPath"],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = allowed.get(argv[index]);
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith("--") || result[key] !== undefined) {
      fail("CLI arguments are invalid.");
    }
    result[key] = value;
  }
  if (Object.keys(result).length !== allowed.size) fail("all packaging paths are required.");
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await packagePortableRelease(commandArguments(process.argv.slice(2)));
}
