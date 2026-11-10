import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import { DEFAULT_LABEL_POOL } from "../../src/app/label-defaults.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";
import { RemoteMutationError } from "../../src/app/remote-outcome.ts";
import { ToolError } from "../../src/contracts/errors.ts";
import type { GitLabCreateIssueInput, GitLabCreateMergeRequestSubmissionInput } from "../../src/gitlab/types.ts";
import type { UserCandidate } from "../../src/context/types.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";
import * as service from "../../src/app/create-submission.ts";
import * as marker from "../../src/render/submission.ts";
const root = resolve(import.meta.dirname, "../..");
async function fixture() {
    const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
    raw.title.type = "docs";
    raw.workItem = { relation: "new" };
    raw.mergeRequest.labelCandidateTokens = [];
    const sr = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-snapshot.json"), "utf8"));
    sr.targetProject.id = "100";
    sr.sourceProject.id = "101";
    sr.sourceProject.path = "author/luban-studio";
    sr.issue = { kind: "none" };
    sr.labelCandidates = DEFAULT_LABEL_POOL.map((name, i) => ({ id: String(i + 1), name }));
    sr.userCandidates.forEach((u: {
        id: string;
    }) => u.id = u.id.replace("user:", ""));
    sr.mergeRequest = { ...sr.mergeRequest, iid: null, lifecycle: "new", authorUserId: "30", labelIds: [], assigneeUserId: null, reviewerUserIds: [] };
    sr.review.qualifiedReviewerUserIds = ["20"];
    const snapshot = validateExternalContextSnapshot(sr);
    const request = normalizeAndValidateRequest(raw);
    const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
    const candidates: UserCandidate[] = [{ kind: "assignee", globalId: null, userId: "10", username: "alice", displayName: "Alice Zhang" }, { kind: "reviewer", globalId: null, userId: "20", username: "bob", displayName: "Bob Chen" }];
    const plan = buildWritePlan({ request, snapshot, bundle, resolvedCandidates: candidates, labelDiff: { sourceHeadSha: snapshot.sourceHeadSha, targetRefSha: snapshot.targetRefSha, mergeBaseSha: snapshot.mergeBaseSha, items: [{ status: "modified", newPath: "README.md", binary: false, submodule: false, before: "old", after: "new" }] } });
    const issue = { id: 900, iid: 71, projectId: 100, webUrl: "https://gitlab.example.test/luban/luban-studio/-/issues/71" };
    const mergeRequest = { iid: 88, sourceProjectId: 101, targetProjectId: 100, webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88" };
    const calls: string[] = [];
    let issueInput: GitLabCreateIssueInput | undefined;
    let mrInput: GitLabCreateMergeRequestSubmissionInput | undefined;
    const remote = { createIssue: async (input: GitLabCreateIssueInput) => { calls.push("issue.create"); issueInput = input; return { value: issue, requestId: "issue-request" }; }, createMergeRequestSubmission: async (input: GitLabCreateMergeRequestSubmissionInput) => { calls.push("merge-request.create"); mrInput = input; return { value: mergeRequest, requestId: "mr-request" }; } };
    return { request, snapshot, bundle, plan, releaseTag: "templates-v1.2.0", cliVersion: "1.2.3", sourceBranch: "feature/fast", targetBranch: "develop", now: new Date("2026-11-10T16:01:00Z"), remote, calls, issue, mergeRequest, get issueInput() { return issueInput; }, get mrInput() { return mrInput; } };
}
test("submits a new current-user Issue then a complete response-only MR without reads", async () => {
    const f = await fixture();
    const guarded: unknown[] = [];
    const result = await service.createSubmission({ ...f, assertNoCredentialExposure: value => guarded.push(value) });
    assert.deepEqual(f.calls, ["issue.create", "merge-request.create"]);
    assert.deepEqual(result, { issue: f.issue, mergeRequest: f.mergeRequest, verification: "creation-response", operations: f.calls });
    assert.deepEqual(f.issueInput!.assigneeIds, [30]);
    assert.equal(f.issueInput!.dueDate, "2026-11-11");
    assert.match(f.issueInput!.description, /30/);
    assert.match(f.issueInput!.description, /2026-11-11/);
    assert.deepEqual([...f.issueInput!.labelNames!].sort(), ["priority::p2", "type::doc"]);
    assert.deepEqual([...f.mrInput!.labelNames].sort(), ["priority::p2", "status::review", "type::doc"]);
    assert.deepEqual(f.mrInput!.assigneeIds, [10]);
    assert.deepEqual(f.mrInput!.reviewerIds, [20]);
    assert.match(f.mrInput!.description, /Closes #71/);
    assert.match(f.mrInput!.description, /linked Issue snapshot is unavailable/);
    assert.equal(f.mrInput!.description.includes("harness-mrtool:v1"), false);
    assert.equal(marker.isSubmissionDescription(f.mrInput!.description), true);
    assert.ok(guarded.length >= 4);
    assert.equal(JSON.stringify(guarded).includes("candidate:reviewer-bob"), false);
    await service.createSubmission(f);
    assert.deepEqual(f.calls, ["issue.create", "merge-request.create", "issue.create", "merge-request.create"]);
});
test("submission marker requires a bounded valid identity at EOF", () => {
    const body = marker.appendSubmissionMarker("Body\n", { cliVersion: "1.2.3", issueIid: 71, targetProjectPath: "luban/luban-studio", sourceHeadSha: "a".repeat(40) });
    assert.equal(marker.isSubmissionDescription(body), true);
    assert.equal(marker.isSubmissionDescription(body + "after"), false);
    assert.equal(marker.isSubmissionDescription(body + body), false);
    assert.equal(marker.isSubmissionDescription(body + "\n"), false);
    assert.equal(marker.isSubmissionDescription("<!-- harness-mrtool:submission:v1 forged -->\n"), false);
    assert.equal(marker.isSubmissionDescription("x".repeat(100) + "<!-- harness-mrtool:submission:v1 " + "a".repeat(3000) + " -->\n"), false);
    assert.throws(() => marker.appendSubmissionMarker("Body", { cliVersion: "1", issueIid: 0, targetProjectPath: "x/y", sourceHeadSha: "a".repeat(40) }));
});
for (const phase of ["issue", "mr"] as const)
    for (const kind of ["auth", "validation", "unknown", "unexpected", "malformed"] as const) {
        test(phase + " " + kind + " stops once and reports only safe known state", async () => {
            const f = await fixture();
            const failure = kind === "auth" ? new RemoteMutationError("rejected", "auth") : kind === "validation" ? new RemoteMutationError("rejected", "validation") : kind === "unknown" ? new RemoteMutationError("unknown", "timeout") : new Error("glpat-NEVER_EXPOSE_SECRET");
            const remote: Pick<GitLabClient, "createIssue" | "createMergeRequestSubmission"> = { ...f.remote };
            if (phase === "issue")
                remote.createIssue = async () => { f.calls.push("issue.create"); if (kind === "malformed")
                    return { value: { ...f.issue, iid: 0 }, requestId: null }; throw failure; };
            else
                remote.createMergeRequestSubmission = async () => { f.calls.push("merge-request.create"); if (kind === "malformed")
                    return { value: { ...f.mergeRequest, targetProjectId: 999 }, requestId: null }; throw failure; };
            let error: unknown;
            try {
                await service.createSubmission({ ...f, remote });
                assert.fail("must stop");
            }
            catch (e) {
                error = e;
            }
            const known = kind === "auth" || kind === "validation";
            assert.equal((error as ToolError).code, known ? (phase === "issue" ? (kind === "auth" ? "AUTH_ERROR" : "GITLAB_ERROR") : "PARTIAL_WRITE") : "PARTIAL_REMOTE_STATE");
            const receipt = service.getSubmissionFailure(error)!;
            assert.ok(receipt);
            assert.deepEqual(receipt.remoteWrite, { state: known ? (phase === "issue" ? "not-written" : "written") : "unknown", operations: phase === "issue" ? ["issue.create"] : ["issue.create", "merge-request.create"] });
            assert.deepEqual(receipt.data.issue, phase === "issue" ? null : f.issue);
            assert.equal(receipt.data.command, "create");
            assert.equal(receipt.data.mode, "issue-first");
            assert.equal(f.calls.length, phase === "issue" ? 1 : 2);
            assert.equal(JSON.stringify(receipt).includes("NEVER_EXPOSE"), false);
            assert.match((error as ToolError).details.safeNextStep, /stopped|Stopped/);
            assert.match((error as ToolError).details.safeNextStep, /no automatic retry/i);
        });
    }
test("invalid lifecycle and invalid rendering fail before any write", async () => {
    const f = await fixture();
    await assert.rejects(service.createSubmission({ ...f, snapshot: { ...f.snapshot, mergeRequest: { ...f.snapshot.mergeRequest, iid: 1, lifecycle: "ready" } } }));
    assert.equal(f.calls.length, 0);
    await assert.rejects(service.createSubmission({ ...f, request: { ...f.request, changes: { ...f.request.changes, summary: ["## injected"] } } }));
    assert.equal(f.calls.length, 0);
    assert.equal(service.getSubmissionFailure(new ToolError("PARTIAL_WRITE", "untrusted", { field: null, expected: null, actual: null, safeNextStep: "stop" })), null);
});
test("local failure after known Issue preserves Issue and does not claim an MR attempt", async () => {
    const f = await fixture();
    let failed = false;
    const remote = { ...f.remote, createIssue: async (input: GitLabCreateIssueInput) => { const r = await f.remote.createIssue(input); failed = true; return r; } };
    let error: unknown;
    try {
        await service.createSubmission({ ...f, remote, assertNoCredentialExposure: value => { if (failed && typeof value === "object" && value !== null && "description" in value)
                throw new Error("unsafe outbound"); } });
    }
    catch (e) {
        error = e;
    }
    assert.equal((error as ToolError).code, "PARTIAL_WRITE");
    const receipt = service.getSubmissionFailure(error)!;
    assert.deepEqual(receipt.remoteWrite, { state: "written", operations: ["issue.create"] });
    assert.deepEqual(receipt.data.issue, f.issue);
    assert.equal(f.calls.length, 1);
});
test("unsafe response identity is withheld when credential guard rejects it", async () => {
    const f = await fixture();
    const unsafe = { ...f.issue, webUrl: "https://glpat-NEVER_EXPOSE_SECRET.example.test/luban/luban-studio/-/issues/71" };
    const remote = { ...f.remote, createIssue: async () => { f.calls.push("issue.create"); return { value: unsafe, requestId: null }; } };
    let error: unknown;
    try {
        await service.createSubmission({ ...f, remote, assertNoCredentialExposure: value => { if (JSON.stringify(value).includes("NEVER_EXPOSE_SECRET"))
                throw new Error("unsafe"); } });
    }
    catch (e) {
        error = e;
    }
    const failure = service.getSubmissionFailure(error)!;
    assert.equal((error as ToolError).code, "PARTIAL_REMOTE_STATE");
    assert.equal(failure.remoteWrite.state, "unknown");
    assert.equal(failure.data.issue, null);
    assert.equal(JSON.stringify(failure).includes("NEVER_EXPOSE_SECRET"), false);
    assert.deepEqual(f.calls, ["issue.create"]);
});

test("invalid submission marker context is rejected before creating an Issue", async () => {
  const f = await fixture();
  await assert.rejects(service.createSubmission({ ...f, cliVersion: "invalid version" }));
  assert.deepEqual(f.calls, []);
});

for (const field of ["sourceBranch", "cliVersion"] as const) {
  test("unsafe known " + field + " is rejected before the first POST", async () => {
    const f = await fixture();
    await assert.rejects(service.createSubmission({
      ...f,
      [field]: field === "sourceBranch" ? "feature/glpat-NEVER_EXPOSE_SECRET" : "glpat-NEVER_EXPOSE_SECRET",
      assertNoCredentialExposure: value => {
        if (JSON.stringify(value).includes("glpat-NEVER_EXPOSE_SECRET")) throw new Error("unsafe known outbound value");
      },
    }));
    assert.deepEqual(f.calls, []);
  });
}

test("preflights the full static MR payload and marker context without an invented Issue IID", async () => {
  const f = await fixture();
  const preflight: unknown[] = [];
  await service.createSubmission({
    ...f,
    assertNoCredentialExposure: value => {
      if (f.calls.length === 0) preflight.push(value);
    },
  });
  const checked = preflight.find((value): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && "sourceBranch" in value);
  assert.ok(checked, "the complete known MR payload must be guarded before Issue creation");
  assert.deepEqual(checked, {
    title: f.plan.desired.title,
    description: checked.description,
    sourceProjectId: 101,
    sourceBranch: "feature/fast",
    targetProjectId: 100,
    targetProjectPath: "luban/luban-studio",
    targetBranch: "develop",
    squash: f.plan.desired.squash,
    removeSourceBranch: f.plan.desired.removeSourceBranch,
    labelNames: f.mrInput!.labelNames,
    assigneeIds: [10],
    reviewerIds: [20],
    submissionMarker: {
      cliVersion: "1.2.3",
      targetProjectPath: "luban/luban-studio",
      sourceHeadSha: f.snapshot.sourceHeadSha,
    },
  });
  assert.equal(typeof checked.description, "string");
  assert.equal(JSON.stringify(checked).includes("issueIid"), false);
});
