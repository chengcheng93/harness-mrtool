import assert from "node:assert/strict";
import test from "node:test";

import {
  isRemoteMutationError,
  isRemoteReadError,
} from "../../src/app/remote-outcome.ts";
import type { CreateDraftInput, ManagedFieldsInput } from "../../src/app/create-mr.ts";
import { GitLabClient } from "../../src/gitlab/client.ts";
import type {
  GitLabHttpRequest,
  GitLabHttpResponse,
  GitLabHttpTransport,
} from "../../src/gitlab/http.ts";
import { GitLabMergeRequestRemote } from "../../src/gitlab/mr-remote.ts";
import type { GitLabMergeRequest } from "../../src/gitlab/types.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../../src/render/marker.ts";
import { FakeGitLab } from "../helpers/fake-gitlab.ts";

const TARGET = Object.freeze({ id: "7", fullPath: "group/project" });
const SOURCE_ID = "9";
const SOURCE_BRANCH = "feature/webengine-css";
const TARGET_BRANCH = "develop";
const SOURCE_SHA = "b".repeat(40);
const TARGET_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);
const TOKEN = "glpat-remote-contract-secret";

function client(transport: GitLabHttpTransport, token = TOKEN): GitLabClient {
  return new GitLabClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => token,
    transport,
  });
}

function createInput(): CreateDraftInput {
  return {
    title: "Draft: [fix][app] Preserve CSS output",
    description: "Provisional description",
    sourceProjectId: SOURCE_ID,
    sourceBranch: SOURCE_BRANCH,
    targetProjectId: TARGET.id,
    targetBranch: TARGET_BRANCH,
    sourceHeadSha: SOURCE_SHA,
    squash: true,
    removeSourceBranch: true,
  };
}

function managedInput(): ManagedFieldsInput {
  return {
    title: "Draft: [fix][app] Preserve CSS output",
    targetBranch: TARGET_BRANCH,
    assigneeUserId: "41",
    reviewerUserIds: ["42", "43"],
    squash: true,
    removeSourceBranch: false,
  };
}

function userBody(id: number, username = `user-${String(id)}`): object {
  return { id, username, name: `User ${String(id)}`, state: "active" };
}

function mergeRequestBody(
  iid: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 1_000 + iid,
    iid,
    project_id: Number(TARGET.id),
    web_url: `https://gitlab.example.test/group/project/-/merge_requests/${String(iid)}`,
    title: "Draft: [fix][app] Preserve CSS output",
    description: "Provisional description",
    draft: true,
    state: "opened",
    source_project_id: Number(SOURCE_ID),
    source_branch: SOURCE_BRANCH,
    target_project_id: Number(TARGET.id),
    target_branch: TARGET_BRANCH,
    sha: SOURCE_SHA,
    author: userBody(40, "author"),
    assignees: [userBody(41)],
    reviewers: [userBody(42), userBody(43)],
    labels: [{ id: 3, name: "status::doing", archived: false }],
    squash: true,
    should_remove_source_branch: false,
    head_pipeline: { status: "success", sha: SOURCE_SHA },
    ...overrides,
  };
}

function mutationBody(iid = 12): Record<string, unknown> {
  return {
    iid,
    project_id: Number(TARGET.id),
    target_project_id: Number(TARGET.id),
    source_project_id: Number(SOURCE_ID),
    source_branch: SOURCE_BRANCH,
    target_branch: TARGET_BRANCH,
    title: "Draft: [fix][app] Preserve CSS output",
    description: "Provisional description",
    draft: true,
    state: "opened",
  };
}

function snapshotFor(mr: GitLabMergeRequest): ExternalContextSnapshot {
  const assigneeUserId = mr.assignees[0]?.id ?? null;
  const reviewerUserIds = mr.reviewers.map((user) => user.id).sort();
  const users = [mr.author, ...mr.assignees, ...mr.reviewers]
    .filter((user, index, all) => all.findIndex((entry) => entry.id === user.id) === index)
    .map((user) => ({ id: user.id, username: user.username, displayName: user.displayName }));
  const labels = mr.labels.map((label) => ({
    id: `gid://gitlab/ProjectLabel/${String(label.restId)}`,
    name: label.name,
  }));
  return validateExternalContextSnapshot({
    snapshotVersion: 1,
    targetProject: { id: TARGET.id, path: TARGET.fullPath },
    sourceProject: { id: mr.sourceProjectId, path: "fork/project" },
    targetRefSha: TARGET_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    sourceHeadSha: mr.sha,
    issue: { kind: "none" },
    labelCandidates: labels,
    userCandidates: users,
    mergeRequest: {
      iid: mr.iid,
      authorUserId: mr.author.id,
      lifecycle: mr.state === "merged" ? "merged"
        : mr.state === "closed" || mr.state === "locked" ? "closed"
        : mr.draft ? "draft" : "ready",
      labelIds: labels.map((label) => label.id),
      assigneeUserId,
      reviewerUserIds,
    },
    localChecks: {
      commitConvention: { status: "passed", evidence: "Commit convention verified locally." },
      secretScan: { status: "passed", evidence: "Secret scan completed locally." },
      repositoryHygiene: { status: "passed", evidence: "Repository hygiene verified locally." },
    },
    metadataRead: { status: "available", evidence: "Fresh GitLab metadata was read." },
    ci: { status: mr.pipelineStatus },
    review: {
      approvedByUserIds: [],
      qualifiedReviewerUserIds: reviewerUserIds,
      unresolvedDiscussions: 0,
    },
  });
}

function remote(fake: GitLabHttpTransport, snapshotReader = async (mr: GitLabMergeRequest) => snapshotFor(mr)) {
  return new GitLabMergeRequestRemote({
    gitlab: client(fake),
    targetProject: TARGET,
    snapshotReader,
  });
}

function requestPath(request: { readonly url: string }): string {
  const parsed = new URL(request.url);
  return `${parsed.pathname}${parsed.search}`;
}

test("creates a Draft with an exact label-free REST body and returns only the acknowledged IID", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("POST", "/api/v4/projects/7/merge_requests", {
    headers: { "x-request-id": "req-create" },
    body: mutationBody(),
  });

  const receipt = await remote(fake).createDraft(createInput());

  assert.deepEqual(receipt, { requestId: "req-create", value: { iid: 12 } });
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(fake.requests[0]?.body, {
    source_branch: SOURCE_BRANCH,
    target_branch: TARGET_BRANCH,
    title: "Draft: [fix][app] Preserve CSS output",
    description: "Provisional description",
    source_project_id: Number(SOURCE_ID),
    target_project_id: Number(TARGET.id),
    squash: true,
    remove_source_branch: true,
  });
  assert.equal(Object.hasOwn(fake.requests[0]?.body as object, "labels"), false);
});

test("findOpen applies all required filters, consumes every page, and hard-binds every snapshot", async () => {
  const fake = new FakeGitLab();
  const query = "scope=all&state=opened&source_branch=feature%2Fwebengine-css&target_branch=develop&with_labels_details=true";
  fake.enqueue("GET", `/api/v4/projects/7/merge_requests?${query}&per_page=100&page=1`, {
    headers: { "x-next-page": "2", "x-request-id": "req-list-1" },
    body: [mergeRequestBody(11, { source_project_id: 8 })],
  });
  fake.enqueue("GET", `/api/v4/projects/7/merge_requests?${query}&per_page=100&page=2`, {
    headers: { "x-next-page": "", "x-request-id": "req-list-2" },
    body: [mergeRequestBody(12), mergeRequestBody(13)],
  });
  const seen: number[] = [];
  const adapter = remote(fake, async (mr) => {
    seen.push(mr.iid);
    return snapshotFor(mr);
  });

  const result = await adapter.findOpen(createInput());

  assert.equal(result.requestId, "req-list-2");
  assert.deepEqual(result.value.map((mr) => mr.iid), [12, 13]);
  assert.deepEqual(seen, [12, 13]);
  assert.deepEqual(fake.requests.map(requestPath), [
    `/api/v4/projects/7/merge_requests?${query}&per_page=100&page=1`,
    `/api/v4/projects/7/merge_requests?${query}&per_page=100&page=2`,
  ]);
  assert.equal(result.value[0]?.snapshot.ci.status, "passed");
  assert.deepEqual(result.value[0]?.snapshot.review.qualifiedReviewerUserIds, ["42", "43"]);
});

test("findOpen follows a same-origin Link continuation when x-next-page is absent", async () => {
  const fake = new FakeGitLab();
  const query = "scope=all&state=opened&source_branch=feature%2Fwebengine-css&target_branch=develop&with_labels_details=true";
  const first = `/api/v4/projects/7/merge_requests?${query}&per_page=100&page=1`;
  const second = `/api/v4/projects/7/merge_requests?${query}&per_page=100&page=2`;
  fake.enqueue("GET", first, {
    headers: { link: `<https://gitlab.example.test${second}>; rel="next"` },
    body: [mergeRequestBody(12)],
  });
  fake.enqueue("GET", second, {
    headers: { link: `<https://gitlab.example.test${first}>; rel="prev"` },
    body: [mergeRequestBody(13)],
  });

  const result = await remote(fake).findOpen(createInput());

  assert.deepEqual(result.value.map((mr) => mr.iid), [12, 13]);
  assert.deepEqual(fake.requests.map(requestPath), [first, second]);
});

test("uses only GraphQL global-ID ADD and REMOVE label mutations and returns their receipts", async () => {
  const fake = new FakeGitLab();
  for (const [mode, requestId] of [["ADD", "req-add"], ["REMOVE", "req-remove"]] as const) {
    fake.enqueue("POST", "/api/graphql", {
      headers: { "x-request-id": requestId },
      body: {
        data: {
          mergeRequestSetLabels: {
            errors: [],
            mergeRequest: {
              iid: "12",
              targetProject: { id: "gid://gitlab/Project/7", fullPath: TARGET.fullPath },
            },
          },
        },
      },
    });
  }
  const adapter = remote(fake);
  const ids = ["gid://gitlab/ProjectLabel/3", "gid://gitlab/GroupLabel/9"];

  assert.deepEqual(await adapter.addLabels(12, ids), { requestId: "req-add" });
  assert.deepEqual(await adapter.removeLabels(12, ids), { requestId: "req-remove" });

  assert.equal(fake.requests.every((request) => request.method === "POST" && requestPath(request) === "/api/graphql"), true);
  for (const [index, operationMode] of ["ADD", "REMOVE"].entries()) {
    const body = fake.requests[index]?.body as {
      readonly query: string;
      readonly variables: unknown;
    };
    assert.match(body.query, /mergeRequestSetLabels/u);
    assert.deepEqual(body.variables, {
      input: {
        projectPath: TARGET.fullPath,
        iid: "12",
        labelIds: ids,
        operationMode,
      },
    });
  }
});

test("treats structured GraphQL mutation errors as a definitive validation rejection", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("POST", "/api/graphql", {
    headers: { "x-request-id": "req-label-rejected" },
    body: {
      data: {
        mergeRequestSetLabels: { errors: ["not allowed"], mergeRequest: null },
      },
    },
  });

  await assert.rejects(
    remote(fake).addLabels(12, ["gid://gitlab/ProjectLabel/3"]),
    (error: unknown) => {
      assert.equal(isRemoteMutationError(error, "rejected"), true);
      assert.equal(isRemoteMutationError(error) ? error.reason : null, "validation");
      assert.equal(isRemoteMutationError(error) ? error.requestId : null, "req-label-rejected");
      return true;
    },
  );
});

test("writes managed fields as numeric IDs and keeps every PUT body on its operation whitelist", async () => {
  const fake = new FakeGitLab();
  for (const requestId of ["req-fields", "req-description", "req-ready", "req-draft"]) {
    fake.enqueue("PUT", "/api/v4/projects/7/merge_requests/12", {
      headers: { "x-request-id": requestId },
      body: mutationBody(),
    });
  }
  const adapter = remote(fake);

  assert.deepEqual(await adapter.writeManagedFields(12, managedInput()), { requestId: "req-fields" });
  assert.deepEqual(await adapter.writeDescription(12, "Final description"), { requestId: "req-description" });
  assert.deepEqual(await adapter.markReady(12, "[fix][app] Preserve CSS output"), { requestId: "req-ready" });
  assert.deepEqual(await adapter.markDraft(12, "Draft: [fix][app] Preserve CSS output"), { requestId: "req-draft" });

  assert.deepEqual(fake.requests.map((request) => request.body), [
    {
      title: "Draft: [fix][app] Preserve CSS output",
      target_branch: TARGET_BRANCH,
      assignee_ids: [41],
      reviewer_ids: [42, 43],
      squash: true,
      remove_source_branch: false,
    },
    { description: "Final description" },
    { title: "[fix][app] Preserve CSS output" },
    { title: "Draft: [fix][app] Preserve CSS output" },
  ]);
  for (const request of fake.requests) {
    const body = request.body as Record<string, unknown>;
    for (const forbidden of ["labels", "add_labels", "remove_labels"]) {
      assert.equal(Object.hasOwn(body, forbidden), false);
    }
  }
});

test("rejects non-numeric managed user IDs before transport", async () => {
  const fake = new FakeGitLab();
  await assert.rejects(
    remote(fake).writeManagedFields(12, { ...managedInput(), assigneeUserId: "user:41" }),
    (error: unknown) => {
      assert.equal(isRemoteMutationError(error, "rejected"), true);
      assert.equal(isRemoteMutationError(error) ? error.reason : null, "validation");
      return true;
    },
  );
  assert.equal(fake.requests.length, 0);
});

test("rejects malformed mutation acknowledgements as unknown instead of using them as readback", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("POST", "/api/v4/projects/7/merge_requests", {
    headers: { "x-request-id": "req-wrong-project" },
    body: { ...mutationBody(), project_id: 8 },
  });

  await assert.rejects(remote(fake).createDraft(createInput()), (error: unknown) => {
    assert.equal(isRemoteMutationError(error, "unknown"), true);
    assert.equal(isRemoteMutationError(error) ? error.reason : null, "server");
    assert.equal(isRemoteMutationError(error) ? error.requestId : null, "req-wrong-project");
    return true;
  });
});

test("maps definitive HTTP mutation failures to rejected auth, validation, and conflict errors", async () => {
  const cases = [
    [400, "validation"],
    [401, "auth"],
    [403, "auth"],
    [404, "validation"],
    [409, "conflict"],
    [422, "validation"],
  ] as const;
  for (const [status, reason] of cases) {
    const fake = new FakeGitLab();
    fake.enqueue("PUT", "/api/v4/projects/7/merge_requests/12", {
      status,
      headers: { "x-request-id": `req-${String(status)}` },
      body: { message: TOKEN },
    });
    await assert.rejects(remote(fake).writeDescription(12, "Description"), (error: unknown) => {
      assert.equal(isRemoteMutationError(error, "rejected"), true);
      assert.equal(isRemoteMutationError(error) ? error.reason : null, reason);
      assert.equal(isRemoteMutationError(error) ? error.requestId : null, `req-${String(status)}`);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
  }
});

class FixedTransport implements GitLabHttpTransport {
  constructor(private readonly result: GitLabHttpResponse | Error) {}

  async request(_request: GitLabHttpRequest): Promise<GitLabHttpResponse> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

test("classifies 5xx, timeout, reset, and malformed 2xx mutation outcomes as unknown", async () => {
  const cases: readonly [GitLabHttpTransport, string][] = [
    [new FixedTransport({ status: 500, headers: { "x-request-id": "req-500" }, body: Buffer.from("{}") }), "server"],
    [new FixedTransport(Object.assign(new Error("timeout"), { name: "AbortError" })), "timeout"],
    [new FixedTransport(new Error("ECONNRESET")), "network"],
    [new FixedTransport({ status: 200, headers: { "x-request-id": "req-malformed" }, body: Buffer.from("{") }), "server"],
  ];
  for (const [transport, reason] of cases) {
    await assert.rejects(remote(transport).writeDescription(12, "Description"), (error: unknown) => {
      assert.equal(isRemoteMutationError(error, "unknown"), true);
      assert.equal(isRemoteMutationError(error) ? error.reason : null, reason);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
  }
});

test("read returns a freshly composed, identity-bound snapshot and brands all read failures", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
    headers: { "x-request-id": "req-read" },
    body: mergeRequestBody(12),
  });
  let reads = 0;
  const adapter = remote(fake, async (mr) => {
    reads += 1;
    return snapshotFor(mr);
  });

  const result = await adapter.read(12);

  assert.equal(result.requestId, "req-read");
  assert.equal(reads, 1);
  assert.equal(result.value.sourceHeadSha, SOURCE_SHA);
  assert.deepEqual(result.value.labelIds, ["gid://gitlab/ProjectLabel/3"]);
  assert.deepEqual(result.value.reviewerUserIds, ["42", "43"]);
  assert.equal(result.value.snapshot.metadataRead.status, "available");

  const bad = new FakeGitLab();
  bad.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
    body: mergeRequestBody(12),
  });
  await assert.rejects(remote(bad, async (mr) => validateExternalContextSnapshot({
    ...snapshotFor(mr),
    targetProject: { id: "8", path: "other/project" },
  })).read(12), (error: unknown) => isRemoteReadError(error));

  const unavailable = new FakeGitLab();
  unavailable.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
    status: 503,
    headers: { "x-request-id": "req-read-503" },
    body: { message: TOKEN },
  });
  await assert.rejects(remote(unavailable).read(12), (error: unknown) => {
    assert.equal(isRemoteReadError(error), true);
    assert.equal(isRemoteReadError(error) ? error.reason : null, "server");
    assert.equal(isRemoteReadError(error) ? error.requestId : null, "req-read-503");
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return true;
  });
});

test("takes applied group-label global IDs from the identity-bound snapshot", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
    body: mergeRequestBody(12, {
      labels: [{ id: 9, name: "week::2026-w32", archived: false }],
    }),
  });
  const adapter = remote(fake, async (mr) => {
    const base = snapshotFor({ ...mr, labels: [] });
    return validateExternalContextSnapshot({
      ...base,
      labelCandidates: [{ id: "gid://gitlab/GroupLabel/9", name: "week::2026-w32" }],
      mergeRequest: {
        ...base.mergeRequest,
        labelIds: ["gid://gitlab/GroupLabel/9"],
      },
    });
  });

  const result = await adapter.read(12);

  assert.deepEqual(result.value.labelIds, ["gid://gitlab/GroupLabel/9"]);
});

test("rejects a snapshot with stale MR user identity or unavailable metadata", async () => {
  for (const kind of ["stale-user", "unavailable"] as const) {
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
      body: mergeRequestBody(12),
    });
    const adapter = remote(fake, async (mr) => {
      const base = snapshotFor(mr);
      return validateExternalContextSnapshot(kind === "stale-user" ? {
        ...base,
        userCandidates: base.userCandidates.map((user) =>
          user.id === "42" ? { ...user, username: "renamed-reviewer" } : user),
      } : {
        ...base,
        metadataRead: { status: "unavailable", evidence: "Metadata could not be refreshed." },
      });
    });

    await assert.rejects(adapter.read(12), (error: unknown) => isRemoteReadError(error));
  }
});

test("sanitizes request IDs that reflect credentials on successful mutations", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("PUT", "/api/v4/projects/7/merge_requests/12", {
    headers: { "x-request-id": `prefix-${TOKEN}-suffix` },
    body: mutationBody(),
  });

  assert.deepEqual(await remote(fake).writeDescription(12, "Description"), { requestId: null });
});
