import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";

// @ts-expect-error The packaging helper intentionally has no declaration file.
import { packagePlugin } from "../../scripts/package-plugin.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Codex plugin packaging emits a bounded, self-contained archive", async () => {
  const output = await mkdtemp(join(tmpdir(), "harness-mrtool-plugin-"));
  try {
    const result = await packagePlugin({
      inputDirectory: join(repositoryRoot, "plugins", "harness-mrtool"),
      outputDirectory: output,
      version: "0.1.0",
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
    assert.equal(manifest.version, "0.1.0");
    const sums = await readFile(result.sumsPath, "utf8");
    assert.match(sums, /^[a-f0-9]{64}  harness-mrtool-codex-plugin\.zip\n$/u);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
