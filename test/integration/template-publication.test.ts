import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { zipSync } from "fflate";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, type JsonObject } from "../../src/contracts/jcs.ts";
import { createTrustState } from "../../src/update/envelope.ts";
import { verifyBundleReceiptEnvelope } from "../../src/update/bundle-receipt.ts";
import { verifyTemplatePublicationReceipt } from "../../src/update/template-publication.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";
import { canonicalPayload, createSigningFixture, signedEnvelope } from "../helpers/signing.ts";
// @ts-expect-error Release tooling deliberately has no declaration file.
import { readTemplatePublicationInputs } from "../../scripts/verify-template-publication.mjs";

const script = resolve(import.meta.dirname, "../../scripts/verify-template-publication.mjs");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function security(error: unknown): boolean {
  assert.equal(isToolError(error, "UPDATE_SECURITY_ERROR"), true, String(error));
  return true;
}
async function fixture(t: test.TestContext) {
  const f = await exactReleaseFixture();
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "template-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = resolve(root, "template");
  for (const [path, bytes] of f.mutableFiles) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await writeFile(resolve(directory, path), bytes);
  }
  const receiptPath = resolve(root, "receipt.json");
  await writeFile(receiptPath, f.assets.receiptEnvelope);
  const options = {
    envelope: typeof f.assets.receiptEnvelope === "string" ? f.assets.receiptEnvelope : new TextDecoder().decode(f.assets.receiptEnvelope),
    files: new Map(f.mutableFiles),
    trustConfig: f.trustConfig,
    expectedTag: "templates-v1.1.0",
    expectedVersion: "1.1.0",
  };
  const sign = (overrides: JsonObject) => signedEnvelope(canonicalPayload({ ...f.receiptPayload, ...overrides }), [f.signingKey]);
  return { f, root, directory, receiptPath, options, sign };
}

test("valid 1.1.0 receipt verifies for publication without authorizing unanchored runtime loading", async (t) => {
  const { f, options } = await fixture(t);
  const checked = verifyTemplatePublicationReceipt(options);
  assert.equal(checked.purpose, "template-publication-only");
  assert.equal(checked.receipt.bundleVersion, "1.1.0");
  assert.equal(checked.receipt.releaseTag, "templates-v1.1.0");
  assert.equal(checked.payloadSha256, hash(canonicalPayload(f.receiptPayload)));
  assert.equal(checked.bundleManifestHash, hash(options.files.get("bundle-manifest.json")!));
  assert.equal(checked.signingKeyId, f.signingKey.keyId);
  assert.equal(Object.isFrozen(checked.receipt.files[0]), true);
  assert.throws(() => verifyBundleReceiptEnvelope(options.envelope,
    createTrustState(f.bootstrapKeys), {
      repository: f.trustConfig.repository, releaseTag: options.expectedTag,
      bundleManifestHash: checked.bundleManifestHash,
    }, options.files, f.bootstrapKeys), security);
  assert.doesNotThrow(() => verifyBundleReceiptEnvelope(options.envelope,
    f.trustState, { repository: f.trustConfig.repository, releaseTag: options.expectedTag,
      bundleManifestHash: checked.bundleManifestHash }, options.files, f.bootstrapKeys));
});

for (const attack of ["zero64", "wrong-key", "unsigned", "noncanonical-envelope", "noncanonical-payload", "wrong-repo", "wrong-tag", "wrong-version", "signer-mismatch", "invalid-signing-sequence", "manifest-hash"] as const) {
  test(`publication rejects ${attack}`, async (t) => {
    const { f, options, sign } = await fixture(t);
    let envelope = options.envelope;
    switch (attack) {
      case "zero64": { const value = JSON.parse(envelope); value.signatures[0].signature = Buffer.alloc(64).toString("base64url"); envelope = `${canonicalizeJson(value)}\n`; break; }
      case "wrong-key": envelope = signedEnvelope(canonicalPayload(f.receiptPayload), [createSigningFixture(f.signingKey.keyId)]); break;
      case "unsigned": envelope = `${canonicalizeJson(f.receiptPayload)}\n`; break;
      case "noncanonical-envelope": envelope = JSON.stringify(JSON.parse(envelope), null, 2); break;
      case "noncanonical-payload": envelope = signedEnvelope(Buffer.from(JSON.stringify(f.receiptPayload, null, 2)), [f.signingKey]); break;
      case "wrong-repo": envelope = sign({ repository: { owner: "different-owner", name: "harness-mrtool" } }); break;
      case "wrong-tag": envelope = sign({ releaseTag: "templates-v1.1.1", bundleVersion: "1.1.1" }); break;
      case "wrong-version": options.expectedVersion = "1.1.1"; break;
      case "signer-mismatch": envelope = sign({ signingKeyId: "another-key" }); break;
      case "invalid-signing-sequence": envelope = sign({ signingSequence: 0 }); break;
      case "manifest-hash": envelope = sign({ bundleManifest: { sha256: "a".repeat(64), size: options.files.get("bundle-manifest.json")!.length } }); break;
    }
    assert.throws(() => verifyTemplatePublicationReceipt({ ...options, envelope }), security);
  });
}

for (const attack of ["tampered", "missing", "extra", "manifest-noncanonical"] as const) {
  test(`publication rejects ${attack} file bytes even with genuine signatures`, async (t) => {
    const { f, options, sign } = await fixture(t);
    let envelope = options.envelope;
    if (attack === "tampered") options.files.set("layout.md", Buffer.from("changed"));
    if (attack === "missing") options.files.delete("layout.md");
    if (attack === "extra") options.files.set("extra.txt", Buffer.from("extra"));
    if (attack === "manifest-noncanonical") {
      const bytes = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(options.files.get("bundle-manifest.json")!).toString()), null, 2));
      options.files.set("bundle-manifest.json", bytes);
      const files = (f.receiptPayload.files as JsonObject[]).map((file, index) => index === 0 ? { path: "bundle-manifest.json", size: bytes.length, sha256: hash(bytes) } : file);
      envelope = sign({ bundleManifest: { size: bytes.length, sha256: hash(bytes) }, files });
    }
    assert.throws(() => verifyTemplatePublicationReceipt({ ...options, envelope }), security);
  });
}

test("unbranded supplied trust and omitted production trust reject fixture signatures", async (t) => {
  const { options } = await fixture(t);
  assert.throws(() => verifyTemplatePublicationReceipt({ ...options, trustConfig: { ...options.trustConfig } }), security);
  const { trustConfig: _trust, ...productionOptions } = options;
  assert.throws(() => verifyTemplatePublicationReceipt(productionOptions), security);
});

test("bounded disk input reads the exact tree for in-process publication verification", async (t) => {
  const { options, directory, receiptPath } = await fixture(t);
  const input = await readTemplatePublicationInputs({ directory, receipt: receiptPath, tag: options.expectedTag });
  assert.equal(input.expectedVersion, "1.1.0");
  assert.equal(input.files.size, 10);
  assert.equal(verifyTemplatePublicationReceipt({ ...input, trustConfig: options.trustConfig }).receipt.bundleVersion, "1.1.0");
});

for (const attack of ["extra", "missing", "file-link", "directory-link", "root-link", "receipt-link", "oversized-file", "oversized-receipt", "oversized-manifest", "noncanonical-root"] as const) {
  test(`disk publication reader rejects ${attack}`, async (t) => {
    const { directory, receiptPath, root, options } = await fixture(t);
    let selectedDirectory = directory;
    let selectedReceipt = receiptPath;
    if (attack === "extra") await writeFile(resolve(directory, "extra.txt"), "extra");
    if (attack === "missing") await rm(resolve(directory, "layout.md"));
    if (attack === "file-link") { const file = resolve(directory, "layout.md"); const outside = resolve(root, "layout.md"); await copyFile(file, outside); await rm(file); await symlink(outside, file); }
    if (attack === "directory-link") { const outside = resolve(root, "profiles"); await mkdir(outside); await rm(resolve(directory, "profiles"), { recursive: true }); await symlink(outside, resolve(directory, "profiles"), process.platform === "win32" ? "junction" : "dir"); }
    if (attack === "root-link") { selectedDirectory = resolve(root, "alias"); await symlink(directory, selectedDirectory, process.platform === "win32" ? "junction" : "dir"); }
    if (attack === "receipt-link") { selectedReceipt = resolve(root, "receipt-alias"); await symlink(receiptPath, selectedReceipt); }
    if (attack === "noncanonical-root") { const alias = resolve(root, "alias"); await symlink(root, alias, process.platform === "win32" ? "junction" : "dir"); selectedDirectory = resolve(alias, "template"); }
    if (attack === "oversized-file" || attack === "oversized-receipt" || attack === "oversized-manifest") {
      const path = attack === "oversized-file" ? resolve(directory, "layout.md") : attack === "oversized-manifest" ? resolve(directory, "bundle-manifest.json") : receiptPath;
      const handle = await open(path, "w"); try { await handle.truncate(attack === "oversized-file" ? 2 * 1024 * 1024 + 1 : attack === "oversized-manifest" ? 64 * 1024 + 1 : 256 * 1024 + 1); } finally { await handle.close(); }
    }
    await assert.rejects(readTemplatePublicationInputs({ directory: selectedDirectory, receipt: selectedReceipt, tag: options.expectedTag }));
  });
}

test("CLI uses production roots only and cannot be overridden by key flags", async (t) => {
  const { directory, receiptPath, options } = await fixture(t);
  const before = await readFile(receiptPath);
  const args = ["--directory", directory, "--receipt", receiptPath, "--tag", options.expectedTag];
  for (const extra of [[], ["--key", "anything"], ["--trust-config", "anything"], ["--tag", options.expectedTag], ["--unknown", "value"]]) {
    const result = spawnSync(process.execPath, [script, ...args, ...extra], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Template publication verification failed/u);
    if (extra.length === 0) assert.match(result.stderr, /signature validation failed/u);
  }
  assert.deepEqual(await readFile(receiptPath), before);
});


test("disk reader enforces aggregate payload cap before reading the next file", async (t) => {
  const { directory, receiptPath, options } = await fixture(t);
  for (const name of ["layout.md", "policy.yml", "profiles/code.yml", "profiles/docs.yml", "profiles/general.yml"]) {
    const file = await open(resolve(directory, name), "w");
    try { await file.truncate(2 * 1024 * 1024); } finally { await file.close(); }
  }
  await assert.rejects(readTemplatePublicationInputs({ directory, receipt: receiptPath, tag: options.expectedTag }), /bounded/u);
});

test("caller expected tag must agree with the independently expected version", async (t) => {
  const { options } = await fixture(t);
  for (const expectedTag of ["templates-v1.1.1", "templates-v01.1.0", "cli-v1.1.0"]) {
    assert.throws(() => verifyTemplatePublicationReceipt({ ...options, expectedTag }), security);
  }
});


test("a signed BOM-prefixed manifest is not accepted as canonical publication input", async (t) => {
  const { f, options, sign } = await fixture(t);
  const original = options.files.get("bundle-manifest.json")!;
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]);
  options.files.set("bundle-manifest.json", bytes);
  const files = (f.receiptPayload.files as JsonObject[]).map((file, index) => index === 0
    ? { path: "bundle-manifest.json", size: bytes.length, sha256: hash(bytes) } : file);
  const envelope = sign({ bundleManifest: { size: bytes.length, sha256: hash(bytes) }, files });
  assert.throws(() => verifyTemplatePublicationReceipt({ ...options, envelope }), security);
});

test("signed BOM-prefixed receipt payload is rejected without weakening historical behavior", async (t) => {
  const { f, options } = await fixture(t);
  const payload = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonicalPayload(f.receiptPayload)]);
  const envelope = signedEnvelope(payload, [f.signingKey]);
  assert.throws(() => verifyTemplatePublicationReceipt({ ...options, envelope }), security);
});


test("actual Template ZIP is authenticated and returned with its exact digest and size", async (t) => {
  const { options, root, directory, receiptPath } = await fixture(t);
  const archiveBytes = zipSync(Object.fromEntries(options.files), { level: 6 });
  const archive = resolve(root, "templates.zip");
  await writeFile(archive, archiveBytes);
  const input = await readTemplatePublicationInputs({ directory, receipt: receiptPath, tag: options.expectedTag, archive });
  assert.equal(Buffer.from(input.archiveBytes).equals(Buffer.from(archiveBytes)), true);
  const verified = verifyTemplatePublicationReceipt({ ...options, archiveBytes });
  assert.equal(verified.archiveSha256, hash(archiveBytes));
  assert.equal(verified.archiveSize, archiveBytes.length);
  const sourceOnly = verifyTemplatePublicationReceipt(options);
  assert.equal(sourceOnly.archiveSha256, undefined);
  assert.equal(sourceOnly.archiveSize, undefined);
});

for (const attack of ["wrong-bytes", "extra", "missing", "duplicate", "traversal", "symlink", "declared-bomb", "lying-bomb", "BOM-name", "BOM-local-name", "truncated"] as const) {
  test(`valid source and receipt cannot authorize an actual ZIP with ${attack}`, async (t) => {
    const { options } = await fixture(t);
    const entries: Record<string, Uint8Array> = Object.fromEntries(options.files);
    if (attack === "wrong-bytes") entries["layout.md"] = Buffer.from("not the signed bytes");
    if (attack === "extra") entries["extra.txt"] = Buffer.from("extra");
    if (attack === "missing") delete entries["layout.md"];
    if (attack === "traversal") entries["../escape"] = Buffer.from("escape");
    if (attack === "duplicate") entries["aaaaaa.md"] = Buffer.from("duplicate");
    if (attack === "declared-bomb" || attack === "lying-bomb") entries["layout.md"] = new Uint8Array(2 * 1024 * 1024 + 1);
    if (attack === "BOM-name") { entries["\ufefflayout.md"] = entries["layout.md"]!; delete entries["layout.md"]; }
    if (attack === "BOM-local-name") { entries["\ufefflayout.md"] = entries["layout.md"]!; delete entries["layout.md"]; }
    let archiveBytes = Buffer.from(zipSync(entries, { level: 6 }));
    if (attack === "duplicate") for (let at = archiveBytes.indexOf("aaaaaa.md"); at !== -1; at = archiveBytes.indexOf("aaaaaa.md")) archiveBytes.write("layout.md", at);
    if (attack === "BOM-local-name") {
      // Leave BOM+layout.md in the local header but make the central name
      // exactly layout.md; this must not normalize into a matching path.
      let found = false;
      for (let i = 0; i + 46 <= archiveBytes.length; i++) {
        if (archiveBytes.readUInt32LE(i) !== 0x02014b50) continue;
        const size = archiveBytes.readUInt16LE(i + 28);
        if (archiveBytes.subarray(i + 46, i + 46 + size).toString() !== "\ufefflayout.md") continue;
        archiveBytes.writeUInt16LE(size - 3, i + 28);
        archiveBytes = Buffer.concat([archiveBytes.subarray(0, i + 46), archiveBytes.subarray(i + 49)]);
        const end = archiveBytes.length - 22;
        archiveBytes.writeUInt32LE(archiveBytes.readUInt32LE(end + 12) - 3, end + 12);
        found = true;
        break;
      }
      assert.equal(found, true);
    }
    if (attack === "symlink") {
      const central = archiveBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      archiveBytes.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
    }
    if (attack === "lying-bomb") {
      // Spoof both local and central uncompressed lengths; the inflater must
      // still stop at the actual output cap rather than trusting metadata.
      for (let i = 0; i + 46 <= archiveBytes.length; i++) {
        const signature = archiveBytes.readUInt32LE(i);
        if (signature === 0x04034b50 && archiveBytes.subarray(i + 30, i + 30 + archiveBytes.readUInt16LE(i + 26)).toString() === "layout.md") archiveBytes.writeUInt32LE(10, i + 22);
        if (signature === 0x02014b50 && archiveBytes.subarray(i + 46, i + 46 + archiveBytes.readUInt16LE(i + 28)).toString() === "layout.md") archiveBytes.writeUInt32LE(10, i + 24);
      }
    }
    if (attack === "truncated") archiveBytes = archiveBytes.subarray(0, archiveBytes.length - 12);
    assert.throws(() => verifyTemplatePublicationReceipt({ ...options, archiveBytes }), security);
  });
}

test("publication rejects a BOM on the outer envelope itself", async (t) => {
  const { options } = await fixture(t);
  const envelope = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(options.envelope)]);
  assert.throws(() => verifyTemplatePublicationReceipt({ ...options, envelope }), security);
});

test("optional CLI archive is bounded before reading; there is no ignored archive flag", async (t) => {
  const { options, root, directory, receiptPath } = await fixture(t);
  const archive = resolve(root, "oversized.zip");
  const handle = await open(archive, "w");
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(readTemplatePublicationInputs({ directory, receipt: receiptPath, tag: options.expectedTag, archive }));
});

test("receipt swapped for FIFO between lstat and open is rejected without hanging", { skip: process.platform === "win32" }, async (t) => {
  const { directory, receiptPath, options } = await fixture(t);
  const child = `
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {spawnSync} from 'node:child_process';
    import {pathToFileURL} from 'node:url';
    const [modulePath,directory,receipt,tag]=process.argv.slice(1);
    process.argv[1]="fifo-race-harness"; // Import the reader, not its CLI entrypoint.
    const originalOpen=fs.open;
    let swapped=false;
    fs.open=async function(path,flags,...rest){
      if(path===receipt&&!swapped){swapped=true;await fs.unlink(receipt);const r=spawnSync('mkfifo',[receipt]);if(r.status!==0)throw Error('mkfifo unavailable');}
      return originalOpen.call(this,path,flags,...rest);
    };
    syncBuiltinESMExports();
    const {readTemplatePublicationInputs}=await import(pathToFileURL(modulePath));
    try{await readTemplatePublicationInputs({directory,receipt,tag});process.exitCode=3;}
    catch{if(!swapped)process.exitCode=4;else process.stdout.write('FIFO rejected');}
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child, script, directory, receiptPath, options.expectedTag], {
    encoding: "utf8", timeout: 2500, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "FIFO rejected");
});


test("CLI accepts optional archive but still refuses non-production signing roots", async (t) => {
  const { options, root, directory, receiptPath } = await fixture(t);
  const archive = resolve(root, "templates.zip");
  await writeFile(archive, zipSync(Object.fromEntries(options.files)));
  const result = spawnSync(process.execPath, [script, "--directory", directory, "--receipt", receiptPath,
    "--tag", options.expectedTag, "--archive", archive], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /signature validation failed/u); // Not an unknown-flag/usage failure.
});

test("actual workflow zip -X output binds to the receipt without a duplicate unpacker", { skip: process.platform === "win32" }, async (t) => {
  const { options, root, directory } = await fixture(t);
  const archive = resolve(root, "workflow.zip");
  const packaged = spawnSync("zip", ["-X", "-q", "-r", archive, "."], { cwd: directory, encoding: "utf8", timeout: 10_000 });
  assert.ifError(packaged.error);
  assert.equal(packaged.status, 0, packaged.stderr);
  const archiveBytes = await readFile(archive);
  const verified = verifyTemplatePublicationReceipt({ ...options, archiveBytes });
  assert.equal(verified.archiveSha256, hash(archiveBytes));
  assert.equal(verified.archiveSize, archiveBytes.length);
});
