import packageMetadata from "../../package.json" with { type: "json" };
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { CandidateContextStore } from "../../src/context/store.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { VerificationReceiptStore } from "../../src/platform/verification-receipt-store.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";
import { seedHistoricalMr } from "../helpers/seed-historical-mr.ts";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { GitLabClient } from "../../src/gitlab/client.ts";
import { runProductionMain } from "../../src/production-main.ts";
import { GitFixture } from "../helpers/git-fixture.ts";
import { RealGitLabelTransport } from "../helpers/real-git-label-transport.ts";

const root = resolve(import.meta.dirname, "../..");
const sourceBranch = "feature/task7";
const endpoint = "git@gitlab.example.test:group/project.git";
const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });

async function setup(t: test.TestContext, origin = "https://gitlab.example.test") {
  const git = await GitFixture.create();
  t.after(() => git.dispose());
  const stateDirectory = await mkdtemp(resolve(await realpath(tmpdir()), "mrtool-real-git-state-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  await git.commitFile("src/boundary.ts", "if (attempts > max) { return false; }\n", "baseline");
  const targetSha = await git.head();
  await git.git(["push", "origin", "HEAD:refs/heads/main"]);
  await git.git(["update-ref", "refs/remotes/origin/main", targetSha]);
  await git.commitFile("src/boundary.ts", "if (attempts >= max) { return false; }\n", "docs: deliberately misleading title");
  const sourceSha = await git.head();
  await git.git(["push", "origin", `HEAD:refs/heads/${sourceBranch}`]);
  await git.git(["remote", "set-url", "origin", endpoint]);

  // Transport substitution only: leave default repository, GitRunner, discovery,
  // blob reads and push planning intact. Even ls-remote is real Git against the
  // published local bare repository; only its external endpoint is redirected.
  const spawn = childProcess.spawn;
  const commands: string[][] = [];
  t.mock.method(childProcess, "spawn", ((...input: Parameters<typeof spawn>) => {
    const [executable, args, options] = input;
    assert.ok(Array.isArray(args));
    // Durable candidate/receipt stores must retain their real OS lock helpers.
    if (!/^git(?:\.exe)?$/u.test(basename(executable))) return spawn(executable, args, options);
    const command = [...args];
    commands.push(command);
    if (command[0] === "ls-remote") {
      assert.deepEqual(command, ["ls-remote", "--exit-code", "--refs", "--", endpoint, `refs/heads/${sourceBranch}`]);
      command[4] = git.remotePath;
    } else {
      assert.ok(!command.some((arg) => ["push", "fetch", "clone"].includes(arg)), "production must not push or fetch");
      assert.ok(!command.includes(endpoint) || command[0] === "config", "unexpected network command");
    }
    return spawn(executable, command, options);
  }) as typeof spawn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live HTTP is forbidden"); });

  const transport = new RealGitLabelTransport(sourceSha, targetSha, sourceBranch, origin);
  const client = new GitLabClient({ origin: transport.origin, tokenProvider: async () => "real-git-test-token", transport });
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  raw.targetBranch = "main";
  raw.workItem = { relation: "new" };
  raw.mergeRequest.labelCandidateTokens = [];

  async function run(args: string[]) {
    let stdout = "", stderr = "";
    const usesInput = args[0] === "create" || args[0] === "update";
    const inputPath = resolve(stateDirectory, "request.json");
    if (usesInput) await writeFile(inputPath, JSON.stringify(raw), { mode: 0o600 });
    const code = await runProductionMain([...args, ...(usesInput ? ["--input", inputPath] : []), "--output", "json"], {
      cwd: git.worktreePath,
      readOnlyDefaults: {
        stateDirectory,
        windowsAclVerifier: allowTestAcl,
        targetSessionResolver: { resolve: async () => ({
          origin: transport.origin, gitlab: client, project: transport.project,
          identity: { host: "gitlab.example.test", path: transport.project.fullPath }, targetRemote: "origin",
          assertNoCredentialExposure: (value) => assert.ok(!JSON.stringify(value).includes("real-git-test-token")),
        }) },
      },
      updatePreflight: { run: async () => {} } as never,
      stdout: { write: (text) => { stdout += text; return true; } },
      stderr: { write: (text) => { stderr += text; return true; } },
    });
    assert.deepEqual(transport.unexpected, [], stdout + stderr);
    return { code, stdout, stderr, json: JSON.parse(stdout) };
  }
  let lastContext: { contextId: string; binding: import("../../src/context/types.ts").ContextBinding };
  async function issue(iid: number | null = null) {
    const result = await run(["context", ...(iid === null ? [] : ["--mr", String(iid)])]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const context = result.json.data;
    lastContext = context;
    raw.contextId = context.contextId;
    const users = context.userCandidates as { kind: string; username: string; token: string }[];
    raw.mergeRequest.assigneeCandidateToken = users.find((candidate) => candidate.kind === "assignee" && candidate.username === "author")!.token;
    raw.review.reviewerCandidateTokens = [users.find((candidate) => candidate.kind === "reviewer" && candidate.username === "reviewer")!.token];
  }
  async function seed() {
    raw.workItem = { relation: "none", noIssueReason: "Historical comparison boundary correction." };
    await issue();
    const resolved = await new CandidateContextStore({ stateDirectory, windowsAclVerifier: allowTestAcl }).resolve({
      contextId: lastContext.contextId, expectedBinding: lastContext.binding, selections: [
        { kind: "assignee", token: raw.mergeRequest.assigneeCandidateToken },
        { kind: "reviewer", token: raw.review.reviewerCandidateTokens[0] },
      ], consume: false,
    });
    const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
    const seeded = seedHistoricalMr({ request: normalizeAndValidateRequest(raw),
      initialSnapshot: validateExternalContextSnapshot(resolved.snapshot), resolvedCandidates: resolved.candidates,
      bundle, releaseTag: lastContext.binding.bundle.releaseTag, cliVersion: packageMetadata.version,
      sourceBranch, gitlabOrigin: transport.origin,
      labelDiff: { sourceHeadSha: sourceSha, targetRefSha: targetSha, mergeBaseSha: targetSha,
        items: [{ status: "modified", newPath: "src/boundary.ts",
          binary: false, submodule: false, before: "if (attempts > max) { return false; }\n",
          after: "if (attempts >= max) { return false; }\n" }] } });
    const mr = seeded.current;
    transport.mr = { id: 888, iid: 88, project_id: 7, web_url: mr.webUrl,
      title: mr.title, description: mr.description, draft: false, state: "opened",
      source_project_id: 7, source_branch: mr.sourceBranch, target_project_id: 7,
      target_branch: mr.targetBranch, sha: mr.sourceHeadSha,
      author: { id: 42, username: "author", name: "Author", state: "active" },
      assignees: [{ id: 42, username: "author", name: "Author", state: "active" }],
      reviewers: [{ id: 43, username: "reviewer", name: "Reviewer", state: "active" }],
      labels: transport.labels.filter((label) => mr.labelIds.includes("gid://gitlab/ProjectLabel/" + label.id)),
      squash: mr.squash, should_remove_source_branch: mr.removeSourceBranch,
      detailed_merge_status: "mergeable", head_pipeline: { sha: sourceSha, status: "success" } };
    await new VerificationReceiptStore({ stateDirectory, windowsAclVerifier: allowTestAcl }).stageAuthenticated(seeded.receipt!);
  }
  return { git, sourceSha, targetSha, stateDirectory, transport, commands, raw, run, issue, seed };
}

// Regresses wiring readChangeSet to the path-only reader: a plausible request
// title cannot supply the missing committed before/after evidence.
test("real default Git adapter derives three bug labels in Issue-first creation responses", async (t) => {
  const f = await setup(t);
  await f.issue();
  const result = await f.run(["create"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.data.mandatoryLabels.names, ["type::bug", "priority::p2", "status::review"]);
  assert.deepEqual((f.transport.mr!.labels as { name: string }[]).map((label) => label.name).sort(),
    ["priority::p2", "status::review", "type::bug"]);
  assert.equal(f.transport.mr!.sha, f.sourceSha);
  assert.match(String(f.transport.mr!.title), /^\[fix\]/u);
  assert.equal(f.transport.mr!.draft, false);
  assert.equal(result.json.data.verification, "creation-response");
  assert.deepEqual(f.transport.writes, ["issue:create", "create"]);
  assert.match(String(f.transport.mr!.description), /Closes #51/u);
  assert.ok(f.commands.some((args) => args[0] === "cat-file" && args[1] === "blob"));
  assert.ok(f.commands.filter((args) => args[0] === "ls-remote").length >= 2);
});

test("real default Git dry-run writes nothing and leaves its context reusable for create", async (t) => {
  const f = await setup(t);
  await f.issue();
  const contextId = f.raw.contextId;
  const remoteRefs = await f.git.git(["--git-dir", f.git.remotePath, "show-ref"]);
  const dry = await f.run(["create", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.deepEqual(dry.json.data.mandatoryLabels.names, ["type::bug", "priority::p2", "status::review"]);
  assert.equal(dry.json.data.pushPlan.kind, "up-to-date");
  assert.deepEqual(f.transport.writes, []);
  assert.equal(f.transport.mr, null);
  assert.equal(await f.git.git(["--git-dir", f.git.remotePath, "show-ref"]), remoteRefs);
  assert.equal(await f.git.head(), f.sourceSha);
  assert.equal(await f.git.targetHead(), f.targetSha);
  assert.equal((await f.git.git(["status", "--porcelain"])).trim(), "");
  const created = await f.run(["create"]);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.equal(f.raw.contextId, contextId);
});

for (const drift of ["HEAD", "tracking"] as const) {
  test(`real default Git gate rejects actual ${drift} drift after preflight before any HTTP mutation`, async (t) => {
    const f = await setup(t);
    await f.issue();
    let changed = false;
    f.transport.beforeMilestones = async () => {
      if (drift === "HEAD") {
        await f.git.git(["update-ref", "HEAD", f.targetSha]);
        await f.git.git(["reset", "--hard", f.targetSha]);
        assert.equal(await f.git.head(), f.targetSha);
      } else {
        await f.git.git(["update-ref", "refs/remotes/origin/main", f.sourceSha]);
        assert.equal(await f.git.targetHead(), f.sourceSha);
      }
      changed = true;
    };
    const result = await f.run(["create"]);
    assert.ok(changed, "the change must occur after planning, at milestone lookup before the final Git gate");
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.json.code, drift === "HEAD" ? "REPOSITORY_ERROR" : "CONCURRENT_UPDATE");
    assert.deepEqual(f.transport.writes, []);
    assert.equal(f.transport.mr, null);
  });
}

for (const origin of ["https://gitlab.example.test", "http://gitlab.example.test"]) {
test(`${origin} real default Git historical update and stored verify preserve staged, unstaged and untracked local files`, async (t) => {
  const f = await setup(t, origin);
  await f.git.write("src/boundary.ts", "local staged work\n");
  await f.git.git(["add", "src/boundary.ts"]);
  await f.git.write("src/boundary.ts", "local unstaged work\n");
  await f.git.write(".superpowers/progress.md", "untracked local report\n");
  const localState = async () => ({
    status: await f.git.git(["status", "--porcelain"]),
    staged: await f.git.git(["diff", "--cached", "--binary"]),
    unstaged: await f.git.git(["diff", "--binary"]),
    report: await readFile(resolve(f.git.worktreePath, ".superpowers/progress.md"), "utf8"),
  });
  const before = await localState();
  await f.seed();
  const createdDescription = String(f.transport.mr!.description);
  await f.issue(88);
  f.raw.changes.summary = ["Update verification details for the committed boundary correction."];
  const updated = await f.run(["update", "88"]);
  assert.equal(updated.code, 0, updated.stdout + updated.stderr);
  assert.notEqual(f.transport.mr!.description, createdDescription);
  assert.match(String(f.transport.mr!.description), /Update verification details for the committed boundary correction\./u);
  const receiptDirectory = resolve(f.stateDirectory, "verification-receipts");
  const receipts = await Promise.all((await readdir(receiptDirectory))
    .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
    .map(async (name) => JSON.parse(await readFile(resolve(receiptDirectory, name), "utf8"))));
  assert.ok(receipts.length >= 1, "historical update must persist verification receipts");
  for (const { locator, receipt } of receipts) {
    assert.equal(locator.gitlabOrigin, origin);
    assert.equal(receipt.gitlabOrigin, origin);
    assert.equal(receipt.sourceHeadSha, f.sourceSha);
  }
  const writesBeforeVerify = [...f.transport.writes];
  // Every run composes new default services/stores, so verify must reload the
  // receipt from disk rather than inherit an in-memory fixture/update result.
  const verified = await f.run(["verify", "88", "--level", "structure"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.deepEqual(f.transport.writes, writesBeforeVerify);
  assert.equal(f.transport.requests.every((request) => new URL(request.url).origin === origin), true);
  assert.ok(f.transport.requests.some(({ method, path }) => method === "POST" && path === "/api/graphql"));
  assert.ok(f.transport.requests.every(({ method, path }) => method !== "POST" || path !== "/api/v4/projects/7/merge_requests"),
    "an existing historical MR must be updated without a create POST");
  assert.ok(f.transport.requests.some(({ method, path }) => method === "PUT" && path === "/api/v4/projects/7/merge_requests/88"));
  assert.equal(f.transport.mr!.web_url, `${origin}/group/project/-/merge_requests/88`);
  assert.equal(f.transport.mr!.sha, f.sourceSha);
  assert.equal(await f.git.head(), f.sourceSha);
  assert.deepEqual(await localState(), before);
});
}

for (const workItem of ["new", "omitted"] as const) {
  test(`real default Git ${workItem} workItem creates Issue then MR in two HTTP writes and preserves local work`, async (t) => {
    const f = await setup(t);
    if (workItem === "new") f.raw.workItem = { relation: "new" };
    else delete f.raw.workItem;
    await f.git.write("src/boundary.ts", "local staged work\n");
    await f.git.git(["add", "src/boundary.ts"]);
    await f.git.write("src/boundary.ts", "local unstaged work\n");
    await f.git.write(".superpowers/progress.md", "untracked local report\n");
    const localState = async () => ({
      status: await f.git.git(["status", "--porcelain"]),
      staged: await f.git.git(["diff", "--cached", "--binary"]),
      unstaged: await f.git.git(["diff", "--binary"]),
      report: await f.git.read(".superpowers/progress.md"),
      head: await f.git.head(),
      target: await f.git.targetHead(),
      remoteRefs: await f.git.git(["--git-dir", f.git.remotePath, "show-ref"]),
    });
    const before = await localState();
    await f.issue();
    const requestStart = f.transport.requests.length;
    const result = await f.run(["create"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const requests = f.transport.requests.slice(requestStart);
    const issueIndex = requests.findIndex(({ method, path }) => method === "POST" && path.endsWith("/issues"));
    assert.ok(issueIndex >= 0, "new submissions must create an Issue");
    assert.deepEqual(requests.slice(issueIndex).map(({ method, path }) => [method, path]), [
      ["POST", "/api/v4/projects/7/issues"], ["POST", "/api/v4/projects/7/merge_requests"],
    ], "after the first write there must be no readback, PUT, GraphQL or extra POST");
    assert.ok(requests.slice(0, issueIndex).every(({ method, path, body }) => method === "GET" ||
      (method === "POST" && path === "/api/graphql" && /^query\s/u.test(String(body.query)))),
    "requests before Issue creation must be read-only preflight");
    assert.deepEqual(f.transport.writes, ["issue:create", "create"]);
    const issue = requests[issueIndex]!.body;
    const mr = requests[issueIndex + 1]!.body;
    assert.equal(issue.issue_type, "issue");
    assert.deepEqual(issue.assignee_ids, [42]);
    assert.deepEqual(String(issue.labels).split(",").sort(), ["priority::p2", "type::bug"]);
    assert.match(String(issue.description), new RegExp(`阶段日期：${String(issue.due_date)}`));
    assert.match(String(issue.description), new RegExp(`计划日期：${String(issue.due_date)}`));
    assert.equal(mr.source_branch, sourceBranch);
    assert.equal(mr.target_branch, "main");
    assert.equal(mr.target_project_id, 7);
    assert.deepEqual(String(mr.labels).split(",").sort(), ["priority::p2", "status::review", "type::bug"]);
    assert.deepEqual(mr.assignee_ids, [42]);
    assert.deepEqual(mr.reviewer_ids, [43]);
    assert.equal(mr.squash, f.raw.mergeRequest.squash);
    assert.equal(mr.remove_source_branch, f.raw.mergeRequest.removeSourceBranch);
    assert.match(String(mr.description), /Closes #51/u);
    const marker = /<!-- harness-mrtool:submission:v1 ([A-Za-z0-9_-]+) -->/u.exec(String(mr.description));
    assert.ok(marker);
    const identity = JSON.parse(Buffer.from(marker[1]!, "base64url").toString("utf8"));
    assert.equal(identity.sourceHeadSha, before.head);
    assert.equal(identity.issueIid, 51);
    assert.equal(identity.targetProjectPath, f.transport.project.fullPath);
    assert.ok(f.commands.some((args) => args[0] === "cat-file" && args[1] === "blob"));
    assert.ok(f.commands.some((args) => args[0] === "ls-remote"));
    assert.equal(result.json.data.verification, "creation-response");
    assert.equal(result.json.data.webUrl, `${f.transport.project.webUrl}/-/merge_requests/88`);
    assert.equal(result.json.data.issue.webUrl, `${f.transport.project.webUrl}/-/issues/51`);
    assert.deepEqual(await localState(), before);
  });
}
