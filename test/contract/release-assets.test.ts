import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { parse } from "yaml";

// @ts-expect-error The packaging helper intentionally has no declaration file.
import { prepareSkillTree } from "../../scripts/package-skill.mjs";

// @ts-expect-error The packaging helper intentionally has no declaration file.
import { packagePortableRelease, validateReleaseArchive, validateReleaseArchiveAndReceipt } from "../../scripts/package-portable.mjs";

const executableBytes = Buffer.from("portable-executable-bytes\n", "utf8");
const receiptPayload = Buffer.from("{\"receiptVersion\":1}\n", "utf8").toString("base64url");
const receiptSignature = Buffer.alloc(64).toString("base64url");
const receiptBytes = Buffer.from(
  `{"payload":"${receiptPayload}","signatures":[{"algorithm":"Ed25519","keyId":"release-key-1","signature":"${receiptSignature}"}]}\n`,
  "utf8",
);

async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "harness-release-contract-"));
  await writeFile(join(directory, "harness-mrtool.exe"), executableBytes);
  await writeFile(join(directory, "bundle-receipt.envelope.json"), receiptBytes);
  await writeFile(join(directory, "THIRD_PARTY_NOTICES.md"), "notice\n");
  await writeFile(join(directory, "Node.txt"), "Node license\n");
  return directory;
}

test("release archive contains an exact tree and checksums final bytes", async (t) => {
  const directory = await fixtureDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "release.zip");

  await packagePortableRelease({
    executablePath: join(directory, "harness-mrtool.exe"),
    receiptPath: join(directory, "bundle-receipt.envelope.json"),
    noticesPath: join(directory, "THIRD_PARTY_NOTICES.md"),
    nodeLicensePath: join(directory, "Node.txt"),
    outputPath: output,
  });

  const archive = unzipSync(await readFile(output));
  assert.deepEqual(Object.keys(archive).sort(), [
    "SHA256SUMS",
    "THIRD_PARTY_NOTICES.md",
    "bundle-receipt.envelope.json",
    "harness-mrtool.exe",
    "licenses/Node.txt",
  ]);
  assert.equal(validateReleaseArchive(archive), true);
  assert.equal(validateReleaseArchiveAndReceipt(archive, receiptBytes), true);
  assert.throws(
    () => validateReleaseArchiveAndReceipt(archive, Buffer.from("different\n")),
    /standalone bundle receipt/u,
  );
  const invalidReceipt = { ...archive, "bundle-receipt.envelope.json": Buffer.from("{\"schemaVersion\":1}\n") };
  assert.throws(() => validateReleaseArchive(invalidReceipt), /SHA256SUMS|receipt envelope/u);
  const emptyNotice = { ...archive, "THIRD_PARTY_NOTICES.md": new Uint8Array() };
  assert.throws(() => validateReleaseArchive(emptyNotice), /entry size/u);
  const sums = Buffer.from(archive["SHA256SUMS"]!).toString("utf8");
  assert.match(sums, /[a-f0-9]{64}  harness-mrtool\.exe\n/u);
  assert.match(sums, /[a-f0-9]{64}  bundle-receipt\.envelope\.json\n/u);
});

test("release workflows verify draft assets before publishing", async () => {
  const workflowDirectory = join(import.meta.dirname, "../../.github/workflows");
  const releaseCli = parse(await readFile(join(workflowDirectory, "release-cli.yml"), "utf8")) as {
    readonly jobs?: Record<string, { readonly needs?: string | readonly string[] }>;
  };
  const publishChannel = parse(await readFile(join(workflowDirectory, "publish-channel.yml"), "utf8")) as {
    readonly jobs?: Record<string, { readonly needs?: string | readonly string[] }>;
  };
  assert.equal(releaseCli.jobs?.publish?.needs, "verify-draft-assets");
  const channelNeeds = publishChannel.jobs?.publish?.needs;
  assert.deepEqual(channelNeeds, ["verify-cli", "verify-template", "verify-skill"]);
});

test("CLI release workflow publishes only the verified final draft assets", async () => {
  const workflow = await readFile(
    join(import.meta.dirname, "../../.github/workflows/release-cli.yml"),
    "utf8",
  );
  assert.match(workflow, /BUNDLE_RECEIPT_B64/u);
  assert.match(workflow, /SHA256SUMS/u);
  assert.match(workflow, /actions\/attest@v4/u);
  assert.match(workflow, /gh release create[\s\S]*--draft/u);
  assert.match(workflow, /gh release download/u);
  assert.match(workflow, /unzip -p[\s\S]*harness-mrtool\.exe[\s\S]*cmp --silent/u);
  assert.match(workflow, /cmp --silent dist\/harness-mrtool\.exe draft-download\/harness-mrtool\.exe/u);
  assert.match(workflow, /cmp --silent dist\/harness-mrtool-windows-x64\.zip draft-download\/harness-mrtool-windows-x64\.zip/u);
  assert.match(workflow, /cmp --silent dist\/bundle-receipt\.envelope\.json draft-download\/bundle-receipt\.envelope\.json/u);
  assert.match(workflow, /gh release edit[\s\S]*--draft=false/u);
  assert.match(workflow, /attestations:\s*write/u);
  assert.match(workflow, /cli-v/iu);
  assert.match(workflow, /harness-mrtool-windows-x64\.zip/u);
  assert.match(workflow, /checkout@v4[\s\S]*ref:/u);
  assert.match(workflow, /release-cli-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
});

test("component and channel workflows refuse unsigned or unverified publication", async () => {
  const workflowDirectory = join(import.meta.dirname, "../../.github/workflows");
  const template = await readFile(join(workflowDirectory, "release-template.yml"), "utf8");
  const skill = await readFile(join(workflowDirectory, "release-skill.yml"), "utf8");
  const channel = await readFile(join(workflowDirectory, "publish-channel.yml"), "utf8");
  for (const source of [template, skill]) {
    assert.match(source, /BUNDLE_RECEIPT_B64|RECEIPT_B64/u);
    assert.match(source, /--draft/u);
    assert.match(source, /gh release download/u);
    assert.match(source, /--draft=false/u);
    assert.match(source, /checkout@v4[\s\S]*ref:/u);
  }
  assert.match(channel, /gh release view/u);
  assert.match(channel, /isImmutable/u);
  assert.match(channel, /CHANNEL_ENVELOPE_B64/u);
  assert.match(channel, /--draft/u);
  assert.match(template, /attestations:\s*write/u);
  assert.match(skill, /attestations:\s*write/u);
  assert.match(template, /templates-v/iu);
  assert.match(skill, /skill-v/iu);
  assert.match(template, /harness-mr-templates\.zip/u);
  assert.match(template, /cmp --silent "\$TEMPLATE_DIST\/harness-mr-templates\.zip" draft-template\/harness-mr-templates\.zip/u);
  assert.match(template, /cmp --silent "\$TEMPLATE_DIST\/bundle-receipt\.envelope\.json" draft-template\/bundle-receipt\.envelope\.json/u);
  assert.match(template, /cmp --silent "\$TEMPLATE_DIST\/SHA256SUMS" draft-template\/SHA256SUMS/u);
  assert.match(skill, /harness-mr-skill\.zip/u);
  assert.match(skill, /cmp --silent "\$SKILL_DIST\/skill-bundle\/harness-mr-skill\.zip" draft-skill\/harness-mr-skill\.zip/u);
  assert.match(skill, /cmp --silent "\$SKILL_DIST\/skill-bundle\/bundle-receipt\.envelope\.json" draft-skill\/bundle-receipt\.envelope\.json/u);
  assert.match(skill, /cmp --silent "\$SKILL_DIST\/skill-bundle\/SHA256SUMS" draft-skill\/SHA256SUMS/u);
  assert.match(skill, /package-skill\.mjs/u);
  assert.match(channel, /harness-mr-skill\.zip/u);
  assert.match(channel, /--target[\s\S]*GITHUB_SHA/u);
  assert.match(channel, /cmp --silent dist\/channel\/stable\.envelope\.json draft-channel\/stable\.envelope\.json/u);
  assert.match(template, /TEMPLATE_DIST/u);
  assert.match(template, /release-template-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(skill, /release-skill-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.doesNotMatch(template, /dist\/template-bundle/u);
});

test("POSIX installer enforces the exact four checksum entries", async () => {
  const portable = await readFile(join(import.meta.dirname, "../../scripts/install.sh"), "utf8");
  assert.match(portable, /CHECKSUM_NAMES|expected_checksum_names|checksum_count/u);
  assert.match(portable, /duplicate|seen/u);
  assert.doesNotMatch(portable, /declare\s+-A/u);
});

test("repair verifies the manager marker before executing the installed binary", async () => {
  const repair = await readFile(join(import.meta.dirname, "../../scripts/repair.ps1"), "utf8");
  assert.match(repair, /archiveSha256|executableSha256/u);
  assert.match(repair, /Get-FileHash|SHA256/u);
  assert.match(repair, /ReparsePoint/u);
});

test("Skill bootstrap pins the immutable GitHub release origin and bounded redirects", async () => {
  const bootstrap = await readFile(
    join(import.meta.dirname, "../../skill/harness-mr/scripts/bootstrap.ps1"),
    "utf8",
  );
  assert.match(bootstrap, /ReleaseOwner\s*=\s*'chengcheng93'/u);
  assert.match(bootstrap, /ReleaseRepository\s*=\s*'harness-mrtool'/u);
  assert.match(bootstrap, /expectedReleasePath[\s\S]*releases\/download\/skill-v\$Version/u);
  assert.match(bootstrap, /objects\.githubusercontent\.com|release-assets\.githubusercontent\.com/u);
  assert.doesNotMatch(bootstrap, /Invoke-WebRequest/u);
});

test("Skill release packaging emits the bootstrap manifest and canonical asset name", async (t) => {
  const input = await mkdtemp(join(tmpdir(), "harness-skill-input-"));
  const output = await mkdtemp(join(tmpdir(), "harness-skill-output-"));
  t.after(async () => {
    await Promise.all([
      rm(input, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
    ]);
  });
  await writeFile(join(input, "SKILL.md"), "# Skill\n", "utf8");
  await writeFile(join(input, "notes.txt"), "notes\n", "utf8");
  await prepareSkillTree({ inputDirectory: input, outputDirectory: output, version: "1.2.3" });
  const manifest = JSON.parse(await readFile(join(output, ".harness-skill-manifest.json"), "utf8")) as {
    readonly tag: string;
    readonly treeSha256: string;
    readonly files: readonly { readonly path: string }[];
  };
  assert.equal(manifest.tag, "skill-v1.2.3");
  assert.match(manifest.treeSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(manifest.files.map((file) => file.path), ["SKILL.md", "notes.txt"]);
  assert.deepEqual((await readdir(output)).sort(), [".harness-skill-manifest.json", "SKILL.md", "notes.txt"]);
});

test("Skill release packaging refuses a non-empty output directory", async (t) => {
  const input = await mkdtemp(join(tmpdir(), "harness-skill-input-"));
  const output = await mkdtemp(join(tmpdir(), "harness-skill-output-"));
  t.after(async () => {
    await Promise.all([
      rm(input, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
    ]);
  });
  await writeFile(join(input, "SKILL.md"), "# Skill\n", "utf8");
  await writeFile(join(output, "stale.txt"), "stale\n", "utf8");

  await assert.rejects(
    prepareSkillTree({ inputDirectory: input, outputDirectory: output, version: "1.2.3" }),
    /output directory must be empty/u,
  );
  assert.deepEqual(await readdir(output), ["stale.txt"]);
});

test("Skill release packaging enforces the bootstrap file-count limit", async (t) => {
  const input = await mkdtemp(join(tmpdir(), "harness-skill-input-"));
  const output = await mkdtemp(join(tmpdir(), "harness-skill-output-"));
  t.after(async () => {
    await Promise.all([
      rm(input, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
    ]);
  });
  await Promise.all([
    writeFile(join(input, "SKILL.md"), "# Skill\n", "utf8"),
    ...Array.from({ length: 128 }, (_, index) =>
      writeFile(join(input, `file-${String(index).padStart(3, "0")}.txt`), "x\n", "utf8")),
  ]);

  await assert.rejects(
    prepareSkillTree({ inputDirectory: input, outputDirectory: output, version: "1.2.3" }),
    /file count|too many|limit/u,
  );
});

test("Skill release packaging enforces the bootstrap total-size limit", async (t) => {
  const input = await mkdtemp(join(tmpdir(), "harness-skill-input-"));
  const output = await mkdtemp(join(tmpdir(), "harness-skill-output-"));
  t.after(async () => {
    await Promise.all([
      rm(input, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
    ]);
  });
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  await Promise.all([
    writeFile(join(input, "SKILL.md"), "# Skill\n", "utf8"),
    ...Array.from({ length: 16 }, (_, index) =>
      writeFile(join(input, `chunk-${String(index).padStart(2, "0")}.txt`), chunk)),
  ]);

  await assert.rejects(
    prepareSkillTree({ inputDirectory: input, outputDirectory: output, version: "1.2.3" }),
    /total|size|limit/u,
  );
});

test("Skill release packaging rejects Windows device-name paths", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows cannot create a device-name fixture");
    return;
  }
  const input = await mkdtemp(join(tmpdir(), "harness-skill-input-"));
  const output = await mkdtemp(join(tmpdir(), "harness-skill-output-"));
  t.after(async () => {
    await Promise.all([
      rm(input, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
    ]);
  });
  await writeFile(join(input, "SKILL.md"), "# Skill\n", "utf8");
  await writeFile(join(input, "CON"), "device-name\n", "utf8");
  await assert.rejects(
    prepareSkillTree({ inputDirectory: input, outputDirectory: output, version: "1.2.3" }),
    /unsafe path/u,
  );
});
