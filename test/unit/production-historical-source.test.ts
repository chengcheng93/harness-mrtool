import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { MAX_BUNDLE_MANIFEST_BYTES, MAX_BUNDLE_PAYLOAD_BYTES, MAX_BUNDLE_TOTAL_PAYLOAD_BYTES } from "../../src/bundle/load.ts";
import { TEMPLATE_BUNDLE_PAYLOAD_PATHS } from "../../src/bundle/types.ts";
import { MAX_SIGNED_ENVELOPE_BYTES } from "../../src/update/envelope.ts";
import type { HistoricalBundleReleaseAssetRequest } from "../../src/update/historical-bundle-loader.ts";
import { createProductionHistoricalBundleSource } from "../../src/update/production-historical-source.ts";
import { PRODUCTION_UPDATE_REPOSITORY } from "../../src/update/trust-config.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";

async function setup() {
  const fixture = await exactReleaseFixture();
  const request: HistoricalBundleReleaseAssetRequest = {
    ...fixture.reference, repository: PRODUCTION_UPDATE_REPOSITORY,
    receiptAssetName: "bundle-receipt.envelope.json",
    filePaths: ["bundle-manifest.json", ...TEMPLATE_BUNDLE_PAYLOAD_PATHS],
    limits: { receiptEnvelopeBytes: MAX_SIGNED_ENVELOPE_BYTES, manifestBytes: MAX_BUNDLE_MANIFEST_BYTES, payloadBytes: MAX_BUNDLE_PAYLOAD_BYTES, totalPayloadBytes: MAX_BUNDLE_TOTAL_PAYLOAD_BYTES },
  };
  const files = Object.fromEntries(fixture.assets.files);
  const archive = zipSync({ ...files, "profiles/": new Uint8Array(), "registries/": new Uint8Array() });
  return { fixture, request, files, archive };
}

test("production source uses pinned release paths and permits only HTTPS GitHub asset redirects", async () => {
  const { request, archive, fixture } = await setup();
  const calls: string[] = [];
  const source = createProductionHistoricalBundleSource({ fetch: async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, "GET");
    if (new URL(url).hostname === "github.com") return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/release/asset?name=${url.endsWith(".zip") ? "zip" : "receipt"}&sig=opaque` } });
    return new Response(url.includes("name=zip") ? Buffer.from(archive) : String(fixture.assets.receiptEnvelope));
  } });
  const assets = await source.loadExact(request);
  assert.deepEqual(assets?.files, new Map([...fixture.assets.files].map(([path, bytes]) => [path, Uint8Array.from(bytes)])));
  assert.equal(calls.length, 4);
  assert.equal(calls[0], `https://github.com/chengcheng93/harness-mrtool/releases/download/${request.releaseTag}/bundle-receipt.envelope.json`);
  for (const location of ["http://release-assets.githubusercontent.com/file", "https://evil.example/file", "https://github.com/other/repo/file", "https://user:secret@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file"]) {
    let requests = 0;
    const bad = createProductionHistoricalBundleSource({ fetch: async () => { requests++; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(bad.loadExact(request));
    assert.equal(requests, 1);
  }
});

test("untrusted repository/tag requests cannot cause any network request", async () => {
  const { request } = await setup();
  let requests = 0;
  const source = createProductionHistoricalBundleSource({ fetch: async () => { requests++; throw new Error("must not fetch"); } });
  for (const changes of [{ repository: { owner: "attacker", name: "harness-mrtool" } }, { releaseTag: "../../latest" }, { releaseTag: "templates-v9.0.0" }]) {
    await assert.rejects(source.loadExact({ ...request, ...changes }));
  }
  assert.equal(requests, 0);
});

test("missing release assets return null; oversized or unsuccessful responses fail closed", async () => {
  const { request } = await setup();
  assert.equal(await createProductionHistoricalBundleSource({ fetch: async () => new Response(null, { status: 404 }) }).loadExact(request), null);
  for (const response of [new Response("error", { status: 503 }), new Response("x", { headers: { "content-length": String(MAX_SIGNED_ENVELOPE_BYTES + 1) } }), new Response("x".repeat(MAX_SIGNED_ENVELOPE_BYTES + 1))]) {
    await assert.rejects(createProductionHistoricalBundleSource({ fetch: async () => response }).loadExact(request));
  }
});

test("archives reject traversal, unexpected files, duplicates, symlinks and decompression bombs", async () => {
  const { request, fixture, files, archive } = await setup();
  async function rejectsArchive(bytes: Uint8Array) {
    const source = createProductionHistoricalBundleSource({ fetch: async (url) => new Response(String(url).endsWith(".zip") ? Buffer.from(bytes) : String(fixture.assets.receiptEnvelope)) });
    await assert.rejects(source.loadExact(request));
  }
  await rejectsArchive(zipSync({ ...files, "../escape": new Uint8Array([1]) }));
  await rejectsArchive(zipSync({ ...files, "unsigned.txt": new Uint8Array([1]) }));
  await rejectsArchive(zipSync({ ...files, "layout.md": new Uint8Array(MAX_BUNDLE_PAYLOAD_BYTES + 1) }));
  const duplicate = Buffer.from(zipSync({ ...files, "aaaaaa.md": new Uint8Array([1]) }));
  for (let offset = duplicate.indexOf("aaaaaa.md"); offset !== -1; offset = duplicate.indexOf("aaaaaa.md")) duplicate.write("layout.md", offset);
  await rejectsArchive(duplicate);
  const link = Buffer.from(archive);
  const central = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  link.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  await rejectsArchive(link);
  await rejectsArchive(archive.subarray(0, archive.length - 10));
});

test("inflation cannot hide oversized output behind a forged uncompressed-size header", async () => {
  const { request, fixture, files } = await setup();
  const archive = Buffer.from(zipSync({ ...files, "layout.md": new Uint8Array(MAX_BUNDLE_PAYLOAD_BYTES + 1) }));
  let cursor = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (cursor !== -1) {
    const length = archive.readUInt16LE(cursor + 28);
    if (archive.subarray(cursor + 46, cursor + 46 + length).toString() === "layout.md") {
      archive.writeUInt32LE(10, cursor + 24);
      break;
    }
    cursor = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor + 4);
  }
  const source = createProductionHistoricalBundleSource({ fetch: async (url) => new Response(String(url).endsWith(".zip") ? archive : String(fixture.assets.receiptEnvelope)) });
  await assert.rejects(source.loadExact(request));
});
