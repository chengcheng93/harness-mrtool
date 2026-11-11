import assert from "node:assert/strict";
import test from "node:test";

import { isRemoteMutationError } from "../../src/app/remote-outcome.ts";
import { GitLabClient } from "../../src/gitlab/client.ts";
import type { GitLabHttpRequest, GitLabHttpTransport } from "../../src/gitlab/http.ts";
import { FakeGitLab } from "../helpers/fake-gitlab.ts";

const ORIGIN = "https://gitlab.example.test";
const TOKEN = "glpat-submit-contract-secret";
const ISSUE_ENDPOINT = "/api/v4/projects/7/issues";
const MR_ENDPOINT = "/api/v4/projects/9/merge_requests";
const ISSUE = {
  projectId: 7, projectPath: "group/project", title: "Fix CSS", description: "Issue body",
  assigneeIds: [41], dueDate: "2026-11-30",
};
const MR = {
  sourceProjectId: 9, targetProjectId: 7, targetProjectPath: "group/project",
  sourceBranch: "feature/css", targetBranch: "develop", title: "Fix CSS", description: "MR body",
  squash: true, removeSourceBranch: false, labelNames: ["type::fix", "status::review"],
  assigneeIds: [41], reviewerIds: [42, 43],
};
function issueBody(overrides: Record<string, unknown> = {}) {
  return { id: 101, iid: 11, project_id: 7, web_url: ORIGIN + "/group/project/-/issues/11", ...overrides };
}
function mrBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 102, iid: 12, project_id: 7, source_project_id: 9, target_project_id: 7,
    source_branch: MR.sourceBranch, target_branch: MR.targetBranch,
    web_url: ORIGIN + "/group/project/-/merge_requests/12", ...overrides,
  };
}
function setup(fake = new FakeGitLab(), transform?: (request: GitLabHttpRequest, transport: FakeGitLab) => ReturnType<GitLabHttpTransport["request"]>) {
  const attempts: GitLabHttpRequest[] = [];
  const gitlab = new GitLabClient({
    origin: ORIGIN, tokenProvider: async () => TOKEN,
    transport: { async request(request) {
      attempts.push(request);
      return transform ? transform(request, fake) : fake.request(request);
    } },
  });
  return { fake, attempts, gitlab };
}
function assertSinglePost(attempts: readonly GitLabHttpRequest[], endpoint: string) {
  assert.deepEqual(attempts.map(({ method, url }) => [method, url]), [["POST", ORIGIN + endpoint]]);
}
function failure(outcome: "unknown" | "rejected", reason: string, requestId: string | null) {
  return (error: unknown) => {
    assert.equal(isRemoteMutationError(error, outcome), true);
    if (isRemoteMutationError(error)) {
      assert.equal(error.reason, reason);
      assert.equal(error.requestId, requestId);
    }
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    assert.equal(String(error).includes(TOKEN), false);
    return true;
  };
}

test("createIssue sends its complete whitelist in one REST POST and returns its identity receipt", async () => {
  const { fake, attempts, gitlab } = setup();
  fake.enqueue("POST", ISSUE_ENDPOINT, { status: 201, headers: { "x-request-id": "req-issue" }, body: issueBody() });
  assert.deepEqual(await gitlab.createIssue(ISSUE), {
    value: { id: 101, iid: 11, projectId: 7, webUrl: ORIGIN + "/group/project/-/issues/11" }, requestId: "req-issue",
  });
  assertSinglePost(attempts, ISSUE_ENDPOINT);
  assert.deepEqual(fake.requests[0]?.body, {
    title: ISSUE.title, description: ISSUE.description, issue_type: "issue", assignee_ids: [41], due_date: ISSUE.dueDate,
  });
});

test("createMergeRequestSubmission sends labels and people on the source project's initial POST", async () => {
  const { fake, attempts, gitlab } = setup();
  fake.enqueue("POST", MR_ENDPOINT, { status: 201, headers: { "x-request-id": "req-mr" }, body: mrBody() });
  assert.deepEqual(await gitlab.createMergeRequestSubmission(MR), {
    value: { iid: 12, webUrl: ORIGIN + "/group/project/-/merge_requests/12", sourceProjectId: 9, targetProjectId: 7 }, requestId: "req-mr",
  });
  assertSinglePost(attempts, MR_ENDPOINT);
  assert.deepEqual(fake.requests[0]?.body, {
    target_project_id: 7, source_branch: MR.sourceBranch, target_branch: MR.targetBranch,
    title: MR.title, description: MR.description, squash: true, remove_source_branch: false,
    labels: "type::fix,status::review", assignee_ids: [41], reviewer_ids: [42, 43],
  });
});

test("MR submission supports empty optional labels and people without any lookup", async () => {
  const { fake, attempts, gitlab } = setup();
  fake.enqueue("POST", "/api/v4/projects/7/merge_requests", { body: mrBody({ source_project_id: 7 }) });
  await gitlab.createMergeRequestSubmission({ ...MR, sourceProjectId: 7, labelNames: [], assigneeIds: [], reviewerIds: [] });
  assertSinglePost(attempts, "/api/v4/projects/7/merge_requests");
  assert.deepEqual(fake.requests[0]?.body, {
    target_project_id: 7, source_branch: MR.sourceBranch, target_branch: MR.targetBranch,
    title: MR.title, description: MR.description, squash: true, remove_source_branch: false,
    labels: "", assignee_ids: [], reviewer_ids: [],
  });
});

for (const [name, overrides] of Object.entries({
  "wrong project": { project_id: 8 }, "zero id": { id: 0 }, "negative id": { id: -1 },
  "unsafe id": { id: Number.MAX_SAFE_INTEGER + 1 }, "zero iid": { iid: 0 }, "string iid": { iid: "11" },
  "foreign URL": { web_url: "https://other.test/group/project/-/issues/11" },
  "wrong path": { web_url: ORIGIN + "/other/project/-/issues/11" },
  "wrong URL iid": { web_url: ORIGIN + "/group/project/-/issues/12" },
  "URL credentials": { web_url: "https://user:pass@gitlab.example.test/group/project/-/issues/11" },
  "URL query": { web_url: ORIGIN + "/group/project/-/issues/11?token=" + TOKEN },
  "URL fragment": { web_url: ORIGIN + "/group/project/-/issues/11#fragment" },
  "missing URL": { web_url: null },
})) {
  test("issue acknowledgement with " + name + " has unknown outcome without followup", async () => {
    const { fake, attempts, gitlab } = setup();
    fake.enqueue("POST", ISSUE_ENDPOINT, { headers: { "x-request-id": "req-malformed" }, body: issueBody(overrides) });
    await assert.rejects(gitlab.createIssue(ISSUE), failure("unknown", "server", "req-malformed"));
    assertSinglePost(attempts, ISSUE_ENDPOINT);
  });
}
for (const [name, overrides] of Object.entries({
  "wrong project": { project_id: 8 }, "wrong target": { target_project_id: 8 }, "wrong source": { source_project_id: 8 },
  "wrong source branch": { source_branch: "another" }, "wrong target branch": { target_branch: "another" },
  "invalid id": { id: 0 }, "invalid iid": { iid: 0 }, "invalid source id": { source_project_id: 0 },
  "invalid target id": { target_project_id: 0 }, "foreign URL": { web_url: "https://other.test/group/project/-/merge_requests/12" },
  "wrong URL path": { web_url: ORIGIN + "/fork/project/-/merge_requests/12" },
  "wrong URL iid": { web_url: ORIGIN + "/group/project/-/merge_requests/13" },
})) {
  test("MR acknowledgement with " + name + " has unknown outcome without followup", async () => {
    const { fake, attempts, gitlab } = setup();
    fake.enqueue("POST", MR_ENDPOINT, { headers: { "x-request-id": "req-malformed" }, body: mrBody(overrides) });
    await assert.rejects(gitlab.createMergeRequestSubmission(MR), failure("unknown", "server", "req-malformed"));
    assertSinglePost(attempts, MR_ENDPOINT);
  });
}

for (const kind of ["issue", "mr"] as const) {
  const endpoint = kind === "issue" ? ISSUE_ENDPOINT : MR_ENDPOINT;
  const submit = (gitlab: GitLabClient) => kind === "issue" ? gitlab.createIssue(ISSUE) : gitlab.createMergeRequestSubmission(MR);
  for (const [status, outcome, reason] of [
    [400, "rejected", "validation"], [401, "rejected", "auth"], [403, "rejected", "auth"],
    [404, "rejected", "validation"], [405, "rejected", "validation"], [408, "rejected", "validation"],
    [409, "rejected", "conflict"], [413, "rejected", "validation"], [422, "rejected", "validation"],
    [429, "rejected", "validation"], [499, "rejected", "validation"],
    [500, "unknown", "server"], [503, "unknown", "server"],
  ] as const) {
    test(kind + " HTTP " + status + " is classified with a single attempt", async () => {
      const { fake, attempts, gitlab } = setup();
      fake.enqueue("POST", endpoint, { status, headers: { "x-request-id": "req-status" }, body: { message: TOKEN } });
      await assert.rejects(submit(gitlab), failure(outcome, reason, "req-status"));
      assertSinglePost(attempts, endpoint);
    });
  }
  for (const mode of ["network", "timeout", "response-loss", "malformed-json", "malformed-success"] as const) {
    test(kind + " " + mode + " is unknown with no retry or record lookup", async () => {
      const fake = new FakeGitLab();
      fake.enqueue("POST", endpoint, { headers: { "x-request-id": "req-response" }, body: kind === "issue" ? issueBody() : mrBody() });
      const { attempts, gitlab } = setup(fake, async (request, transport) => {
        const response = await transport.request(request);
        if (mode === "network" || mode === "timeout" || mode === "response-loss") {
          const error = new Error(TOKEN);
          if (mode === "timeout") error.name = "AbortError";
          throw error;
        }
        return { ...response, body: new TextEncoder().encode(mode === "malformed-json" ? "{invalid " + TOKEN : "null") };
      });
      await assert.rejects(submit(gitlab), failure("unknown", mode === "timeout" ? "timeout" : mode === "network" || mode === "response-loss" ? "network" : "server", mode.startsWith("malformed") ? "req-response" : null));
      assertSinglePost(attempts, endpoint);
    });
  }
  test(kind + " suppresses credential-reflecting request IDs", async () => {
    const { fake, attempts, gitlab } = setup();
    fake.enqueue("POST", endpoint, { headers: { "x-request-id": "req-" + TOKEN }, body: kind === "issue" ? issueBody() : mrBody() });
    const receipt = await submit(gitlab);
    assert.equal(receipt.requestId, null);
    assertSinglePost(attempts, endpoint);
  });
}

test("invalid issue and MR IDs or issue assignee cardinality are rejected before transport", async () => {
  const { attempts, gitlab } = setup();
  for (const projectId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(gitlab.createIssue({ ...ISSUE, projectId }), failure("rejected", "validation", null));
    await assert.rejects(gitlab.createMergeRequestSubmission({ ...MR, sourceProjectId: projectId }), failure("rejected", "validation", null));
    await assert.rejects(gitlab.createMergeRequestSubmission({ ...MR, targetProjectId: projectId }), failure("rejected", "validation", null));
  }
  for (const assigneeIds of [[], [41, 42], [0]]) {
    await assert.rejects(gitlab.createIssue({ ...ISSUE, assigneeIds }), failure("rejected", "validation", null));
  }
  await assert.rejects(gitlab.createMergeRequestSubmission({ ...MR, reviewerIds: [0] }), failure("rejected", "validation", null));
  assert.equal(attempts.length, 0);
});

for (const labelNames of [[], ["type::fix", "priority::normal"]]) {
  test("issue creation sends only nonempty optional labels in its initial POST: " + labelNames.length, async () => {
    const { fake, attempts, gitlab } = setup();
    fake.enqueue("POST", ISSUE_ENDPOINT, { body: issueBody() });
    await gitlab.createIssue({ ...ISSUE, labelNames });
    assertSinglePost(attempts, ISSUE_ENDPOINT);
    assert.deepEqual(fake.requests[0]?.body, {
      title: ISSUE.title, description: ISSUE.description, issue_type: "issue", assignee_ids: [41], due_date: ISSUE.dueDate,
      ...(labelNames.length ? { labels: labelNames.join(",") } : {}),
    });
  });
}


test("selected milestone is sent by both initial POSTs without a lookup",async()=>{
 const {fake,attempts,gitlab}=setup();fake.enqueue("POST",ISSUE_ENDPOINT,{body:issueBody()});fake.enqueue("POST",MR_ENDPOINT,{body:mrBody()});
 await gitlab.createIssue({...ISSUE,milestoneId:901});await gitlab.createMergeRequestSubmission({...MR,milestoneId:901});
 assert.deepEqual(attempts.map(r=>r.method),["POST","POST"]);
 assert.equal((fake.requests[0]!.body as Record<string,unknown>).milestone_id,901);
 assert.equal((fake.requests[1]!.body as Record<string,unknown>).milestone_id,901);
});
for (const milestoneId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN]) test("invalid milestone ID fails before transport: "+milestoneId,async()=>{
 const {attempts,gitlab}=setup();await assert.rejects(gitlab.createIssue({...ISSUE,milestoneId}),failure("rejected","validation",null));
 await assert.rejects(gitlab.createMergeRequestSubmission({...MR,milestoneId}),failure("rejected","validation",null));assert.equal(attempts.length,0);
});
