import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import packageMetadata from "../../package.json" with { type: "json" };

// @ts-expect-error The packaging helper intentionally has no declaration file.
import { packagePlugin } from "../../scripts/package-plugin.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Codex plugin packaging emits a bounded, self-contained archive", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "harness-mrtool-plugin-"));
  try {
    const result = await packagePlugin({
      inputDirectory: join(repositoryRoot, "plugins", "harness-mrtool"),
      outputDirectory: output,
      version: packageMetadata.version,
    });
    const archive = await readFile(result.archivePath);
    const entries = unzipSync(archive);
    const names = Object.keys(entries).sort();
    const instructions = Buffer.from(entries["skills/harness-mr/SKILL.md"]!).toString("utf8");
    for (const link of instructions.matchAll(/\]\(([^)]+)\)/gu)) {
      assert.ok(entries["skills/harness-mr/" + link[1]!], link[1] + " must resolve inside the plugin archive");
    }
    assert.ok(names.includes(".codex-plugin/plugin.json"));
    assert.ok(names.includes("skills/harness-mr/SKILL.md"));
    assert.ok(names.includes("skills/harness-mr/scripts/bootstrap.ps1"));
    assert.ok(names.includes("README.md"));
    for (const relative of ["scripts/run-flow.ps1", "references/workflows.md"]) {
      const name = "skills/harness-mr/" + relative;
      assert.ok(names.includes(name), name + " must ship in the actual plugin archive");
      assert.deepEqual(Buffer.from(entries[name]!), await readFile(join(repositoryRoot, "skill/harness-mr", relative)));
    }
    assert.ok(names.includes("scripts/setup-gitlab.ps1"));
    assert.ok(names.includes("hooks/hooks.json"));
    assert.ok(names.includes("hooks/session-start.ps1"));
    assert.ok(names.includes("hooks/session-start.sh"));
    assert.equal(Buffer.compare(Buffer.from(entries["scripts/setup-gitlab.ps1"]!), await readFile(join(repositoryRoot, "scripts/setup-gitlab.ps1"))), 0);
    const hooks = JSON.parse(Buffer.from(entries["hooks/hooks.json"]!).toString("utf8"));
    assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
    assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume|clear");
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-start\.sh/u);
    assert.match(hooks.hooks.SessionStart[0].hooks[0].commandWindows, /session-start\.ps1/u);
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
    assert.equal(manifest.version, packageMetadata.version);
    const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
    assert.equal(pkg.version, manifest.version);
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[""].version, manifest.version);
    const sums = await readFile(result.sumsPath, "utf8");
    assert.match(sums, /^[a-f0-9]{64}  harness-mrtool-codex-plugin\.zip\n$/u);
    const readme = Buffer.from(entries["README.md"]!).toString("utf8").replace(/\s+/gu, " ");
    await t.test("packaged README distinguishes CLI installation from plugin/source versions", () => {
      assert.match(readme, /Install a verified, versioned CLI package/u);
      assert.match(readme, /The plugin does not include or upgrade the CLI binary/u);
      assert.match(readme, /check its installed version separately/u);
      assert.match(readme, /Source\/plugin version numbers alone do not confirm that the matching CLI Release is published/u);
      assert.doesNotMatch(readme, /is a release candidate, not yet published/u);
    });
    await t.test("packaged README uses main with the existing marketplace commands", () => {
      assert.match(readme, /codex plugin marketplace add chengcheng93\/harness-mrtool --ref main/u);
      assert.match(readme, /codex plugin add harness-mrtool@harness-mrtool/u);
      assert.doesNotMatch(readme, /--ref release-candidate-0\.1\.0/u);
    });
    await t.test("packaged README defaults to direct API MR creation with preview only on request", () => {
      assert.match(readme, /The default invocation follows this order \(`--auth api` is the CLI default\)/u);
      assert.match(readme, /schema\/profiles -> context --auth api -> Request workItem:new -> create -> creation-response MR URL/u);
      assert.match(readme, /[Pp]review[^.]*only when explicitly requested/u);
      assert.doesNotMatch(readme, /structured Request -> preview -> user confirmation/u);
      assert.match(readme, /Missing credentials or API failures stop the flow; never automatically fall back to SSH or manual handoff/u);
      assert.match(readme, /`--auth auto` remains a compatibility alias for API selection without SSH fallback/u);
      assert.doesNotMatch(readme, /default Skill path is SSH-first|optional API invocation|A GitLab token is optional/u);
    });
    await t.test("packaged README describes early initialization and hook trust", () => {
      assert.match(readme, /setup-gitlab\.ps1/u);
      assert.match(readme, /auth check --output json/u);
      assert.match(readme, /SessionStart/u);
      assert.match(readme, /review and trust/u);
      assert.match(readme, /no PostInstall/u);
    });
    await t.test("packaged README disables every manual MR handoff before repository or push effects", () => {
      assert.match(readme, /Manual MR creation handoff is disabled/u);
      assert.match(readme, /Git may still use SSH to push the source branch/u);
      assert.match(readme, /including `--push` and `--ssh-mr`/u);
      assert.match(readme, /before repository inspection, push planning/u);
      assert.doesNotMatch(readme, /Use `manual --auth ssh` only|explicit opt-in basic Push Options request/u);
    });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
