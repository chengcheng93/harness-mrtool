import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { getContext } from "../../src/app/get-context.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { CandidateContextStore } from "../../src/context/store.ts";
import { GitLabClient } from "../../src/gitlab/client.ts";
import { GitLabHttpClient } from "../../src/gitlab/http.ts";
import { FakeGitLab } from "../helpers/fake-gitlab.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function client(fake: FakeGitLab, token = "canary-secret-token"): GitLabClient {
  return new GitLabClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => token,
    transport: fake,
  });
}

function restLabel(
  id: number,
  name: string,
  options: { readonly archived?: boolean; readonly description?: string | null } = {},
): Record<string, unknown> {
  return {
    id,
    name,
    color: "#123456",
    description: options.description ?? `${name} description`,
    archived: options.archived ?? false,
  };
}

function labelGraphql(nodes: readonly Record<string, unknown>[], hasNextPage: boolean, endCursor: string | null): Record<string, unknown> {
  return {
    data: {
      project: {
        labels: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

function bundleManifestHash(bundle: Awaited<ReturnType<typeof loadTemplateBundle>>): string {
  return sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
}

test("redacts transport failures and never exposes the token", async () => {
  const api = new GitLabClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => "canary-secret-token",
    transport: {
      async request(): Promise<never> {
        throw new Error("canary-secret-token transport fixture");
      },
    },
  });

  const error = await api.listLabels("group/project").catch((caught: unknown) => caught);
  assert.equal(error instanceof Error, true);
  assert.equal((error as Error).message, "GitLab request failed");
  assert.doesNotMatch(JSON.stringify(error), /canary-secret-token|transport fixture/u);
  assert.doesNotMatch(inspect(error, { depth: 10 }), /canary-secret-token|transport fixture/u);
});

test("rejects endpoint traversal and malformed transport status before parsing", async () => {
  let calls = 0;
  const api = new GitLabHttpClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => "token",
    transport: {
      async request() {
        calls += 1;
        return { status: Number.NaN, headers: {}, body: new TextEncoder().encode("{}") };
      },
    },
  });
  await assert.rejects(api.requestJson("GET", "/api/v4/../admin"));
  assert.equal(calls, 0);
  await assert.rejects(api.requestJson("GET", "/api/v4/version"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
});

test("rejects malformed credential and response-header runtime values with stable errors", async () => {
  const badCredential = new GitLabHttpClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => 42 as unknown as string,
    transport: { async request() { throw new Error("must not run"); } },
  });
  await assert.rejects(badCredential.requestJson("GET", "/api/v4/version"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "AUTH_ERROR");

  const badHeader = new GitLabHttpClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => "token",
    transport: {
      async request() {
        return {
          status: 200,
          headers: { "x-request-id": 42 } as unknown as Record<string, string>,
          body: new TextEncoder().encode("{}"),
        };
      },
    },
  });
  await assert.rejects(badHeader.requestJson("GET", "/api/v4/version"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
});

test("bounds response size before strict JSON parsing", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: `group/${"x".repeat(2_200_000)}`,
    default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  const api = new GitLabClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => "token",
    transport: fake,
    maxResponseBytes: 3 * 1024 * 1024,
  });
  const project = await api.getProject("group/project");
  assert.equal(project.fullPath.length, 2_200_006);
});

test("enforces the response limit even when a custom transport ignores it", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({
    id: 7,
    path_with_namespace: `group/${"x".repeat(256)}`,
    default_branch: "develop",
    web_url: "https://gitlab.example.test/group/project",
  }));
  const api = new GitLabClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => "token",
    maxResponseBytes: 128,
    transport: {
      async request() {
        return { status: 200, headers: {}, body: encoded };
      },
    },
  });

  await assert.rejects(api.getProject("group/project"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
});

test("reads every project and ancestor-group label page and applies project precedence", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", {
    headers: { "x-request-id": "req-project" },
    body: { id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project" },
  });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: { "x-next-page": "2", "x-request-id": "req-groups-1" },
    body: [{ id: 11, full_path: "group" }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=2", {
    headers: { "x-next-page": "", "x-request-id": "req-groups-2" },
    body: [{ id: 12, full_path: "parent" }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
    headers: { "x-next-page": "2", "x-request-id": "req-project-labels-1" },
    body: [restLabel(1, "type::bug"), restLabel(2, "obsolete", { archived: true })],
  });
  fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=2", {
    headers: { "x-next-page": "" },
    body: [restLabel(3, "priority::p1")],
  });
  fake.enqueue("GET", "/api/v4/groups/11/labels?include_ancestor_groups=false&include_descendant_groups=false&only_group_labels=true&per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [restLabel(21, "type::bug"), restLabel(22, "status::doing")],
  });
  fake.enqueue("GET", "/api/v4/groups/12/labels?include_ancestor_groups=false&include_descendant_groups=false&only_group_labels=true&per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [restLabel(31, "week::2026-w32-0803-0809")],
  });
  fake.enqueue("POST", "/api/graphql", {
    headers: { "x-request-id": "req-graphql-1" },
    body: labelGraphql([
      { id: "gid://gitlab/ProjectLabel/1", title: "type::bug" },
      { id: "gid://gitlab/ProjectLabel/3", title: "priority::p1" },
      { id: "gid://gitlab/GroupLabel/21", title: "type::bug" },
    ], true, "cursor-1"),
  });
  fake.enqueue("POST", "/api/graphql", {
    headers: { "x-request-id": "req-graphql-2" },
    body: labelGraphql([
      { id: "gid://gitlab/GroupLabel/22", title: "status::doing" },
      { id: "gid://gitlab/GroupLabel/31", title: "week::2026-w32-0803-0809" },
    ], false, null),
  });

  const api = client(fake);
  const labels = await api.listLabels("group/project");
  assert.deepEqual(labels.map((label) => [label.name, label.scopeKind, label.globalId]), [
    ["priority::p1", "project", "gid://gitlab/ProjectLabel/3"],
    ["status::doing", "group", "gid://gitlab/GroupLabel/22"],
    ["type::bug", "project", "gid://gitlab/ProjectLabel/1"],
    ["week::2026-w32-0803-0809", "group", "gid://gitlab/GroupLabel/31"],
  ]);
  assert.equal(labels.some((label) => label.name === "obsolete"), false);
  assert.deepEqual(api.audit().requestIds, [
    "req-graphql-1", "req-graphql-2", "req-groups-1", "req-groups-2", "req-project", "req-project-labels-1",
  ]);
  assert.equal(fake.requests.every((request) => request.headers["private-token"] === "canary-secret-token"), true);
  assert.equal(fake.requests.filter((request) => request.url.endsWith("/api/graphql")).length, 2);
  assert.deepEqual(
    fake.requests.filter((request) => request.url.endsWith("/api/graphql")).map((request) =>
      (request.body as { variables: { after: string | null } }).variables.after),
    [null, "cursor-1"],
  );
});

test("rejects same-priority duplicate group labels instead of guessing", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [{ id: 11, full_path: "group" }, { id: 12, full_path: "parent" }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [],
  });
  fake.enqueue("GET", "/api/v4/groups/11/labels?include_ancestor_groups=false&include_descendant_groups=false&only_group_labels=true&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [restLabel(21, "type::bug")],
  });
  fake.enqueue("GET", "/api/v4/groups/12/labels?include_ancestor_groups=false&include_descendant_groups=false&only_group_labels=true&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [restLabel(31, "type::bug")],
  });
  fake.enqueue("POST", "/api/graphql", { body: labelGraphql([
    { id: "gid://gitlab/GroupLabel/21", title: "type::bug" },
    { id: "gid://gitlab/GroupLabel/31", title: "type::bug" },
  ], false, null) });

  await assert.rejects(client(fake).listLabels("group/project"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "LABEL_ERROR");
});

test("rejects a paginated REST response with missing continuation metadata", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop",
    web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    body: [],
  });

  await assert.rejects(client(fake).listAncestorGroups("7"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
});

test("doctor capability probe requires label ID ADD and REMOVE", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/version", { body: { version: "19.2.1", revision: "abc" } });
  fake.enqueue("POST", "/api/graphql", { body: { data: {
    mutation: { fields: [{ name: "mergeRequestSetLabels" }] },
    input: { inputFields: [
      { name: "projectPath" }, { name: "iid" }, { name: "labelIds" }, { name: "operationMode" },
    ] },
    mode: { enumValues: [{ name: "ADD" }, { name: "REMOVE" }, { name: "REPLACE" }] },
  } } });
  assert.deepEqual(await client(fake).probeCapabilities(), {
    version: "19.2.1", revision: "abc", mergeRequestSetLabels: true, labelOperationModes: ["ADD", "REMOVE"],
  });

  const missing = new FakeGitLab();
  missing.enqueue("GET", "/api/v4/version", { body: { version: "19.2.1", revision: null } });
  missing.enqueue("POST", "/api/graphql", { body: { data: {
    mutation: { fields: [] }, input: { inputFields: [] }, mode: { enumValues: [] },
  } } });
  await assert.rejects(
    client(missing).probeCapabilities(),
    (error: unknown) => typeof error === "object" && error !== null &&
      "code" in error && error.code === "GITLAB_ERROR" &&
      "details" in error && JSON.stringify(error.details).includes("label ID ADD/REMOVE mutation is unavailable"),
  );
});

test("label mutation sends only global IDs and never a label name", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("POST", "/api/graphql", { body: { data: {
    mergeRequestSetLabels: { errors: [], mergeRequest: { iid: "12" } },
  } } });
  await client(fake).mutateLabels("group/project", 12, ["gid://gitlab/ProjectLabel/3"], "ADD");
  const body = fake.requests[0]?.body as { query: string; variables: unknown };
  assert.match(body.query, /mergeRequestSetLabels/u);
  assert.doesNotMatch(JSON.stringify(body.variables), /type::|priority::|status::|week::/u);
  assert.deepEqual(body.variables, {
    input: { projectPath: "group/project", iid: "12", labelIds: ["gid://gitlab/ProjectLabel/3"], operationMode: "ADD" },
  });
});

test("rejects Issue and label-mutation responses for a different IID", async () => {
  const issue = new FakeGitLab();
  issue.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop",
    web_url: "https://gitlab.example.test/group/project",
  } });
  issue.enqueue("GET", "/api/v4/projects/7/issues/51?with_labels_details=true", { body: {
    iid: 52, milestone: null, assignees: [], due_date: null, labels: [],
  } });
  await assert.rejects(client(issue).getIssue("group/project", 51), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");

  const mutation = new FakeGitLab();
  mutation.enqueue("POST", "/api/graphql", { body: { data: {
    mergeRequestSetLabels: { errors: [], mergeRequest: { iid: "13" } },
  } } });
  await assert.rejects(
    client(mutation).mutateLabels("group/project", 12, ["gid://gitlab/ProjectLabel/3"], "ADD"),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR",
  );
});

test("classifies authenticated HTTP failures without exposing credentials", async () => {
  for (const [status, code] of [[401, "AUTH_ERROR"], [403, "AUTH_ERROR"], [429, "GITLAB_ERROR"], [500, "GITLAB_ERROR"]] as const) {
    const http = new GitLabHttpClient({
      origin: "https://gitlab.example.test",
      tokenProvider: async () => "status-canary-token",
      transport: {
        async request() {
          return {
            status,
            headers: { "x-request-id": `request-${String(status)}` },
            body: new TextEncoder().encode("{}"),
          };
        },
      },
    });
    const error = await http.requestJson("GET", "/api/v4/version").catch((caught: unknown) => caught);
    assert.equal((error as { code: string }).code, code);
    assert.match(JSON.stringify(error), new RegExp(`request-${String(status)}`, "u"));
    assert.doesNotMatch(JSON.stringify(error), /status-canary-token/u);
  }
});

test("review state uses approvals rather than treating a completed review as approval", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
    approved_by: [{ user: { id: 41, username: "approver", name: "Approver", state: "active" } }],
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [{ notes: [{ resolvable: true, resolved: false }] }],
  });

  assert.deepEqual(await client(fake).getReviewState("group/project", 12), {
    approvedUserIds: ["41"],
    unresolvedDiscussions: 1,
  });
  assert.equal(fake.requests.some((request) => request.url.includes("/reviewers")), false);
});

test("reads exact applied label IDs and the live target branch head", async () => {
  const fake = new FakeGitLab();
  for (let index = 0; index < 3; index += 1) {
    fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
      id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
    } });
  }
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject/repository/branches/develop", {
    body: { name: "develop", commit: { id: "a".repeat(40) } },
  });
  fake.enqueue("GET", "/api/v4/projects/7/issues/51?with_labels_details=true", { body: {
    iid: 51, milestone: null, assignees: [], due_date: null,
    labels: [{ id: 3, name: "status::doing", archived: false }],
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", { body: {
    iid: 12, web_url: "https://gitlab.example.test/group/project/-/merge_requests/12",
    title: "Draft: [fix][app] Fix labels", description: "", draft: true, state: "opened",
    source_project_id: 7, source_branch: "fix/51-labels", target_project_id: 7,
    target_branch: "develop", sha: "b".repeat(40),
    author: { id: 40, username: "author", name: "Author", state: "active" },
    assignees: [], reviewers: [],
    labels: [{ id: 3, name: "status::doing", archived: false }],
    squash: true, should_remove_source_branch: true, head_pipeline: null,
  } });

  const api = client(fake);
  assert.equal(await api.getBranchHead("group/project", "develop"), "a".repeat(40));
  assert.deepEqual((await api.getIssue("group/project", 51)).labels, [
    { restId: 3, name: "status::doing", archived: false },
  ]);
  assert.deepEqual((await api.getMergeRequest("group/project", 12)).labels, [
    { restId: 3, name: "status::doing", archived: false },
  ]);
});

test("rejects an applied label ID repeated with conflicting names", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop",
    web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/issues/51?with_labels_details=true", { body: {
    iid: 51, milestone: null, assignees: [], due_date: null,
    labels: [
      { id: 3, name: "status::doing", archived: false },
      { id: 3, name: "status::review", archived: false },
    ],
  } });

  await assert.rejects(client(fake).getIssue("group/project", 51), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
});

test("discovers tokenized live candidates while keeping lifecycle labels derived and snapshots tokenless", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [{ id: 11, full_path: "group" }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [
      restLabel(1, "type::bug"), restLabel(2, "priority::p1"),
      restLabel(3, "status::doing"), restLabel(4, "status::review"),
    ],
  });
  fake.enqueue("GET", "/api/v4/groups/11/labels?include_ancestor_groups=false&include_descendant_groups=false&only_group_labels=true&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [restLabel(21, "week::2026-w32-0803-0809")],
  });
  fake.enqueue("POST", "/api/graphql", { body: labelGraphql([
    { id: "gid://gitlab/ProjectLabel/1", title: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/2", title: "priority::p1" },
    { id: "gid://gitlab/ProjectLabel/3", title: "status::doing" },
    { id: "gid://gitlab/ProjectLabel/4", title: "status::review" },
    { id: "gid://gitlab/GroupLabel/21", title: "week::2026-w32-0803-0809" },
  ], false, null) });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/members/all?state=active&per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [
      { id: 40, username: "author", name: "Author", state: "active", access_level: 30 },
      { id: 41, username: "maintainer", name: "Maintainer", state: "active", access_level: 40 },
      { id: 42, username: "developer", name: "Developer", state: "active", access_level: 30 },
    ],
  });
  fake.enqueue("GET", "/api/v4/user", { body: {
    id: 40, username: "author", name: "Author", state: "active",
  } });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject/repository/branches/develop", { body: {
    name: "develop", commit: { id: "a".repeat(40) },
  } });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject/repository/branches/develop", { body: {
    name: "develop", commit: { id: "a".repeat(40) },
  } });

  const stateRoot = await mkdtemp(resolve(tmpdir(), "hmr-gitlab-context-"));
  try {
    const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
    const store = new CandidateContextStore({
      stateDirectory: stateRoot,
      windowsAclVerifier: { verify: async () => undefined },
    });
    const context = await getContext({
      operation: "create",
      gitlabOrigin: "https://gitlab.example.test",
      targetProject: "group/project",
      mrIid: null,
      issueIid: null,
      git: {
        sourceProject: { id: "7", path: "group/project" },
        targetRefSha: "a".repeat(40), mergeBaseSha: "a".repeat(40), sourceHeadSha: "b".repeat(40),
        sourceBranch: "fix/51-labels", targetBranch: "develop",
        localChecks: {
          commitConvention: { status: "passed", evidence: "Conventional commits were checked." },
          secretScan: { status: "passed", evidence: "Secret scan passed." },
          repositoryHygiene: { status: "passed", evidence: "Repository hygiene was checked." },
        },
      },
      bundle,
      release: {
        releaseSetId: "stable-1", releaseTag: "templates-v1.0.0",
        bundleManifestHash: bundleManifestHash(bundle), cliVersion: "0.1.0-dev", skillProtocol: 1,
      },
      gitlab: client(fake),
      store,
    });

    assert.deepEqual(context.requiredLabelCategories, ["week", "type", "priority"]);
    assert.deepEqual({
      sourceProject: context.binding.sourceProject,
      sourceBranch: context.binding.sourceBranch,
      targetRefSha: context.binding.targetRefSha,
    }, {
      sourceProject: { id: "7", fullPath: "group/project" },
      sourceBranch: "fix/51-labels",
      targetRefSha: "a".repeat(40),
    });
    assert.deepEqual(context.labelCandidates.map((candidate) => candidate.name), [
      "priority::p1", "type::bug", "week::2026-w32-0803-0809",
    ]);
    assert.equal(context.labelCandidates.some((candidate) => candidate.name.startsWith("status::")), false);
    assert.equal(context.userCandidates.filter((candidate) => candidate.kind === "assignee").length, 3);
    assert.deepEqual(context.userCandidates.filter((candidate) => candidate.defaultSelected).map((candidate) => [
      candidate.kind, candidate.username,
    ]), [["assignee", "author"]]);
    assert.deepEqual(context.userCandidates.filter((candidate) => candidate.kind === "reviewer").map((candidate) => [
      candidate.username, candidate.qualifiedReviewer,
    ]), [["developer", false], ["maintainer", true]]);
    assert.deepEqual(context.snapshot.review.qualifiedReviewerUserIds, ["41"]);
    assert.doesNotMatch(JSON.stringify(context.snapshot), /hmr[cx]1_/u);
    assert.match(context.contextId, /^hmrx1_/u);
    assert.equal(context.labelCandidates.every((candidate) => /^hmrc1_/u.test(candidate.token)), true);
    const persisted = await readFile(resolve(stateRoot, "candidate-contexts-v1.json"), "utf8");
    assert.doesNotMatch(persisted, /hmr[cx]1_/u);
    for (const candidate of context.labelCandidates) assert.equal(persisted.includes(candidate.token), false);
    for (const candidate of context.userCandidates) assert.equal(persisted.includes(candidate.token), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("context is fail-closed when the live target branch moved", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const stateRoot = await mkdtemp(resolve(tmpdir(), "hmr-gitlab-context-moved-"));
  try {
    const minimal = {
      origin: "https://gitlab.example.test",
      getProject: async () => ({ id: "7", fullPath: "group/project", defaultBranch: "develop", webUrl: "https://gitlab.example.test/group/project" }),
      labelInventory: async () => { throw new Error("other context reads must not complete first"); },
      listUsers: async () => [],
      getCurrentUser: async () => ({ id: "40", username: "author", displayName: "Author", state: "active" as const, accessLevel: null }),
      getIssue: async () => { throw new Error("not expected"); },
      getMergeRequest: async () => { throw new Error("not expected"); },
      getBranchHead: async () => "f".repeat(40),
      getReviewState: async () => ({ approvedUserIds: [], unresolvedDiscussions: 0 }),
      audit: () => ({ requestIds: [] }),
    };
    await assert.rejects(getContext({
      operation: "create", gitlabOrigin: "https://gitlab.example.test", targetProject: "group/project",
      mrIid: null, issueIid: null,
      git: {
        sourceProject: { id: "7", path: "group/project" }, sourceBranch: "fix/51-labels", targetBranch: "develop",
        targetRefSha: "a".repeat(40), mergeBaseSha: "a".repeat(40), sourceHeadSha: "b".repeat(40),
        localChecks: {
          commitConvention: { status: "passed", evidence: "Checked commit convention." },
          secretScan: { status: "passed", evidence: "Secret scan passed." },
          repositoryHygiene: { status: "passed", evidence: "Repository hygiene passed." },
        },
      },
      bundle,
      release: {
        releaseSetId: "stable-1", releaseTag: "templates-v1.0.0", bundleManifestHash: bundleManifestHash(bundle),
        cliVersion: "0.1.0-dev", skillProtocol: 1,
      },
      gitlab: minimal as unknown as GitLabClient,
      store: new CandidateContextStore({ stateDirectory: stateRoot, windowsAclVerifier: { verify: async () => undefined } }),
    }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("context validates origin and Bundle receipt before any GitLab read", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  let reads = 0;
  const neverRead = {
    origin: "https://gitlab.example.test",
    getProject: async () => { reads += 1; throw new Error("must not read"); },
  };
  const base = {
    operation: "create" as const,
    targetProject: "group/project",
    mrIid: null,
    issueIid: null,
    git: {
      sourceProject: { id: "7", path: "group/project" },
      sourceBranch: "fix/51-labels", targetBranch: "develop",
      targetRefSha: "a".repeat(40), mergeBaseSha: "a".repeat(40), sourceHeadSha: "b".repeat(40),
      localChecks: {
        commitConvention: { status: "passed" as const, evidence: "Checked commit convention." },
        secretScan: { status: "passed" as const, evidence: "Secret scan passed." },
        repositoryHygiene: { status: "passed" as const, evidence: "Repository hygiene passed." },
      },
    },
    bundle,
    store: { issue: async () => { throw new Error("must not issue"); } },
  };
  for (const release of [
    { gitlabOrigin: "https://other.example.test", bundleManifestHash: bundleManifestHash(bundle) },
    { gitlabOrigin: "https://gitlab.example.test", bundleManifestHash: "c".repeat(64) },
  ]) {
    await assert.rejects(getContext({
      ...base,
      gitlabOrigin: release.gitlabOrigin,
      release: {
        releaseSetId: "stable-1", releaseTag: "templates-v1.0.0",
        bundleManifestHash: release.bundleManifestHash, cliVersion: "0.1.0-dev", skillProtocol: 1,
      },
      gitlab: neverRead as unknown as GitLabClient,
    }), (error: unknown) => typeof error === "object" && error !== null &&
      "code" in error && error.code === "GITLAB_ERROR");
  }
  assert.equal(reads, 0);
});

test("context validates the live source project before candidate reads", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const minimal = {
    origin: "https://gitlab.example.test",
    getProject: async (reference: string) => {
      if (reference === "group/project") {
        return { id: "7", fullPath: "group/project", defaultBranch: "develop", webUrl: "https://gitlab.example.test/group/project" };
      }
      return { id: "99", fullPath: "fork/wrong", defaultBranch: "develop", webUrl: "https://gitlab.example.test/fork/wrong" };
    },
    getBranchHead: async () => "a".repeat(40),
    labelInventory: async () => { throw new Error("candidate reads must not run"); },
  };
  await assert.rejects(getContext({
    operation: "create", gitlabOrigin: "https://gitlab.example.test", targetProject: "group/project",
    mrIid: null, issueIid: null,
    git: {
      sourceProject: { id: "8", path: "fork/project" }, sourceBranch: "fix/51-labels", targetBranch: "develop",
      targetRefSha: "a".repeat(40), mergeBaseSha: "a".repeat(40), sourceHeadSha: "b".repeat(40),
      localChecks: {
        commitConvention: { status: "passed", evidence: "Checked commit convention." },
        secretScan: { status: "passed", evidence: "Secret scan passed." },
        repositoryHygiene: { status: "passed", evidence: "Repository hygiene passed." },
      },
    },
    bundle,
    release: {
      releaseSetId: "stable-1", releaseTag: "templates-v1.0.0",
      bundleManifestHash: bundleManifestHash(bundle), cliVersion: "0.1.0-dev", skillProtocol: 1,
    },
    gitlab: minimal as unknown as GitLabClient,
    store: { issue: async () => { throw new Error("must not issue"); } } as never,
  }), (error: unknown) => typeof error === "object" && error !== null &&
    "code" in error && error.code === "GITLAB_ERROR" &&
    "message" in error && error.message === "Source project identity does not match the local Git snapshot");
});

test("context refuses to issue tokens when target HEAD moves during discovery", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const active = [
    [1, "week::2026-w32-0803-0809"], [2, "type::bug"], [3, "priority::p1"],
    [4, "status::doing"], [5, "status::review"],
  ].map(([restId, name]) => ({
    restId: restId as number,
    globalId: `gid://gitlab/ProjectLabel/${String(restId)}`,
    name: name as string,
    description: "Policy label",
    color: "#123456",
    archived: false,
    scopeKind: "project" as const,
    scopeId: "7",
    scopePath: "group/project",
  }));
  let branchReads = 0;
  let issues = 0;
  const api = {
    origin: "https://gitlab.example.test",
    getProject: async () => ({ id: "7", fullPath: "group/project", defaultBranch: "develop", webUrl: "https://gitlab.example.test/group/project" }),
    getBranchHead: async () => (++branchReads === 1 ? "a" : "f").repeat(40),
    labelInventory: async () => ({ all: active, effective: active, audit: { requestIds: [] } }),
    listUsers: async () => [{ id: "40", username: "author", displayName: "Author", state: "active" as const, accessLevel: 40 }],
    getCurrentUser: async () => ({ id: "40", username: "author", displayName: "Author", state: "active" as const, accessLevel: null }),
    audit: () => ({ requestIds: [] }),
  };
  await assert.rejects(getContext({
    operation: "create", gitlabOrigin: api.origin, targetProject: "group/project", mrIid: null, issueIid: null,
    git: {
      sourceProject: { id: "7", path: "group/project" }, sourceBranch: "fix/51-labels", targetBranch: "develop",
      targetRefSha: "a".repeat(40), mergeBaseSha: "a".repeat(40), sourceHeadSha: "b".repeat(40),
      localChecks: {
        commitConvention: { status: "passed", evidence: "Checked commit convention." },
        secretScan: { status: "passed", evidence: "Secret scan passed." },
        repositoryHygiene: { status: "passed", evidence: "Repository hygiene passed." },
      },
    },
    bundle,
    release: {
      releaseSetId: "stable-1", releaseTag: "templates-v1.0.0", bundleManifestHash: bundleManifestHash(bundle),
      cliVersion: "0.1.0-dev", skillProtocol: 1,
    },
    gitlab: api as unknown as GitLabClient,
    store: { issue: async () => { issues += 1; throw new Error("must not issue"); } } as never,
  }), (error: unknown) => typeof error === "object" && error !== null &&
    "code" in error && error.code === "GITLAB_ERROR" &&
    "message" in error && error.message === "Target branch moved during context discovery");
  assert.equal(branchReads, 2);
  assert.equal(issues, 0);
});
