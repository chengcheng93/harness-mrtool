import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Generates a production Ed25519 signing root for the update trust chain.
// The private key is written once (never overwritten) to the path given on
// the command line, which must be outside the repository. Only the public
// half is printed; it is what src/update/trust-config.ts pins.

const KEY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const TEST_MARKER = /(?:^|[._-])(?:dev|development|example|fake|fixture|local|loopback|sample|test)(?:$|[._-])/iu;

function fail(message, cause) {
  throw new Error(`Release key generation failed: ${message}`, cause === undefined ? undefined : { cause });
}

function args(argv) {
  const fields = new Map([["--key-id", "keyId"], ["--output", "outputPath"]]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = fields.get(argv[index]);
    const value = argv[index + 1];
    if (field === undefined || value === undefined || value.startsWith("--") || result[field] !== undefined) {
      fail("use --key-id and --output exactly once each");
    }
    result[field] = value;
  }
  if (result.keyId === undefined || result.outputPath === undefined) fail("--key-id and --output are required");
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

export async function createReleaseKey({ keyId, outputPath }) {
  if (!KEY_ID.test(keyId)) fail("key id is invalid");
  if (TEST_MARKER.test(keyId)) fail("key id must not carry a test marker; production trust rejects it");
  const output = resolve(outputPath);
  if (!/\.pem$/iu.test(output)) fail("--output must end in .pem");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync("ed25519");
  await writeNoReplace(output, pair.privateKey.export({ format: "pem", type: "pkcs8" }));
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const publicRecord = {
    keyId,
    publicKeySpki: spki.toString("base64url"),
    spkiSha256: createHash("sha256").update(spki).digest("hex"),
    algorithm: "Ed25519",
    privateKeyPath: output,
  };
  await writeNoReplace(output.replace(/\.pem$/iu, ".public.json"), `${JSON.stringify(publicRecord, null, 2)}\n`);
  return publicRecord;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = await createReleaseKey(args(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
