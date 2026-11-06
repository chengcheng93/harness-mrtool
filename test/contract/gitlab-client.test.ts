import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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

function labelGraphql(
  nodes: readonly Record<string, unknown>[],
  hasNextPage: boolean,
  endCursor: string | null,
  project: { readonly id: string; readonly fullPath: string } = {
    id: "gid://gitlab/Project/7",
    fullPath: "group/project",
  },
): Record<string, unknown> {
  return {
    data: {
      project: {
        id: project.id,
        fullPath: project.fullPath,
        labels: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

function enqueueCapabilities(fake: FakeGitLab, modes: readonly string[] = ["ADD", "REMOVE"]): void {
  fake.enqueue("GET", "/api/v4/version", { body: { version: "17.10.3", revision: "abc" } });
  fake.enqueue("POST", "/api/graphql", { body: { data: {
    mutation: { fields: [{ name: "mergeRequestSetLabels" }] },
    input: { inputFields: ["projectPath", "iid", "labelIds", "operationMode"].map((name) => ({ name })) },
    mode: { enumValues: modes.map((name) => ({ name })) },
  } } });
}

function bundleManifestHash(bundle: Awaited<ReturnType<typeof loadTemplateBundle>>): string {
  return sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
}

function projectBody(
  id = 7,
  fullPath = "group/project",
): Record<string, unknown> {
  return {
    id,
    path_with_namespace: fullPath,
    default_branch: "develop",
    web_url: `https://gitlab.example.test/${fullPath}`,
  };
}

function reviewFenceBody(
  sha: string,
  detailedMergeStatus = "mergeable",
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 120,
    project_id: 7,
    iid: 12,
    sha,
    detailed_merge_status: detailedMergeStatus,
    ...overrides,
  };
}

function mergeRequestBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    iid: 12, web_url: "https://gitlab.example.test/group/project/-/merge_requests/12",
    title: "Draft: [fix][app] Fix labels", description: "", draft: true, state: "opened",
    source_project_id: 7, source_branch: "fix/51-labels", target_project_id: 7,
    target_branch: "develop", sha: "b".repeat(40),
    author: { id: 40, username: "author", name: "Author", state: "active" },
    assignees: [], reviewers: [], labels: [],
    squash: true, should_remove_source_branch: true, head_pipeline: null,
    ...overrides,
  };
}

function enqueueAppliedLabelInventory(
  fake: FakeGitLab,
  projectLabels: readonly Record<string, unknown>[],
  groupLabels: readonly Record<string, unknown>[] = [],
): void {
  fake.enqueue("GET", "/api/v4/projects/7", { headers: { "x-request-id": "req-inventory-project" }, body: projectBody() });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: { "x-next-page": "", "x-request-id": "req-inventory-groups" }, body: groupLabels.length === 0 ? [] : [{ id: 11, full_path: "group" }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
    headers: { "x-next-page": "", "x-request-id": "req-inventory-project-labels" }, body: projectLabels,
  });
  if (groupLabels.length > 0) {
    fake.enqueue("GET", "/api/v4/groups/11/labels?include_ancestor_groups=false&include_descendant_groups=false&only_group_labels=true&per_page=100&page=1", {
      headers: { "x-next-page": "", "x-request-id": "req-inventory-group-labels" }, body: groupLabels,
    });
  }
  fake.enqueue("POST", "/api/graphql", { headers: { "x-request-id": "req-inventory-graphql" }, body: labelGraphql([
    ...projectLabels.filter((label) => label.archived !== true).map((label) => ({
      id: `gid://gitlab/ProjectLabel/${String(label.id)}`, title: label.name,
    })),
    ...groupLabels.filter((label) => label.archived !== true).map((label) => ({
      id: `gid://gitlab/GroupLabel/${String(label.id)}`, title: label.name,
    })),
  ], false, null) });
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

  let whitespaceCredentialCalls = 0;
  const whitespaceCredential = new GitLabHttpClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => " token ",
    transport: { async request() {
      whitespaceCredentialCalls += 1;
      throw new Error("must not run");
    } },
  });
  await assert.rejects(whitespaceCredential.requestJson("GET", "/api/v4/version"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "AUTH_ERROR");
  assert.equal(whitespaceCredentialCalls, 0);

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
  fake.enqueue("GET", "/api/v4/projects/7", { body: {
    id: 7, path_with_namespace: `group/${"x".repeat(2_200_000)}`,
    default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  const api = new GitLabClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => "token",
    transport: fake,
    maxResponseBytes: 3 * 1024 * 1024,
  });
  const project = await api.getProject("7");
  assert.equal(project.fullPath.length, 2_200_006);
});

test("rejects a numeric project lookup whose response has another ID", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", { body: {
    id: 8,
    path_with_namespace: "other/project",
    default_branch: "develop",
    web_url: "https://gitlab.example.test/other/project",
  } });

  await assert.rejects(client(fake).getProject("7"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
});

test("rejects a path project lookup whose response has another full path", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectBody(8, "other/project") });

  await assert.rejects(client(fake).getProject("group/project"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
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

test("project label responses may repeat inherited labels without changing group identity or project precedence", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/258", { body: projectBody(258, "projectGroup/cloud-api") });
  fake.enqueue("GET", "/api/v4/projects/258/groups?with_shared=false&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [{ id: 324, full_path: "projectGroup" }],
  });
  const inheritedPriority = {
    id: 1481, name: "priority::p0", is_project_label: false,
    description: null, description_html: "", text_color: "#FFFFFF", color: "#123456",
    subscribed: false, priority: null,
  };
  const inheritedType = { ...inheritedPriority, id: 1482, name: "type::bug" };
  fake.enqueue("GET", "/api/v4/projects/258/labels?include_ancestor_groups=false&per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [
      { ...inheritedPriority, id: 1058, name: "cloud-api", is_project_label: true },
      { ...inheritedPriority, id: 1059, name: "type::bug", is_project_label: true },
      inheritedPriority,
      inheritedType,
    ],
  });
  fake.enqueue("GET", "/api/v4/groups/324/labels?include_ancestor_groups=false&include_descendant_groups=false&only_group_labels=true&per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [inheritedPriority, inheritedType],
  });
  fake.enqueue("POST", "/api/graphql", {
    body: labelGraphql([
      { id: "gid://gitlab/ProjectLabel/1058", title: "cloud-api" },
      { id: "gid://gitlab/ProjectLabel/1059", title: "type::bug" },
      { id: "gid://gitlab/GroupLabel/1481", title: "priority::p0" },
      { id: "gid://gitlab/GroupLabel/1482", title: "type::bug" },
    ], false, null, { id: "gid://gitlab/Project/258", fullPath: "projectGroup/cloud-api" }),
  });

  const inventory = await client(fake).labelInventory("258");
  assert.deepEqual(inventory.all.map((label) => [label.restId, label.scopeKind, label.scopeId, label.globalId]), [
    [1058, "project", "258", "gid://gitlab/ProjectLabel/1058"],
    [1481, "group", "324", "gid://gitlab/GroupLabel/1481"],
    [1482, "group", "324", "gid://gitlab/GroupLabel/1482"],
    [1059, "project", "258", "gid://gitlab/ProjectLabel/1059"],
  ]);
  assert.deepEqual(inventory.effective.map((label) => [label.name, label.globalId]), [
    ["cloud-api", "gid://gitlab/ProjectLabel/1058"],
    ["priority::p0", "gid://gitlab/GroupLabel/1481"],
    ["type::bug", "gid://gitlab/ProjectLabel/1059"],
  ]);
});

test("project label responses reject malformed is_project_label values", async (t) => {
  for (const isProjectLabel of [null, "false", 0]) {
    await t.test(JSON.stringify(isProjectLabel), async () => {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
      fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
        headers: { "x-next-page": "" }, body: [],
      });
      fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
        headers: { "x-next-page": "" }, body: [{ ...restLabel(1, "type::bug"), is_project_label: isProjectLabel }],
      });
      fake.enqueue("POST", "/api/graphql", {
        body: labelGraphql([{ id: "gid://gitlab/ProjectLabel/1", title: "type::bug" }], false, null),
      });

      await assert.rejects(client(fake).labelInventory("7"), {
        code: "GITLAB_ERROR", message: "GitLab label.is_project_label validation failed",
      });
    });
  }
});

test("label inventory defaults omitted archived to false and validates explicit values", async (t) => {
  for (const [name, archived, expected] of [
    ["omitted", undefined, false],
    ["false", false, false],
    ["true", true, true],
    ["null", null, null],
    ["string", "false", null],
  ] as const) {
    await t.test(name, async () => {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
      fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
        headers: { "x-next-page": "" }, body: [],
      });
      const label = restLabel(1, "type::bug");
      if (archived === undefined) delete label.archived;
      else label.archived = archived;
      fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
        headers: { "x-next-page": "" }, body: [label],
      });
      fake.enqueue("POST", "/api/graphql", {
        body: labelGraphql([{ id: "gid://gitlab/ProjectLabel/1", title: "type::bug" }], false, null),
      });

      const result = client(fake).labelInventory("7");
      if (expected === null) {
        await assert.rejects(result, { code: "GITLAB_ERROR", message: "GitLab label.archived validation failed" });
      } else {
        const inventory = await result;
        assert.equal(inventory.all[0]?.archived, expected);
        assert.deepEqual(inventory.effective.map((entry) => entry.name), expected ? [] : ["type::bug"]);
      }
    });
  }
});

test("rejects labels when a GraphQL full path resolves to another project", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", { body: {
    id: 7,
    path_with_namespace: "group/project",
    default_branch: "develop",
    web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [],
  });
  fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [restLabel(1, "type::bug")],
  });
  fake.enqueue("POST", "/api/graphql", {
    body: labelGraphql(
      [{ id: "gid://gitlab/ProjectLabel/1", title: "type::bug" }],
      false,
      null,
      { id: "gid://gitlab/Project/8", fullPath: "group/project" },
    ),
  });

  await assert.rejects(client(fake).listLabels("7"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
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

test("rejects a paginated REST response that skips a page", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: { "x-next-page": "3" },
    body: [{ id: 11, full_path: "group" }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=3", {
    headers: { "x-next-page": "" },
    body: [{ id: 13, full_path: "parent" }],
  });

  await assert.rejects(client(fake).listAncestorGroups("7"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
  assert.equal(fake.requests.length, 1);
});

test("uses a same-origin consecutive Link relation when x-next-page is unavailable", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: {
      link: '<https://gitlab.example.test/api/v4/projects/7/groups?with_shared=false&per_page=100&page=2>; rel="next"',
    },
    body: [{ id: 11, full_path: "group" }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=2", {
    headers: { "x-next-page": "" },
    body: [{ id: 12, full_path: "parent" }],
  });

  assert.deepEqual(await client(fake).listAncestorGroups("7"), [
    { id: "11", fullPath: "group" },
    { id: "12", fullPath: "parent" },
  ]);
  assert.equal(fake.requests.length, 2);
});

test("rejects a cross-origin Link continuation without following it", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
    headers: {
      link: '<https://attacker.example.test/api/v4/projects/7/groups?with_shared=false&per_page=100&page=2>; rel="next"',
    },
    body: [{ id: 11, full_path: "group" }],
  });

  await assert.rejects(client(fake).listAncestorGroups("7"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
  assert.equal(fake.requests.length, 1);
});

test("doctor capability probe accepts advertised legacy label ID ADD and REMOVE", async () => {
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
      "details" in error && JSON.stringify(error.details).includes("label ID append/remove mutation is unavailable"),
  );
});

test("capability probe prefers advertised APPEND and caches one immutable session result", async () => {
  const fake = new FakeGitLab();
  enqueueCapabilities(fake, ["REPLACE", "ADD", "APPEND", "REMOVE"]);
  const api = client(fake);
  const [first, second] = await Promise.all([api.probeCapabilities(), api.probeCapabilities()]);
  assert.deepEqual(first.labelOperationModes, ["APPEND", "REMOVE"]);
  assert.equal(first, second);
  assert.equal(fake.requests.length, 2);
});

test("Draft creation probes required label capabilities before any remote write", async (t) => {
  for (const modes of [["REPLACE", "APPEND", "REMOVE"], ["REPLACE", "REMOVE"]]) {
    await t.test(modes.join(","), async () => {
      const fake = new FakeGitLab();
      enqueueCapabilities(fake, modes);
      fake.enqueue("POST", "/api/v4/projects/7/merge_requests", { body: {
        iid: 12, project_id: 7, target_project_id: 7, source_project_id: 7,
        source_branch: "fix/labels", target_branch: "develop", title: "Draft: Fix labels",
        description: "", draft: true, state: "opened",
      } });
      const created = client(fake).createMergeRequest({ id: "7", fullPath: "group/project" }, {
        title: "Draft: Fix labels", description: "", sourceProjectId: 7, sourceBranch: "fix/labels",
        targetProjectId: 7, targetBranch: "develop", squash: true, removeSourceBranch: true,
      });
      if (modes.includes("APPEND")) {
        assert.equal((await created).value.iid, 12);
        assert.deepEqual(fake.requests.map((request) => [request.method, new URL(request.url).pathname]), [
          ["GET", "/api/v4/version"], ["POST", "/api/graphql"], ["POST", "/api/v4/projects/7/merge_requests"],
        ]);
      } else {
        await assert.rejects(created, { name: "GitLabMutationPreflightError", code: "GITLAB_ERROR" });
        assert.equal(fake.requests.some((request) => new URL(request.url).pathname === "/api/v4/projects/7/merge_requests"), false);
      }
    });
  }
});

test("read-only capability probe failures reject before create or label mutations", async (t) => {
  for (const operation of ["create", "labels"] as const) {
    for (const status of [401, 503]) {
      await t.test(`${operation}: ${String(status)}`, async () => {
        const fake = new FakeGitLab();
        fake.enqueue("GET", "/api/v4/version", { status, body: { message: "Unavailable" } });
        const api = client(fake);
        const result = operation === "labels"
          ? api.mutateLabels({ id: "7", fullPath: "group/project" }, 12, ["gid://gitlab/ProjectLabel/3"], "ADD")
          : api.createMergeRequest({ id: "7", fullPath: "group/project" }, {
            title: "Draft: Fix labels", description: "", sourceProjectId: 7, sourceBranch: "fix/labels",
            targetProjectId: 7, targetBranch: "develop", squash: true, removeSourceBranch: true,
          });
        await assert.rejects(result, {
          name: "GitLabMutationPreflightError", code: status === 401 ? "AUTH_ERROR" : "GITLAB_ERROR",
        });
        assert.deepEqual(fake.requests.map((request) => request.method), ["GET"]);
      });
    }
  }
});

test("label ADD uses only the advertised append operation and never retries a rejected mutation", async (t) => {
  for (const modes of [["REPLACE", "APPEND", "REMOVE"], ["ADD", "REMOVE"], ["ADD", "APPEND", "REMOVE"]]) {
    await t.test(modes.join(","), async () => {
      const fake = new FakeGitLab();
      enqueueCapabilities(fake, modes);
      fake.enqueue("POST", "/api/graphql", { body: { data: {
        mergeRequestSetLabels: { errors: ["Mutation rejected"], mergeRequest: null },
      } } });
      await assert.rejects(client(fake).mutateLabels({ id: "7", fullPath: "group/project" }, 12,
        ["gid://gitlab/ProjectLabel/3"], "ADD"), { code: "GITLAB_ERROR" });
      assert.equal(fake.requests.length, 3);
      const mutation = fake.requests[2]?.body as { variables: { input: { operationMode: string } } };
      assert.equal(mutation.variables.input.operationMode, modes.includes("APPEND") ? "APPEND" : "ADD");
    });
  }
});

test("label mutation sends only global IDs and never a label name", async () => {
  const fake = new FakeGitLab();
  enqueueCapabilities(fake);
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectBody() });
  fake.enqueue("POST", "/api/graphql", { body: { data: {
    mergeRequestSetLabels: { errors: [], mergeRequest: {
      iid: "12",
      targetProject: { id: "gid://gitlab/Project/7", fullPath: "group/project" },
    } },
  } } });
  await client(fake).mutateLabels("group/project", 12, ["gid://gitlab/ProjectLabel/3"], "ADD");
  const body = fake.requests[3]?.body as { query: string; variables: unknown };
  assert.match(body.query, /mergeRequestSetLabels/u);
  assert.match(body.query, /targetProject\s*\{\s*id\s+fullPath\s*\}/u);
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
  enqueueCapabilities(mutation);
  mutation.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectBody() });
  mutation.enqueue("POST", "/api/graphql", { body: { data: {
    mergeRequestSetLabels: { errors: [], mergeRequest: {
      iid: "13",
      targetProject: { id: "gid://gitlab/Project/7", fullPath: "group/project" },
    } },
  } } });
  await assert.rejects(
    client(mutation).mutateLabels("group/project", 12, ["gid://gitlab/ProjectLabel/3"], "ADD"),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR",
  );
});

test("rejects label mutation operation modes other than explicit ADD or REMOVE before transport", async () => {
  for (const operationMode of ["REPLACE", undefined] as const) {
    const fake = new FakeGitLab();
    await assert.rejects(
      client(fake).mutateLabels(
        "group/project",
        12,
        ["gid://gitlab/ProjectLabel/3"],
        operationMode as never,
      ),
      TypeError,
    );
    assert.equal(fake.requests.length, 0);
  }
});

test("rejects a label mutation response bound to another target project", async () => {
  const fake = new FakeGitLab();
  enqueueCapabilities(fake);
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectBody() });
  fake.enqueue("POST", "/api/graphql", { body: { data: {
    mergeRequestSetLabels: { errors: [], mergeRequest: {
      iid: "12",
      targetProject: { id: "gid://gitlab/Project/8", fullPath: "other/project" },
    } },
  } } });

  await assert.rejects(
    client(fake).mutateLabels("group/project", 12, ["gid://gitlab/ProjectLabel/3"], "ADD"),
    (error: unknown) => typeof error === "object" && error !== null &&
      "code" in error && error.code === "GITLAB_ERROR",
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

test("redacts a credential reflected through request IDs from successful audit and errors", async () => {
  const token = "Response-Header-Canary-Token";
  const reflectedToken = token.toLowerCase();
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", {
    headers: { "x-request-id": `prefix-${reflectedToken}-suffix` },
    body: {
      id: 7,
      path_with_namespace: "group/project",
      default_branch: "develop",
      web_url: "https://gitlab.example.test/group/project",
    },
  });
  const api = client(fake, token);
  await api.getProject("group/project");
  assert.deepEqual(api.audit().requestIds, []);
  assert.doesNotMatch(JSON.stringify(api.audit()), new RegExp(token, "iu"));

  const http = new GitLabHttpClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => token,
    transport: {
      async request() {
        return {
          status: 500,
          headers: { "x-request-id": `prefix-${reflectedToken}-suffix` },
          body: new TextEncoder().encode("{}"),
        };
      },
    },
  });
  const error = await http.requestJson("GET", "/api/v4/version").catch((caught: unknown) => caught);
  assert.equal((error as { code: string }).code, "GITLAB_ERROR");
  assert.doesNotMatch(JSON.stringify(error), new RegExp(token, "iu"));
  assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(token, "iu"));
});

test("redacts request IDs that reflect any credential seen before or after rotation", async () => {
  const credentials = ["old-rotation-token", "future-rotation-token"];
  let credentialIndex = 0;
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", {
    headers: { "x-request-id": "safe-first-request-id" },
    body: projectBody(),
  });
  fake.enqueue("GET", "/api/v4/projects/7", {
    headers: { "x-request-id": "prefix-old-rotation-token-suffix" },
    body: projectBody(),
  });
  const api = new GitLabClient({
    origin: "https://gitlab.example.test",
    tokenProvider: async () => credentials[credentialIndex++] as string,
    transport: fake,
  });

  await api.getProject("7");
  await api.getProject("7");
  assert.deepEqual(api.audit().requestIds, ["safe-first-request-id"]);
  assert.doesNotMatch(JSON.stringify(api.audit()), /old-rotation-token|future-rotation-token/u);
});

test("review state uses approvals rather than treating a completed review as approval", async () => {
  const sourceSha = "b".repeat(40);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
    id: 120,
    iid: 12,
    project_id: 7,
    approved_by: [{ user: { id: 41, username: "approver", name: "Approver", state: "active" } }],
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [{ notes: [{
      project_id: 7,
      noteable_id: 120,
      noteable_iid: null,
      noteable_type: "MergeRequest",
      resolvable: true,
      resolved: false,
    }] }],
  });

  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });

  assert.deepEqual(await client(fake).getReviewState("group/project", 12, sourceSha), {
    approvedUserIds: ["41"],
    unresolvedDiscussions: 1,
  });
  assert.equal(fake.requests.some((request) => request.url.includes("/reviewers")), false);
});

test("GitLab CE review state accepts the four-field approvals response and binds discussions to both MR fences", async () => {
  const sourceSha = "b".repeat(40);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
    user_has_approved: false, user_can_approve: true, approved: false, approved_by: [],
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [{ notes: [{
      project_id: 7, noteable_id: 120, noteable_iid: 12, noteable_type: "MergeRequest",
      resolvable: true, resolved: false,
    }] }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
  assert.deepEqual(await client(fake).getReviewState("7", 12, sourceSha), {
    approvedUserIds: [], unresolvedDiscussions: 1,
  });
  assert.equal(fake.requests.length, 5);
  assert.equal(fake.requests.every((request) => request.method === "GET"), true);
});

test("review approvals reject every null, malformed, or mismatched identity field that is present", async () => {
  const sourceSha = "b".repeat(40);
  for (const field of ["id", "iid", "project_id"] as const) {
    for (const value of [null, "120", field === "id" ? 121 : field === "iid" ? 13 : 8]) {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
      fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
      fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
        user_has_approved: false, user_can_approve: true, approved: false, approved_by: [], [field]: value,
      } });
      await assert.rejects(client(fake).getReviewState("7", 12, sourceSha),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR",
        `${field}=${String(value)}`);
      assert.equal(fake.requests.length, 3);
    }
  }
});

test("CE approval omission still requires the final MR fence to match the original MR identity and SHA", async () => {
  const sourceSha = "b".repeat(40);
  for (const drift of [{ id: 121 }, { iid: 13 }, { project_id: 8 }, { sha: "c".repeat(40) }]) {
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
      user_has_approved: false, user_can_approve: true, approved: false, approved_by: [],
    } });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
      headers: { "x-next-page": "" }, body: [],
    });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", {
      body: reviewFenceBody(sourceSha, "mergeable", drift),
    });
    await assert.rejects(client(fake).getReviewState("7", 12, sourceSha),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
    assert.equal(fake.requests.length, 5);
  }
});

test("review state accepts non-resolvable system notes without a resolved field", async () => {
  const sourceSha = "b".repeat(40);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
    user_has_approved: false, user_can_approve: true, approved: false, approved_by: [],
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [{ notes: [{
      project_id: 7, noteable_id: 120, noteable_iid: 12, noteable_type: "MergeRequest",
      system: true, resolvable: false,
    }] }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
  assert.deepEqual(await client(fake).getReviewState("7", 12, sourceSha), {
    approvedUserIds: [], unresolvedDiscussions: 0,
  });
  assert.equal(fake.requests.length, 5);
});

test("rejects review state whose approvals or discussions belong to another resource", async () => {
  const sourceSha = "b".repeat(40);
  for (const variant of ["approval-project", "approval-iid", "discussion-project", "discussion-mr"] as const) {
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/7", { body: {
      id: 7,
      path_with_namespace: "group/project",
      default_branch: "develop",
      web_url: "https://gitlab.example.test/group/project",
    } });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
      id: 120,
      iid: variant === "approval-iid" ? 13 : 12,
      project_id: variant === "approval-project" ? 8 : 7,
      approved_by: [],
    } });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
      headers: { "x-next-page": "" },
      body: [{ notes: [{
        project_id: variant === "discussion-project" ? 8 : 7,
        noteable_id: variant === "discussion-mr" ? 121 : 120,
        noteable_iid: variant === "discussion-mr" ? 13 : 12,
        noteable_type: "MergeRequest",
        resolvable: true,
        resolved: false,
      }] }],
    });
    if (variant === "discussion-project" || variant === "discussion-mr") {
      fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
    }

    await assert.rejects(client(fake).getReviewState("7", 12, sourceSha), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
  }
});

test("rejects review discussion state with unknown resolution booleans", async () => {
  const sourceSha = "b".repeat(40);
  const identity = { project_id: 7, noteable_id: 120, noteable_iid: 12, noteable_type: "MergeRequest" };
  for (const notes of [
    [{ ...identity, resolvable: "true", resolved: false }],
    [{ ...identity, resolvable: true, resolved: "false" }],
    [{ ...identity, resolvable: true }],
    [{ ...identity, resolvable: false, resolved: null }],
    [{ ...identity, resolvable: false, resolved: "false" }],
    [
      { ...identity, resolvable: true, resolved: false },
      { ...identity, resolvable: true, resolved: "false" },
    ],
  ]) {
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/7", { body: {
      id: 7,
      path_with_namespace: "group/project",
      default_branch: "develop",
      web_url: "https://gitlab.example.test/group/project",
    } });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
      id: 120,
      iid: 12,
      project_id: 7,
      approved_by: [],
    } });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
      headers: { "x-next-page": "" },
      body: [{ notes }],
    });

    await assert.rejects(client(fake).getReviewState("7", 12, sourceSha), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
  }
});

test("rejects a review discussion with no notes", async () => {
  const sourceSha = "b".repeat(40);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
    id: 120, iid: 12, project_id: 7, approved_by: [],
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
    headers: { "x-next-page": "" }, body: [{ notes: [] }],
  });

  await assert.rejects(client(fake).getReviewState("7", 12, sourceSha), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
});

test("rejects review state while GitLab is checking or synchronizing approvals", async () => {
  const sourceSha = "b".repeat(40);
  for (const detailedMergeStatus of ["checking", "approvals_syncing"] as const) {
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", {
      body: reviewFenceBody(sourceSha, detailedMergeStatus),
    });

    await assert.rejects(client(fake).getReviewState("7", 12, sourceSha), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
    assert.equal(fake.requests.length, 2);
  }
});

test("rejects review state when the MR source SHA changes during review discovery", async () => {
  const sourceSha = "b".repeat(40);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody(sourceSha) });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/approvals", { body: {
    id: 120, iid: 12, project_id: 7, approved_by: [],
  } });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12/discussions?per_page=100&page=1", {
    headers: { "x-next-page": "" },
    body: [{ notes: [{
      project_id: 7, noteable_id: 120, noteable_iid: 12, noteable_type: "MergeRequest",
      resolvable: false, resolved: false,
    }] }],
  });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12", { body: reviewFenceBody("c".repeat(40)) });

  await assert.rejects(client(fake).getReviewState("7", 12, sourceSha), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
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

test("hydrates string applied labels from a fresh project and ancestor inventory for MR and Issue reads", async (t) => {
  for (const resource of ["merge request", "issue"] as const) {
    await t.test(resource, async () => {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
      const labels = ["status::doing", "type::bug", "archived::old"];
      fake.enqueue("GET", resource === "issue"
        ? "/api/v4/projects/7/issues/51?with_labels_details=true"
        : "/api/v4/projects/7/merge_requests/12?with_labels_details=true", { body: resource === "issue"
          ? { iid: 51, milestone: null, assignees: [], due_date: null, labels }
          : mergeRequestBody({ labels }),
      });
      enqueueAppliedLabelInventory(fake, [restLabel(3, "status::doing"), restLabel(9, "archived::old", { archived: true })], [restLabel(21, "type::bug")]);

      const api = client(fake);
      const result = resource === "issue" ? await api.getIssue("7", 51) : await api.getMergeRequest("7", 12);
      assert.deepEqual(result.labels, [
        { restId: 9, name: "archived::old", archived: true },
        { restId: 3, name: "status::doing", archived: false },
        { restId: 21, name: "type::bug", archived: false },
      ]);
      assert.equal(fake.requests.filter((request) => new URL(request.url).pathname === "/api/graphql").length, 1);
    });
  }
});

test("MR string label receipts keep the MR request ID while auditing inventory requests", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
    headers: { "x-request-id": "req-mr-string-labels" }, body: mergeRequestBody({ labels: ["type::bug"] }),
  });
  enqueueAppliedLabelInventory(fake, [], [restLabel(21, "type::bug")]);
  const api = client(fake);

  const receipt = await api.getMergeRequestReceipt({ id: "7", fullPath: "group/project" }, 12);
  assert.equal(receipt.requestId, "req-mr-string-labels");
  assert.deepEqual(receipt.value.labels, [{ restId: 21, name: "type::bug", archived: false }]);
  assert.deepEqual(api.audit().requestIds, [
    "req-inventory-graphql", "req-inventory-group-labels", "req-inventory-groups",
    "req-inventory-project", "req-inventory-project-labels", "req-mr-string-labels",
  ]);
});

test("paginated MR string labels share one inventory within the list and keep the last page receipt", async () => {
  const fake = new FakeGitLab();
  const endpoint = "/api/v4/projects/7/merge_requests?scope=all&state=opened&source_branch=fix%2F51-labels&target_branch=develop&with_labels_details=true&per_page=100&page=";
  fake.enqueue("GET", `${endpoint}1`, {
    headers: { "x-next-page": "2", "x-request-id": "req-list-1" }, body: [mergeRequestBody({ labels: ["type::bug"] })],
  });
  fake.enqueue("GET", `${endpoint}2`, {
    headers: { "x-next-page": "", "x-request-id": "req-list-2" }, body: [mergeRequestBody({ iid: 13, labels: ["status::doing"] })],
  });
  enqueueAppliedLabelInventory(fake, [restLabel(3, "status::doing")], [restLabel(21, "type::bug")]);

  const receipt = await client(fake).listOpenMergeRequestReceipts({ id: "7", fullPath: "group/project" }, "fix/51-labels", "develop");
  assert.equal(receipt.requestId, "req-list-2");
  assert.deepEqual(receipt.value.map((mr) => mr.labels), [
    [{ restId: 21, name: "type::bug", archived: false }],
    [{ restId: 3, name: "status::doing", archived: false }],
  ]);
  assert.equal(fake.requests.filter((request) => new URL(request.url).pathname === "/api/graphql").length, 1);
});

test("string applied labels reject absent or ambiguous real identities and retain the MR receipt", async (t) => {
  for (const [name, projectLabels, groupLabels] of [
    ["absent", [], []],
    ["same project", [restLabel(3, "status::doing"), restLabel(4, "status::doing")], []],
    ["project shadows group", [restLabel(3, "status::doing")], [restLabel(21, "status::doing")]],
    ["archived duplicate", [restLabel(3, "status::doing"), restLabel(4, "status::doing", { archived: true })], []],
  ] as const) {
    await t.test(name, async () => {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
        headers: { "x-request-id": "req-unresolved-labels" }, body: mergeRequestBody({ labels: ["status::doing"] }),
      });
      enqueueAppliedLabelInventory(fake, projectLabels, groupLabels);

      await assert.rejects(client(fake).getMergeRequestReceipt({ id: "7", fullPath: "group/project" }, 12), (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR" &&
          "requestId" in error && error.requestId === "req-unresolved-labels");
    });
  }
});

test("string applied label reads reject malformed labels and resource identities before inventory lookup", async (t) => {
  for (const [name, overrides] of [
    ["duplicate names", { labels: ["status::doing", "status::doing"] }],
    ["mixed labels", { labels: ["status::doing", { id: 3, name: "status::doing" }] }],
    ["empty name", { labels: [""] }],
    ["wrong project", { labels: ["status::doing"], target_project_id: 8 }],
    ["wrong IID", { labels: ["status::doing"], iid: 13 }],
    ["wrong pipeline SHA", { labels: ["status::doing"], head_pipeline: { status: "success", sha: "c".repeat(40) } }],
  ] as const) {
    await t.test(name, async () => {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
        headers: { "x-request-id": "req-invalid-label-resource" }, body: mergeRequestBody(overrides),
      });

      await assert.rejects(client(fake).getMergeRequestReceipt({ id: "7", fullPath: "group/project" }, 12), {
        code: "GITLAB_ERROR", requestId: "req-invalid-label-resource",
      });
      assert.equal(fake.requests.length, 1);
    });
  }
});

test("string applied labels use a new live inventory on each MR read", async () => {
  const fake = new FakeGitLab();
  for (const id of [3, 30]) {
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", { body: mergeRequestBody({ labels: ["status::doing"] }) });
    enqueueAppliedLabelInventory(fake, [restLabel(id, "status::doing")]);
  }
  const api = client(fake);
  const project = { id: "7", fullPath: "group/project" };

  assert.equal((await api.getMergeRequestReceipt(project, 12)).value.labels[0]?.restId, 3);
  assert.equal((await api.getMergeRequestReceipt(project, 12)).value.labels[0]?.restId, 30);
  assert.equal(fake.requests.filter((request) => new URL(request.url).pathname === "/api/graphql").length, 2);
});

test("string applied label hydration retains inventory HTTP failures and rejects another project's inventory", async (t) => {
  for (const status of [401, 503]) {
    await t.test(`inventory HTTP ${String(status)}`, async () => {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
        headers: { "x-request-id": "req-mr-before-inventory" }, body: mergeRequestBody({ labels: ["status::doing"] }),
      });
      fake.enqueue("GET", "/api/v4/projects/7", {
        status, headers: { "x-request-id": "req-inventory-failure" }, body: { message: "inventory failed" },
      });

      await assert.rejects(client(fake).getMergeRequestReceipt({ id: "7", fullPath: "group/project" }, 12), {
        name: "GitLabRequestError", requestId: "req-inventory-failure", status,
      });
    });
  }
  await t.test("inventory project mismatch", async () => {
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
      headers: { "x-request-id": "req-mr-before-inventory" }, body: mergeRequestBody({ labels: ["status::doing"] }),
    });
    fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody(8, "other/project") });

    await assert.rejects(client(fake).getMergeRequestReceipt({ id: "7", fullPath: "group/project" }, 12), {
      code: "GITLAB_ERROR", requestId: "req-mr-before-inventory",
    });
    assert.equal(fake.requests.length, 2);
  });
});

test("string applied label hydration rejects one REST ID resolving to two applied names", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", {
    headers: { "x-request-id": "req-duplicate-applied-id" }, body: mergeRequestBody({ labels: ["status::doing", "type::bug"] }),
  });
  enqueueAppliedLabelInventory(fake, [restLabel(3, "status::doing")], [restLabel(3, "type::bug")]);

  await assert.rejects(client(fake).getMergeRequestReceipt({ id: "7", fullPath: "group/project" }, 12), {
    code: "GITLAB_ERROR", requestId: "req-duplicate-applied-id",
  });
});

test("merge request source branch removal uses both nullable GitLab flags and rejects malformed values", async (t) => {
  for (const [name, shouldRemove, forceRemove, expected] of [
    ["legacy true", true, undefined, true],
    ["legacy false", false, undefined, false],
    ["nullable true force", null, true, true],
    ["explicit false true force", false, true, true],
    ["true false force", true, false, true],
    ["nullable false force", null, false, false],
    ["both nullable", null, null, false],
    ["string should", "true", true, null],
    ["missing should", undefined, true, null],
    ["string force", true, "true", null],
    ["number force", false, 0, null],
  ] as const) {
    await t.test(name, async () => {
      const fake = new FakeGitLab();
      fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
      const body: Record<string, unknown> = {
        iid: 12, web_url: "https://gitlab.example.test/group/project/-/merge_requests/12",
        title: "Draft: [fix][app] Fix labels", description: "", draft: true, state: "opened",
        source_project_id: 7, source_branch: "fix/51-labels", target_project_id: 7,
        target_branch: "develop", sha: "b".repeat(40),
        author: { id: 40, username: "author", name: "Author", state: "active" },
        assignees: [], reviewers: [], labels: [], squash: true, head_pipeline: null,
      };
      if (shouldRemove !== undefined) body.should_remove_source_branch = shouldRemove;
      if (forceRemove !== undefined) body.force_remove_source_branch = forceRemove;
      fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", { body });
      const result = client(fake).getMergeRequest("7", 12);
      if (expected === null) await assert.rejects(result, { code: "GITLAB_ERROR" });
      else assert.equal((await result).shouldRemoveSourceBranch, expected);
    });
  }
});

test("Issue and MR labels default omitted archived to false and validate explicit values", async (t) => {
  for (const resource of ["issue", "merge request"] as const) {
    for (const [name, archived, expected] of [
      ["omitted", undefined, false],
      ["false", false, false],
      ["true", true, true],
      ["null", null, null],
      ["string", "false", null],
    ] as const) {
      await t.test(`${resource}: ${name}`, async () => {
        const fake = new FakeGitLab();
        fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
        const label: Record<string, unknown> = { id: 3, name: "status::doing" };
        if (archived !== undefined) label.archived = archived;
        if (resource === "issue") {
          fake.enqueue("GET", "/api/v4/projects/7/issues/51?with_labels_details=true", { body: {
            iid: 51, milestone: null, assignees: [], due_date: null, labels: [label],
          } });
        } else {
          fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", { body: {
            iid: 12, web_url: "https://gitlab.example.test/group/project/-/merge_requests/12",
            title: "Draft: [fix][app] Fix labels", description: "", draft: true, state: "opened",
            source_project_id: 7, source_branch: "fix/51-labels", target_project_id: 7,
            target_branch: "develop", sha: "b".repeat(40),
            author: { id: 40, username: "author", name: "Author", state: "active" },
            assignees: [], reviewers: [], labels: [label],
            squash: true, should_remove_source_branch: true, head_pipeline: null,
          } });
        }

        const api = client(fake);
        const result = resource === "issue" ? api.getIssue("7", 51) : api.getMergeRequest("7", 12);
        if (expected === null) {
          await assert.rejects(result, {
            code: "GITLAB_ERROR", message: `GitLab ${resource} label.archived validation failed`,
          });
        } else {
          assert.deepEqual((await result).labels, [{ restId: 3, name: "status::doing", archived: expected }]);
        }
      });
    }
  }
});

test("rejects a head pipeline whose SHA does not equal the MR source SHA", async () => {
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/7", { body: projectBody() });
  fake.enqueue("GET", "/api/v4/projects/7/merge_requests/12?with_labels_details=true", { body: {
    iid: 12,
    web_url: "https://gitlab.example.test/group/project/-/merge_requests/12",
    title: "[fix][app] Fix labels",
    description: "",
    draft: false,
    state: "opened",
    source_project_id: 7,
    source_branch: "fix/51-labels",
    target_project_id: 7,
    target_branch: "develop",
    sha: "b".repeat(40),
    author: { id: 40, username: "author", name: "Author", state: "active" },
    assignees: [],
    reviewers: [],
    labels: [],
    squash: true,
    should_remove_source_branch: true,
    head_pipeline: { status: "success", sha: "c".repeat(40) },
  } });

  await assert.rejects(client(fake).getMergeRequest("7", 12), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "GITLAB_ERROR");
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
  fake.enqueue("GET", "/api/v4/projects/7", { body: {
    id: 7, path_with_namespace: "group/project", default_branch: "develop", web_url: "https://gitlab.example.test/group/project",
  } });
  fake.enqueue("GET", "/api/v4/projects/7", { body: {
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
  fake.enqueue("GET", "/api/v4/projects/7/repository/branches/develop", { body: {
    name: "develop", commit: { id: "a".repeat(40) },
  } });
  fake.enqueue("GET", "/api/v4/projects/7/repository/branches/develop", { body: {
    name: "develop", commit: { id: "a".repeat(40) },
  } });

  const stateRoot = await mkdtemp(resolve(await realpath(tmpdir()), "hmr-gitlab-context-"));
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

    assert.deepEqual(context.requiredLabelCategories, ["type", "priority"]);
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
      "priority::p1", "type::bug",
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
  const stateRoot = await mkdtemp(resolve(await realpath(tmpdir()), "hmr-gitlab-context-moved-"));
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

test("context pins target reads by project ID and rejects a rebound target path before issuing tokens", async () => {
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
  let pathReads = 0;
  let issues = 0;
  const pinnedReferences: string[] = [];
  const api = {
    origin: "https://gitlab.example.test",
    getProject: async (reference: string) => {
      assert.equal(reference, "group/project");
      pathReads += 1;
      return pathReads === 1
        ? { id: "7", fullPath: "group/project", defaultBranch: "develop", webUrl: "https://gitlab.example.test/group/project" }
        : { id: "8", fullPath: "group/project", defaultBranch: "develop", webUrl: "https://gitlab.example.test/group/project" };
    },
    getBranchHead: async (reference: string) => { pinnedReferences.push(reference); return "a".repeat(40); },
    labelInventory: async (reference: string) => {
      pinnedReferences.push(reference);
      return { all: active, effective: active, audit: { requestIds: [] } };
    },
    listUsers: async (reference: string) => {
      pinnedReferences.push(reference);
      return [{ id: "40", username: "author", displayName: "Author", state: "active" as const, accessLevel: 40 }];
    },
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
    "message" in error && error.message === "Target project identity changed during context discovery");
  assert.equal(pathReads, 2);
  assert.equal(pinnedReferences.length > 0, true);
  assert.equal(pinnedReferences.every((reference) => reference === "7"), true);
  assert.equal(issues, 0);
});
