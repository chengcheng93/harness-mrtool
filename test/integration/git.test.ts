import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { isToolError } from "../../src/contracts/errors.ts";
import { readCanonicalChangeSet } from "../../src/git/change-set.ts";
import {
  assertCleanWorktree,
  discoverRepository,
  runGitChecked,
} from "../../src/git/repository.ts";
import {
  GitRunner,
  type GitRunnerOptions,
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

function isPushRequest(request: ProcessRequest): boolean {
  return request.arguments[0] === "push" || request.arguments[2] === "push";
}

interface HeldWindowsFile {
  readonly child: ChildProcess;
  readonly temporaryRoot: string;
}

async function holdTemporaryViewFile(temporaryRoot: string): Promise<HeldWindowsFile> {
  const lockPath = resolve(temporaryRoot, "cleanup-lock");
  const readyPath = resolve(temporaryRoot, "cleanup-lock-ready");
  await writeFile(lockPath, "locked\n");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$stream=[IO.File]::Open($env:HMR_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);" +
        "[IO.File]::WriteAllText($env:HMR_READY_PATH,'ready');" +
        "try { while ($true) { Start-Sleep -Milliseconds 100 } } finally { $stream.Dispose() }",
    ],
    {
      env: {
        ...process.env,
        HMR_LOCK_PATH: lockPath,
        HMR_READY_PATH: readyPath,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(readyPath);
      return { child, temporaryRoot };
    } catch {
      if (child.exitCode !== null) {
        throw new Error("Temporary-view lock process exited before acquiring the file");
      }
      await delay(25);
    }
  }
  child.kill();
  throw new Error("Timed out acquiring the temporary-view cleanup lock");
}

async function releaseTemporaryViewFile(held: HeldWindowsFile | undefined): Promise<void> {
  if (held === undefined) return;
  const exited = new Promise<void>((resolveExit) => {
    if (held.child.exitCode !== null) {
      resolveExit();
      return;
    }
    held.child.once("exit", () => resolveExit());
  });
  held.child.kill();
  await Promise.race([exited, delay(5_000)]);
  await rm(held.temporaryRoot, { force: true, recursive: true });
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
    if (isPushRequest(request) && this.fault === "timeout-after-write") {
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
  const trustedExecutable = await realpath(process.execPath);
  const runner = new GitRunner("C:\\fixture", processRunner, {
    environment: { GIT_ATTR_NOSYSTEM: "0", GIT_TERMINAL_PROMPT: "1" },
    gitExecutable: trustedExecutable,
  });

  const result = await runner.run(["--version"]);

  assert.equal(result.stdout.toString("utf8"), "git version fixture\n");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.executable, trustedExecutable);
  assert.equal(isAbsolute(requests[0]?.executable ?? ""), true);
  assert.deepEqual(requests[0]?.arguments, ["--version"]);
  assert.equal(requests[0]?.shell, false);
  assert.equal(requests[0]?.environment.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(requests[0]?.environment.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(requests[0]?.environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(requests[0]?.fileIdentityGuards.length, 1);
  assert.equal(
    requests[0]?.fileIdentityGuards[0]?.identity.path,
    trustedExecutable,
  );
  assert.equal(requests[0]?.fileIdentityGuards[0]?.compareContentMetadata, true);
});

test("GitRunner scrubs executable ambient Git transport and prompt hooks", async () => {
  const requests: ProcessRequest[] = [];
  const processRunner: ProcessRunner = {
    async run(request) {
      requests.push(request);
      return {
        exitCode: 0,
        signal: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
        timedOut: false,
      };
    },
  };
  const dangerous = [
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ] as const;
  const trustedExecutable = await realpath(process.execPath);
  const previous = new Map<string, string | undefined>();
  for (const key of dangerous) {
    previous.set(key, process.env[key]);
    process.env[key] = `canary-${key}`;
  }
  try {
    await new GitRunner("C:\\fixture", processRunner, {
      gitExecutable: trustedExecutable,
    }).run(["--version"]);
  } finally {
    for (const key of dangerous) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  assert.equal(requests.length, 1);
  for (const key of dangerous) {
    assert.equal(requests[0]?.environment[key], undefined, key);
  }
});

test("GitRunner does not execute a repository-local git.exe on Windows", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fixture = await fixtureFor(t);
  const systemRoot = process.env.SystemRoot;
  assert.notEqual(systemRoot, undefined);
  await copyFile(
    resolve(systemRoot as string, "System32", "where.exe"),
    resolve(fixture.worktreePath, "git.exe"),
  );
  const processRunner = new RecordingProcessRunner();

  const result = await new GitRunner(fixture.worktreePath, processRunner, {
    environment: {
      PATH: fixture.worktreePath,
      ProgramFiles: fixture.worktreePath,
      ProgramW6432: fixture.worktreePath,
    },
  }).run(["--version"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.toString("utf8"), /^git version /u);
  assert.equal(isAbsolute(processRunner.requests[0]?.executable ?? ""), true);
  assert.notEqual(
    processRunner.requests[0]?.executable.toLowerCase(),
    resolve(fixture.worktreePath, "git.exe").toLowerCase(),
  );
});

test("GitRunner ignores arbitrary absolute PATH entries outside its trusted roots", async (t) => {
  const fixture = await fixtureFor(t);
  const untrustedRoot = resolve(fixture.root, "untrusted-git");
  const trustedRoot = resolve(fixture.root, "trusted-git");
  await mkdir(untrustedRoot);
  await mkdir(trustedRoot);
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  const untrustedExecutable = resolve(untrustedRoot, executableName);
  const trustedExecutable = resolve(trustedRoot, executableName);
  await copyFile(process.execPath, untrustedExecutable);
  await copyFile(process.execPath, trustedExecutable);
  if (process.platform !== "win32") {
    await chmod(untrustedExecutable, 0o755);
    await chmod(trustedExecutable, 0o755);
  }
  const processRunner = new RecordingProcessRunner();
  const options = {
    environment: { PATH: [untrustedRoot, process.env.PATH ?? ""].join(delimiter) },
    trustedGitRoots: [trustedRoot],
  } satisfies GitRunnerOptions;

  await new GitRunner(fixture.worktreePath, processRunner, options).run(["--version"]);

  assert.equal(processRunner.requests[0]?.executable, await realpath(trustedExecutable));
  assert.notEqual(processRunner.requests[0]?.executable, await realpath(untrustedExecutable));
});

test("GitRunner rejects replacement of its resolved executable at the spawn boundary", async (t) => {
  const fixture = await fixtureFor(t);
  const executableRoot = resolve(fixture.root, "replaceable-git");
  const movedRoot = resolve(fixture.root, "original-git");
  await mkdir(executableRoot);
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  const executable = resolve(executableRoot, executableName);
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  let runCount = 0;
  const processRunner: ProcessRunner = {
    async run(request) {
      runCount += 1;
      if (runCount === 2) {
        await rename(executableRoot, movedRoot);
        await mkdir(executableRoot);
        await copyFile(
          process.platform === "win32"
            ? resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
            : process.execPath,
          executable,
        );
        if (process.platform !== "win32") await chmod(executable, 0o755);
      }
      if (runCount === 1) {
        return {
          exitCode: 0,
          signal: null,
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
          timedOut: false,
        };
      }
      return nodeProcessRunner.run(request);
    },
  };
  const runner = new GitRunner(fixture.worktreePath, processRunner, {
    gitExecutable: executable,
  });
  await runner.run(["--version"]);

  await assert.rejects(runner.run(["--version"]), /filesystem identity changed/i);
});

test("GitRunner rejects in-place modification of its resolved executable", async (t) => {
  const fixture = await fixtureFor(t);
  const executableRoot = resolve(fixture.root, "mutable-git");
  await mkdir(executableRoot);
  const executable = resolve(
    executableRoot,
    process.platform === "win32" ? "git.exe" : "git",
  );
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const processRunner: ProcessRunner = {
    async run() {
      return {
        exitCode: 0,
        signal: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
        timedOut: false,
      };
    },
  };
  const runner = new GitRunner(fixture.worktreePath, processRunner, {
    gitExecutable: executable,
  });
  await runner.run(["--version"]);
  await writeFile(executable, "modified executable bytes\n");

  await assert.rejects(runner.run(["--version"]), /filesystem identity changed/i);
});

test("production process runner rejects injected Git executable authority", async (t) => {
  await assert.rejects(
    new GitRunner(process.cwd(), nodeProcessRunner, {
      gitExecutable: process.execPath,
    }).run(["--version"]),
    /test process runner|injected Git executable/i,
  );

  const fixture = await fixtureFor(t);
  const injectedRoot = resolve(fixture.root, "injected-trusted-root");
  await mkdir(injectedRoot);
  const executable = resolve(
    injectedRoot,
    process.platform === "win32" ? "git.exe" : "git",
  );
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  await assert.rejects(
    new GitRunner(fixture.worktreePath, nodeProcessRunner, {
      trustedGitRoots: [injectedRoot],
    }).run(["--version"]),
    /test process runner|trusted Git roots/i,
  );
});

test("repository discovery preserves an explicitly trusted Git executable", async (t) => {
  const fixture = await fixtureFor(t);
  const resolver = new RecordingProcessRunner();
  await new GitRunner(fixture.worktreePath, resolver).run(["--version"]);
  const trustedExecutable = resolver.requests[0]?.executable;
  assert.notEqual(trustedExecutable, undefined);
  const processRunner = new RecordingProcessRunner();

  await discoverRepository({
    cwd: fixture.worktreePath,
    gitRunnerOptions: { gitExecutable: trustedExecutable as string },
    processRunner,
    targetBranch: "main",
  });

  assert.equal(processRunner.requests.length > 0, true);
  assert.equal(
    processRunner.requests.every((request) => request.executable === trustedExecutable),
    true,
  );
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

test("canonical ChangeSet isolates repository-local attribute overrides", async (t) => {
  await t.test("non-empty info attributes", async (t) => {
    const fixture = await fixtureFor(t);
    await fixture.commitFile("src/added.ts", "export const added = true;\n", "add source");
    const repository = await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
    await fixture.write(".git/info/attributes", "*.ts binary\n");

    const changeSet = await readCanonicalChangeSet(repository);

    assert.deepEqual(
      changeSet.items.find((item) => item.status === "added" && item.newPath === "src/added.ts"),
      { status: "added", newPath: "src/added.ts", binary: false, submodule: false },
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

    const changeSet = await readCanonicalChangeSet(repository);

    assert.deepEqual(
      changeSet.items.find((item) => item.status === "added" && item.newPath === "src/added.ts"),
      { status: "added", newPath: "src/added.ts", binary: false, submodule: false },
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

test("canonical ChangeSet ignores repository-local replacement objects", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/replaced.ts", "export const replaced = true;\n", "change");
  const sourceSha = await fixture.head();
  const targetSha = await fixture.targetHead();
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  const expected = await readCanonicalChangeSet(repository);
  const targetTree = (await fixture.git(["rev-parse", `${targetSha}^{tree}`])).trim();
  const replacement = (await fixture.git([
    "commit-tree",
    targetTree,
    "-p",
    targetSha,
    "-m",
    "replacement object",
  ])).trim();
  await fixture.git(["replace", sourceSha, replacement]);

  const actual = await readCanonicalChangeSet(repository);

  assert.deepEqual(actual, expected);
});

test("canonical ChangeSet is isolated from transient repository attributes", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/race.ts", "export const race = true;\n", "race");
  const discovered = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  const expected = await readCanonicalChangeSet(discovered);
  const attributesPath = resolve(fixture.worktreePath, ".git", "info", "attributes");
  let diffStarted = 0;
  let diffCompleted = 0;
  let attributesReadyResolve: (() => void) | undefined;
  const attributesReady = new Promise<void>((resolveReady) => {
    attributesReadyResolve = resolveReady;
  });
  const processRunner: ProcessRunner = {
    async run(request) {
      if (!request.arguments.includes("diff")) {
        return nodeProcessRunner.run(request);
      }
      diffStarted += 1;
      if (diffStarted === 1) {
        await writeFile(attributesPath, "*.ts binary\n");
        attributesReadyResolve?.();
      } else {
        await attributesReady;
      }
      const result = await nodeProcessRunner.run(request);
      diffCompleted += 1;
      if (diffCompleted === 2) {
        await rm(attributesPath);
      }
      return result;
    },
  };
  const repository = {
    ...discovered,
    runner: new GitRunner(fixture.worktreePath, processRunner),
  };

  const actual = await readCanonicalChangeSet(repository);

  assert.equal(diffStarted, 2);
  assert.deepEqual(actual, expected);
});

test("canonical ChangeSet reports a typed temporary-view cleanup failure", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile(
    "src/cleanup-failure.ts",
    "export const cleanupFailure = true;\n",
    "cleanup failure",
  );
  const discovered = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  let held: HeldWindowsFile | undefined;
  let heldPromise: Promise<HeldWindowsFile> | undefined;
  const processRunner: ProcessRunner = {
    async run(request) {
      if (request.arguments.includes("diff")) {
        const gitDirectory = request.environment.GIT_DIR;
        assert.notEqual(gitDirectory, undefined);
        heldPromise ??= holdTemporaryViewFile(dirname(gitDirectory as string));
        held = await heldPromise;
      }
      return nodeProcessRunner.run(request);
    },
  };
  const repository = {
    ...discovered,
    runner: new GitRunner(fixture.worktreePath, processRunner),
  };

  try {
    await assert.rejects(
      readCanonicalChangeSet(repository),
      (error: unknown) =>
        isToolError(error, "REPOSITORY_ERROR", /cleanup|temporary/i) &&
        !JSON.stringify(error.details).includes("EBUSY"),
    );
  } finally {
    await releaseTemporaryViewFile(held);
  }
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

test("repository rejects HTTP credentials before they can enter a push plan", async (t) => {
  const fixture = await fixtureFor(t);
  const credentialCanary = "credential-canary";
  const endpoint = `https://oauth2:${credentialCanary}@gitlab.example.test/team/project.git`;
  await fixture.git(["remote", "set-url", "origin", endpoint]);

  let error: unknown;
  try {
    await discoverRepository({
      cwd: fixture.worktreePath,
      targetBranch: "main",
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(isToolError(error, "REPOSITORY_ERROR", /credential|userinfo|URL/i), true);
  assert.equal(JSON.stringify(error).includes(credentialCanary), false);
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
  const pushes = processRunner.requests.filter(isPushRequest);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0]?.arguments, [
    "-c",
    "push.pushOption=",
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--no-push-option",
    "--recurse-submodules=no",
    "--no-verify",
    "--",
    repository.sourcePushUrl,
    `${localHead}:refs/heads/feature/task7`,
  ]);
  assert.equal(pushes[0]?.arguments.some((argument) => argument.includes("force")), false);
  assert.equal(pushes[0]?.arguments.includes("--tags"), false);
  const pushIndex = processRunner.requests.indexOf(pushes[0] as ProcessRequest);
  const remoteBefore = processRunner.requests
    .slice(0, pushIndex)
    .findLast((request) => request.arguments[0] === "ls-remote");
  const remoteAfter = processRunner.requests
    .slice(pushIndex + 1)
    .find((request) => request.arguments[0] === "ls-remote");
  assert.notEqual(remoteBefore, undefined);
  assert.notEqual(remoteAfter, undefined);
  for (const request of [remoteBefore, pushes[0], remoteAfter]) {
    assert.equal(request?.arguments.includes(repository.sourcePushUrl), true);
    assert.equal(request?.arguments.includes(repository.sourceRemote), false);
    assert.equal(request?.environment.GIT_DIR, pushes[0]?.environment.GIT_DIR);
    assert.equal(request?.environment.GIT_NO_REPLACE_OBJECTS, "1");
  }
  assert.equal(
    processRunner.requests.every((request) =>
      request.environment.GIT_NO_REPLACE_OBJECTS === "1"),
    true,
  );
});

test("push execution disables repository pre-push hooks", async (t) => {
  const fixture = await fixtureFor(t);
  const localHead = await fixture.commitFile(
    "src/local.ts",
    "export const local = true;\n",
    "local",
  );
  await fixture.git(["branch", "unrelated", localHead]);
  const hooksPath = resolve(fixture.root, "hooks");
  await mkdir(hooksPath);
  const hookPath = resolve(hooksPath, "pre-push");
  await writeFile(
    hookPath,
    "#!/bin/sh\ngit push --no-verify origin refs/heads/unrelated:refs/heads/unrelated >/dev/null 2>&1\n",
  );
  await chmod(hookPath, 0o755);
  await fixture.git(["config", "core.hooksPath", hooksPath]);
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  const result = await executeSourceBranchPush(repository, plan, { authorized: true });

  assert.equal(result.kind, "pushed");
  assert.equal(await fixture.remoteHead(), localHead);
  assert.equal(await fixture.remoteHead("unrelated"), null);
});

test("push execution clears configured GitLab push options", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/local.ts", "export const local = true;\n", "local");
  await fixture.git(["config", "push.pushOption", "merge_request.create"]);
  await fixture.git(["--git-dir", fixture.remotePath, "config", "receive.advertisePushOptions", "true"]);
  const receiveHook = resolve(fixture.remotePath, "hooks", "pre-receive");
  await writeFile(
    receiveHook,
    "#!/bin/sh\nprintf '%s\\n' \"$GIT_PUSH_OPTION_COUNT\" \"${GIT_PUSH_OPTION_0-}\" > received-options.txt\n",
  );
  await chmod(receiveHook, 0o755);
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  const result = await executeSourceBranchPush(repository, plan, { authorized: true });

  assert.equal(result.kind, "pushed");
  assert.equal(
    await readFile(resolve(fixture.remotePath, "received-options.txt"), "utf8"),
    "0\n\n",
  );
});

test("local push does not expose credential configuration to child env or hooks", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile("src/no-credential-leak.ts", "export const safe = true;\n", "safe push");
  const credentialCanary = "credential-canary";
  const globalConfig = resolve(fixture.root, "credential-probe.gitconfig");
  await writeFile(
    globalConfig,
    `[credential]\n\thelper = ${credentialCanary}\n[http]\n\textraHeader = Authorization: Bearer ${credentialCanary}\n`,
  );
  const hookPath = resolve(fixture.remotePath, "hooks", "pre-receive");
  await writeFile(
    hookPath,
    `#!/bin/sh\nif env | grep -q '${credentialCanary}' || git config --global --get-regexp '^(credential\\.|http\\.)' 2>/dev/null | grep -q '${credentialCanary}'; then printf leaked > credential-leaked.txt; fi\n`,
  );
  await chmod(hookPath, 0o755);
  const processRunner = new RecordingProcessRunner();
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    gitRunnerOptions: { environment: { GIT_CONFIG_GLOBAL: globalConfig } },
    processRunner,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  await executeSourceBranchPush(repository, plan, { authorized: true });

  const transactionRequests = processRunner.requests.filter((request) =>
    request.arguments[0] === "ls-remote" || isPushRequest(request)
  );
  assert.equal(JSON.stringify(transactionRequests).includes(credentialCanary), false);
  await assert.rejects(readFile(resolve(fixture.remotePath, "credential-leaked.txt"), "utf8"));
});

test("HTTPS transaction scopes auth config without placing secrets in child env", async (t) => {
  const fixture = await fixtureFor(t);
  const endpointCanary = "endpoint-secret-canary";
  const otherCanary = "other-endpoint-canary";
  const unrelatedHttpCanary = "unrelated-http-config-canary";
  const endpoint = "https://gitlab.example.test/team/project.git";
  const globalConfig = resolve(fixture.root, "https-auth.gitconfig");
  await writeFile(
    globalConfig,
    `[credential]\n\thelper = manager\n[http "https://gitlab.example.test/team/"]\n\textraHeader = Authorization: Bearer ${endpointCanary}\n\tuserAgent = ${unrelatedHttpCanary}\n[http "https://other.example.test/"]\n\textraHeader = Authorization: Bearer ${otherCanary}\n`,
  );
  await fixture.git(["remote", "set-url", "origin", endpoint]);
  let scopedConfig = "";
  let credentialConfig = "";
  const processRunner: ProcessRunner = {
    async run(request) {
      if (request.arguments[0] === "ls-remote") {
        assert.equal(JSON.stringify(request.environment).includes(endpointCanary), false);
        assert.equal(JSON.stringify(request.environment).includes(otherCanary), false);
        const authConfigPath = request.environment.GIT_CONFIG_GLOBAL;
        assert.equal(typeof authConfigPath, "string");
        const probe = await nodeProcessRunner.run({
          ...request,
          arguments: [
            "config",
            "--null",
            "--get-urlmatch",
            "http",
            endpoint,
          ],
        });
        assert.equal(probe.exitCode, 0);
        scopedConfig = probe.stdout.toString("utf8");
        const credentialProbe = await nodeProcessRunner.run({
          ...request,
          arguments: [
            "config",
            "--null",
            "--get-urlmatch",
            "credential",
            endpoint,
          ],
        });
        assert.equal(credentialProbe.exitCode, 0);
        credentialConfig = credentialProbe.stdout.toString("utf8");
        return {
          exitCode: 2,
          signal: null,
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
          timedOut: false,
        };
      }
      return nodeProcessRunner.run(request);
    },
  };
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    gitRunnerOptions: { environment: { GIT_CONFIG_GLOBAL: globalConfig } },
    processRunner,
    targetBranch: "main",
  });

  await planSourceBranchPush(repository, { allowPush: false });

  assert.equal(credentialConfig.includes("credential.helper"), true, JSON.stringify(credentialConfig));
  assert.equal(credentialConfig.includes("manager"), true, JSON.stringify(credentialConfig));
  assert.equal(scopedConfig.includes(endpointCanary), true);
  assert.equal(scopedConfig.includes(otherCanary), false);
  assert.equal(scopedConfig.includes(unrelatedHttpCanary), false);
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
    assert.equal(processRunner.requests.some(isPushRequest), false);
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
    assert.equal(processRunner.requests.some(isPushRequest), false);
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
  assert.equal(processRunner.requests.some(isPushRequest), false);
});

test("push execution cannot be redirected at the process spawn boundary", async (t) => {
  const fixture = await fixtureFor(t);
  const localHead = await fixture.commitFile(
    "src/local.ts",
    "export const local = true;\n",
    "local",
  );
  const originalRemotePath = fixture.remotePath;
  const redirectedRemotePath = resolve(fixture.root, "redirected-remote.git");
  await fixture.git(["init", "--bare", "--initial-branch=main", redirectedRemotePath]);
  let redirected = false;
  const processRunner: ProcessRunner = {
    async run(request) {
      if (!redirected && isPushRequest(request)) {
        redirected = true;
        await fixture.git(["remote", "set-url", "origin", redirectedRemotePath]);
      }
      return nodeProcessRunner.run(request);
    },
  };
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  await assert.rejects(
    executeSourceBranchPush(repository, plan, { authorized: true }),
    (error: unknown) =>
      isToolError(error, "CONCURRENT_UPDATE", /repository|remote|changed/i),
  );

  await fixture.git(["remote", "set-url", "origin", originalRemotePath]);
  assert.equal(await fixture.remoteHead(), localHead);
  await fixture.git(["remote", "set-url", "origin", redirectedRemotePath]);
  assert.equal(await fixture.remoteHead(), null);
});

test("push exact endpoint cannot be rewritten by concurrent Git config", async (t) => {
  const fixture = await fixtureFor(t);
  const localHead = await fixture.commitFile(
    "src/local.ts",
    "export const local = true;\n",
    "local",
  );
  const originalRemotePath = fixture.remotePath;
  const originalEndpoint = pathToFileURL(originalRemotePath).href;
  const redirectedRemotePath = resolve(fixture.root, "rewritten-remote.git");
  const redirectedEndpoint = pathToFileURL(redirectedRemotePath).href;
  await fixture.git(["init", "--bare", "--initial-branch=main", redirectedRemotePath]);
  await fixture.git(["remote", "set-url", "origin", originalEndpoint]);
  let redirected = false;
  const processRunner: ProcessRunner = {
    async run(request) {
      if (!redirected && isPushRequest(request)) {
        redirected = true;
        await fixture.git([
          "config",
          `url.${redirectedEndpoint}.pushInsteadOf`,
          originalEndpoint,
        ]);
      }
      return nodeProcessRunner.run(request);
    },
  };
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  await assert.rejects(
    executeSourceBranchPush(repository, plan, { authorized: true }),
    (error: unknown) => isToolError(error, "CONCURRENT_UPDATE", /repository|remote|changed/i),
  );

  await fixture.git(["config", "--unset-all", `url.${redirectedEndpoint}.pushInsteadOf`]);
  assert.equal(await fixture.remoteHead(), localHead);
  await fixture.git(["remote", "set-url", "origin", redirectedRemotePath]);
  assert.equal(await fixture.remoteHead(), null);
});

test("push pins a local endpoint when its configured junction is swapped", async (t) => {
  const fixture = await fixtureFor(t);
  const localHead = await fixture.commitFile(
    "src/junction-endpoint.ts",
    "export const junctionEndpoint = true;\n",
    "junction endpoint",
  );
  const endpointPath = resolve(fixture.root, "endpoint.git");
  const redirectedRemotePath = resolve(fixture.root, "junction-redirected.git");
  await fixture.git(["init", "--bare", "--initial-branch=main", redirectedRemotePath]);
  await symlink(
    fixture.remotePath,
    endpointPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  await fixture.git(["remote", "set-url", "origin", endpointPath]);
  let redirected = false;
  const processRunner: ProcessRunner = {
    async run(request) {
      if (!redirected && isPushRequest(request)) {
        redirected = true;
        await rm(endpointPath, { force: true, recursive: false });
        await symlink(
          redirectedRemotePath,
          endpointPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return nodeProcessRunner.run(request);
    },
  };
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  await assert.rejects(
    executeSourceBranchPush(repository, plan, { authorized: true }),
    (error: unknown) => isToolError(error, "CONCURRENT_UPDATE", /repository|remote|changed/i),
  );

  await fixture.git(["remote", "set-url", "origin", fixture.remotePath]);
  assert.equal(await fixture.remoteHead(), localHead);
  await fixture.git(["remote", "set-url", "origin", redirectedRemotePath]);
  assert.equal(await fixture.remoteHead(), null);
});

test("push rejects replacement of the pinned local endpoint before spawn", async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.commitFile(
    "src/replaced-endpoint.ts",
    "export const replacedEndpoint = true;\n",
    "replaced endpoint",
  );
  const originalRemotePath = fixture.remotePath;
  const movedRemotePath = resolve(fixture.root, "original-moved.git");
  const redirectedRemotePath = resolve(fixture.root, "replacement-redirected.git");
  await fixture.git(["init", "--bare", "--initial-branch=main", redirectedRemotePath]);
  let replaced = false;
  const processRunner: ProcessRunner = {
    async run(request) {
      if (!replaced && isPushRequest(request)) {
        replaced = true;
        await rename(originalRemotePath, movedRemotePath);
        await symlink(
          redirectedRemotePath,
          originalRemotePath,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return nodeProcessRunner.run(request);
    },
  };
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  await assert.rejects(
    executeSourceBranchPush(repository, plan, { authorized: true }),
    (error: unknown) =>
      isToolError(error, "PARTIAL_REMOTE_STATE", /outcome|remote|process/i),
  );

  await fixture.git(["remote", "set-url", "origin", movedRemotePath]);
  assert.equal(await fixture.remoteHead(), null);
  await fixture.git(["remote", "set-url", "origin", redirectedRemotePath]);
  assert.equal(await fixture.remoteHead(), null);
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

test("push cleanup failure retains the verified remote outcome in a typed error", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fixture = await fixtureFor(t);
  const localHead = await fixture.commitFile(
    "src/push-cleanup-failure.ts",
    "export const pushCleanupFailure = true;\n",
    "push cleanup failure",
  );
  let held: HeldWindowsFile | undefined;
  const processRunner: ProcessRunner = {
    async run(request) {
      const result = await nodeProcessRunner.run(request);
      if (isPushRequest(request)) {
        const gitDirectory = request.environment.GIT_DIR;
        assert.notEqual(gitDirectory, undefined);
        held = await holdTemporaryViewFile(dirname(gitDirectory as string));
      }
      return result;
    },
  };
  const repository = await discoverRepository({
    cwd: fixture.worktreePath,
    processRunner,
    targetBranch: "main",
  });
  const plan = await planSourceBranchPush(repository, { allowPush: true });

  try {
    await assert.rejects(
      executeSourceBranchPush(repository, plan, { authorized: true }),
      (error: unknown) =>
        isToolError(error, "PARTIAL_REMOTE_STATE", /cleanup|temporary/i) &&
        error.details.actual === `remote source SHA verified as ${localHead}; temporary cleanup failed` &&
        !JSON.stringify(error.details).includes("EBUSY"),
    );
    assert.equal(await fixture.remoteHead(), localHead);
  } finally {
    await releaseTemporaryViewFile(held);
  }
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
