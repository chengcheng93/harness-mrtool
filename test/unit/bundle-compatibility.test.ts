import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadTemplateBundle, type LoadedTemplateBundle } from "../../src/bundle/load.ts";
import { validateTemplateBundle } from "../../src/bundle/validate.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { renderDescription } from "../../src/render/markdown.ts";
import { validateDesiredWritePlan, validateExternalContextSnapshot } from "../../src/render/marker.ts";
import { assertTransactionStructure, buildVerificationReceipt, verifyMergeRequest, verifyStoredMergeRequest } from "../../src/app/verify-mr.ts";
import type { RemoteMergeRequest } from "../../src/app/create-mr.ts";

import { historicalPolicy, historicalManifest } from "../helpers/historical-template-bundle.ts";

const root = resolve(import.meta.dirname, "../..");

async function historicalFixture(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(resolve(await realpath(tmpdir()), "bundle-compatibility-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  await cp(resolve(root, "template-bundle"), path, { recursive: true });
  await writeFile(resolve(path, "policy.yml"), historicalPolicy);
  await writeFile(resolve(path, "bundle-manifest.json"), historicalManifest);
  return path;
}

function semanticFixture(bundle: LoadedTemplateBundle, version: string, week: boolean): LoadedTemplateBundle {
  const value = JSON.parse(JSON.stringify(bundle));
  value.manifest.version = version;
  delete value.policy.labels.categories.week;
  if (week) value.policy.labels.categories.week = { match: "^week::", required: true, max: 1 };
  return value;
}

test("published 1.0.0 bundle loads without rewriting its hash or historical week policy", async (t) => {
  const path = await historicalFixture(t);
  const bundle = await loadTemplateBundle(path);
  assert.equal(sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`),
    "f9a35f36f124f76561a507b96b643f9493d7883f6e46af71b21209788bbe7d69");
  assert.equal(await readFile(resolve(path, "bundle-manifest.json"), "utf8"), historicalManifest);
  assert.doesNotThrow(() => validateTemplateBundle(bundle));
});

test("the no-week policy is published as bundle 1.1.0 with unchanged wire schemas", async () => {
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  assert.equal(bundle.manifest.version, "1.1.0");
  assert.equal(bundle.manifest.inputSchema, 1);
  assert.equal(bundle.manifest.policySchema, 1);
  assert.deepEqual(Object.keys((bundle.policy.labels as any).categories).sort(), ["priority", "status", "type"]);
});

test("versioned label policy contracts accept old build metadata and new prereleases but reject cross-policy relabeling", async () => {
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  for (const version of ["1.0.0", "1.0.0+bundle.7", "1.0.1"]) {
    assert.doesNotThrow(() => validateTemplateBundle(semanticFixture(bundle, version, true)), version);
    assert.throws(() => validateTemplateBundle(semanticFixture(bundle, version, false)), /label categories/, version);
  }
  for (const version of ["1.1.0", "1.1.0-rc.1", "1.1.0+bundle.7", "1.2.0"]) {
    assert.doesNotThrow(() => validateTemplateBundle(semanticFixture(bundle, version, false)), version);
    assert.throws(() => validateTemplateBundle(semanticFixture(bundle, version, true)), /label categories/, version);
  }
});

test("historical payload tampering still fails hash verification before policy validation", async (t) => {
  const path = await historicalFixture(t);
  await writeFile(resolve(path, "policy.yml"), historicalPolicy.replace('^week::', '^weak::'));
  await assert.rejects(loadTemplateBundle(path), /hash/i);
});

test("neither policy generation accepts weakened category rules or unknown categories", async () => {
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  for (const [version, week] of [["1.0.0", true], ["1.1.0", false]] as const) {
    for (const mutate of [
      (categories: any) => { categories.priority.required = false; },
      (categories: any) => { categories.type.max = 2; },
      (categories: any) => { categories.status.match = ".*"; },
      (categories: any) => { categories.extra = { match: "^extra::", required: true, max: 1 }; },
      (categories: any) => { delete categories.status; },
    ]) {
      const value = semanticFixture(bundle, version, week);
      mutate((value.policy.labels as any).categories);
      assert.throws(() => validateTemplateBundle(value), (error) => isToolError(error, "TEMPLATE_ERROR"));
    }
  }
});

async function verificationFixture(bundle: LoadedTemplateBundle) {
  const json = async (name: string) => JSON.parse(await readFile(resolve(root, "test/golden/fixtures", name), "utf8"));
  const request = normalizeAndValidateRequest(await json("code-docs-request.json"));
  const snapshot = validateExternalContextSnapshot(await json("code-docs-snapshot.json"));
  const writePlan = validateDesiredWritePlan(await json("code-docs-write-plan.json"));
  const releaseTag = "templates-v1.0.0";
  const cliVersion = "0.1.0-dev";
  const description = renderDescription({ request, snapshot, writePlan, bundle, releaseTag, cliVersion, renderPhase: "final" });
  const current: RemoteMergeRequest = {
    ...writePlan, iid: 88, webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88",
    description, draft: false, state: "opened", sourceProjectId: snapshot.sourceProject.id,
    sourceBranch: "fix/webengine-css", targetProjectId: snapshot.targetProject.id,
    targetBranch: request.targetBranch, sourceHeadSha: snapshot.sourceHeadSha, snapshot,
  };
  const expected = { request, snapshot, writePlan, releaseTag, cliVersion, description, sourceBranch: current.sourceBranch };
  return { current, expected };
}

test("historical live and receipt verification retain week labels without applying today's fixed pool", async (t) => {
  const bundle = await loadTemplateBundle(await historicalFixture(t));
  const { current, expected } = await verificationFixture(bundle);
  assert.doesNotThrow(() => assertTransactionStructure(current, expected.description, bundle, expected.releaseTag));
  assert.equal(verifyMergeRequest({ level: "structure", current, expected, bundle }).valid, true);
  const receipt = buildVerificationReceipt({ gitlabOrigin: "https://gitlab.example.test", current, expected, bundle });
  // Test doubles only at existing authenticated-loader boundaries; no production trust implementation.
  const inputs = {
    level: "structure" as const, current, gitlabOrigin: receipt.gitlabOrigin,
    receiptLoader: { loadVerified: async () => ({ trusted: true as const, receipt }) },
    bundleLoader: { loadVerifiedExact: async () => ({ trusted: true as const, bundle }) },
  };
  assert.equal((await verifyStoredMergeRequest(inputs)).valid, true);
  await assert.rejects(verifyStoredMergeRequest({ ...inputs,
    bundleLoader: { loadVerifiedExact: async () => ({ trusted: false as const, bundle: null }) },
  }), /verification failed/i);
  await assert.rejects(verifyStoredMergeRequest({ ...inputs,
    receiptLoader: { loadVerified: async () => ({ trusted: false as const, receipt: null }) },
  }), /verification failed/i);
  const wrongVersion = semanticFixture(bundle, "1.0.1", true);
  await assert.rejects(verifyStoredMergeRequest({ ...inputs,
    bundleLoader: { loadVerifiedExact: async () => ({ trusted: true as const, bundle: wrongVersion }) },
  }), /verification failed/i);
  const drifted = structuredClone(current);
  (drifted.snapshot.labelCandidates.find(({ id }) => id === "label:week") as any).name = "week::renamed";
  await assert.rejects(verifyStoredMergeRequest({ ...inputs, current: drifted }), /verification failed/i);
});

async function contextFixture(bundle: LoadedTemplateBundle) {
  const { readExternalContext } = await import("../../src/app/external-context.ts");
  const names = ["type::bug", "priority::p2", "priority::legacy", "status::doing", "status::review", "week::2026-w32-0803-0809"];
  const labels = names.map((name, index) => ({
    restId: index + 1, globalId: `gid://gitlab/ProjectLabel/${index + 1}`, name,
    description: name, color: "#123456", archived: false, scopeKind: "project" as const,
    scopeId: "7", scopePath: "group/project",
  }));
  const user = { id: "40", username: "author", displayName: "Author", state: "active" as const, accessLevel: 40 };
  const sha = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  const gitlab = {
    origin: "https://gitlab.example.test",
    getProject: async () => ({ id: "7", fullPath: "group/project", defaultBranch: "main", webUrl: "https://gitlab.example.test/group/project" }),
    getBranchHead: async () => sha,
    labelInventory: async () => ({ all: labels, effective: labels, audit: { requestIds: [] } }),
    listUsers: async () => [user],
    getCurrentUser: async () => user,
    getMergeRequest: async () => ({
      iid: 88, webUrl: "https://gitlab.example.test/group/project/-/merge_requests/88",
      title: "Historical MR", description: "Historical description", draft: true, state: "opened" as const,
      sourceProjectId: "7", sourceBranch: "fix/compatibility", targetProjectId: "7", targetBranch: "main",
      sha: sourceSha, author: user, assignees: [], reviewers: [],
      labels: labels.filter(({ name }) => ["type::bug", "priority::legacy", "status::doing", "week::2026-w32-0803-0809"].includes(name))
        .map(({ restId, name, archived }) => ({ restId, name, archived })),
      squash: true, shouldRemoveSourceBranch: true, pipelineStatus: "pending" as const,
    }),
    getReviewState: async () => ({ approvedUserIds: [], unresolvedDiscussions: 0 }),
    audit: () => ({ requestIds: [] }),
    createMergeRequest: async () => { assert.fail("read-only context must not mutate GitLab"); },
    updateMergeRequest: async () => { assert.fail("read-only context must not mutate GitLab"); },
  };
  return readExternalContext({
    operation: "update", gitlabOrigin: gitlab.origin, targetProject: "group/project", mrIid: 88, issueIid: null,
    git: { sourceProject: { id: "7", path: "group/project" }, sourceBranch: "fix/compatibility", targetBranch: "main",
      sourceHeadSha: sourceSha, targetRefSha: sha, mergeBaseSha: sha,
      localChecks: { commitConvention: { status: "passed", evidence: "Checked." }, secretScan: { status: "passed", evidence: "Checked." }, repositoryHygiene: { status: "passed", evidence: "Checked." } },
    },
    bundle, release: { releaseSetId: "stable-compatibility", releaseTag: `templates-v${bundle.manifest.version}`,
      bundleManifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`), cliVersion: "0.1.5", skillProtocol: 1 },
    gitlab: gitlab as unknown as import("../../src/gitlab/client.ts").GitLabClient,
  });
}

test("historical read-only context retains week and dynamic category candidates without changing its pinned bundle", async (t) => {
  const bundle = await loadTemplateBundle(await historicalFixture(t));
  const result = await contextFixture(bundle);
  assert.equal(result.binding.bundle.version, "1.0.0");
  assert.equal(result.binding.bundle.manifestHash, "f9a35f36f124f76561a507b96b643f9493d7883f6e46af71b21209788bbe7d69");
  assert.ok(result.requiredLabelCategories.includes("week"));
  const labels = result.candidates.filter((candidate) => candidate.kind === "label");
  assert.ok(labels.some(({ name }) => name.startsWith("week::")));
  assert.ok(labels.some(({ name }) => name === "priority::legacy"));
});

test("new policy context filters selectable labels but retains historical applied identities for verification", async () => {
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const result = await contextFixture(bundle);
  assert.equal(result.binding.bundle.version, "1.1.0");
  assert.deepEqual([...result.requiredLabelCategories].sort(), ["priority", "type"]);
  const labels = result.candidates.filter((candidate) => candidate.kind === "label");
  assert.deepEqual(labels.map(({ name }) => name).sort(), ["priority::p2", "type::bug"]);
  assert.ok(result.snapshot.labelCandidates.some(({ name }) => name.startsWith("week::")));
});

test("historical verification exemption cannot admit week labels under the new bundle", async () => {
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const { current, expected } = await verificationFixture(bundle);
  assert.throws(() => assertTransactionStructure(current, expected.description, bundle, expected.releaseTag),
    (error) => isToolError(error, "POSTCONDITION_ERROR"));
  assert.throws(() => verifyMergeRequest({ level: "structure", current, expected, bundle }),
    (error) => isToolError(error, "POSTCONDITION_ERROR"));
});

test("manifest rebuild preserves the explicit current or historical release metadata", async (t) => {
  const { buildTemplateBundleManifest } = await import("../../src/bundle/manifest.ts");
  for (const path of [resolve(root, "template-bundle"), await historicalFixture(t)]) {
    const before = await readFile(resolve(path, "bundle-manifest.json"), "utf8");
    const rebuilt = await buildTemplateBundleManifest(path);
    assert.equal(rebuilt.serialized, before);
    assert.equal(rebuilt.sha256, sha256Utf8(before));
  }
});

test("manifest rebuild rejects malformed release metadata rather than silently defaulting it", async (t) => {
  const { buildTemplateBundleManifest } = await import("../../src/bundle/manifest.ts");
  const path = await historicalFixture(t);
  for (const version of ["v1.0.0", "1.0", "1.0.0-01", "", null]) {
    const manifest = JSON.parse(historicalManifest);
    manifest.version = version;
    await writeFile(resolve(path, "bundle-manifest.json"), `${canonicalizeJson(manifest)}\n`);
    await assert.rejects(buildTemplateBundleManifest(path), (error) => isToolError(error, "TEMPLATE_ERROR"));
  }
});
