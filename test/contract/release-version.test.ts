import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

// @ts-expect-error The release helper intentionally has no declaration file.
import { verifyReleaseVersion } from "../../scripts/verify-release-version.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = join(repositoryRoot, "scripts/verify-release-version.mjs");
const components = ["cli", "templates", "skill", "plugin"] as const;
const packageVersion = "0.1.7";
const templateVersion = "1.1.0";
const pluginPath = "plugins/harness-mrtool/.codex-plugin/plugin.json";
const templatePath = "template-bundle/bundle-manifest.json";

async function json(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), `${JSON.stringify(value)}\n`);
}

async function fixture(t: test.TestContext, version = packageVersion, bundleVersion = templateVersion) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "release-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await json(root, "package.json", { name: "harness-mrtool", version });
  await json(root, "package-lock.json", {
    name: "harness-mrtool", version, lockfileVersion: 3,
    packages: { "": { name: "harness-mrtool", version } },
  });
  await json(root, pluginPath, { name: "harness-mrtool", version });
  await json(root, templatePath, { bundleId: "harness-mr-default", version: bundleVersion });
  return root;
}

function cli(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

async function snapshot(root: string) {
  const paths = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")]));
}

async function rejectsVersion(root: string, component: string, tag: string, reason: RegExp) {
  const before = await snapshot(root);
  await assert.rejects(verifyReleaseVersion({ component, tag, root }), reason);
  const result = cli(root, ["--component", component, "--tag", tag, "--root", root]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Release version validation failed:/u);
  assert.match(result.stderr, reason);
  assert.deepEqual(await snapshot(root), before, "validation must not change metadata or create files");
}

test("helper and CLI accept coherent versions for all four release components without writes", async (t) => {
  const root = await fixture(t);
  const before = await snapshot(root);
  for (const component of components) {
    await t.test(component, async () => {
      const version = component === "templates" ? templateVersion : packageVersion;
      const tag = `${component}-v${version}`;
      const expected = { component, tag, version, packageVersion };
      assert.deepEqual(await verifyReleaseVersion({ component, tag, root }), expected);
      const result = cli(root, ["--component", component, "--tag", tag, "--root", root]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), expected);
    });
  }
  assert.deepEqual(await snapshot(root), before);
});

test("canonical prerelease and build identifiers are accepted without dropping build identity", async (t) => {
  const version = "2.3.4-rc.1+build.01";
  const root = await fixture(t, version, version);
  for (const component of components) {
    await t.test(component, async () => {
      const tag = `${component}-v${version}`;
      const result = cli(root, ["--component", component, "--tag", tag, "--root", root]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).version, version);
      await rejectsVersion(root, component, `${component}-v2.3.4-rc.1+build.02`, /does not match/u);
    });
  }
});

test("wrong release versions and component prefixes fail through both helper and CLI", async (t) => {
  const root = await fixture(t);
  for (const component of components) {
    await t.test(`${component} version`, () => rejectsVersion(root, component, `${component}-v9.9.9`, /does not match/u));
    const other = component === "cli" ? "plugin" : "cli";
    await t.test(`${component} prefix`, () => rejectsVersion(root, component, `${other}-v${packageVersion}`, /prefix/u));
  }
});

test("noncanonical or malformed tags never authorize a release", async (t) => {
  const root = await fixture(t);
  for (const tag of [
    "cli-v01.1.6", "cli-v0.1", "cli-v0.1.6-01", "cli-v0.1.6-rc..1", "cli-v0.1.6-",
    "cli-v0.1.6+", "cli-v0.1.6+build..1", "cli-vv0.1.6", "cli-v0.1.6 ", "cli-v0.1.6\n",
    " cli-v0.1.6", "CLI-v0.1.6", "refs/tags/cli-v0.1.6", "0.1.6", "cli-v9007199254740992.0.0",
  ]) {
    await t.test(JSON.stringify(tag), () => rejectsVersion(root, "cli", tag, /canonical SemVer|prefix/u));
  }
});

test("all component releases require both lockfile root versions to agree with package metadata", async (t) => {
  for (const component of components) {
    for (const field of ["version", "root package"] as const) {
      await t.test(`${component}: ${field}`, async (t) => {
        const root = await fixture(t);
        const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
        if (field === "version") lock.version = "0.1.5";
        else lock.packages[""].version = "0.1.5";
        await json(root, "package-lock.json", lock);
        const version = component === "templates" ? templateVersion : packageVersion;
        await rejectsVersion(root, component, `${component}-v${version}`, /package-lock\.json.*does not match/u);
      });
    }
  }
});

test("a plugin tag matching its manifest still fails if the CLI package version differs", async (t) => {
  const root = await fixture(t, "0.1.6");
  await json(root, pluginPath, { name: "harness-mrtool", version: "0.1.7" });
  await rejectsVersion(root, "plugin", "plugin-v0.1.7", /does not match/u);
});

test("a plugin tag matching the CLI package fails if its plugin manifest differs", async (t) => {
  const root = await fixture(t);
  await json(root, pluginPath, { name: "harness-mrtool", version: "0.1.5" });
  await rejectsVersion(root, "plugin", "plugin-v0.1.7", /does not match/u);
});

test("missing, malformed, or noncanonical selected metadata fails closed", async (t) => {
  for (const [path, component, tag] of [
    ["package.json", "cli", "cli-v0.1.6"],
    ["package-lock.json", "skill", "skill-v0.1.6"],
    [pluginPath, "plugin", "plugin-v0.1.6"],
    [templatePath, "templates", "templates-v1.1.0"],
  ]) {
    for (const bad of ["missing", "invalid JSON", "null", "array", "missing version", "non-string version", "noncanonical version"]) {
      await t.test(`${path}: ${bad}`, async (t) => {
        const root = await fixture(t);
        if (bad === "missing") await rm(join(root, path!));
        else if (bad === "invalid JSON") await writeFile(join(root, path!), "{broken");
        else await json(root, path!, bad === "null" ? null : bad === "array" ? [] : bad === "missing version" ? {}
          : { version: bad === "non-string version" ? 16 : "v0.1.6" });
        await rejectsVersion(root, component!, tag!, /metadata|canonical SemVer/u);
      });
    }
  }
});

test("missing or malformed lockfile package-root records cannot bypass coherence", async (t) => {
  for (const packages of [undefined, null, [], {}, { "": null }, { "": {} }, { "": { version: 16 } }]) {
    await t.test(JSON.stringify(packages) ?? "absent", async (t) => {
      const root = await fixture(t);
      await json(root, "package-lock.json", { version: packageVersion, packages });
      await rejectsVersion(root, "cli", "cli-v0.1.6", /metadata|canonical SemVer/u);
    });
  }
});

test("unknown components and invalid root values are rejected", async (t) => {
  const root = await fixture(t);
  for (const component of ["unknown", "template", "CLI", "constructor", "__proto__"]) {
    await rejectsVersion(root, component, "cli-v0.1.6", /component/u);
  }
  for (const invalidRoot of ["", null, 42]) {
    await assert.rejects(verifyReleaseVersion({ component: "cli", tag: "cli-v0.1.6", root: invalidRoot }), /root/u);
  }
});

test("CLI rejects unknown, duplicate, positional and missing arguments", async (t) => {
  const root = await fixture(t);
  const valid = ["--component", "cli", "--tag", "cli-v0.1.6", "--root", root];
  for (const args of [
    [], ["--component", "cli"], ["--tag", "cli-v0.1.6"], ["--component"],
    ["--component", "--tag", "cli-v0.1.6"], [...valid, "--unknown", "value"],
    [...valid, "--component", "cli"], [...valid, "--tag", "cli-v0.1.6"],
    [...valid, "--root", root], [...valid, "positional"], [...valid, "--root"],
    ["--component=cli", "--tag", "cli-v0.1.6"], ["--component", "cli", "--tag", "cli-v0.1.6", "--root", ""],
  ]) {
    const result = cli(root, args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Release version validation failed:/u);
  }
});

test("default root is the helper repository, not the caller working directory", async (t) => {
  const root = await fixture(t, "9.9.9");
  const metadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const tag = `cli-v${metadata.version}`;
  assert.equal((await verifyReleaseVersion({ component: "cli", tag })).packageVersion, metadata.version);
  const result = cli(root, ["--component", "cli", "--tag", tag]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).packageVersion, metadata.version);
});

test("each release workflow gates version coherence before build or packaging", async (t) => {
  for (const [component, filename, job, boundary] of [
    ["cli", "release-cli.yml", "build", "npm run build:sea"],
    ["templates", "release-template.yml", "verify", "zip -X"],
    ["skill", "release-skill.yml", "verify", "node scripts/package-skill-archive.mjs"],
    ["plugin", "release-plugin.yml", "verify", "node scripts/package-plugin.mjs"],
  ] as const) {
    await t.test(component, async () => {
      const workflow = parse(await readFile(join(repositoryRoot, ".github/workflows", filename), "utf8"));
      const steps = workflow.jobs[job].steps as { name?: string; run?: string; shell?: string; if?: string; "continue-on-error"?: boolean }[];
      const matches = steps.filter((step) => step.run?.includes("node scripts/verify-release-version.mjs"));
      assert.equal(matches.length, 1, "release job must contain one version gate");
      const gate = matches[0]!;
      const gateIndex = steps.indexOf(gate);
      assert.equal(gate.if, undefined, "version gate must not be conditional");
      assert.notEqual(gate["continue-on-error"], true);
      assert.equal(gate.shell, component === "cli" ? "pwsh" : "bash");
      assert.equal(gate.run?.trim(), `node scripts/verify-release-version.mjs --component ${component} --tag "${component === "cli" ? "$env:RELEASE_TAG" : "$RELEASE_TAG"}"`);
      assert.ok(gateIndex > steps.findIndex((step) => step.run === "npm ci"));
      assert.ok(gateIndex > steps.findIndex((step) => step.name?.startsWith("Require an immutable")));
      const boundaryIndex = steps.findIndex((step) => step.run?.includes(boundary));
      assert.ok(boundaryIndex > gateIndex, "version gate must precede artifact creation");
      if (component === "cli") {
        assert.deepEqual(workflow.jobs["verify-draft-assets"].needs, ["build", "verify-draft-assets-macos-arm64"]);
        assert.equal(workflow.jobs["verify-draft-assets-macos-arm64"].needs, "build-macos-arm64");
        const macSteps = workflow.jobs["build-macos-arm64"].steps as { run?: string; if?: string; "continue-on-error"?: boolean }[];
        const macGate = macSteps.findIndex((step) => step.run?.includes("node scripts/verify-release-version.mjs"));
        const macBuild = macSteps.findIndex((step) => step.run === "npm run build:sea");
        assert.ok(macGate >= 0 && macBuild > macGate, "native build also requires the unconditional version gate");
        assert.equal(macSteps[macGate]!.if, undefined);
        assert.notEqual(macSteps[macGate]!["continue-on-error"], true);
        assert.equal(workflow.jobs.publish.needs, "verify-draft-assets");
      } else {
        assert.ok(steps.findIndex((step) => step.run?.includes("gh release create")) > gateIndex);
      }
    });
  }
});
