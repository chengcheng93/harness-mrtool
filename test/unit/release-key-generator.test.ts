import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createTestOnlyUpdateTrustConfig } from "../../src/update/trust-config.ts";
// @ts-expect-error Release tooling intentionally has no declaration file.
import { createReleaseKey } from "../../scripts/create-release-key.mjs";

async function workDirectory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(resolve(await realpath(tmpdir()), "release-key-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("the generator writes a pkcs8 Ed25519 key once and reports the exact pinned public form", async (t) => {
  const work = await workDirectory(t);
  const outputPath = resolve(work, "keys", "release-key-9.pem");
  const record = await createReleaseKey({ keyId: "release-key-9", outputPath });

  const privateKey = createPrivateKey(await readFile(outputPath));
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  assert.equal(record.publicKeySpki, spki.toString("base64url"));
  assert.equal(record.spkiSha256, createHash("sha256").update(spki).digest("hex"));
  assert.equal(record.keyId, "release-key-9");
  const payload = Buffer.from("payload");
  assert.equal(verify(null, payload, createPublicKey(privateKey), sign(null, payload, privateKey)), true);

  // The public record is also persisted next to the key and is accepted as a trust root shape.
  const persisted = JSON.parse(await readFile(resolve(work, "keys", "release-key-9.public.json"), "utf8"));
  assert.equal(persisted.publicKeySpki, record.publicKeySpki);
  assert.doesNotThrow(() => createTestOnlyUpdateTrustConfig({
    repository: { owner: "chengcheng93", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:43123",
    bootstrapKeys: [{ keyId: record.keyId, publicKeySpki: record.publicKeySpki, activeFromSequence: 1, revokedAtSequence: null }],
  }));

  await assert.rejects(createReleaseKey({ keyId: "release-key-9", outputPath }), /could not write/u);
  assert.equal(createPrivateKey(await readFile(outputPath)).export({ format: "der", type: "pkcs8" }).equals(
    privateKey.export({ format: "der", type: "pkcs8" }) as Buffer), true);
});

test("the generator rejects test-marked or malformed key ids and non-pem outputs", async (t) => {
  const work = await workDirectory(t);
  for (const keyId of ["test-key", "release-key-fake", "release.sample.1", "-bad", "bad-", "a b"]) {
    await assert.rejects(createReleaseKey({ keyId, outputPath: resolve(work, "x.pem") }), /key id/u, keyId);
  }
  await assert.rejects(createReleaseKey({ keyId: "release-key-2", outputPath: resolve(work, "key.txt") }), /\.pem/u);
});
