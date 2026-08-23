import { createHash, createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lstat, open, readFile } from "node:fs/promises";
import { canonicalize } from "json-canonicalize";

const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function fail(message, cause) {
  throw new Error(`Skill receipt generation failed: ${message}`, cause === undefined ? undefined : { cause });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function args(argv) {
  const fields = new Map([
    ["--manifest", "manifestPath"],
    ["--archive", "archivePath"],
    ["--version", "version"],
    ["--key", "privateKeyPath"],
    ["--output", "outputPath"],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = fields.get(argv[index]);
    const value = argv[index + 1];
    if (field === undefined || value === undefined || value.startsWith("--") || result[field] !== undefined) {
      fail("CLI arguments are invalid");
    }
    result[field] = value;
  }
  if (Object.keys(result).length !== fields.size || !VERSION.test(result.version)) fail("required arguments are invalid");
  return result;
}

async function writeNoReplace(path, bytes) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    fail(`could not write ${path}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function createSkillReceipt({ manifestPath, archivePath, version, privateKeyPath, outputPath }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const archive = await readFile(archivePath);
  const archiveInfo = await lstat(archivePath, { bigint: true });
  if (!archiveInfo.isFile() || archive.length < 1 || !SHA256.test(sha256(archive))) fail("archive is invalid");
  if (manifest.version !== version || manifest.tag !== `skill-v${version}` || manifest.manifestVersion !== 1 ||
      !Number.isSafeInteger(manifest.skillProtocol) || !Array.isArray(manifest.files) ||
      typeof manifest.treeSha256 !== "string" || !SHA256.test(manifest.treeSha256)) {
    fail("skill manifest is invalid");
  }
  const payload = {
    asset: {
      name: "harness-mr-skill.zip",
      sha256: sha256(archive),
      size: archive.length,
    },
    cliVersionRange: manifest.cliVersionRange,
    files: manifest.files,
    receiptType: "skill-bundle",
    receiptVersion: 1,
    releaseTag: `skill-v${version}`,
    repository: { name: "harness-mrtool", owner: "chengcheng93" },
    signingKeyId: "release-key-1",
    signingSequence: 1,
    skillProtocol: manifest.skillProtocol,
    treeSha256: manifest.treeSha256,
    version,
  };
  const payloadBytes = Buffer.from(`${canonicalize(payload)}\n`, "utf8");
  const envelope = {
    payload: payloadBytes.toString("base64url"),
    signatures: [{
      algorithm: "Ed25519",
      keyId: "release-key-1",
      signature: sign(null, payloadBytes, createPrivateKey(await readFile(privateKeyPath))).toString("base64url"),
    }],
  };
  await writeNoReplace(outputPath, Buffer.from(`${canonicalize(envelope)}\n`, "utf8"));
  return { outputPath, payloadSha256: sha256(payloadBytes) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await createSkillReceipt(args(process.argv.slice(2)));
}
