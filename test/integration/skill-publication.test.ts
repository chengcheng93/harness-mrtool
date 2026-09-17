import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { zipSync } from "fflate";
import { isToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, type JsonObject } from "../../src/contracts/jcs.ts";
import { verifySkillPublicationReceipt, MAX_SKILL_ARCHIVE_BYTES, MAX_SKILL_FILE_BYTES } from "../../src/skill/publication-receipt.ts";
import { createTestOnlyUpdateTrustConfig } from "../../src/update/trust-config.ts";
import { createTrustState, verifySignedEnvelope } from "../../src/update/envelope.ts";
import { canonicalPayload, createSigningFixture, signedEnvelope } from "../helpers/signing.ts";
// @ts-expect-error Release tooling intentionally has no declaration file.
import { prepareSkillTree } from "../../scripts/package-skill.mjs";
// @ts-expect-error Release tooling intentionally has no declaration file.
import { createSkillReceipt } from "../../scripts/create-skill-receipt.mjs";
// @ts-expect-error Release tooling intentionally has no declaration file.
import { readSkillPublicationInputs } from "../../scripts/verify-skill-publication.mjs";

const script = resolve(import.meta.dirname, "../../scripts/verify-skill-publication.mjs");
const manifestName = ".harness-skill-manifest.json";
const version = "0.1.6", tag = `skill-v${version}`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function security(error: unknown): boolean {
  assert.equal(isToolError(error, "UPDATE_SECURITY_ERROR"), true, String(error));
  return true;
}

type ZipInput = { name: string; bytes: Uint8Array; method?: number; size?: number; mode?: number; flags?: number; localName?: string; descriptor?: boolean };
// Tiny ZIP producer allows malicious duplicate/metadata cases that zipSync's object API cannot express.
function rawZip(entries: ZipInput[]): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(entry.bytes) : Buffer.from(entry.bytes);
    const size = entry.size ?? entry.bytes.length, crc = crc32(entry.bytes);
    const flags = entry.flags ?? (entry.descriptor ? 8 : 0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(entry.descriptor ? 0 : crc, 14);
    header.writeUInt32LE(entry.descriptor ? 0 : compressed.length, 18); header.writeUInt32LE(entry.descriptor ? 0 : size, 22);
    header.writeUInt16LE(localName.length, 26);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12); }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? (entry.name.endsWith("/") ? 0x41ed : 0x81a4)) * 65536) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, localName, compressed, descriptor); central.push(record, name);
    offset += header.length + localName.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "skill-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = resolve(root, "source"), output = resolve(root, "packed");
  await mkdir(resolve(input, "scripts"), { recursive: true });
  await writeFile(resolve(input, "SKILL.md"), "---\nname: harness-mr\n---\nUse the verified CLI.\n");
  await writeFile(resolve(input, "scripts/run.txt"), "local handoff only\n");
  const manifest = await prepareSkillTree({ inputDirectory: input, outputDirectory: output, version, cliVersionRange: ">=0.1.6 <1.0.0" });
  const entries: ZipInput[] = [];
  for (const path of [manifestName, "SKILL.md", "scripts/run.txt"]) entries.push({ name: path, bytes: await readFile(resolve(output, path)) });
  const archiveBytes = zipSync(Object.fromEntries(entries.map((entry) => [entry.name, entry.bytes])));
  // This key is generated for this test only; it is not the production release key.
  const key = createSigningFixture("release-key-1");
  const repository = { owner: "chengcheng93", name: "harness-mrtool" };
  const trustConfig = createTestOnlyUpdateTrustConfig({ repository, pagesOrigin: "http://127.0.0.1:43123",
    bootstrapKeys: [{ keyId: key.keyId, publicKeySpki: key.publicKeySpki, activeFromSequence: 1, revokedAtSequence: null }] });
  const payload: JsonObject = { asset: { name: "harness-mr-skill.zip", sha256: hash(archiveBytes), size: archiveBytes.length },
    cliVersionRange: manifest.cliVersionRange, files: manifest.files, receiptType: "skill-bundle", receiptVersion: 1,
    releaseTag: tag, repository, signingKeyId: key.keyId, signingSequence: 1,
    skillProtocol: manifest.skillProtocol, treeSha256: manifest.treeSha256, version };
  const sign = (overrides: JsonObject = {}) => signedEnvelope(canonicalPayload({ ...payload, ...overrides }), [key]);
  const options = { envelope: sign(), archiveBytes, expectedTag: tag, expectedVersion: version, trustConfig };
  const withArchive = (bytes: Uint8Array) => ({ ...options, archiveBytes: bytes,
    envelope: sign({ asset: { name: "harness-mr-skill.zip", sha256: hash(bytes), size: bytes.length } }) });
  return { root, output, manifest, entries, key, payload, options, sign, withArchive };
}

test("real test-key publication matches existing packager/receipt generator without authorizing installation", async (t) => {
  const f = await fixture(t);
  const archive = resolve(f.root, "skill.zip"), receipt = resolve(f.root, "receipt.json"), privateKeyPath = resolve(f.root, "test-key.pem");
  await writeFile(archive, f.options.archiveBytes);
  await writeFile(privateKeyPath, f.key.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await createSkillReceipt({ manifestPath: resolve(f.output, manifestName), archivePath: archive,
    version, privateKeyPath, outputPath: receipt });
  const inputs = await readSkillPublicationInputs({ archive, receipt, tag });
  const verified = verifySkillPublicationReceipt({ ...inputs, trustConfig: f.options.trustConfig });
  assert.equal(verified.purpose, "skill-publication-only");
  assert.equal(verified.receipt.version, version);
  assert.equal(verified.receipt.cliVersionRange, ">=0.1.6 <1.0.0");
  assert.equal(verified.receipt.skillProtocol, 1);
  assert.equal(verified.signingKeyId, f.key.keyId);
  assert.equal(verified.payloadSha256, hash(canonicalPayload(f.payload)));
  assert.deepEqual([...verified.files.keys()].sort(), ["SKILL.md", "scripts/run.txt"]);
  assert.equal(Buffer.from(verified.files.get("SKILL.md")!).toString(), Buffer.from(f.entries[1]!.bytes).toString());
  assert.equal(Object.isFrozen(verified.receipt.files[0]), true);
  verified.files.get("SKILL.md")!.fill(0);
  assert.notEqual(verified.files.get("SKILL.md")![0], 0, "returned bytes must not mutate authenticated state");
  assert.equal("installed" in verified, false);
  assert.equal("nextTrustState" in verified, false);
});

for (const attack of ["zero-signature", "wrong-key", "unsigned", "noncanonical-envelope", "noncanonical-payload", "duplicate-json", "repo", "tag", "version", "signer", "sequence", "asset-name", "hash", "size", "extra-field", "protocol", "range", "tree", "unsorted-files", "extra-file-field", "expected-tag", "expected-version", "forged-roots"] as const) {
  test(`publication rejects ${attack}`, async (t) => {
    const f = await fixture(t);
    let options = { ...f.options };
    switch (attack) {
      case "zero-signature": { const e = JSON.parse(options.envelope); e.signatures[0].signature = Buffer.alloc(64).toString("base64url"); options.envelope = `${canonicalizeJson(e)}\n`; break; }
      case "wrong-key": options.envelope = signedEnvelope(canonicalPayload(f.payload), [createSigningFixture(f.key.keyId)]); break;
      case "unsigned": options.envelope = `${canonicalizeJson(f.payload)}\n`; break;
      case "noncanonical-envelope": options.envelope = JSON.stringify(JSON.parse(options.envelope), null, 2); break;
      case "noncanonical-payload": options.envelope = signedEnvelope(Buffer.from(JSON.stringify(f.payload, null, 2)), [f.key]); break;
      case "duplicate-json": options.envelope = signedEnvelope(Buffer.from(`${canonicalizeJson(f.payload).slice(0, -1)},"version":"0.1.6"}\n`), [f.key]); break;
      case "repo": options.envelope = f.sign({ repository: { owner: "wrong", name: "harness-mrtool" } }); break;
      case "tag": options.envelope = f.sign({ releaseTag: "skill-v0.1.7" }); break;
      case "version": options.envelope = f.sign({ version: "0.1.7" }); break;
      case "signer": options.envelope = f.sign({ signingKeyId: "not-the-signer" }); break;
      case "sequence": options.envelope = f.sign({ signingSequence: 0 }); break;
      case "asset-name": options.envelope = f.sign({ asset: { ...(f.payload.asset as JsonObject), name: "different.zip" } }); break;
      case "hash": options.envelope = f.sign({ asset: { ...(f.payload.asset as JsonObject), sha256: "0".repeat(64) } }); break;
      case "size": options.envelope = f.sign({ asset: { ...(f.payload.asset as JsonObject), size: options.archiveBytes.length + 1 } }); break;
      case "extra-field": options.envelope = f.sign({ unexpected: true }); break;
      case "protocol": options.envelope = f.sign({ skillProtocol: 2 }); break;
      case "range": options.envelope = f.sign({ cliVersionRange: ">=0.2.0 <1.0.0" }); break;
      case "tree": options.envelope = f.sign({ treeSha256: "0".repeat(64) }); break;
      case "unsorted-files": options.envelope = f.sign({ files: [...f.manifest.files].reverse() }); break;
      case "extra-file-field": options.envelope = f.sign({ files: f.manifest.files.map((file: JsonObject) => ({ ...file, extra: 1 })) }); break;
      case "expected-tag": options.expectedTag = "templates-v0.1.6"; break;
      case "expected-version": options.expectedVersion = "v0.1.6"; break;
      case "forged-roots": options.trustConfig = { ...options.trustConfig }; break;
    }
    assert.throws(() => verifySkillPublicationReceipt(options), security);
  });
}

for (const kind of ["stored", "deflated", "descriptor", "directory"] as const) {
  test(`bounded ZIP accepts valid ${kind} entries`, async (t) => {
    const f = await fixture(t);
    const entries = f.entries.map((entry) => ({ ...entry, method: kind === "stored" ? 0 : 8, descriptor: kind === "descriptor" }));
    if (kind === "directory") entries.push({ name: "scripts/", bytes: Buffer.alloc(0), method: 0, descriptor: false });
    const result = verifySkillPublicationReceipt(f.withArchive(rawZip(entries)));
    assert.equal(result.files.size, 2);
  });
}

for (const attack of ["malformed", "missing", "extra", "traversal", "symlink", "duplicate", "case-collision", "local-central-mismatch", "unsupported-method", "encrypted", "crc", "trailing", "oversized", "lying-bomb", "tampered-content", "bad-manifest", "manifest-extra", "manifest-files", "manifest-version", "manifest-protocol", "manifest-range", "manifest-activation", "empty-directory"] as const) {
  test(`signed archive rejects ${attack} after archive authentication`, async (t) => {
    const f = await fixture(t);
    let entries = f.entries.map((entry) => ({ ...entry }));
    switch (attack) {
      case "missing": entries = entries.filter((entry) => entry.name !== "SKILL.md"); break;
      case "extra": entries.push({ name: "extra.txt", bytes: Buffer.from("extra") }); break;
      case "traversal": entries.push({ name: "../outside", bytes: Buffer.from("bad") }); break;
      case "symlink": entries[1] = { ...entries[1]!, mode: 0xa1ff }; break;
      case "duplicate": entries.push(entries[1]!); break;
      case "case-collision": entries.push({ ...entries[1]!, name: "skill.md" }); break;
      case "local-central-mismatch": entries[1] = { ...entries[1]!, localName: "other.md" }; break;
      case "unsupported-method": entries[1] = { ...entries[1]!, method: 99 }; break;
      case "encrypted": entries[1] = { ...entries[1]!, flags: 1 }; break;
      case "oversized": entries[1] = { ...entries[1]!, size: 0xffffffff }; break;
      case "lying-bomb": entries[1] = { ...entries[1]!, bytes: Buffer.alloc(MAX_SKILL_FILE_BYTES + 1), size: entries[1]!.bytes.length, method: 8 }; break;
      case "tampered-content": entries[1] = { ...entries[1]!, bytes: Buffer.alloc(entries[1]!.bytes.length, 65) }; break;
      case "bad-manifest": entries[0] = { ...entries[0]!, bytes: Buffer.from("not JSON") }; break;
      case "empty-directory": entries.push({ name: "extra/", bytes: Buffer.alloc(0) }); break;
      default: if (attack.startsWith("manifest-")) {
        const m = { ...f.manifest };
        if (attack === "manifest-extra") m.extra = true;
        if (attack === "manifest-files") m.files = [];
        if (attack === "manifest-version") m.version = "0.1.7";
        if (attack === "manifest-protocol") m.skillProtocol = 2;
        if (attack === "manifest-range") m.cliVersionRange = ">=0.2.0 <1.0.0";
        if (attack === "manifest-activation") m.activation = "automatic";
        entries[0] = { ...entries[0]!, bytes: canonicalPayload(m) };
      }
    }
    let archive: Uint8Array = rawZip(entries);
    if (attack === "malformed") archive = Buffer.from("not a ZIP");
    if (attack === "trailing") archive = Buffer.concat([archive, Buffer.from("trailing")]);
    if (attack === "crc") { archive = Uint8Array.from(archive); archive[14] = archive[14]! ^ 1; }
    assert.throws(() => verifySkillPublicationReceipt(f.withArchive(archive)), security);
  });
}

test("oversized archive is rejected before decompression", async (t) => {
  const f = await fixture(t);
  assert.throws(() => verifySkillPublicationReceipt(f.withArchive(new Uint8Array(MAX_SKILL_ARCHIVE_BYTES + 1))), security);
});

test("CLI input reader bounds files and rejects links; CLI never accepts test roots or supplied keys", async (t) => {
  const f = await fixture(t);
  const archive = resolve(f.root, "archive.zip"), receipt = resolve(f.root, "receipt.json");
  await writeFile(archive, f.options.archiveBytes); await writeFile(receipt, f.options.envelope);
  const args = ["--archive", archive, "--receipt", receipt, "--tag", tag];
  for (const extra of [[], ["--key", "forbidden"], ["--trust-config", "forbidden"], ["--archive", archive], ["--unknown"], ["positional"], ["--tag"]]) {
    const result = spawnSync(process.execPath, [script, ...args, ...extra], { cwd: f.root, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Skill publication verification failed/u);
    assert.doesNotMatch(result.stderr, /forbidden|BEGIN PRIVATE|payload/u);
  }
  for (const invalidArgs of [[], ["--archive", archive], [...args, "--receipt", receipt], [...args, "--tag", tag]]) {
    const result = spawnSync(process.execPath, [script, ...invalidArgs], { cwd: f.root, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
  for (const badTag of ["skill-v01.1.6", "cli-v0.1.6", "skill-v0.1.6\n"]) await assert.rejects(readSkillPublicationInputs({ archive, receipt, tag: badTag }));
  await t.test("symlink input is rejected without following its target", async (t) => {
    const linked = resolve(f.root, "link.zip");
    try { await symlink(archive, linked, "file"); } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("file symlink creation is unavailable on this platform");
        return;
      }
      throw error;
    }
    await assert.rejects(readSkillPublicationInputs({ archive: linked, receipt, tag }));
    assert.deepEqual(await readFile(archive), Buffer.from(f.options.archiveBytes));
  });
  const hard = resolve(f.root, "hard.zip"); await link(archive, hard);
  await assert.rejects(readSkillPublicationInputs({ archive: hard, receipt, tag }));
  await rm(hard);
  const oversized = resolve(f.root, "oversized.zip"), handle = await open(oversized, "wx");
  await handle.truncate(MAX_SKILL_ARCHIVE_BYTES + 1); await handle.close();
  await assert.rejects(readSkillPublicationInputs({ archive: oversized, receipt, tag }));
  await assert.rejects(readSkillPublicationInputs({ archive: f.root, receipt, tag }));
  await writeFile(receipt, "x".repeat(300_000));
  await assert.rejects(readSkillPublicationInputs({ archive, receipt, tag }));
});

test("a coherently signed tree without mandatory SKILL.md is not a publishable Skill", async (t) => {
  const f = await fixture(t);
  const files = f.manifest.files.filter((file: { path: string }) => file.path !== "SKILL.md");
  const treeSha256 = hash(canonicalPayload(files));
  const manifest = { ...f.manifest, files, treeSha256 };
  const archive = rawZip(f.entries.filter((entry) => entry.name !== "SKILL.md")
    .map((entry) => entry.name === manifestName ? { ...entry, bytes: canonicalPayload(manifest) } : entry));
  const envelope = f.sign({ files, treeSha256, asset: { name: "harness-mr-skill.zip", sha256: hash(archive), size: archive.length } });
  assert.throws(() => verifySkillPublicationReceipt({ ...f.options, archiveBytes: archive, envelope }), security);
});

test("existing workflow zip -X layout verifies without changing packagers", async (t) => {
  const f = await fixture(t), path = resolve(f.root, "workflow.zip");
  const packed = spawnSync("zip", ["-X", "-q", "-r", path, "."], { cwd: f.output, encoding: "utf8", timeout: 10_000 });
  if ((packed.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("the release workflow's zip executable is not installed on this test platform");
    return;
  }
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr);
  const verified = verifySkillPublicationReceipt(f.withArchive(await readFile(path)));
  assert.equal(verified.files.size, 2);
});

for (const boundary of ["signed payload", "packed manifest", "outer envelope bytes", "outer envelope string"] as const) {
  test(`publication rejects BOM-prefixed ${boundary} with real test-key signatures`, async (t) => {
    const f = await fixture(t);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const trust = createTrustState(f.options.trustConfig.bootstrapKeys);
    let options: Parameters<typeof verifySkillPublicationReceipt>[0] = f.options;
    if (boundary === "signed payload") {
      const payload = Buffer.concat([bom, canonicalPayload(f.payload)]);
      const envelope = signedEnvelope(payload, [f.key]);
      const authenticated = verifySignedEnvelope(envelope, trust, f.options.trustConfig.bootstrapKeys);
      assert.equal(authenticated.payloadSha256, hash(payload));
      assert.deepEqual(authenticated.verifiedKeyIds, [f.key.keyId]);
      options = { ...f.options, envelope };
    } else if (boundary === "packed manifest") {
      const entries = f.entries.map((entry) => entry.name === manifestName
        ? { ...entry, bytes: Buffer.concat([bom, entry.bytes]) } : entry);
      options = f.withArchive(rawZip(entries));
      assert.deepEqual(verifySignedEnvelope(options.envelope, trust, f.options.trustConfig.bootstrapKeys).verifiedKeyIds, [f.key.keyId]);
    } else {
      assert.deepEqual(verifySignedEnvelope(f.options.envelope, trust, f.options.trustConfig.bootstrapKeys).verifiedKeyIds, [f.key.keyId]);
      options = { ...f.options, envelope: boundary === "outer envelope bytes"
        ? Buffer.concat([bom, Buffer.from(f.options.envelope)]) : `\uFEFF${f.options.envelope}` };
    }
    assert.throws(() => verifySkillPublicationReceipt(options), security);
  });
}
