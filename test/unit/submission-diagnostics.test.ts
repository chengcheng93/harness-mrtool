import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runProductionMain } from "../../src/production-main.ts";
import { createSubmission, getSubmissionFailure } from "../../src/app/create-submission.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import { DEFAULT_LABEL_POOL } from "../../src/app/label-defaults.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { GitLabClient } from "../../src/gitlab/client.ts";
import type { GitLabHttpRequest } from "../../src/gitlab/http.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";

const root = resolve(import.meta.dirname, "../..");
const secret = "opaque-active-credential-canary";
async function fixture(status: number | "network" | "timeout", body: unknown, phase = "mr", requestId = "req-rejected", summaryCanary?: string) {
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  raw.title.type = "docs"; raw.workItem = { relation: "new" }; raw.mergeRequest.labelCandidateTokens = [];
  const sr = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-snapshot.json"), "utf8"));
  sr.targetProject.id = "100"; sr.sourceProject.id = "101"; sr.sourceProject.path = "author/luban-studio";
  sr.issue = { kind: "none" }; sr.userCandidates.forEach((u: {id: string}) => u.id = u.id.replace("user:", ""));
  sr.labelCandidates = DEFAULT_LABEL_POOL.map((name, i) => ({id: String(i + 1), name}));
  sr.mergeRequest = {...sr.mergeRequest, iid: null, lifecycle: "new", authorUserId: "30", labelIds: [], assigneeUserId: null, reviewerUserIds: []};
  sr.review.qualifiedReviewerUserIds = ["20"];
  const snapshot = validateExternalContextSnapshot(sr), request = normalizeAndValidateRequest(raw);
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const resolvedCandidates = [{kind: "assignee" as const, globalId: null, userId: "10", username: "alice", displayName: "Alice Zhang"}, {kind: "reviewer" as const, globalId: null, userId: "20", username: "bob", displayName: "Bob Chen"}];
  const plan = buildWritePlan({request, snapshot, bundle, resolvedCandidates, labelDiff: {sourceHeadSha: snapshot.sourceHeadSha, targetRefSha: snapshot.targetRefSha, mergeBaseSha: snapshot.mergeBaseSha, items: [{status: "modified", newPath: "README.md", binary: false, submodule: false, before: "old", after: "new"}]}});
  const calls: GitLabHttpRequest[] = [];
  const remote = new GitLabClient({origin: "https://gitlab.example.test", tokenProvider: async () => secret, transport: {async request(input) {
    calls.push(input);
    if (phase === "mr" && calls.length === 1) return {status: 201, headers: {"x-request-id": "req-issue"}, body: new TextEncoder().encode(JSON.stringify({id: 900, iid: 71, project_id: 100, web_url: "https://gitlab.example.test/luban/luban-studio/-/issues/71"}))};
    if (status === "network" || status === "timeout") {const error = new Error(secret); if (status === "timeout") error.name = "AbortError"; throw error;}
    return {status, headers: {"x-request-id": requestId}, body: body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body))};
  }}});
  let error: unknown;
  try {await createSubmission({request, snapshot, plan, bundle, remote, releaseTag: "templates-v1.2.0", cliVersion: "0.1.12", sourceBranch: "feature/fast", targetBranch: "develop", now: new Date("2026-11-12T00:00:00Z"), assertNoCredentialExposure(value) {if (JSON.stringify(value).toLowerCase().includes(secret.toLowerCase()) || (typeof value === "string" && summaryCanary !== undefined && value.includes(summaryCanary))) throw new Error("credential exposure");}});} catch (caught) {error = caught;}
  const failure = getSubmissionFailure(error);
  assert.ok(failure);
  assert.equal(JSON.stringify({error, failure}).includes(secret), false);
  assert.deepEqual(calls.map(c => c.method), phase === "mr" ? ["POST", "POST"] : ["POST"]);
  return {error, failure};
}
for (const status of [400, 409]) test("MR HTTP " + status + " preserves safe duplicate diagnostic and known Issue", async () => {
  const message = "Another open merge request already exists for this source branch: !28";
  const {failure} = await fixture(status, {message: [message]});
  assert.deepEqual(failure.data.diagnostic, {status, reason: status === 409 ? "conflict" : "validation", requestId: "req-rejected", message});
  assert.equal((failure.data.issue as {iid: number}).iid, 71);
  assert.deepEqual(failure.remoteWrite, {state: "written", operations: ["issue.create", "merge-request.create"]});
});
test("Issue auth rejection retains HTTP evidence and never attempts MR", async () => {
  const {failure} = await fixture(403, {message: "403 Forbidden"}, "issue");
  assert.deepEqual(failure.data.diagnostic, {status: 403, reason: "auth", requestId: "req-rejected", message: "403 Forbidden"});
  assert.equal(failure.data.issue, null);
  assert.equal(failure.remoteWrite.state, "not-written");
});
for (const reason of ["network", "timeout"] as const) test(reason + " keeps unknown outcome with no invented HTTP status", async () => {
  const {failure} = await fixture(reason, {});
  assert.deepEqual(failure.data.diagnostic, {status: null, reason, requestId: null, message: null});
  assert.equal(failure.remoteWrite.state, "unknown");
});
for (const message of [secret, "glpat-other-secret-canary", "Authorization: Bearer abcdefghijk", "github_pat_other_secret_canary"]) test("unsafe GitLab error message is omitted: " + message.slice(0, 8), async () => {
  const {failure} = await fixture(400, {message}, "mr", "req-" + secret);
  assert.deepEqual(failure.data.diagnostic, {status: 400, reason: "validation", requestId: null, message: null});
  assert.equal(JSON.stringify(failure).includes(message), false);
});
for (const body of [new Uint8Array([255]), new TextEncoder().encode("<html>bad gateway</html>"), new TextEncoder().encode('{"message":"one","message":"two"}'), {message: "x".repeat(20_000)}]) test("malformed or excessive error body preserves only safe HTTP evidence: " + (body instanceof Uint8Array ? body.length : 20000), async () => {
  const {failure} = await fixture(422, body);
  assert.deepEqual(failure.data.diagnostic, {status: 422, reason: "validation", requestId: "req-rejected", message: null});
});
test("long valid GitLab messages are bounded", async () => {
  const {failure} = await fixture(400, {message: "x".repeat(1000)});
  assert.equal((failure.data.diagnostic as {message: string}).message.length, 512);
});

test("a malformed 2xx acknowledgement retains known HTTP status without claiming success", async () => {
  const {failure} = await fixture(200, {unexpected: true});
  assert.deepEqual(failure.data.diagnostic, {status: 200, reason: "server", requestId: "req-rejected", message: null});
  assert.equal(failure.data.outcome, "unknown");
  assert.equal(failure.remoteWrite.state, "unknown");
});

test("text CLI shows the safe HTTP diagnostic and known Issue URL", async () => {
  const {error} = await fixture(400, {message: "Another open merge request already exists for this source branch: !28"});
  let stdout = "", stderr = "";
  const code = await runProductionMain(["create"], {
    updatePreflight: {run: async () => {throw error;}},
    stdout: {write: text => {stdout += text; return true;}},
    stderr: {write: text => {stderr += text; return true;}},
  });
  assert.equal(code, 6);
  assert.equal(stdout, "");
  assert.match(stderr, /HTTP 400/u);
  assert.match(stderr, /Another open merge request already exists/u);
  assert.match(stderr, /request-id req-rejected/u);
  assert.match(stderr, /issues\/71/u);
  assert.equal(stderr.includes(secret), false);
});

test("a credential formed only by the text summary falls back without losing safe diagnostic fields", async () => {
  const canary = "HTTP 400; validation; request-id req-rejected";
  const {error, failure} = await fixture(400, {message: "MR creation was refused"}, "mr", "req-rejected", canary);
  assert.equal((error as Error).message, "Issue-first submission stopped");
  assert.deepEqual(failure.data.diagnostic, {status: 400, reason: "validation", requestId: "req-rejected", message: "MR creation was refused"});
  assert.equal((error as Error).message.includes(canary), false);
});
