import { seedHistoricalMr } from "../helpers/seed-historical-mr.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { VerificationReceiptStore } from "../../src/platform/verification-receipt-store.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import packageMetadata from "../../package.json" with { type: "json" };
import { RemoteMutationError } from "../../src/app/remote-outcome.ts";
import { getContext } from "../../src/app/get-context.ts";
import { DEFAULT_LABEL_POOL } from "../../src/app/label-defaults.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createProductionReadOnlyDefaults } from "../../src/cli/production-runtime.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { CandidateContextStore } from "../../src/context/store.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";
import type { GitLabMergeRequest, GitLabUpdateMergeRequestInput, GitLabMilestone, GitLabCreateIssueInput, GitLabCreateMergeRequestSubmissionInput } from "../../src/gitlab/types.ts";
import type { RepositorySnapshot } from "../../src/git/repository.ts";
import { runProductionMain } from "../../src/production-main.ts";

const root = resolve(import.meta.dirname, "../..");
const sourceSha = "b".repeat(40), targetSha = "a".repeat(40);
const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: test.TestContext) {
  const stateDirectory = await mkdtemp(resolve(await realpath(tmpdir()), "mrtool-default-write-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const hash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  const currentBundle = { bundle, bundleManifestHash: hash, releaseSetId: `embedded:${hash}`, releaseTag: `templates-v${bundle.manifest.version}` };
  const user = { id: "42", globalId: "gid://gitlab/User/42", username: "author", displayName: "Author", state: "active" as const, accessLevel: 40 };
  const reviewer = { ...user, id: "43", globalId: "gid://gitlab/User/43", username: "reviewer", displayName: "Reviewer" };
  const project = { id: "7", fullPath: "group/project", defaultBranch: "develop", webUrl: "https://gitlab.example.test/group/project" };
  const labels = DEFAULT_LABEL_POOL.map((name, index) => ({ restId: index + 1, globalId: `gid://gitlab/ProjectLabel/${index + 1}`, name,
    description: name, color: "#123456", archived: false, scopeKind: "project" as const, scopeId: "7", scopePath: project.fullPath }));
  const state: { mr: GitLabMergeRequest | null; writes: string[]; drift: boolean; omitP2: boolean; wrongReadback: boolean; driftOnFind: boolean; driftAfterCreate: boolean; renameAfterFind: boolean; sourceMissing: boolean; sourceMissingOnFind: boolean; dirtyOnFind: boolean; fastIssueReject: boolean; fastMrReject: boolean; fastStarted: boolean; driftAfterConsume: boolean; driftAfterLabels: boolean; duplicateAfterFields: boolean } = {
    mr: null, writes: [], drift: false, omitP2: false, wrongReadback: false, driftOnFind: false, driftAfterCreate: false, renameAfterFind: false, sourceMissing: false, sourceMissingOnFind: false, dirtyOnFind: false, fastIssueReject: false, fastMrReject: false, fastStarted: false, driftAfterConsume: false, driftAfterLabels: false, duplicateAfterFields: false,
  };
  const milestoneState = { candidates: [{id:91,title:"next",state:"active",dueDate:"2026-11-13"}] as GitLabMilestone[], fail:false, consumed:0, nowCalls:0, issueInput:null as GitLabCreateIssueInput | null, mrInput:null as GitLabCreateMergeRequestSubmissionInput | null };
  const calls = { milestones:0, mergeRequest: 0, mergeRequestReceipt: 0, inventory: 0, users: 0, review: 0, projects: 0, discover: 0, pushPlans: 0, diff: 0 };
  const guardConcurrency = { armed: false, rejectPush: false, diffSettled: false,
    pushRejected: deferred(), diffEntered: deferred(), releaseDiff: deferred() };
  let receiptSequence = 0;
  const receipt = <T>(value: T) => ({ value, requestId: `request-${++receiptSequence}` });
  const applied = (ids: readonly string[]) => ids.map((id) => {
    const label = labels.find((value) => value.globalId === id)!;
    return { restId: label.restId, name: label.name, archived: false };
  });
  const client = {
    origin: "https://gitlab.example.test", audit: () => ({ requestIds: ["request-test"] }),
    listProjectMilestones: async (projectId: string) => { calls.milestones++; assert.equal(projectId,"7"); assert.equal(state.fastStarted,false); if(milestoneState.fail) throw new Error("milestone read unavailable"); return milestoneState.candidates; },
    getProject: async () => { calls.projects++; return project; }, getBranchHead: async () => targetSha,
    getCurrentUser: async () => user, listUsers: async () => { calls.users++; return [user, reviewer]; },
    labelInventory: async () => { calls.inventory++; const effective = labels.filter((label) => !state.omitP2 || label.name !== "priority::p2"); return { all: effective, effective, audit: { requestIds: ["request-test"] } }; },
    getReviewState: async () => { calls.review++; return { approvedUserIds: [reviewer.id], unresolvedDiscussions: 0 }; },
    getMergeRequest: async () => { calls.mergeRequest++; return structuredClone(state.mr!); },
    getMergeRequestReceipt: async () => { calls.mergeRequestReceipt++; return receipt(structuredClone(state.mr!)); },
    listOpenMergeRequestReceipts: async () => {
      if (state.driftOnFind) state.drift = true;
      if (state.sourceMissingOnFind) state.sourceMissing = true;
      if (state.dirtyOnFind) (repo.worktree as { clean: boolean }).clean = false;
      if (state.renameAfterFind) labels.find((label) => label.name === "priority::p2")!.name = "priority::p1";
      return receipt(state.mr === null ? [] : [structuredClone(state.mr)]);
    },
    createIssue: async (input: GitLabCreateIssueInput) => {
      milestoneState.issueInput = input;
      state.fastStarted = true; state.writes.push("issue.create");
      assert.deepEqual(input.assigneeIds, [42]);
      assert.match(input.dueDate, /^\d{4}-\d{2}-\d{2}$/u);
      if (state.fastIssueReject) throw new RemoteMutationError("rejected", "validation");
      return receipt({ id: 1001, iid: 41, projectId: 7, webUrl: project.webUrl + "/-/issues/41" });
    },
    createMergeRequestSubmission: async (input: GitLabCreateMergeRequestSubmissionInput) => {
      milestoneState.mrInput = input;
      state.writes.push("merge-request.create");
      if (state.fastMrReject) throw new RemoteMutationError("rejected", "validation");
      assert.match(input.description, /Closes #41/u);
      assert.equal(input.labelNames.length, 3);
      assert.deepEqual(input.assigneeIds, [42]); assert.deepEqual(input.reviewerIds, [43]);
      return receipt({ iid: 88, webUrl: project.webUrl + "/-/merge_requests/88", sourceProjectId: 7, targetProjectId: 7 });
    },
    createMergeRequest: async () => { throw new Error("Legacy MR-only creation must never be reached"); },
    mutateLabels: async (_target: unknown, _iid: number, ids: readonly string[], mode: string) => {
      state.writes.push(`labels:${mode}`);
      if (!state.wrongReadback) state.mr = { ...state.mr!, labels: mode === "ADD"
        ? [...state.mr!.labels.filter((label) => !applied(ids).some((value) => value.restId === label.restId)), ...applied(ids)]
        : state.mr!.labels.filter((label) => !applied(ids).some((value) => value.restId === label.restId)) };
      if (state.driftAfterLabels) state.drift = true;
      return receipt(null);
    },
    updateMergeRequest: async (_target: unknown, _iid: number, input: GitLabUpdateMergeRequestInput) => {
      state.writes.push(input.kind);
      state.mr = input.kind === "description" ? { ...state.mr!, description: input.description }
        : { ...state.mr!, title: input.title, draft: input.title.startsWith("Draft:"), targetBranch: input.targetBranch,
          assignees: input.assigneeIds.map((id) => id === 42 ? user : reviewer), reviewers: input.reviewerIds.map((id) => id === 42 ? user : reviewer),
          squash: input.squash, shouldRemoveSourceBranch: input.removeSourceBranch };
      if (state.duplicateAfterFields && input.kind === "managed-fields") {
        const original = labels.find((label) => label.name === "status::review")!;
        labels.push({ ...original, restId: 999, globalId: "gid://gitlab/ProjectLabel/999" });
      }
      return receipt(structuredClone(state.mr));
    },
  } as unknown as GitLabClient;
  for (const method of ["listProjectMilestones", "getProject", "getBranchHead", "getCurrentUser", "listUsers", "labelInventory", "getReviewState", "getMergeRequest", "getMergeRequestReceipt", "listOpenMergeRequestReceipts"] as const) {
    const port = client[method] as (...args: unknown[]) => Promise<unknown>;
    (client as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      assert.equal(state.fastStarted, false, "fast submission must not read GitLab after its first POST: " + method);
      return port(...args);
    };
  }
  const repo = { gitlabHost: "gitlab.example.test", sourceBranch: "feature/labels", sourceHeadSha: sourceSha, sourceProject: { host: "gitlab.example.test", path: project.fullPath },
    targetProject: { host: "gitlab.example.test", path: project.fullPath }, targetBranch: "develop", sourceRemote: "origin", sourceRemoteRef: "refs/heads/feature/labels",
    targetRemote: "origin", targetRef: "refs/remotes/origin/develop", targetRefSha: targetSha,
    worktree: { clean: true, staged: false, unstaged: false, untracked: false } } as unknown as RepositorySnapshot;
  const diff = { sourceHeadSha: sourceSha, targetRefSha: targetSha, mergeBaseSha: targetSha,
    items: [{ status: "modified" as const, newPath: "src/a.ts", oldPath: "src/a.ts", binary: false, submodule: false, before: "if (a > 0) return a;", after: "if (a >= 0) return a;" }] };
  const repository = { discover: async () => { calls.discover++; return repo; }, readChangeSet: async () => {
      calls.diff++;
      if (guardConcurrency.rejectPush) {
        guardConcurrency.diffEntered.resolve();
        await guardConcurrency.releaseDiff.promise;
        guardConcurrency.diffSettled = true;
      }
      return { ...diff, sourceHeadSha: state.drift ? "c".repeat(40) : sourceSha };
    },
    planPush: async () => {
      calls.pushPlans++;
      if (guardConcurrency.rejectPush) {
        guardConcurrency.pushRejected.resolve();
        throw new Error("Injected push-plan rejection after candidate consumption");
      }
      return ({ kind: state.sourceMissing ? "missing" as const : "up-to-date" as const, remote: "origin", ref: repo.sourceRemoteRef, sourceHeadSha: sourceSha, remoteSha: state.sourceMissing ? null : sourceSha, command: state.sourceMissing ? `git push --no-force origin ${sourceSha}:${repo.sourceRemoteRef}` : null }); } };
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  raw.workItem = { relation: "new" };
  raw.mergeRequest.labelCandidateTokens = [];
  const contextStore = new CandidateContextStore({ stateDirectory, windowsAclVerifier: allowTestAcl });
  const resolveCandidates = contextStore.resolve.bind(contextStore);
  contextStore.resolve = async (input) => {
    if(input.consume) milestoneState.consumed++;
    const result = await resolveCandidates(input);
    if (input.consume && state.driftAfterConsume) state.drift = true;
    if (input.consume && guardConcurrency.armed) guardConcurrency.rejectPush = true;
    return result;
  };
  const overrides = { now: () => { milestoneState.nowCalls++; return new Date("2026-11-11T23:55:00Z"); }, stateDirectory, windowsAclVerifier: allowTestAcl, contextStore, repository, stdinIsTerminal: () => false,
    inputIo: { statFile: async () => ({ size: Buffer.byteLength(JSON.stringify(raw)) }), readFile: async () => Buffer.from(JSON.stringify(raw)), stdin: { async *[Symbol.asyncIterator]() {} } },
    targetSessionResolver: { resolve: async () => ({ origin: client.origin, gitlab: client, project, identity: { host: "gitlab.example.test", path: project.fullPath }, targetRemote: "origin", assertNoCredentialExposure: () => {} }) } };
  const defaults = createProductionReadOnlyDefaults({ ...overrides, cliVersion: packageMetadata.version, cwd: root, currentBundle, contextIssueIid: null });
  let lastContext: Awaited<ReturnType<typeof getContext>>;
  async function issue(iid: number | null = null, migrate = false) {
    const invocation = parseCliInvocation(["context", ...(iid === null ? [] : ["--mr", String(iid)]), ...(migrate ? ["--migrate-template"] : []), "--output", "json"]);
    const planned = await defaults.planner.prepare({ cliVersion: packageMetadata.version, command: "context", currentBundle, cwd: root, invocation, request: null, contextIssueIid: null });
    const context = await getContext({ ...planned.options, store: contextStore });
    lastContext = context;
    raw.contextId = context.contextId;
    // Tokens come from the real private context store, not synthetic placeholders.
    const issued = context as unknown as { userCandidates: { kind: string; token: string; username: string }[] };
    raw.mergeRequest.assigneeCandidateToken = issued.userCandidates.find((value) => value.kind === "assignee" && value.username === "author")!.token;
    raw.review.reviewerCandidateTokens = [issued.userCandidates.find((value) => value.kind === "reviewer" && value.username === "reviewer")!.token];
  }
  async function seed() {
    raw.workItem = { relation: "none", noIssueReason: "Historical maintenance MR." };
    await issue();
    const seeded = seedHistoricalMr({ request: normalizeAndValidateRequest(raw),
      initialSnapshot: lastContext.snapshot, resolvedCandidates: [
        { kind: "assignee", userId: user.id, globalId: user.globalId, username: user.username, displayName: user.displayName },
        { kind: "reviewer", userId: reviewer.id, globalId: reviewer.globalId, username: reviewer.username, displayName: reviewer.displayName },
      ], bundle, releaseTag: currentBundle.releaseTag, cliVersion: packageMetadata.version,
      sourceBranch: repo.sourceBranch, gitlabOrigin: client.origin, labelDiff: diff });
    const mr = seeded.current;
    state.mr = { iid: mr.iid, webUrl: mr.webUrl, title: mr.title, description: mr.description,
      draft: false, state: "opened", sourceProjectId: mr.sourceProjectId, sourceBranch: mr.sourceBranch,
      targetProjectId: mr.targetProjectId, targetBranch: mr.targetBranch, sha: mr.sourceHeadSha,
      author: user, assignees: mr.assigneeUserId === null ? [] : [user],
      reviewers: mr.reviewerUserIds.length === 0 ? [] : [reviewer], labels: applied(mr.labelIds),
      squash: mr.squash, shouldRemoveSourceBranch: mr.removeSourceBranch, pipelineStatus: "passed" };
    await new VerificationReceiptStore({ stateDirectory, windowsAclVerifier: allowTestAcl }).stageAuthenticated(seeded.receipt!);
  }
  async function run(args: string[]) {
    let stdout = "", stderr = "";
    const code = await runProductionMain([...args, ...(args[0] === "verify" ? [] : ["--input", "request.json"]), "--output", "json"], {
      cwd: root, loadCurrentBundle: async () => currentBundle, readOnlyDefaults: overrides,
      updatePreflight: { run: async () => {} } as never,
      stdout: { write: (text) => { stdout += text; return true; } }, stderr: { write: (text) => { stderr += text; return true; } },
    });
    return { code, stdout, stderr };
  }
  return { issue, seed, run, state, raw, calls, milestoneState, guardConcurrency, resetCalls: () => { for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0; } };
}

// These exercise the default production adapter and transaction, not a fake
// readCurrentBinding implementation. The ACL adapter matches the existing
// production-default-label-flow fixture; native ACL behavior has its own tests.
test("default update rejects canonical-diff drift after candidate consumption before its first mutation", async (t) => {
  const f = await setup(t);
  await f.seed();
  await f.issue(88);
  const before = f.state.writes.length;
  f.state.driftAfterConsume = true;
  const result = await f.run(["update", "88"]);
  assert.equal(f.state.drift, true, "the injection must occur during candidate consumption");
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(f.state.writes.slice(before), [], "the first update mutation must not reach transport");
  assert.match(result.stdout, /CONCURRENT_UPDATE/);
});

test("default guards reject later local drift after historical label synchronization", async (t) => {
  const f = await setup(t); await f.seed();
  f.state.mr = { ...f.state.mr!, labels: [] };
  await f.issue(88); f.state.driftAfterLabels = true;
  const result = await f.run(["update", "88"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(f.state.writes, ["labels:ADD"], "fields/description writes must not follow drift");
});
test("default readback rejects a new duplicate lifecycle label even when applied IDs are unchanged", async (t) => {
  const f = await setup(t);
  await f.seed(); await f.issue(88);
  f.state.duplicateAfterFields = true;
  const result = await f.run(["update", "88"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(f.state.writes, ["managed-fields"]);
  assert.equal(f.state.mr!.labels.some((label) => label.restId === 999), false,
    "the newly ambiguous duplicate lifecycle label must remain unapplied in this regression");
  assert.equal(f.state.mr!.labels.filter((label) => label.name === "status::review").length, 1,
    "the originally applied lifecycle label must stay applied");
});

test("default historical update keeps inventory/member/review reads and mutation guards live", async (t) => {
  const f = await setup(t);
  await f.seed(); await f.issue(88);
  f.resetCalls();
  const result = await f.run(["update", "88"]);
  assert.equal(result.code, 0, result.stdout);
  assert.ok(f.calls.mergeRequestReceipt > 0, "the real remote must perform standalone MR reads");
  assert.ok(f.calls.mergeRequest > 0, "existing-MR ownership guards retain independent live discovery");
  t.diagnostic(JSON.stringify({ apiCalls: f.calls }));
  assert.equal(f.calls.pushPlans, f.calls.discover, "every repository discovery retains push-plan verification");
  assert.ok(f.calls.pushPlans >= f.state.writes.length, "every mutation retains a write guard");
  assert.ok(f.calls.inventory >= f.calls.mergeRequestReceipt, "each readback still discovers the live label inventory");
  assert.ok(f.calls.users >= f.calls.mergeRequestReceipt, "each readback still discovers current project members");
  assert.ok(f.calls.review >= f.calls.mergeRequestReceipt, "each existing-MR readback still discovers approvals/discussions");
  assert.equal(f.state.mr!.draft, false, "the tool only creates normal (non-Draft) merge requests");
});

test("default dry-run preserves candidate tokens for the later real submission", async (t) => {
  const f = await setup(t);
  await f.issue();
  const dry = await f.run(["create", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stdout);
  assert.deepEqual(f.state.writes, []);
  const created = await f.run(["create"]);
  assert.equal(created.code, 0, created.stdout);
});

test("default stored verification still refreshes inventory, members and review state", async (t) => {
  const f = await setup(t);
  await f.seed();
  f.resetCalls();
  const verified = await f.run(["verify", "88", "--level", "structure"]);
  assert.equal(verified.code, 0, verified.stdout);
  assert.ok(f.calls.inventory > 0);
  assert.ok(f.calls.users > 0);
  assert.ok(f.calls.review > 0);
});


test("default write guard drains the concurrent diff read before reporting a rejected push plan", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  await f.seed();
  await f.issue(88);
  const before = f.state.writes.length;
  const gate = f.guardConcurrency;
  gate.armed = true;
  let commandSettled = false;
  let result: Awaited<ReturnType<typeof f.run>> | undefined;
  const command = f.run(["update", "88"]).finally(() => { commandSettled = true; });
  try {
    const reached = await Promise.race([
      Promise.all([gate.pushRejected.promise, gate.diffEntered.promise]).then(() => "concurrent-checks"),
      command.then((value) => "command-finished: " + value.stdout),
    ]);
    assert.equal(reached, "concurrent-checks", "both checks must start at the first write-time guard");
    // Let a fail-fast rejection traverse the adapter/domain promise chain. This
    // is an event-loop boundary, not a duration-based race against a timer.
    await nextEventLoopTurn();
    assert.equal(gate.diffSettled, false);
    assert.equal(commandSettled, false, "command cleanup must not race an in-flight repository read");
    assert.deepEqual(f.state.writes.slice(before), []);
  } finally {
    gate.releaseDiff.resolve();
    result = await command;
  }
  assert.equal(gate.diffSettled, true);
  assert.notEqual(result!.code, 0, result!.stdout);
  assert.match(result!.stdout, /CONCURRENT_UPDATE/);
  assert.deepEqual(f.state.writes.slice(before), []);
});


test("new default submission sends only Issue and MR POSTs without readback", async (t) => {
 const f = await setup(t); await f.issue(); f.raw.workItem = { relation: "new" }; f.resetCalls();
 const result = await f.run(["create"]); assert.equal(result.code, 0, result.stdout + result.stderr);
 const out = JSON.parse(result.stdout); assert.equal(out.ok, true); assert.equal(out.data.verification, "creation-response");
 assert.equal(out.data.webUrl, "https://gitlab.example.test/group/project/-/merge_requests/88");
 assert.equal(out.data.issue.iid, 41); assert.deepEqual(f.state.writes, ["issue.create", "merge-request.create"]);
 assert.equal(f.calls.mergeRequestReceipt, 0); assert.equal(f.calls.mergeRequest, 0);
 t.diagnostic(JSON.stringify({ preWriteReads:f.calls }));
 assert.equal(f.calls.inventory, 1, "new submit must not reload labels twice");
 assert.equal(f.calls.users, 1, "new submit must not reload members twice");
});
test("fast submission stops on Issue rejection without sending MR", async (t) => {
 const f = await setup(t); await f.issue(); f.raw.workItem = { relation: "new" }; f.state.fastIssueReject = true;
 const result = await f.run(["create"]); assert.notEqual(result.code, 0); const out = JSON.parse(result.stdout);
 assert.equal(out.ok, false); assert.deepEqual(f.state.writes, ["issue.create"]); assert.equal(out.remoteWrite.state, "not-written");
});
test("fast submission reports known Issue when MR fails and never retries", async (t) => {
 const f = await setup(t); await f.issue(); f.raw.workItem = { relation: "new" }; f.state.fastMrReject = true;
 const result = await f.run(["create"]); assert.equal(result.code, 6); const out = JSON.parse(result.stdout);
 assert.equal(out.code, "PARTIAL_WRITE"); assert.equal(out.data.issue.iid, 41);
 assert.equal(out.data.issue.webUrl, "https://gitlab.example.test/group/project/-/issues/41");
 assert.deepEqual(f.state.writes, ["issue.create", "merge-request.create"]); assert.equal(out.remoteWrite.state, "written");
});
test("fast dry-run creates neither Issue nor MR", async (t) => {
 const f = await setup(t); await f.issue(); f.raw.workItem = { relation: "new" };
 const result = await f.run(["create", "--dry-run"]); assert.equal(result.code, 0, result.stdout); assert.deepEqual(f.state.writes, []);
});

for (const [name, args] of [["upsert", ["create", "--upsert"]], ["resume", ["create", "--resume", "88", "--resume-from", "original.json"]]] as const) {
 test("new Issue mode rejects " + name + " before remote writes", async (t) => {
  const f=await setup(t); await f.issue(); f.raw.workItem={relation:"new"};
  const result=await f.run([...args]); assert.notEqual(result.code,0); assert.equal(JSON.parse(result.stdout).code,"INPUT_ERROR"); assert.deepEqual(f.state.writes,[]);
 });
}
test("fast submission rejects candidate-consumption drift before Issue creation", async (t) => {
 const f=await setup(t); await f.issue(); f.raw.workItem={relation:"new"}; f.state.driftAfterConsume=true;
 const result=await f.run(["create"]); assert.notEqual(result.code,0); assert.equal(JSON.parse(result.stdout).code,"CONCURRENT_UPDATE"); assert.deepEqual(f.state.writes,[]);
});
test("fast submission requires the selected source SHA to be published before Issue creation", async (t) => {
 const f=await setup(t); await f.issue(); f.raw.workItem={relation:"new"}; f.state.sourceMissing=true;
 const result=await f.run(["create"]); assert.notEqual(result.code,0); assert.equal(JSON.parse(result.stdout).code,"REPOSITORY_ERROR"); assert.deepEqual(f.state.writes,[]);
});


test("fast default freezes Shanghai date once and supplies the same selected milestone on both POSTs",async(t)=>{
 const f=await setup(t);await f.issue();f.raw.workItem={relation:"new"};f.resetCalls();
 const result=await f.run(["create"]);assert.equal(result.code,0,result.stdout);
 assert.equal(f.milestoneState.nowCalls,1);assert.equal(f.calls.milestones,1);
 assert.equal(f.milestoneState.issueInput!.dueDate,"2026-11-12");
 assert.equal(f.milestoneState.issueInput!.milestoneId,91);assert.equal(f.milestoneState.mrInput!.milestoneId,91);
 assert.deepEqual(JSON.parse(result.stdout).data.milestoneSelection,{submissionDate:"2026-11-12",reason:"nearest-future",milestone:{id:91,title:"next",dueDate:"2026-11-13"}});
});
test("milestone read failure stops before candidate consumption and permits a later explicit attempt",async(t)=>{
 const f=await setup(t);await f.issue();f.raw.workItem={relation:"new"};f.milestoneState.fail=true;
 const failed=await f.run(["create"]);assert.notEqual(failed.code,0);assert.deepEqual(f.state.writes,[]);assert.equal(f.milestoneState.consumed,0);
 f.milestoneState.fail=false;const success=await f.run(["create"]);assert.equal(success.code,0,success.stdout);assert.equal(f.milestoneState.consumed,1);
});
test("empty milestones produce structured omission in default submission",async(t)=>{
 const f=await setup(t);await f.issue();f.raw.workItem={relation:"new"};f.milestoneState.candidates=[];
 const result=await f.run(["create"]);assert.equal(result.code,0,result.stdout);
 assert.equal(Object.hasOwn(f.milestoneState.issueInput!,"milestoneId"),false);assert.equal(Object.hasOwn(f.milestoneState.mrInput!,"milestoneId"),false);
 assert.equal(JSON.parse(result.stdout).data.milestoneSelection.reason,"no-future-milestone");
});
test("rejected legacy and dry-run paths do not prefetch milestones",async(t)=>{
 const f=await setup(t);await f.issue();f.milestoneState.fail=true;
 f.raw.workItem={relation:"none",noIssueReason:"Historical request"};
 const legacy=await f.run(["create","--dry-run"]);assert.notEqual(legacy.code,0);assert.match(legacy.stdout,/INPUT_ERROR/);
 f.raw.workItem={relation:"new"};const dry=await f.run(["create","--dry-run"]);assert.equal(dry.code,0,dry.stdout);
 assert.equal(f.calls.milestones,0);assert.equal(f.milestoneState.nowCalls,0);assert.deepEqual(f.state.writes,[]);
});
