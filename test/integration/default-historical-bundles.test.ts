import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createDefaultHistoricalBundleLoader } from "../../src/cli/default-historical-bundles.ts";
import { createProductionHistoricalBundleSource } from "../../src/update/production-historical-source.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { createProductionUpdateTrustConfig } from "../../src/update/trust-config.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";

async function currentSelection() {
  const bundle = await loadTemplateBundle(resolve(import.meta.dirname, "../../template-bundle"));
  return { bundle, bundleManifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`), releaseTag: `templates-v${bundle.manifest.version}`, releaseSetId: "embedded-current" };
}
function reference(current: Awaited<ReturnType<typeof currentSelection>>) {
  return { releaseTag: current.releaseTag, bundleManifestHash: current.bundleManifestHash, bundleId: current.bundle.manifest.bundleId, bundleVersion: current.bundle.manifest.version, policySchema: current.bundle.manifest.policySchema };
}

test("default history construction is lazy and accepts only the exact validated embedded reference", async () => {
  const current = await currentSelection();
  let loads = 0;
  const fixture = await exactReleaseFixture();
  const loader = createDefaultHistoricalBundleLoader(current, {
    trustConfig: fixture.trustConfig, trustState: fixture.trustState,
    releaseAssets: { async loadExact() { loads++; return null; } },
  });
  assert.equal(loads, 0);
  const result = await loader.loadVerifiedExact(reference(current));
  assert.equal(result.trusted, true);
  assert.deepEqual(result.bundle, current.bundle);
  assert.equal(loads, 0);
  for (const change of [
    { releaseTag: "templates-v0.9.0", bundleVersion: "0.9.0" },
    { bundleId: "different-bundle" }, { bundleManifestHash: "a".repeat(64) }, { policySchema: 2 },
  ]) {
    const loaded = await loader.loadVerifiedExact({ ...reference(current), ...change });
    assert.equal(loaded.trusted, false);
    assert.equal(loaded.bundle, null);
  }
  assert.equal(loads, 4);
});

test("default history rejects invalid reference metadata instead of falling back to current", async () => {
  const current = await currentSelection();
  const loader = createDefaultHistoricalBundleLoader(current);
  for (const change of [{ releaseTag: "cli-v1.0.0" }, { bundleVersion: "0.9.0" }, { extra: "untrusted" }]) {
    await assert.rejects(loader.loadVerifiedExact({ ...reference(current), ...change }));
  }
});

test("the embedded fast path revalidates the bundle and manifest hash", async () => {
  const current = await currentSelection();
  const bad = { ...current, bundleManifestHash: "a".repeat(64) };
  await assert.rejects(createDefaultHistoricalBundleLoader(bad).loadVerifiedExact(reference(bad)));
  const broken = structuredClone(current);
  Object.assign(broken.bundle, { layout: "invalid layout" });
  await assert.rejects(createDefaultHistoricalBundleLoader(broken).loadVerifiedExact(reference(broken)));
});

test("historical ZIP files are authenticated through a signed channel anchor and signed receipt", async () => {
  const fixture = await exactReleaseFixture();
  const current = { ...await currentSelection(), releaseTag: "templates-v2.0.0" };
  const urls: string[] = [];
  let payloads = Object.fromEntries(fixture.assets.files);
  const source = createProductionHistoricalBundleSource({
    repository: fixture.trustConfig.repository,
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(String(url).endsWith(".zip") ? Buffer.from(zipSync(payloads)) : String(fixture.assets.receiptEnvelope));
    },
  });
  const make = () => createDefaultHistoricalBundleLoader(current, {
    trustConfig: fixture.trustConfig, trustState: fixture.trustState, releaseAssets: source,
  });
  const loaded = await make().loadVerifiedExact(fixture.reference);
  assert.equal(loaded.trusted, true);
  assert.equal(loaded.bundle?.manifest.version, fixture.reference.bundleVersion);
  assert.deepEqual(urls.map((url) => new URL(url).pathname).sort(), [
    `/fixture-owner/harness-mrtool/releases/download/${fixture.reference.releaseTag}/bundle-receipt.envelope.json`,
    `/fixture-owner/harness-mrtool/releases/download/${fixture.reference.releaseTag}/harness-mr-templates.zip`,
  ]);
  payloads = { ...payloads, "layout.md": new TextEncoder().encode("tampered") };
  await assert.rejects(make().loadVerifiedExact(fixture.reference));
});

test("unanchored or incorrectly signed history is rejected", async () => {
  const fixture = await exactReleaseFixture();
  const current = { ...await currentSelection(), releaseTag: "templates-v2.0.0" };
  const production = createProductionUpdateTrustConfig();
  await assert.rejects(createDefaultHistoricalBundleLoader(current, {
    trustConfig: production, trustState: fixture.trustState, releaseAssets: { loadExact: async () => fixture.assets },
  }).loadVerifiedExact(fixture.reference));
  await assert.rejects(createDefaultHistoricalBundleLoader(current, {
    trustConfig: fixture.trustConfig, trustState: fixture.trustState,
    releaseAssets: { loadExact: async () => ({ ...fixture.assets, receiptEnvelope: "{}" }) },
  }).loadVerifiedExact(fixture.reference));
});

test("no signed channel anchor means no trusted historical bundle", async () => {
  const { createTrustState } = await import("../../src/update/envelope.ts");
  const fixture = await exactReleaseFixture();
  const current = { ...await currentSelection(), releaseTag: "templates-v2.0.0" };
  await assert.rejects(createDefaultHistoricalBundleLoader(current, {
    trustConfig: fixture.trustConfig,
    trustState: createTrustState(fixture.bootstrapKeys),
    releaseAssets: { loadExact: async () => fixture.assets },
  }).loadVerifiedExact(fixture.reference));
});

test("production trust state is read lazily and never accepts an unsigned channel", async () => {
  const current = await currentSelection();
  let reads = 0;
  let saves = 0;
  const urls: string[] = [];
  const loader = createDefaultHistoricalBundleLoader(current, {
    stateStore: {
      async load() { reads++; return null; },
      async save() { saves++; throw new Error("must not persist an unsigned channel"); },
    },
    channelTransport: { async request(request) { urls.push(request.url); return { status: 200, headers: {}, body: new TextEncoder().encode("{}") }; } },
  });
  assert.equal(reads, 0);
  assert.equal((await loader.loadVerifiedExact(reference(current))).trusted, true);
  assert.equal(reads, 0);
  await assert.rejects(loader.loadVerifiedExact({ ...reference(current), releaseTag: "templates-v0.9.0", bundleVersion: "0.9.0" }));
  assert.equal(reads, 1);
  assert.equal(saves, 0);
  assert.deepEqual(urls, ["https://chengcheng93.github.io/harness-mrtool/stable.envelope.json"]);
});

test("non-string version metadata is rejected before any historical state access", async () => {
  const current = await currentSelection();
  let reads = 0;
  const loader = createDefaultHistoricalBundleLoader(current, {
    stateStore: {
      async load() { reads++; throw new Error("must not load"); },
      async save() { throw new Error("must not save"); },
    },
  });
  await assert.rejects(loader.loadVerifiedExact({ ...reference(current), bundleVersion: [current.bundle.manifest.version] } as unknown as Parameters<typeof loader.loadVerifiedExact>[0]));
  assert.equal(reads, 0);
});

test("in-process historical channel endpoints cannot bypass canonical HTTPS validation", async () => {
  const current = await currentSelection();
  const fixture = await exactReleaseFixture();
  for (const channelUrl of ["http://fixture.example.test/stable.json", "https://fixture.example.test:444/stable.json", "https://user:secret@fixture.example.test/stable.json"]) {
    let requests = 0;
    let saves = 0;
    const loader = createDefaultHistoricalBundleLoader(current, {
      trustConfig: fixture.trustConfig,
      channelUrl,
      stateStore: { async load() { return null; }, async save() { saves++; throw new Error("must not save"); } },
      channelTransport: { async request() { requests++; throw new Error("must not request"); } },
    });
    await assert.rejects(loader.loadVerifiedExact({ ...reference(current), releaseTag: "templates-v1.0.0", bundleVersion: "1.0.0" }));
    assert.equal(requests, 0);
    assert.equal(saves, 0);
  }
});
