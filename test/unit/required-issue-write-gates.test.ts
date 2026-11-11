import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createMergeRequest, type MergeRequestRemote } from "../../src/app/create-mr.ts";
import { valueReceipt } from "../../src/app/remote-receipt.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createMergeRequestCommandAdapter } from "../../src/cli/commands/merge-request.ts";
import { createDefaultWriteServices } from "../../src/cli/default-write-services.ts";
import type { ReadOnlyCommandDependencies } from "../../src/cli/commands/readonly.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { GitLabClient } from "../../src/gitlab/client.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";

const root = resolve(import.meta.dirname, "../..");
async function fixture() {
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  const sr = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-snapshot.json"), "utf8"));
  raw.mergeRequest.labelCandidateTokens = [];
  raw.mergeRequest.assigneeCandidateToken = null;
  raw.review.reviewerCandidateTokens = [];
  sr.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p2" },
    { id: "gid://gitlab/ProjectLabel/50", name: "status::review" },
  ];
  sr.mergeRequest = { ...sr.mergeRequest, iid: null, lifecycle: "new", labelIds: [], assigneeUserId: null, reviewerUserIds: [] };
  const snapshot = validateExternalContextSnapshot(sr);
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const currentBundle = { bundle, bundleManifestHash: "a".repeat(64), releaseSetId: "embedded:test", releaseTag: "templates-v1.2.0" };
  return { raw, snapshot, bundle, currentBundle };
}

for (const relation of ["none", "closes", "related"] as const) {
  test("new create rejects explicit " + relation + " before planning or capability consumption", async () => {
    const f = await fixture();
    f.raw.workItem = relation === "none" ? { relation, noIssueReason: "Historical documentation change" } : { relation, iid: 51 };
    let planned = 0;
    const readOnly = { requestSource: { read: async () => f.raw }, planner: { prepare: async () => { planned++; throw new Error("planner must not run"); } } } as unknown as Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
    const service = createDefaultWriteServices({ options: { cliVersion: "test", cwd: root, contextIssueIid: null, currentBundle: f.currentBundle }, currentBundle: f.currentBundle, readOnly });
    await assert.rejects(async () => service.create!(parseCliInvocation(["create", "--input", "request.json"])), (e: unknown) => isToolError(e, "INPUT_ERROR"));
    assert.equal(planned, 0);
  });
}

test("new create rejects upsert before request collection, planning, or capability consumption", async () => {
  const f = await fixture();
  let reads = 0, planned = 0, resolved = 0;
  const readOnly = {
    requestSource: { read: async () => { reads++; throw new Error("wizard must not run"); } },
    planner: { prepare: async () => { planned++; throw new Error("planner must not run"); } },
    contextStore: { resolve: async () => { resolved++; throw new Error("candidates must not be consumed"); } },
  } as unknown as Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
  const service = createDefaultWriteServices({ options: { cliVersion: "test", cwd: root, contextIssueIid: null, currentBundle: f.currentBundle }, currentBundle: f.currentBundle, readOnly });
  await assert.rejects(async () => service.create!(parseCliInvocation(["create", "--upsert"])), (e: unknown) => isToolError(e, "INPUT_ERROR"));
  assert.equal(reads, 0);
  assert.equal(planned, 0);
  assert.equal(resolved, 0);
});

for (const upsert of [false, true]) {
  test("legacy domain cannot create after an empty lookup, upsert=" + upsert, async () => {
    const f = await fixture();
    let creates = 0;
    const remote = { findOpen: async () => valueReceipt([], "lookup"), create: async () => { creates++; throw new Error("legacy create must not run"); } } as unknown as MergeRequestRemote;
    await assert.rejects(() => createMergeRequest({ request: normalizeAndValidateRequest(f.raw), initialSnapshot: f.snapshot, resolvedCandidates: [], bundle: f.bundle, releaseTag: "templates-v1.2.0", cliVersion: "test", sourceBranch: "feature/test", remote, gitlabOrigin: "https://gitlab.example.test", verificationReceiptWriter: {} as never, labelDiff: bugLabelDiff(f.snapshot), upsert }), (e: unknown) => isToolError(e, "INPUT_ERROR"));
    assert.equal(creates, 0);
  });
}

test("legacy adapter requires an authenticated resume before preparation", async () => {
  let prepared = 0;
  const adapter = createMergeRequestCommandAdapter({ gitlabOrigin: "https://gitlab.example.test", readCurrentBinding: async () => { throw new Error("unused"); }, candidateStore: { resolve: async () => { throw new Error("unused"); } }, verifyLiveCandidateIdentities: async () => {}, verificationReceiptWriter: { stageAuthenticated: async () => { throw new Error("unused"); } }, verificationReceiptLoader: { loadVerified: async () => { throw new Error("unused"); } }, historicalBundleLoader: { loadVerifiedExact: async () => { throw new Error("unused"); } } } as never);
  await assert.rejects(() => adapter.create({ upsert: false, prepare: async () => { prepared++; throw new Error("prepare must not run"); } }), (e: unknown) => isToolError(e, "INPUT_ERROR"));
  assert.equal(prepared, 0);
});

test("legacy GitLab MR creator rejects before credentials, capabilities, or transport", async () => {
  let calls = 0;
  const client = new GitLabClient({ origin: "https://gitlab.example.test", tokenProvider: async () => { calls++; return "unused"; }, transport: { request: async () => { calls++; throw new Error("transport must not run"); } } });
  await assert.rejects(() => client.createMergeRequest({ id: "100", fullPath: "a/b" }, { title: "title", description: "body", sourceBranch: "feature/test", targetBranch: "develop", sourceProjectId: 100, targetProjectId: 100, squash: false, removeSourceBranch: false }), (e: unknown) => isToolError(e, "INPUT_ERROR"));
  assert.equal(calls, 0);
});
