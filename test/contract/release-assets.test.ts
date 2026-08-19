import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { parse } from "yaml";

// @ts-expect-error The packaging helper intentionally has no declaration file.
import { packagePortableRelease, validateReleaseArchive } from "../../scripts/package-portable.mjs";

const executableBytes = Buffer.from("portable-executable-bytes\n", "utf8");
const receiptBytes = Buffer.from("{\"schemaVersion\":1}\n", "utf8");

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
  assert.match(workflow, /gh release edit[\s\S]*--draft=false/u);
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
  }
  assert.match(channel, /gh release view/u);
  assert.match(channel, /isImmutable/u);
  assert.match(channel, /CHANNEL_ENVELOPE_B64/u);
  assert.match(channel, /--draft/u);
});
