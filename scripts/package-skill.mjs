import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalize } from "json-canonicalize";

const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MANIFEST_NAME = ".harness-skill-manifest.json";
const MAX_SKILL_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const MAX_MANIFEST_BYTES = 64 * 1024;
const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

function fail(message) {
  throw new Error(`Skill packaging failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertVersion(version) {
  if (typeof version !== "string" || !VERSION.test(version)) fail("version is invalid");
  return version;
}

function assertRelativePath(path) {
  if (path === MANIFEST_NAME || !SAFE_PATH.test(path) || path.length > 256 || path.endsWith("/") ||
      path.split("/").some((part) => part === "" || part === "." || part === ".." || part.endsWith(".") ||
        part.endsWith(" ") || RESERVED_DEVICE_NAME.test(part))) {
    fail("skill tree contains an unsafe path");
  }
  return path;
}

async function collectFiles(root, directory = root, prefix = "", limits = { count: 0, totalBytes: 0 }) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = assertRelativePath(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
    const absolute = resolve(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket()) {
      fail("skill tree contains a link or special file");
    }
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, absolute, relativePath, limits));
      continue;
    }
    if (!info.isFile() || info.size < 1 || info.size > MAX_SKILL_FILE_BYTES) fail("skill file is invalid or too large");
    limits.count += 1;
    if (limits.count > MAX_SKILL_FILES) fail("skill file count exceeds bootstrap limit");
    limits.totalBytes += info.size;
    if (limits.totalBytes > MAX_SKILL_BYTES) fail("skill tree total size exceeds bootstrap limit");
    files.push({ path: relativePath, source: absolute });
  }
  return files;
}

async function readStableFile(file) {
  const before = await lstat(file.source, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_SKILL_FILE_BYTES)) {
    fail("skill file changed or is too large");
  }
  let handle;
  try {
    handle = await open(file.source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail("skill file changed while it was opened");
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.byteLength !== Number(before.size)) {
      fail("skill file changed while it was read");
    }
    return bytes;
  } catch (error) {
    if (error?.message?.startsWith("Skill packaging failed:")) throw error;
    fail("could not read skill file", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function prepareSkillTree({
  inputDirectory,
  outputDirectory,
  version,
  cliVersionRange = ">=1.2.0 <2.0.0",
  skillProtocol = 1,
}) {
  const parsedVersion = assertVersion(version);
  if (typeof cliVersionRange !== "string" || cliVersionRange.length === 0 ||
      !Number.isSafeInteger(skillProtocol) || skillProtocol < 1) {
    fail("manifest metadata is invalid");
  }
  const input = resolve(inputDirectory);
  const output = resolve(outputDirectory);
  const inputKey = process.platform === "win32" ? input.toLowerCase() : input;
  const outputKey = process.platform === "win32" ? output.toLowerCase() : output;
  if (inputKey === outputKey || outputKey.startsWith(`${inputKey}${sep}`)) fail("output must not be inside input");
  const inputInfo = await lstat(input);
  if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink()) fail("input directory is invalid");
  const limits = { count: 0, totalBytes: 0 };
  const files = (await collectFiles(input, input, "", limits)).sort((left, right) => comparePath(left.path, right.path));
  if (!files.some((file) => file.path === "SKILL.md")) fail("skill tree must contain SKILL.md");
  await mkdir(output, { recursive: true });
  const outputInfo = await lstat(output);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) fail("output directory is invalid");
  if ((await readdir(output)).length !== 0) fail("output directory must be empty");
  const records = [];
  let actualTotalBytes = 0;
  for (const file of files) {
    const bytes = await readStableFile(file);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_SKILL_FILE_BYTES) fail("skill file changed or is too large");
    actualTotalBytes += bytes.byteLength;
    if (actualTotalBytes > MAX_SKILL_BYTES) fail("skill tree total size exceeds bootstrap limit");
    const destination = resolve(output, file.path.replaceAll("/", sep));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    records.push({ path: file.path, sha256: sha256(bytes), size: bytes.byteLength });
  }
  const treeSha256 = sha256(Buffer.from(`${canonicalize(records)}\n`, "utf8"));
  if (!SHA256.test(treeSha256)) fail("tree hash generation failed");
  const manifest = {
    activation: "explicit-host-refresh",
    cliVersionRange,
    files: records,
    manifestVersion: 1,
    skillProtocol,
    tag: `skill-v${parsedVersion}`,
    treeSha256,
    version: parsedVersion,
  };
  const manifestBytes = Buffer.from(`${canonicalize(manifest)}\n`, "utf8");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES || actualTotalBytes + manifestBytes.byteLength > MAX_SKILL_BYTES) {
    fail("skill tree including its manifest exceeds bootstrap total-size limit");
  }
  await writeFile(resolve(output, MANIFEST_NAME), manifestBytes, { flag: "wx" });
  return manifest;
}

function cliArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) fail("CLI arguments are invalid");
    const field = {
      "--input": "inputDirectory",
      "--output": "outputDirectory",
      "--version": "version",
      "--cli-version-range": "cliVersionRange",
    }[key];
    if (field === undefined || result[field] !== undefined) fail("CLI arguments are invalid");
    result[field] = value;
  }
  if (result.inputDirectory === undefined || result.outputDirectory === undefined || result.version === undefined) {
    fail("input, output, and version are required");
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareSkillTree(cliArguments(process.argv.slice(2)));
}
