import { createHash, createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalize } from "json-canonicalize";

// Offline companion of scripts/verify-template-publication.mjs: builds and signs
// the template-bundle receipt that the release workflow decodes from the
// TEMPLATE_BUNDLE_RECEIPT_B64 secret. The private release key never enters the
// repository; it is read from the path given on the command line only.

const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PAYLOAD_PATHS = [
  "layout.md",
  "policy.yml",
  "profiles/code.yml",
  "profiles/docs.yml",
  "profiles/general.yml",
  "profiles/ops.yml",
  "registries/checkboxes.json",
  "registries/fields.json",
  "schema.json",
];
const REPOSITORY = { name: "harness-mrtool", owner: "chengcheng93" };
const KEY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;

function fail(message, cause) {
  throw new Error(`Template receipt generation failed: ${message}`, cause === undefined ? undefined : { cause });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function args(argv) {
  const fields = new Map([
    ["--directory", "directory"],
    ["--key", "privateKeyPath"],
    ["--key-id", "signingKeyId"],
    ["--output", "outputPath"],
    ["--sequence", "signingSequence"],
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
  for (const required of ["directory", "privateKeyPath", "signingKeyId", "outputPath"]) {
    if (result[required] === undefined) fail("--directory, --key, --key-id and --output are required");
  }
  if (result.signingSequence !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(result.signingSequence)) fail("--sequence must be a positive integer");
    result.signingSequence = Number(result.signingSequence);
  }
  return result;
}

async function regularFile(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) fail("bundle payload is not a regular file");
  return readFile(path);
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

/** Builds the exact receipt payload for the bundle directory; no signing. */
export async function buildTemplateReceiptPayload({ directory, signingKeyId, signingSequence = 1 }) {
  if (typeof signingKeyId !== "string" || !KEY_ID.test(signingKeyId)) fail("signing key id is invalid");
  if (!Number.isSafeInteger(signingSequence) || signingSequence < 1) fail("signing sequence is invalid");
  const manifestBytes = await regularFile(resolve(directory, "bundle-manifest.json"));
  const manifestText = manifestBytes.toString("utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    fail("bundle manifest is not JSON", error);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) ||
      manifestText !== `${canonicalize(manifest)}\n` ||
      manifest.manifestVersion !== 1 || typeof manifest.bundleId !== "string" ||
      typeof manifest.version !== "string" || !VERSION.test(manifest.version) ||
      manifest.inputSchema !== 1 || manifest.policySchema !== 1 ||
      !Array.isArray(manifest.files) || manifest.files.length !== PAYLOAD_PATHS.length) {
    fail("bundle manifest is invalid");
  }
  const files = [{ path: "bundle-manifest.json", sha256: sha256(manifestBytes), size: manifestBytes.length }];
  for (const [index, expectedPath] of PAYLOAD_PATHS.entries()) {
    const entry = manifest.files[index];
    const bytes = await regularFile(resolve(directory, expectedPath));
    if (entry === null || typeof entry !== "object" || entry.path !== expectedPath ||
        entry.size !== bytes.length || entry.sha256 !== sha256(bytes) || !SHA256.test(entry.sha256)) {
      fail(`bundle payload ${expectedPath} does not match the manifest`);
    }
    files.push({ path: expectedPath, sha256: entry.sha256, size: entry.size });
  }
  const payload = {
    bundleId: manifest.bundleId,
    bundleManifest: { sha256: files[0].sha256, size: files[0].size },
    bundleVersion: manifest.version,
    files,
    inputSchema: manifest.inputSchema,
    policySchema: manifest.policySchema,
    receiptType: "template-bundle",
    receiptVersion: 1,
    releaseTag: `templates-v${manifest.version}`,
    repository: REPOSITORY,
    signingKeyId,
    signingSequence,
    skillProtocols: [1],
  };
  return { payload, payloadBytes: Buffer.from(`${canonicalize(payload)}\n`, "utf8") };
}

export async function createTemplateReceipt({ directory, privateKeyPath, signingKeyId, outputPath, signingSequence = 1 }) {
  const { payload, payloadBytes } = await buildTemplateReceiptPayload({ directory, signingKeyId, signingSequence });
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") fail("the release key must be an Ed25519 private key");
  const envelope = {
    payload: payloadBytes.toString("base64url"),
    signatures: [{
      algorithm: "Ed25519",
      keyId: signingKeyId,
      signature: sign(null, payloadBytes, privateKey).toString("base64url"),
    }],
  };
  const envelopeBytes = Buffer.from(`${canonicalize(envelope)}\n`, "utf8");
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeNoReplace(outputPath, envelopeBytes);
  // The workflow secret is the standard base64 of the envelope bytes.
  await writeNoReplace(`${outputPath}.b64`, Buffer.from(envelopeBytes.toString("base64"), "utf8"));
  return {
    outputPath,
    secretPath: `${outputPath}.b64`,
    signingKeyId,
    releaseTag: payload.releaseTag,
    bundleManifestHash: payload.bundleManifest.sha256,
    payloadSha256: sha256(payloadBytes),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await createTemplateReceipt(args(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
