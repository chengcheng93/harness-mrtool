import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

async function setup(t: test.TestContext) {
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

  const transport = new RealGitLabelTransport(sourceSha, targetSha, sourceBranch);
  const client = new GitLabClient({ origin: transport.origin, tokenProvider: async () => "real-git-test-token", transport });
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  raw.intent = "draft";
  raw.targetBranch = "main";
  raw.workItem = { relation: "none", noIssueReason: "A self-contained comparison boundary correction." };
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
  async function issue() {
    const result = await run(["context"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const context = result.json.data;
    raw.contextId = context.contextId;
    const users = context.userCandidates as { kind: string; username: string; token: string }[];
    raw.mergeRequest.assigneeCandidateToken = users.find((candidate) => candidate.kind === "assignee" && candidate.username === "author")!.token;
    raw.review.reviewerCandidateTokens = [users.find((candidate) => candidate.kind === "reviewer" && candidate.username === "reviewer")!.token];
  }
  return { git, sourceSha, targetSha, transport, commands, raw, run, issue };
}

// Regresses wiring readChangeSet to the path-only reader: a plausible request
// title cannot supply the missing committed before/after evidence.
test("real default Git adapter derives three bug labels and verifies HTTP readback", async (t) => {
  const f = await setup(t);
  await f.issue();
  const result = await f.run(["create"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.data.mandatoryLabels.names, ["type::bug", "priority::p2", "status::doing"]);
  assert.deepEqual((f.transport.mr!.labels as { name: string }[]).map((label) => label.name).sort(),
    ["priority::p2", "status::doing", "type::bug"]);
  assert.equal(f.transport.mr!.sha, f.sourceSha);
  assert.match(String(f.transport.mr!.title), /^Draft: \[fix\]/u);
  const verified = await f.run(["verify", "88", "--level", "structure"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
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
  assert.deepEqual(dry.json.data.mandatoryLabels.names, ["type::bug", "priority::p2", "status::doing"]);
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

for (const drift of ["HEAD", "tracking", "worktree"] as const) {
  test(`real default Git gate rejects actual ${drift} drift after preflight before any HTTP mutation`, async (t) => {
    const f = await setup(t);
    await f.issue();
    let changed = false;
    f.transport.beforeFind = async () => {
      if (drift === "HEAD") {
        await f.git.git(["update-ref", "HEAD", f.targetSha]);
        await f.git.git(["reset", "--hard", f.targetSha]);
        assert.equal(await f.git.head(), f.targetSha);
      } else if (drift === "tracking") {
        await f.git.git(["update-ref", "refs/remotes/origin/main", f.sourceSha]);
        assert.equal(await f.git.targetHead(), f.sourceSha);
      } else {
        await f.git.write("src/boundary.ts", "if (attempts > max) { return false; }\n");
        assert.match(await f.git.git(["status", "--porcelain"]), / M src\/boundary\.ts/u);
      }
      changed = true;
    };
    const result = await f.run(["create"]);
    assert.ok(changed, "the change must occur after planning, at open-MR lookup");
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /CONCURRENT_UPDATE/u);
    assert.deepEqual(f.transport.writes, []);
    assert.equal(f.transport.mr, null);
  });
}
