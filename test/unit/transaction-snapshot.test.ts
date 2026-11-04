import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  readExternalContext,
  type ExternalContextReadOptions,
} from "../../src/app/external-context.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";
import type {
  GitLabIssue,
  GitLabLabel,
  GitLabMergeRequest,
  GitLabProject,
  GitLabReviewState,
  GitLabUser,
} from "../../src/gitlab/types.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sourceSha = "b".repeat(40);
const targetSha = "a".repeat(40);
const bundlePromise = loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));

function label(restId: number, name: string): GitLabLabel {
  return {
    restId,
    globalId: "gid://gitlab/ProjectLabel/" + String(restId),
    name,
    description: name,
    color: "#123456",
    archived: false,
    scopeKind: "project",
    scopeId: "7",
    scopePath: "group/project",
  };
}

function user(id: string, username: string, accessLevel: number): GitLabUser {
  return { id, username, displayName: username, state: "active", accessLevel };
}

function mergeRequest(
  overrides: Partial<GitLabMergeRequest> = {},
): GitLabMergeRequest {
  return {
    iid: 88,
    webUrl: "https://gitlab.example.test/group/project/-/merge_requests/88",
    title: "Draft: [bug][runtime] Preserve live context",
    description: "body",
    draft: true,
    state: "opened",
    sourceProjectId: "7",
    sourceBranch: "feature/fast-path",
    targetProjectId: "7",
    targetBranch: "develop",
    sha: sourceSha,
    author: user("40", "author", 30),
    assignees: [user("42", "developer", 30)],
    reviewers: [user("41", "maintainer", 40)],
    labels: [
      { restId: 1, name: "type::bug", archived: false },
      { restId: 2, name: "priority::p2", archived: false },
      { restId: 3, name: "status::doing", archived: false },
    ],
    squash: true,
    shouldRemoveSourceBranch: true,
    pipelineStatus: "passed",
    ...overrides,
  };
}

/** Same tokenless, read-only assembly as integration/external-context.test.ts. */
class LiveContextFixture {
  readonly origin = "https://gitlab.example.test";
  readonly calls: string[] = [];
  readonly project: GitLabProject = {
    id: "7", fullPath: "group/project", defaultBranch: "develop",
    webUrl: "https://gitlab.example.test/group/project",
  };
  readonly labels: GitLabLabel[] = [
    label(1, "type::bug"), label(2, "priority::p2"),
    label(3, "status::doing"), label(4, "status::review"),
  ];
  readonly users: GitLabUser[] = [
    user("40", "author", 30), user("42", "developer", 30),
    user("41", "maintainer", 40),
  ];
  issue: GitLabIssue = {
    iid: 51, milestone: "Current issue", dueDate: null,
    assignees: [], labels: [{ restId: 1, name: "type::bug", archived: false }],
  };
  review: GitLabReviewState = { approvedUserIds: ["41"], unresolvedDiscussions: 2 };
  branchHeads = [targetSha];
  branchReadIndex = 0;
  #binding = "original-client";

  async getProject(reference: string): Promise<GitLabProject> {
    assert.equal(this.#binding, "original-client");
    this.calls.push("getProject:" + reference);
    return this.project;
  }

  async getBranchHead(project: string, branch: string): Promise<string> {
    this.calls.push("getBranchHead:" + project + ":" + branch);
    const index = Math.min(this.branchReadIndex++, this.branchHeads.length - 1);
    return this.branchHeads[index]!;
  }

  async labelInventory(project: string) {
    this.calls.push("labelInventory:" + project);
    return { all: this.labels, effective: this.labels, audit: { requestIds: [] } };
  }

  async listUsers(project: string): Promise<readonly GitLabUser[]> {
    assert.equal(this.#binding, "original-client");
    this.calls.push("listUsers:" + project);
    return this.users;
  }

  async getCurrentUser(): Promise<GitLabUser> {
    this.calls.push("getCurrentUser");
    return this.users[0]!;
  }

  async getIssue(project: string, iid: number): Promise<GitLabIssue> {
    this.calls.push("getIssue:" + project + ":" + String(iid));
    return this.issue;
  }

  async getMergeRequest(project: string, iid: number): Promise<GitLabMergeRequest> {
    assert.equal(this.#binding, "original-client");
    this.calls.push("getMergeRequest:" + project + ":" + String(iid));
    return mergeRequest({ iid, pipelineStatus: "canceled" });
  }

  async getReviewState(
    project: string, iid: number, expectedSha: string,
  ): Promise<GitLabReviewState> {
    this.calls.push("getReviewState:" + project + ":" + String(iid) + ":" + expectedSha);
    return this.review;
  }

  audit() {
    assert.equal(this.#binding, "original-client");
    this.calls.push("audit");
    return { requestIds: [] };
  }
}

async function readOptions(
  api: LiveContextFixture,
  overrides: Partial<ExternalContextReadOptions> = {},
): Promise<ExternalContextReadOptions> {
  const bundle = await bundlePromise;
  return {
    operation: "update",
    gitlabOrigin: api.origin,
    targetProject: "group/project",
    mrIid: 88,
    issueIid: null,
    git: {
      sourceProject: { id: "7", path: "group/project" },
      sourceBranch: "feature/fast-path",
      targetBranch: "develop",
      targetRefSha: targetSha,
      mergeBaseSha: targetSha,
      sourceHeadSha: sourceSha,
      localChecks: {
        commitConvention: { status: "passed", evidence: "checked" },
        secretScan: { status: "passed", evidence: "checked" },
        repositoryHygiene: { status: "passed", evidence: "checked" },
      },
    },
    bundle,
    release: {
      releaseSetId: "stable-test",
      releaseTag: "templates-v" + bundle.manifest.version,
      bundleManifestHash: sha256Utf8(canonicalizeJson(bundle.manifest) + "\n"),
      cliVersion: "0.1.7",
      skillProtocol: 1,
    },
    gitlab: api as unknown as GitLabClient,
    ...overrides,
  };
}

function hasCode(code: string) {
  return (error: unknown): boolean => typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}

test("reuses one exact MR read while discovering all other external context live", async () => {
  const api = new LiveContextFixture();
  const supplied = mergeRequest({ pipelineStatus: "running" });
  const originalRead = api.getMergeRequest;
  const context = await readExternalContext(await readOptions(api, {
    mergeRequestRead: supplied, issueIid: 51,
  }));

  assert.deepEqual(api.calls, [
    "getProject:group/project",
    "getBranchHead:7:develop",
    "labelInventory:7",
    "listUsers:7",
    "getCurrentUser",
    "getIssue:7:51",
    "getReviewState:7:88:" + sourceSha,
    "getProject:group/project",
    "getBranchHead:7:develop",
    "audit",
  ]);
  assert.equal(api.getMergeRequest, originalRead);
  assert.equal(context.snapshot.ci.status, "running");
  assert.equal(context.snapshot.mergeRequest.iid, 88);
  assert.deepEqual(context.snapshot.review, {
    approvedByUserIds: ["41"], qualifiedReviewerUserIds: ["41"],
    unresolvedDiscussions: 2,
  });
  assert.equal(context.snapshot.issue.kind, "linked");
  if (context.snapshot.issue.kind === "linked" && context.snapshot.issue.readStatus === "available") {
    assert.equal(context.snapshot.issue.milestone, "Current issue");
  }
  assert.equal(Object.isFrozen(context.snapshot), true);
});

test("does not leak an MR read into later calls on the same client", async () => {
  const api = new LiveContextFixture();
  const originalRead = api.getMergeRequest;
  const options = await readOptions(api);
  const first = await readExternalContext({ ...options, mergeRequestRead: mergeRequest() });
  const later = await readExternalContext(options);

  assert.equal(first.snapshot.ci.status, "passed");
  assert.equal(later.snapshot.ci.status, "canceled");
  assert.deepEqual(api.calls.filter((call) => call.startsWith("getMergeRequest:")),
    ["getMergeRequest:7:88"]);
  assert.equal(api.getMergeRequest, originalRead);
});

test("isolates supplied MR reads across concurrent calls and an ordinary live read", async () => {
  const api = new LiveContextFixture();
  const options = await readOptions(api);
  const contexts = await Promise.all([
    readExternalContext({ ...options, mergeRequestRead: mergeRequest({ pipelineStatus: "running" }) }),
    readExternalContext({
      ...options, mrIid: 89,
      mergeRequestRead: mergeRequest({ iid: 89, pipelineStatus: "failed" }),
    }),
    readExternalContext({ ...options, mrIid: 90 }),
  ]);

  assert.deepEqual(contexts.map((context) =>
    [context.snapshot.mergeRequest.iid, context.snapshot.ci.status]),
  [[88, "running"], [89, "failed"], [90, "canceled"]]);
  assert.deepEqual(api.calls.filter((call) => call.startsWith("getMergeRequest:")),
    ["getMergeRequest:7:90"]);
  assert.equal(api.calls.filter((call) => call === "labelInventory:7").length, 3);
  assert.equal(api.calls.filter((call) => call === "listUsers:7").length, 3);
});

test("captures supplied MR evidence before asynchronous discovery can mutate the input", async () => {
  const api = new LiveContextFixture();
  const supplied = mergeRequest({ pipelineStatus: "running" });
  const options = await readOptions(api, { mergeRequestRead: supplied });
  const reading = readExternalContext(options);
  (supplied as { sha: string; pipelineStatus: string }).sha = "f".repeat(40);
  (supplied as { sha: string; pipelineStatus: string }).pipelineStatus = "failed";
  const context = await reading;

  assert.equal(context.snapshot.sourceHeadSha, sourceSha);
  assert.equal(context.snapshot.ci.status, "running");
  assert.equal(api.calls.some((call) => call.startsWith("getMergeRequest:")), false);
});

test("rejects an MR read supplied for a different operation or IID", async () => {
  for (const overrides of [
    { operation: "create" as const, mrIid: null },
    { mrIid: 89 },
  ]) {
    const api = new LiveContextFixture();
    await assert.rejects(
      readExternalContext(await readOptions(api, {
        ...overrides, mergeRequestRead: mergeRequest(),
      })),
      TypeError,
    );
    assert.equal(api.calls.length, 0);
  }
});

test("delegates a foreign-project supplied MR instead of binding it to this project", async () => {
  const api = new LiveContextFixture();
  const context = await readExternalContext(await readOptions(api, {
    mergeRequestRead: mergeRequest({ targetProjectId: "99", pipelineStatus: "failed" }),
  }));

  assert.equal(context.snapshot.targetProject.id, "7");
  assert.equal(context.snapshot.ci.status, "canceled");
  assert.deepEqual(api.calls.filter((call) => call.startsWith("getMergeRequest:")),
    ["getMergeRequest:7:88"]);
});

test("still rejects a supplied MR whose source SHA differs from the prepared Git evidence", async () => {
  const api = new LiveContextFixture();
  await assert.rejects(
    readExternalContext(await readOptions(api, {
      mergeRequestRead: mergeRequest({ sha: "f".repeat(40) }),
    })),
    hasCode("GITLAB_ERROR"),
  );
  assert.equal(api.calls.includes("labelInventory:7"), true);
  assert.equal(api.calls.some((call) => call.startsWith("getMergeRequest:")), false);
});

test("retains the final live target-head fence when reusing an MR read", async () => {
  const api = new LiveContextFixture();
  api.branchHeads = [targetSha, "f".repeat(40)];
  await assert.rejects(
    readExternalContext(await readOptions(api, { mergeRequestRead: mergeRequest() })),
    hasCode("GITLAB_ERROR"),
  );
  assert.equal(api.branchReadIndex, 2);
  assert.equal(api.calls.includes("audit"), false);
});

test("refreshes membership qualifications instead of preserving an earlier snapshot", async () => {
  const api = new LiveContextFixture();
  const options = await readOptions(api, { mergeRequestRead: mergeRequest() });
  const before = await readExternalContext(options);
  api.users[2] = user("41", "maintainer", 30);
  const after = await readExternalContext(options);

  assert.deepEqual(before.snapshot.review.qualifiedReviewerUserIds, ["41"]);
  assert.deepEqual(after.snapshot.review.qualifiedReviewerUserIds, []);
  assert.equal(api.calls.filter((call) => call === "listUsers:7").length, 2);
  api.users.splice(2, 1);
  await assert.rejects(readExternalContext(options), hasCode("GITLAB_ERROR"));
});

test("refreshes Issue and discussion evidence on every supplied-MR context read", async () => {
  const api = new LiveContextFixture();
  const options = await readOptions(api, { mergeRequestRead: mergeRequest(), issueIid: 51 });
  const before = await readExternalContext(options);
  api.issue = { ...api.issue, milestone: "Changed issue" };
  api.review = { approvedUserIds: [], unresolvedDiscussions: 5 };
  const after = await readExternalContext(options);

  assert.equal(before.snapshot.review.unresolvedDiscussions, 2);
  assert.equal(after.snapshot.review.unresolvedDiscussions, 5);
  assert.deepEqual(after.snapshot.review.approvedByUserIds, []);
  assert.equal(after.snapshot.issue.kind, "linked");
  if (after.snapshot.issue.kind === "linked" && after.snapshot.issue.readStatus === "available") {
    assert.equal(after.snapshot.issue.milestone, "Changed issue");
  }
  assert.equal(api.calls.filter((call) => call === "getIssue:7:51").length, 2);
});

test("detects ambiguity in an unapplied lifecycle label after an earlier successful read", async () => {
  const api = new LiveContextFixture();
  const options = await readOptions(api, { mergeRequestRead: mergeRequest() });
  await readExternalContext(options);
  api.labels.push(label(99, "status::review"));

  await assert.rejects(readExternalContext(options), hasCode("LABEL_ERROR"));
  assert.equal(api.calls.filter((call) => call === "labelInventory:7").length, 2);
});

test("rejects a same-name applied label recreated under a different REST identity", async () => {
  const api = new LiveContextFixture();
  api.labels[0] = label(99, "type::bug");
  await assert.rejects(
    readExternalContext(await readOptions(api, { mergeRequestRead: mergeRequest() })),
    hasCode("GITLAB_ERROR"),
  );
});
