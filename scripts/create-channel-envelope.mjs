import { createPrivateKey, sign } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "json-canonicalize";
import { createTrustState } from "../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../src/update/manifest.ts";
import { createProductionUpdateTrustConfig } from "../src/update/trust-config.ts";

/** Offline signing only; the production writer verifies the pinned root before publication. */
export function signChannelManifest(manifest, privateKey, keyId = "release-key-2") {
  const payload = Buffer.from(canonicalize(manifest) + "\n", "utf8");
  return Buffer.from(canonicalize({ payload: payload.toString("base64url"), signatures: [{
    keyId, algorithm: "Ed25519", signature: sign(null, payload, privateKey).toString("base64url"),
  }] }) + "\n", "utf8");
}

export async function createChannelEnvelope({ manifestPath, privateKeyPath, outputPath }) {
  const input = await readFile(manifestPath);
  if (input.length > 256 * 1024) throw new Error("Channel manifest exceeds its size limit");
  const bytes = signChannelManifest(JSON.parse(input.toString("utf8")), createPrivateKey(await readFile(privateKeyPath)));
  const config = createProductionUpdateTrustConfig();
  const verified = verifyChannelEnvelope(bytes, createTrustState(config.bootstrapKeys), config.repository, config.bootstrapKeys);
  const handle = await open(outputPath, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { outputPath, sequence: verified.manifest.sequence, payloadSha256: verified.payloadSha256 };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const fields = new Map([["--manifest", "manifestPath"], ["--key", "privateKeyPath"], ["--output", "outputPath"]]);
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const field = fields.get(process.argv[i]), value = process.argv[i + 1];
    if (field === undefined || value === undefined || value.startsWith("--") || Object.hasOwn(options, field)) throw new Error("Use --manifest, --key and --output exactly once each");
    options[field] = value;
  }
  if (Object.keys(options).length !== fields.size) throw new Error("Manifest, external signing key and output paths are required");
  process.stdout.write(JSON.stringify(await createChannelEnvelope(options)) + "\n");
}
