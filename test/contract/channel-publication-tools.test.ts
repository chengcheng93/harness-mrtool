import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createTrustState } from "../../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import { canonicalizeJson, type JsonObject } from "../../src/contracts/jcs.ts";
import { canonicalPayload, createSigningFixture, signedEnvelope } from "../helpers/signing.ts";
// @ts-expect-error Publication scripts intentionally have no declaration file.
import { assertChannelReleaseTags } from "../../scripts/verify-channel-release-inputs.mjs";

const repository = { owner: "chengcheng93", name: "harness-mrtool" };
function fixture() {
  const key = createSigningFixture("fixture-channel-key");
  const keys = [{ keyId: key.keyId, publicKeySpki: key.publicKeySpki, activeFromSequence: 1, revokedAtSequence: null }];
  const payload: JsonObject = { manifestVersion: 1, sequence: 1, channel: "stable", issuedAt: "2026-11-17T00:00:00Z", repository,
    components: {
      cli: { version: "0.1.14", tag: "cli-v0.1.14", inputSchemas: [1], policySchemas: [1], skillProtocols: [1], artifacts: {
        "darwin-arm64": { name: "harness-mrtool-darwin-arm64.zip", sha256: "a".repeat(64), size: 1 },
        "windows-x64": { name: "harness-mrtool-windows-x64.zip", sha256: "b".repeat(64), size: 1 },
      } },
      templates: { version: "1.2.0", tag: "templates-v1.2.0", inputSchema: 1, policySchema: 1, minCliVersion: "0.1.10", asset: "harness-mr-templates.zip", sha256: "c".repeat(64), size: 1 },
      skill: { version: "0.1.14", tag: "skill-v0.1.14", skillProtocol: 1, cliVersionRange: ">=0.1.14 <1.0.0", asset: "harness-mr-skill.zip", sha256: "d".repeat(64), size: 1, activation: "explicit-host-refresh" },
    }, releaseSet: { id: "stable-1", cli: "0.1.14", templates: "1.2.0" },
    security: { minimumAllowedCliVersion: "0.1.10", revokedCliVersions: [], revokedReleaseSetIds: [] }, recommendedSkillVersion: "0.1.14",
    templateHistory: [{ releaseTag: "templates-v1.2.0", bundleManifestHash: "e".repeat(64), receiptPayloadSha256: "f".repeat(64), signingSequence: 1, signingKeyId: key.keyId }],
  };
  return { key, keys, payload };
}
const tags = { cliTag: "cli-v0.1.14", templateTag: "templates-v1.2.0", skillTag: "skill-v0.1.14" };

test("publication accepts version-valued releaseSet after signed-manifest validation", () => {
  const f = fixture();
  const verified = verifyChannelEnvelope(signedEnvelope(canonicalPayload(f.payload), [f.key]), createTrustState(f.keys), repository);
  assert.equal(verified.manifest.releaseSet.cli, "0.1.14");
  assert.doesNotThrow(() => assertChannelReleaseTags(verified.manifest, tags));
  for (const [field, value] of Object.entries(tags)) {
    assert.throws(() => assertChannelReleaseTags(verified.manifest, { ...tags, [field]: value + "-other" }), /tags do not match/u);
  }
});

test("offline signer emits the existing canonical signed-channel format", async () => {
  // @ts-expect-error Publication script intentionally has no declaration file.
  const { signChannelManifest } = await import("../../scripts/create-channel-envelope.mjs");
  const f = fixture();
  const bytes = signChannelManifest(f.payload, f.key.privateKey, f.key.keyId);
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assert.equal(Buffer.from(bytes).toString("utf8"), canonicalizeJson(parsed) + "\n");
  const verified = verifyChannelEnvelope(bytes, createTrustState(f.keys), repository);
  assert.equal(verified.manifest.components.cli.version, "0.1.14");
  assertChannelReleaseTags(verified.manifest, tags);
});

test("production channel writer rejects an untrusted signing key before publishing output", async (t) => {
  // @ts-expect-error Publication script intentionally has no declaration file.
  const { createChannelEnvelope } = await import("../../scripts/create-channel-envelope.mjs");
  const f = fixture();
  const dir = await mkdtemp(resolve(tmpdir(), "harness-channel-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = resolve(dir, "payload.json"), keyPath = resolve(dir, "key.pem"), outputPath = resolve(dir, "stable.envelope.json");
  const pair = generateKeyPairSync("ed25519");
  await writeFile(manifestPath, canonicalizeJson(f.payload) + "\n");
  await writeFile(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  await assert.rejects(createChannelEnvelope({ manifestPath, privateKeyPath: keyPath, outputPath }), { code: "UPDATE_SECURITY_ERROR" });
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});
