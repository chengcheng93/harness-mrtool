import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { lstat, link, mkdir, open, readdir, rm } from "node:fs/promises";
import { zipSync } from "fflate";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 128;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SECRET_SHAPE = /(?:glpat-[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/u;
const ARCHIVE_NAME = "harness-mrtool-codex-plugin.zip";
const SUMS_NAME = "SHA256SUMS";

function fail(message, cause) {
  throw new Error(`Codex plugin packaging failed: ${message}`, cause === undefined ? undefined : { cause });
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

function assertSafeArchiveName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 256 ||
      name.includes("\\") || name.includes("\0") || !SAFE_PATH.test(name) ||
      name.split("/").some((part) => part === "" || part === "." || part === ".." ||
        part.endsWith(".") || part.endsWith(" "))) {
    fail("plugin tree contains an unsafe path");
  }
  const reserved = name.split("/").some((part) => /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part));
  if (reserved) fail("plugin tree contains a reserved device name");
  return name;
}

async function readStableFile(path, displayName) {
  let handle;
  let before;
  try {
    before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(MAX_FILE_BYTES)) {
      fail(`${displayName} is not a bounded regular file`);
    }
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail(`${displayName} changed while it was opened`);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || bytes.byteLength !== Number(before.size)) {
      fail(`${displayName} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error?.message?.startsWith("Codex plugin packaging failed:")) throw error;
    fail(`could not read ${displayName}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function collectFiles(root, directory = root, prefix = "", state = { count: 0, total: 0 }) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = assertSafeArchiveName(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
    const absolute = resolve(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket()) {
      fail("plugin tree contains a link or special file");
    }
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, absolute, relativePath, state));
      continue;
    }
    if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES) fail("plugin file is invalid or too large");
    state.count += 1;
    state.total += info.size;
    if (state.count > MAX_FILES || state.total > MAX_ARCHIVE_BYTES) fail("plugin tree exceeds size limits");
    files.push({ path: relativePath, source: absolute });
  }
  return files;
}

function parsePluginManifest(bytes, version) {
  let manifest;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    manifest = JSON.parse(text);
  } catch (error) {
    if (error?.message?.startsWith("Codex plugin packaging failed:")) throw error;
    fail("plugin.json is not valid UTF-8 JSON", error);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) ||
      manifest.name !== "harness-mrtool" || manifest.version !== version ||
      typeof manifest.description !== "string" || typeof manifest.skills !== "string" ||
      manifest.skills.replace(/\/$/u, "") !== "./skills") {
    fail("plugin manifest identity or skills path is invalid");
  }
  if (manifest.interface === null || typeof manifest.interface !== "object" ||
      typeof manifest.interface.displayName !== "string" ||
      typeof manifest.interface.shortDescription !== "string" ||
      typeof manifest.interface.longDescription !== "string" ||
      typeof manifest.interface.defaultPrompt === "undefined") {
    fail("plugin interface metadata is invalid");
  }
  return manifest;
}

function validateSkillFiles(entries) {
  const skill = entries["skills/harness-mr/SKILL.md"];
  if (skill === undefined) fail("plugin must contain skills/harness-mr/SKILL.md");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(skill);
  if (!text.startsWith("---\n") || !text.includes("\nname: harness-mr\n") || !text.includes("\ndescription:")) {
    fail("bundled Skill frontmatter is invalid");
  }
  if (Object.values(entries).some((bytes) => SECRET_SHAPE.test(new TextDecoder().decode(bytes)))) {
    fail("plugin tree contains a credential-shaped value");
  }
}

function assertOutputAbsent(path) {
  return lstat(path).then(() => fail(`output already exists: ${path}`)).catch((error) => {
    if (error?.message?.startsWith("Codex plugin packaging failed:")) throw error;
    if (error?.code !== "ENOENT") fail(`could not inspect output: ${path}`, error);
  });
}

export async function packagePlugin({ inputDirectory, outputDirectory, version }) {
  const parsedVersion = assertVersion(version);
  const root = resolve(inputDirectory);
  const output = resolve(outputDirectory);
  const files = (await collectFiles(root)).sort((left, right) => comparePath(left.path, right.path));
  const entries = {};
  for (const file of files) entries[file.path] = await readStableFile(file.source, file.path);
  const manifestPath = ".codex-plugin/plugin.json";
  if (entries[manifestPath] === undefined) fail("plugin manifest is missing");
  parsePluginManifest(entries[manifestPath], parsedVersion);
  validateSkillFiles(entries);
  const archive = zipSync(entries, {
    level: 0,
    mtime: new Date("1980-01-01T00:00:00.000Z"),
  });
  if (archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) fail("archive is outside the size limit");
  await mkdir(output, { recursive: true });
  const archivePath = resolve(output, ARCHIVE_NAME);
  const sumsPath = resolve(output, SUMS_NAME);
  await assertOutputAbsent(archivePath);
  await assertOutputAbsent(sumsPath);
  const sums = Buffer.from(`${sha256(archive)}  ${ARCHIVE_NAME}\n`, "utf8");
  const suffix = randomBytes(16).toString("hex");
  const temporaryArchive = `${archivePath}.${process.pid}.${suffix}.tmp`;
  const temporarySums = `${sumsPath}.${process.pid}.${suffix}.tmp`;
  try {
    await writeAtomic(temporaryArchive, archive, archivePath);
    await writeAtomic(temporarySums, sums, sumsPath);
  } finally {
    await rm(temporaryArchive, { force: true }).catch(() => undefined);
    await rm(temporarySums, { force: true }).catch(() => undefined);
  }
  return Object.freeze({ archivePath, sumsPath, archiveSha256: sha256(archive), archiveSize: archive.byteLength });
}

async function writeAtomic(temporary, bytes, destination) {
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link() publishes without replacing a destination created by another process.
    await link(temporary, destination);
    await rm(temporary, { force: true });
  } catch (error) {
    fail(`could not publish ${destination}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function cliArguments(argv) {
  const allowed = new Map([["--input", "inputDirectory"], ["--output", "outputDirectory"], ["--version", "version"]]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = allowed.get(argv[index]);
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith("--") || result[key] !== undefined) fail("CLI arguments are invalid");
    result[key] = value;
  }
  if (Object.keys(result).length !== allowed.size) fail("all packaging paths are required");
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await packagePlugin(cliArguments(process.argv.slice(2)));
}
