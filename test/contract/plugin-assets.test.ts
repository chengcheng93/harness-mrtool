import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";

// @ts-expect-error The packaging helper intentionally has no declaration file.
import { packagePlugin } from "../../scripts/package-plugin.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Codex plugin packaging emits a bounded, self-contained archive", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "harness-mrtool-plugin-"));
  try {
    const result = await packagePlugin({
      inputDirectory: join(repositoryRoot, "plugins", "harness-mrtool"),
      outputDirectory: output,
      version: "0.1.7",
    });
    const archive = await readFile(result.archivePath);
    const entries = unzipSync(archive);
    const names = Object.keys(entries).sort();
    assert.ok(names.includes(".codex-plugin/plugin.json"));
    assert.ok(names.includes("skills/harness-mr/SKILL.md"));
    assert.ok(names.includes("skills/harness-mr/scripts/bootstrap.ps1"));
    assert.ok(names.includes("README.md"));
    assert.equal(names.some((name) => name.includes("node_modules") || name.startsWith(".git/")), false);
    assert.equal(
      Buffer.compare(
        Buffer.from(entries["skills/harness-mr/SKILL.md"]!),
        await readFile(join(repositoryRoot, "skill", "harness-mr", "SKILL.md")),
      ),
      0,
    );
    const manifest = JSON.parse(Buffer.from(entries[".codex-plugin/plugin.json"]!).toString("utf8")) as Record<string, unknown>;
    assert.equal(manifest.name, "harness-mrtool");
    assert.equal(manifest.version, "0.1.7");
    const sums = await readFile(result.sumsPath, "utf8");
    assert.match(sums, /^[a-f0-9]{64}  harness-mrtool-codex-plugin\.zip\n$/u);
    const readme = Buffer.from(entries["README.md"]!).toString("utf8").replace(/\s+/gu, " ");
    await t.test("packaged README distinguishes the unpublished candidate from the old CLI", () => {
      assert.ok(readme.includes(`CLI/Plugin ${manifest.version} is a release candidate, not yet published.`));
      assert.match(readme, /CLI 0\.1\.5 is historical and is not the matching CLI for this candidate/u);
      assert.doesNotMatch(readme, /Install the matching CLI Release first/u);
    });
    await t.test("packaged README uses main with the existing marketplace commands", () => {
      assert.match(readme, /codex plugin marketplace add chengcheng93\/harness-mrtool --ref main/u);
      assert.match(readme, /codex plugin add harness-mrtool@harness-mrtool/u);
      assert.doesNotMatch(readme, /--ref release-candidate-0\.1\.0/u);
    });
    await t.test("packaged README makes API MR creation the default without automatic SSH fallback", () => {
      assert.match(readme, /The default CLI and Skill flow uses the GitLab API/u);
      assert.match(readme, /context --auth api -> structured Request -> preview -> user confirmation -> create\/update -> verify/u);
      assert.match(readme, /Missing credentials or API failures stop the flow; never automatically fall back to SSH or manual handoff/u);
      assert.match(readme, /`--auth auto` remains a compatibility alias for API selection without SSH fallback/u);
      assert.doesNotMatch(readme, /default Skill path is SSH-first|optional API invocation|A GitLab token is optional/u);
    });
    await t.test("packaged README limits manual handoff to an explicit human request and refuses SSH MR creation", () => {
      assert.match(readme, /Use `manual --auth ssh` only after an explicit human request for manual handoff/u);
      assert.match(readme, /Git may still use SSH to push the source branch before the API flow/u);
      assert.match(readme, /`manual --auth ssh --ssh-mr --push` is rejected with `LABEL_ERROR` before push planning or execution/u);
      assert.match(readme, /Use the API flow for mandatory-label-verified MR creation/u);
      assert.doesNotMatch(readme, /explicit opt-in basic Push Options request/u);
    });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
