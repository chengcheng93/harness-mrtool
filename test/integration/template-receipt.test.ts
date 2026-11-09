import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { verifyTemplatePublicationReceipt } from "../../src/update/template-publication.ts";
import { createTestOnlyUpdateTrustConfig } from "../../src/update/trust-config.ts";
import { canonicalPayload, createSigningFixture } from "../helpers/signing.ts";
// @ts-expect-error Release tooling intentionally has no declaration file.
import { buildTemplateReceiptPayload, createTemplateReceipt } from "../../scripts/create-template-receipt.mjs";
// @ts-expect-error Release tooling intentionally has no declaration file.
import { readTemplatePublicationInputs } from "../../scripts/verify-template-publication.mjs";

const root = resolve(import.meta.dirname, "../..");
const bundleDirectory = resolve(root, "template-bundle");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: test.TestContext) {
  const work = await mkdtemp(resolve(await realpath(tmpdir()), "template-receipt-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  // This key is generated for this test only; it is not the production release key.
  const key = createSigningFixture("release-key-1");
  const privateKeyPath = resolve(work, "test-key.pem");
  await writeFile(privateKeyPath, key.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const trustConfig = createTestOnlyUpdateTrustConfig({
    repository: { owner: "chengcheng93", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:43123",
    bootstrapKeys: [{ keyId: key.keyId, publicKeySpki: key.publicKeySpki, activeFromSequence: 1, revokedAtSequence: null }],
  });
  return { work, key, privateKeyPath, trustConfig };
}

test("the generated template receipt verifies through the publication verifier for the current bundle", async (t) => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(resolve(bundleDirectory, "bundle-manifest.json"), "utf8"));
  const receipt = resolve(f.work, "bundle-receipt.envelope.json");
  const result = await createTemplateReceipt({ directory: bundleDirectory, privateKeyPath: f.privateKeyPath, outputPath: receipt });
  const tag = `templates-v${String(manifest.version)}`;
  assert.equal(result.releaseTag, tag);
  assert.equal(result.secretPath, `${receipt}.b64`);

  const inputs = await readTemplatePublicationInputs({ directory: bundleDirectory, receipt, tag });
  const verified = verifyTemplatePublicationReceipt({ ...inputs, trustConfig: f.trustConfig });
  assert.equal(verified.purpose, "template-publication-only");
  assert.equal(verified.receipt.bundleVersion, manifest.version);
  assert.equal(verified.receipt.releaseTag, tag);
  assert.equal(verified.receipt.signingKeyId, "release-key-1");
  assert.equal(verified.receipt.signingSequence, 1);
  assert.deepEqual(verified.receipt.skillProtocols, [1]);
  assert.equal(verified.signingKeyId, f.key.keyId);
  assert.equal(verified.bundleManifestHash, hash(await readFile(resolve(bundleDirectory, "bundle-manifest.json"))));
  assert.equal(verified.bundleManifestHash, result.bundleManifestHash);
  const { payload } = await buildTemplateReceiptPayload({ directory: bundleDirectory });
  assert.equal(verified.payloadSha256, hash(canonicalPayload(payload)));
  assert.equal(verified.payloadSha256, result.payloadSha256);

  // The workflow secret is the plain base64 of the exact envelope bytes.
  const envelopeBytes = await readFile(receipt);
  assert.equal(Buffer.from(await readFile(`${receipt}.b64`, "utf8"), "base64").equals(envelopeBytes), true);
  assert.doesNotMatch(await readFile(`${receipt}.b64`, "utf8"), /\s/u);
});

test("the generator honours an explicit signing sequence and never overwrites an existing receipt", async (t) => {
  const f = await fixture(t);
  const receipt = resolve(f.work, "receipt.json");
  await createTemplateReceipt({ directory: bundleDirectory, privateKeyPath: f.privateKeyPath, outputPath: receipt, signingSequence: 7 });
  const tag = `templates-v${String(JSON.parse(await readFile(resolve(bundleDirectory, "bundle-manifest.json"), "utf8")).version)}`;
  const inputs = await readTemplatePublicationInputs({ directory: bundleDirectory, receipt, tag });
  assert.equal(verifyTemplatePublicationReceipt({ ...inputs, trustConfig: f.trustConfig }).receipt.signingSequence, 7);
  await assert.rejects(
    createTemplateReceipt({ directory: bundleDirectory, privateKeyPath: f.privateKeyPath, outputPath: receipt }),
    /could not write/u,
  );
  await assert.rejects(buildTemplateReceiptPayload({ directory: bundleDirectory, signingSequence: 0 }), /signing sequence/u);
});

test("the generator refuses a bundle whose payload bytes drifted from its manifest", async (t) => {
  const f = await fixture(t);
  const tampered = resolve(f.work, "bundle");
  await cp(bundleDirectory, tampered, { recursive: true });
  await writeFile(resolve(tampered, "policy.yml"), `${await readFile(resolve(tampered, "policy.yml"), "utf8")}# drift\n`);
  await assert.rejects(
    createTemplateReceipt({ directory: tampered, privateKeyPath: f.privateKeyPath, outputPath: resolve(f.work, "drift.json") }),
    /policy\.yml does not match the manifest/u,
  );
});

test("a receipt signed by a key other than the pinned root is rejected by the verifier", async (t) => {
  const f = await fixture(t);
  const other = createSigningFixture("release-key-1");
  const otherKeyPath = resolve(f.work, "other-key.pem");
  await writeFile(otherKeyPath, other.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const receipt = resolve(f.work, "other-receipt.json");
  await createTemplateReceipt({ directory: bundleDirectory, privateKeyPath: otherKeyPath, outputPath: receipt });
  const tag = `templates-v${String(JSON.parse(await readFile(resolve(bundleDirectory, "bundle-manifest.json"), "utf8")).version)}`;
  const inputs = await readTemplatePublicationInputs({ directory: bundleDirectory, receipt, tag });
  assert.throws(() => verifyTemplatePublicationReceipt({ ...inputs, trustConfig: f.trustConfig }), /signature validation failed/u);
  // Without an injected test trust config the verifier only accepts the production root.
  assert.throws(() => verifyTemplatePublicationReceipt(inputs), /signature validation failed/u);
});
