import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { readCanonicalChangeSet } from "../../src/git/change-set.ts";
import {
  assertCleanWorktree,
  discoverRepository,
  runGitChecked,
} from "../../src/git/repository.ts";
import {
  GitRunner,
  nodeProcessRunner,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from "../../src/git/runner.ts";
import {
  executeSourceBranchPush,
  planSourceBranchPush,
  type SourceBranchPushPlan,
} from "../../src/git/push-plan.ts";
import { GitFixture } from "../helpers/git-fixture.ts";

async function fixtureFor(t: TestContext): Promise<GitFixture> {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  return fixture;
}

class RecordingProcessRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return nodeProcessRunner.run(request);
  }
}

type PushFault = "post-read-fails" | "post-read-other" | "timeout-after-write";

class FaultingPushRunner implements ProcessRunner {
  private lsRemoteCount = 0;

  constructor(
    private readonly fault: PushFault,
    private readonly otherSha: string | null = null,
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.arguments[0] === "ls-remote") {
      this.lsRemoteCount += 1;
      if (this.lsRemoteCount === 3 && this.fault === "post-read-fails") {
        return {
          exitCode: 1,
          signal: null,
          stderr: Buffer.from("simulated readback failure\n"),
          stdout: Buffer.alloc(0),
          timedOut: false,
        };
      }
      if (this.lsRemoteCount === 3 && this.fault === "post-read-other") {
        assert.notEqual(this.otherSha, null);
        return {
          exitCode: 0,
          signal: null,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(
            `${this.otherSha}\trefs/heads/feature/task7\n`,
          ),
          timedOut: false,
        };
      }
    }
    const result = await nodeProcessRunner.run(request);
    if (request.arguments[0] === "push" && this.fault === "timeout-after-write") {
      return { ...result, exitCode: null, timedOut: true };
    }
    return result;
  }
}

test("GitRunner always invokes git with an argv array and shell disabled", async () => {
  const requests: ProcessRequest[] = [];
  const processRunner: ProcessRunner = {
    async run(request) {
      requests.push(request);
      return {
        exitCode: 0,
        signal: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("git version fixture\n"),
        timedOut: false,
      };
    },
  };
  const runner = new GitRunner("C:\\fixture", processRunner, {
    environment: { GIT_ATTR_NOSYSTEM: "0", GIT_TERMINAL_PROMPT: "1" },
  });

  const result = await runner.run(["--version"]);

  assert.equal(result.stdout.toString("utf8"), "git version fixture\n");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.executable, "git");
  assert.deepEqual(requests[0]?.arguments, ["--version"]);
  assert.equal(requests[0]?.shell, false);
  assert.equal(requests[0]?.environment.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(requests[0]?.environment.GIT_TERMINAL_PROMPT, "0");
});

test("Git command failures are stable repository errors without stderr secrets", async () => {
  const processRunner: ProcessRunner = {
    async run() {
      return {
        exitCode: 128,
        signal: null,
        stderr: Buffer.from("fatal: credential-canary must not escape\n"),
        stdout: Buffer.alloc(0),
        timedOut: false,
      };
    },
  };

  await assert.rejects(
    runGitChecked(new GitRunner("C:\\fixture", processRunner), ["status"], "fixture"),
    (error: unknown) =>
      isToolError(error, "REPOSITORY_ERROR") &&
      !JSON.stringify(error.details).includes("credential-canary"),
  );
});

test("repository discovery records branch, HEAD, target ref SHA, and dirty state", async (t) => {
  const fixture = await fixtureFor(t);
  const expectedHead = await fixture.head();
  const expectedTarget = await fixture.targetHead();
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });

  assert.equal(repository.sourceBranch, "feature/task7");
  assert.equal(repository.sourceRemote, "origin");
  assert.equal(repository.sourceHeadSha, expectedHead);
  assert.equal(repository.targetRef, "refs/remotes/origin/main");
  assert.equal(repository.targetRefSha, expectedTarget);
  assert.equal(repository.worktree.clean, true);

  await fixture.write("untracked.txt", "dirty\n");
  await assert.rejects(
    assertCleanWorktree(repository),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /clean worktree/i),
  );

  await fixture.remove("untracked.txt");
  await fixture.rename("src/rename-old.ts", "src/rename-staged.ts");
  await fixture.git(["add", "--all"]);
  const stagedRename = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  assert.equal(stagedRename.worktree.clean, false);
  assert.equal(stagedRename.worktree.staged, true);
});

test("repository discovery rejects revision syntax masquerading as a target branch", async (t) => {
  const fixture = await fixtureFor(t);

  await assert.rejects(
    discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main~0",
    }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /invalid target branch/i),
  );
});

test("canonical ChangeSet parses NUL diff records for A/M/D/R, binary, and submodule", async (t) => {
  const fixture = await fixtureFor(t);
  const processRunner = new RecordingProcessRunner();
  const targetSha = await fixture.targetHead();
  await fixture.write("src/added.ts", "export const added = true;\n");
  await fixture.write("src/modified.ts", "export const value = 2;\n");
  await fixture.remove("src/deleted.ts");
  await fixture.rename("src/rename-old.ts", "src/rename-new.ts");
  await fixture.write("assets/blob.bin", new Uint8Array([0, 1, 2, 3, 0, 255]));
  await fixture.addSubmodule();
  const sourceSha = await fixture.commitAll("representative change set");
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });

  const first = await readCanonicalChangeSet(repository);
  const second = await readCanonicalChangeSet(repository);

  await fixture.write(".gitattributes", "*.ts binary\n");
  const withDirtyAttributes = await readCanonicalChangeSet(repository);

  assert.equal(first.targetRefSha, targetSha);
  assert.equal(first.mergeBaseSha, targetSha);
  assert.equal(first.sourceHeadSha, sourceSha);
  assert.deepEqual(first, second);
  assert.deepEqual(withDirtyAttributes, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items), true);
  const diffCommands = processRunner.requests.filter((request) =>
    request.arguments.includes("diff")
  );
  assert.notEqual(diffCommands.length, 0);
  assert.equal(
    diffCommands.every((request) => {
      const index = request.arguments.indexOf("diff.renameLimit=0");
      return index > 0 && request.arguments[index - 1] === "-c";
    }),
    true,
  );
  assert.deepEqual(
    first.items.find((item) => item.status === "added" && item.newPath === "src/added.ts"),
    { status: "added", newPath: "src/added.ts", binary: false, submodule: false },
  );
  assert.deepEqual(
    first.items.find((item) => item.status === "modified" && item.newPath === "src/modified.ts"),
    { status: "modified", newPath: "src/modified.ts", binary: false, submodule: false },
  );
  assert.deepEqual(
    first.items.find((item) => item.status === "deleted" && item.oldPath === "src/deleted.ts"),
    { status: "deleted", oldPath: "src/deleted.ts", binary: false, submodule: false },
  );
  assert.deepEqual(
    first.items.find((item) => item.status === "renamed"),
    {
      status: "renamed",
      oldPath: "src/rename-old.ts",
      newPath: "src/rename-new.ts",
      binary: false,
      submodule: false,
    },
  );
  assert.deepEqual(
    first.items.find((item) => item.status === "added" && item.newPath === "assets/blob.bin"),
    { status: "added", newPath: "assets/blob.bin", binary: true, submodule: false },
  );
  assert.deepEqual(
    first.items.find((item) => item.status === "added" && item.newPath === "vendor/dependency"),
    { status: "added", newPath: "vendor/dependency", binary: false, submodule: true },
  );
});

test("canonical ChangeSet rejects repository-local attribute overrides", async (t) => {
  await t.test("non-empty info attributes", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/added.ts", "export const added = true;\n", "add source");
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
    await fixture.write(".git/info/attributes", "*.ts binary\n");

    await assert.rejects(
      readCanonicalChangeSet(repository),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /attributes/i),
    );
  });

  await t.test("configured core.attributesFile", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/added.ts", "export const added = true;\n", "add source");
    await fixture.write("custom.attributes", "*.ts binary\n");
    await fixture.git([
      "config",
      "core.attributesFile",
      `${fixture.worktreePath}/custom.attributes`,
    ]);
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });

    await assert.rejects(
      readCanonicalChangeSet(repository),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /attributes/i),
    );
  });
});

test("canonical ChangeSet ignores default user attributes", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/added.ts", "export const added = true;\n", "add source");
  const xdgRoot = resolve(fixture.root, "xdg-config");
  await mkdir(resolve(xdgRoot, "git"), { recursive: true });
  await writeFile(resolve(xdgRoot, "git", "attributes"), "*.ts binary\n");
  const discovered = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  const repository = {
    ...discovered,
    runner: new GitRunner(fixture.worktreePath, nodeProcessRunner, {
      environment: { XDG_CONFIG_HOME: xdgRoot },
    }),
  };

  const changeSet = await readCanonicalChangeSet(repository);

  assert.deepEqual(
    changeSet.items.find((item) => item.status === "added" && item.newPath === "src/added.ts"),
    { status: "added", newPath: "src/added.ts", binary: false, submodule: false },
  );
});

test("repository rejects fetch and push URLs for different GitLab projects", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.git([
    "remote",
    "set-url",
    "origin",
    "https://gitlab.example.test/team/project.git",
  ]);
  await fixture.git([
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://gitlab.example.test/other/project.git",
  ]);

  await assert.rejects(
    discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /fetch|push|identity/i),
  );
});

test("repository normalizes equivalent GitLab fetch and push identities", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.git([
    "remote",
    "set-url",
    "origin",
    "https://GitLab.Example.Test/team/project.git",
  ]);
  await fixture.git([
    "remote",
    "set-url",
    "--push",
    "origin",
    "git@gitlab.example.test:team/project.git",
  ]);

  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });

  assert.equal(repository.gitlabHost, "gitlab.example.test");
  assert.deepEqual(repository.sourceProject, {
    host: "gitlab.example.test",
    path: "team/project",
  });
  assert.deepEqual(repository.targetProject, repository.sourceProject);
});

test("absent source ref needs authorization and dry-run never writes", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });

  const unauthorizedPlan = await planSourceBranchPush(repository, { allowPush: false });
  assert.equal(unauthorizedPlan.kind, "confirmation-required");
  assert.equal(unauthorizedPlan.relation, "absent");
  const unauthorized = await executeSourceBranchPush(repository, unauthorizedPlan, {
    authorized: false,
  });
  assert.equal(unauthorized.kind, "not-written");
  assert.equal(await fixture.remoteHead(), null);

  const readyPlan = await planSourceBranchPush(repository, { allowPush: true });
  assert.equal(readyPlan.kind, "ready");
  const deniedReadyPlan = await executeSourceBranchPush(repository, readyPlan, {
    authorized: false,
  });
  assert.equal(deniedReadyPlan.kind, "not-written");
  assert.equal(await fixture.remoteHead(), null);

  const dryRunPlan = await planSourceBranchPush(repository, {
    allowPush: true,
    dryRun: true,
  });
  const dryRun = await executeSourceBranchPush(repository, dryRunPlan, {
    authorized: true,
    dryRun: true,
  });
  assert.equal(dryRun.kind, "not-written");
  assert.equal(await fixture.remoteHead(), null);
});

test("equal source ref is a no-op", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/equal.ts", "export const equal = true;\n", "equal");
  await fixture.pushSource();
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });

  const plan = await planSourceBranchPush(repository, { allowPush: true });

  assert.equal(plan.kind, "up-to-date");
  assert.equal(plan.relation, "equal");
});

test("up-to-date execution rechecks the repository and live remote", async (t) => {
  await t.test("remote advanced after planning", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/equal.ts", "export const equal = true;\n", "equal");
    await fixture.pushSource();
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });
    const remoteHead = await fixture.peerCommitAndPush(
      "src/remote-after-plan.ts",
      "export const remoteAfterPlan = true;\n",
    );

    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) => isToolError(error, "CONCURRENT_UPDATE", /remote|SHA|changed/i),
    );
    assert.equal(await fixture.remoteHead(), remoteHead);
  });

  await t.test("worktree became dirty after planning", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/equal.ts", "export const equal = true;\n", "equal");
    await fixture.pushSource();
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });
    await fixture.write("dirty-after-plan.txt", "dirty\n");

    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /clean worktree/i),
    );
  });

  await t.test("local HEAD changed after planning", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/equal.ts", "export const equal = true;\n", "equal");
    await fixture.pushSource();
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });
    await fixture.commitFile("src/local-after-plan.ts", "export const localAfterPlan = true;\n", "local after plan");

    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /changed/i),
    );
  });
});

test("push planning wraps process failures as repository errors", async (t) => {
  const fixture = await fixtureFor(t);
  const processRunner: ProcessRunner = {
    async run(request) {
      if (request.arguments[0] === "ls-remote") {
        throw new RangeError("simulated output overflow");
      }
      return nodeProcessRunner.run(request);
    },
  };
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });

  await assert.rejects(
    planSourceBranchPush(repository, { allowPush: false }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /read.*remote|remote.*read/i),
  );
});

test("behind source ref pushes exactly planned HEAD to the selected branch", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/base.ts", "export const base = true;\n", "source base");
  await fixture.pushSource();
  const beforeSha = await fixture.remoteHead();
  const localHead = await fixture.commitFile(
    "src/next.ts",
    "export const next = true;\n",
    "source next",
  );
  const targetBefore = await fixture.remoteHead("main");
  const processRunner = new RecordingProcessRunner();
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });

  const plan = await planSourceBranchPush(repository, { allowPush: true });
  assert.equal(plan.kind, "ready");
  assert.equal(plan.relation, "behind");
  const result = await executeSourceBranchPush(repository, plan, { authorized: true });

  assert.equal(result.kind, "pushed");
  assert.equal(result.beforeSha, beforeSha);
  assert.equal(result.afterSha, localHead);
  assert.equal(await fixture.remoteHead(), localHead);
  assert.equal(await fixture.remoteHead("main"), targetBefore);
  const pushes = processRunner.requests.filter((request) => request.arguments[0] === "push");
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0]?.arguments, [
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    "origin",
    `${localHead}:refs/heads/feature/task7`,
  ]);
  assert.equal(pushes[0]?.arguments.some((argument) => argument.includes("force")), false);
  assert.equal(pushes[0]?.arguments.includes("--tags"), false);
});

test("remote ahead and diverged source refs are blocked without a push command", async (t) => {
  await t.test("ahead", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/base.ts", "export const base = true;\n", "base");
    await fixture.pushSource();
    await fixture.peerCommitAndPush("src/remote.ts", "export const remote = true;\n");
    await fixture.fetchSource();
    const processRunner = new RecordingProcessRunner();
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      processRunner,
      targetBranch: "main",
    });

    await assert.rejects(
      planSourceBranchPush(repository, { allowPush: true }),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /ahead/i),
    );
    assert.equal(processRunner.requests.some((request) => request.arguments[0] === "push"), false);
  });

  await t.test("diverged", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/base.ts", "export const base = true;\n", "base");
    await fixture.pushSource();
    await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
    await fixture.peerCommitAndPush("src/remote.ts", "export const remote = true;\n");
    await fixture.fetchSource();
    const processRunner = new RecordingProcessRunner();
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      processRunner,
      targetBranch: "main",
    });

    await assert.rejects(
      planSourceBranchPush(repository, { allowPush: true }),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /diverged/i),
    );
    const serialized = JSON.stringify(processRunner.requests.map((request) => request.arguments));
    assert.equal(serialized.includes("--force"), false);
    assert.equal(processRunner.requests.some((request) => request.arguments[0] === "push"), false);
  });
});

test("push execution rechecks cleanliness and reports a rejected remote write", async (t) => {
  await t.test("dirty after planning", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });
    await fixture.write("untracked-after-plan.txt", "dirty\n");

    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /clean worktree/i),
    );
    assert.equal(await fixture.remoteHead(), null);
  });

  await t.test("server rejection", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
    await fixture.rejectPushes();
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });

    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /rejected/i),
    );
    assert.equal(await fixture.remoteHead(), null);
  });
});

test("push execution rejects a tampered plan without writing another ref", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });
  if (plan.kind !== "ready") {
    assert.fail(`Expected a ready push plan, received ${plan.kind}`);
  }
  const tampered: SourceBranchPushPlan = {
    ...plan,
    command: [
      "push",
      "--force",
      "--",
      "origin",
      `${repository.sourceHeadSha}:refs/heads/unrelated`,
    ],
  };

  await assert.rejects(
    executeSourceBranchPush(repository, tampered, { authorized: true }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /plan|command/i),
  );
  assert.equal(await fixture.remoteHead("unrelated"), null);
});

test("push execution rejects a push URL changed after planning before writing", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
  const processRunner = new RecordingProcessRunner();
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });
  const otherRemotePath = resolve(fixture.root, "other-remote.git");
  await fixture.git(["init", "--bare", "--initial-branch=main", otherRemotePath]);
  await fixture.git(["remote", "set-url", "--push", "origin", otherRemotePath]);

  await assert.rejects(
    executeSourceBranchPush(repository, plan, { authorized: true }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /fetch|push|identit/i),
  );
  assert.equal(processRunner.requests.some((request) => request.arguments[0] === "push"), false);
});

test("push execution cannot be redirected after plan validation", async (t) => {
  const fixture = await fixtureFor(t);
  const localHead = await fixture.commitFile(
    "src/local.ts",
    "export const local = true;\n",
    "local",
  );
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });
  if (plan.kind !== "ready" || plan.command === null) {
    assert.fail(`Expected a ready push plan, received ${plan.kind}`);
  }
  const mutableCommand = [...plan.command];
  const mutablePlan: SourceBranchPushPlan = { ...plan, command: mutableCommand };

  const execution = executeSourceBranchPush(repository, mutablePlan, { authorized: true });
  mutableCommand.splice(
    0,
    mutableCommand.length,
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    "origin",
    `${localHead}:refs/heads/unrelated`,
  );
  const result = await execution;

  assert.equal(result.kind, "pushed");
  assert.equal(await fixture.remoteHead(), localHead);
  assert.equal(await fixture.remoteHead("unrelated"), null);
});

test("push execution preserves unknown and concurrent remote outcomes", async (t) => {
  await t.test("timeout after write is synchronized but not reported as a known push", async (t) => {
    const fixture = await fixtureFor(t);
    const localHead = await fixture.commitFile(
      "src/local.ts",
      "export const local = true;\n",
      "local",
    );
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      processRunner: new FaultingPushRunner("timeout-after-write"),
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });

    const result = await executeSourceBranchPush(repository, plan, { authorized: true });

    assert.equal(result.kind, "synchronized-after-unknown");
    assert.equal(result.afterSha, localHead);
    assert.equal(await fixture.remoteHead(), localHead);
  });

  await t.test("failed post-read is partial remote state", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      processRunner: new FaultingPushRunner("post-read-fails"),
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });

    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) => isToolError(error, "PARTIAL_REMOTE_STATE", /read|state/i),
    );
  });

  await t.test("a different post-read SHA is concurrent update", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      processRunner: new FaultingPushRunner("post-read-other", await fixture.targetHead()),
      targetBranch: "main",
    });
    const plan = await planSourceBranchPush(repository, { allowPush: true });

    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) => isToolError(error, "CONCURRENT_UPDATE", /SHA|changed|match/i),
    );
  });
});
