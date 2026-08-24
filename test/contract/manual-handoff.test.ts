import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { createManualCommandServices } from "../../src/cli/commands/manual.ts";
import { executeCliJson } from "../../src/cli/execute.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import type { RepositorySnapshot } from "../../src/git/repository.ts";
import type { SourceBranchPushPlan } from "../../src/git/push-plan.ts";
import { buildSshMergeRequestPushOptions, isSshPushUrl } from "../../src/git/push-plan.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function fakeRepository(): RepositorySnapshot {
  return {
    gitlabHost: "gitlab.example.test",
    root: repositoryRoot,
    runner: {} as never,
    sourceBranch: "feature/manual",
    sourceHeadSha: "b".repeat(40),
    sourceProject: { host: "gitlab.example.test", path: "team/source" },
    sourceFetchUrl: "git@gitlab.example.test:team/source.git",
    sourcePushUrl: "git@gitlab.example.test:team/source.git",
    sourceRemote: "origin",
    sourceRemoteIdentity: { key: "gitlab:gitlab.example.test/team/source", kind: "gitlab", project: { host: "gitlab.example.test", path: "team/source" } },
    sourceRemoteRef: "refs/heads/feature/manual",
    targetBranch: "develop",
    targetProject: { host: "gitlab.example.test", path: "team/target" },
    targetFetchUrl: "git@gitlab.example.test:team/target.git",
    targetPushUrl: "git@gitlab.example.test:team/target.git",
    targetRef: "refs/remotes/origin/develop",
    targetRefSha: "a".repeat(40),
    targetRemote: "origin",
    targetRemoteIdentity: { key: "gitlab:gitlab.example.test/team/target", kind: "gitlab", project: { host: "gitlab.example.test", path: "team/target" } },
    worktree: { clean: true, staged: false, unstaged: false, untracked: false },
  };
}

test("manual handoff renders a token-free MR draft and never calls GitLab", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const raw = JSON.parse(await readFile(
    resolve(repositoryRoot, "test/golden/fixtures/code-docs-request.json"),
    "utf8",
  )) as Record<string, unknown>;
  raw.targetBranch = "develop";
  const review = raw.review as Record<string, unknown>;
  review.reviewerCandidateTokens = [`hmrc1_${"A".repeat(43)}`];
  const mergeRequest = raw.mergeRequest as Record<string, unknown>;
  mergeRequest.assigneeCandidateToken = `hmrc1_${"B".repeat(43)}`;
  mergeRequest.labelCandidateTokens = [`hmrc1_${"C".repeat(43)}`];
  const repository = fakeRepository();
  const plan: SourceBranchPushPlan = {
    kind: "confirmation-required",
    relation: "absent",
    beforeSha: null,
    command: ["push", "--no-force", "origin", `${repository.sourceHeadSha}:${repository.sourceRemoteRef}`],
    localHeadSha: repository.sourceHeadSha,
    remote: repository.sourceRemote,
    remoteRef: repository.sourceRemoteRef,
  };
  let pushed = false;
  const services = createManualCommandServices({
    cliVersion: "0.1.4-test",
    cwd: repositoryRoot,
    currentBundle: {
      bundle,
      bundleManifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`),
      releaseSetId: "release-set:test",
      releaseTag: "templates-v1.0.0",
    },
    requestSource: { read: async () => raw },
    repository: {
      discover: async () => repository,
      mergeBase: async () => "a".repeat(40),
      planPush: async () => plan,
      executePush: async () => {
        pushed = true;
        return { kind: "pushed", beforeSha: null, afterSha: repository.sourceHeadSha };
      },
    },
  });
  const chunks: string[] = [];
  const result = await executeCliJson(
    ["manual", "--input", "-", "--input-format", "json", "--output", "json"],
    {
      cliVersion: "0.1.4-test",
      handlers: services,
      stdout: {
        write(chunk, callback) {
          chunks.push(chunk);
          callback();
          return true;
        },
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(pushed, false);
  const output = JSON.parse(chunks[0]!) as Record<string, unknown>;
  assert.equal(output.ok, true);
  const data = output.data as Record<string, unknown>;
  assert.equal(data.command, "manual");
  assert.equal(data.tokenRequired, false);
  assert.equal(typeof data.description, "string");
  assert.equal((data.description as string).includes("hmrc1_"), false);
  const pushPlan = data.pushPlan as Record<string, unknown>;
  assert.equal(pushPlan.state, "ready");
  assert.equal(pushPlan.command, `git push --no-force origin ${repository.sourceHeadSha}:${repository.sourceRemoteRef}`);

  const pushChunks: string[] = [];
  const pushResult = await executeCliJson(
    ["manual", "--input", "-", "--input-format", "json", "--push", "--output", "json"],
    {
      cliVersion: "0.1.4-test",
      handlers: services,
      stdout: {
        write(chunk, callback) {
          pushChunks.push(chunk);
          callback();
          return true;
        },
      },
    },
  );
  assert.equal(pushResult.exitCode, 0);
  assert.equal(pushed, true);
  const pushedOutput = JSON.parse(pushChunks[0]!) as Record<string, unknown>;
  const pushedData = pushedOutput.data as Record<string, unknown>;
  const pushedPlan = pushedData.pushPlan as Record<string, unknown>;
  assert.deepEqual(pushedPlan.execution, {
    state: "pushed",
    beforeSha: null,
    afterSha: repository.sourceHeadSha,
  });
});

test("SSH Push Options are explicit, newline-safe, and exclude metadata mutation", () => {
  assert.equal(isSshPushUrl("git@gitlab.example.test:team/project.git"), true);
  assert.equal(isSshPushUrl("https://gitlab.example.test/team/project.git"), false);
  assert.deepEqual(buildSshMergeRequestPushOptions({
    targetBranch: "main",
    title: "Draft title",
    description: "# Summary\nLine one",
    draft: true,
  }), [
    "merge_request.create",
    "merge_request.target=main",
    "merge_request.title=Draft title",
    "merge_request.description=# Summary\\nLine one",
    "merge_request.draft",
  ]);
});

test("manual --ssh-mr exposes an unverified basic MR request without labels or reviewers", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const raw = JSON.parse(await readFile(
    resolve(repositoryRoot, "test/golden/fixtures/code-docs-request.json"),
    "utf8",
  )) as Record<string, unknown>;
  raw.targetBranch = "develop";
  let capturedOptions: readonly string[] | undefined;
  const repository = fakeRepository();
  const basePlan: SourceBranchPushPlan = {
    kind: "confirmation-required",
    relation: "absent",
    beforeSha: null,
    command: ["push", "--push-option=merge_request.create"],
    localHeadSha: repository.sourceHeadSha,
    remote: repository.sourceRemote,
    remoteRef: repository.sourceRemoteRef,
    pushOptions: [
      "merge_request.create",
      "merge_request.target=develop",
      "merge_request.title=placeholder",
      "merge_request.description=placeholder",
      "merge_request.draft",
    ],
  };
  const services = createManualCommandServices({
    cliVersion: "0.1.4-test",
    cwd: repositoryRoot,
    currentBundle: {
      bundle,
      bundleManifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`),
      releaseSetId: "release-set:test",
      releaseTag: "templates-v1.0.0",
    },
    requestSource: { read: async () => raw },
    repository: {
      discover: async () => repository,
      mergeBase: async () => "a".repeat(40),
      planPush: async (_repository, options) => {
        capturedOptions = options.pushOptions;
        return basePlan;
      },
      executePush: async () => ({ kind: "not-written", beforeSha: null, afterSha: null }),
    },
  });
  const chunks: string[] = [];
  await executeCliJson(
    ["manual", "--auth", "ssh", "--ssh-mr", "--input", "-", "--input-format", "json", "--output", "json"],
    {
      cliVersion: "0.1.4-test",
      handlers: services,
      stdout: { write(chunk, callback) { chunks.push(chunk); callback(); return true; } },
    },
  );
  assert.ok(capturedOptions?.includes("merge_request.create"));
  assert.equal(capturedOptions?.some((option) => option.includes("label=") || option.includes("assign=")), false);
  const data = (JSON.parse(chunks[0]!) as Record<string, unknown>).data as Record<string, unknown>;
  assert.equal(data.mode, "ssh-mr");
  assert.equal(data.mrCreation, "not-requested");
  const pushPlan = data.pushPlan as Record<string, unknown>;
  assert.equal(typeof pushPlan.command, "string");
  assert.match(pushPlan.command as string, /--no-force/u);
  assert.ok((pushPlan.command as string).includes('--push-option="merge_request.create"'));
  assert.doesNotMatch(pushPlan.command as string, /--no-push-option/u);
});

test("manual --ssh-mr rejects API auth mode before rendering or writing", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const raw = JSON.parse(await readFile(
    resolve(repositoryRoot, "test/golden/fixtures/code-docs-request.json"),
    "utf8",
  )) as Record<string, unknown>;
  const services = createManualCommandServices({
    cliVersion: "0.1.4-test",
    cwd: repositoryRoot,
    currentBundle: {
      bundle,
      bundleManifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`),
      releaseSetId: "release-set:test",
      releaseTag: "templates-v1.0.0",
    },
    requestSource: { read: async () => raw },
    repository: {
      discover: async () => { throw new Error("must not discover repository"); },
      mergeBase: async () => { throw new Error("must not calculate merge base"); },
      planPush: async () => { throw new Error("must not plan push"); },
      executePush: async () => { throw new Error("must not execute push"); },
    },
  });
  const chunks: string[] = [];
  const result = await executeCliJson(
    ["manual", "--auth", "api", "--ssh-mr", "--input", "-", "--input-format", "json", "--output", "json"],
    {
      cliVersion: "0.1.4-test",
      handlers: services,
      stdout: { write(chunk, callback) { chunks.push(chunk); callback(); return true; } },
    },
  );
  assert.equal(result.exitCode, 3);
  const output = JSON.parse(chunks[0]!) as Record<string, unknown>;
  assert.equal(output.ok, false);
  assert.equal(output.code, "REPOSITORY_ERROR");
});

test("manual SSH mode requires structured input before any wizard or GitLab access", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  let requestRead = false;
  const services = createManualCommandServices({
    cliVersion: "0.1.4-test",
    cwd: repositoryRoot,
    currentBundle: {
      bundle,
      bundleManifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`),
      releaseSetId: "release-set:test",
      releaseTag: "templates-v1.0.0",
    },
    requestSource: { read: async () => { requestRead = true; return {}; } },
    repository: {
      discover: async () => { throw new Error("must not discover repository"); },
      mergeBase: async () => { throw new Error("must not calculate merge base"); },
      planPush: async () => { throw new Error("must not plan push"); },
      executePush: async () => { throw new Error("must not execute push"); },
    },
  });
  const chunks: string[] = [];
  const result = await executeCliJson(
    ["manual", "--auth", "ssh", "--output", "json"],
    {
      cliVersion: "0.1.4-test",
      handlers: services,
      stdout: { write(chunk, callback) { chunks.push(chunk); callback(); return true; } },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(requestRead, false);
  const output = JSON.parse(chunks[0]!) as Record<string, unknown>;
  assert.equal(output.ok, false);
  assert.equal(output.code, "INPUT_ERROR");
});
