import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...arguments_], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function configureIdentity(repository: string): Promise<void> {
  await runGit(repository, ["config", "user.name", "Task7 Test"]);
  await runGit(repository, ["config", "user.email", "task7@example.invalid"]);
}

export class GitFixture {
  readonly root: string;
  readonly remotePath: string;
  readonly worktreePath: string;

  private constructor(root: string, remotePath: string, worktreePath: string) {
    this.root = root;
    this.remotePath = remotePath;
    this.worktreePath = worktreePath;
  }

  static async create(): Promise<GitFixture> {
    const root = await mkdtemp(join(tmpdir(), "harness-mrtool-git-"));
    const remotePath = resolve(root, "remote.git");
    const worktreePath = resolve(root, "worktree");
    await mkdir(worktreePath);
    await runGit(root, ["init", "--bare", "--initial-branch=main", remotePath]);
    await runGit(worktreePath, ["init", "--initial-branch=main"]);
    await configureIdentity(worktreePath);

    const initialFiles = new Map([
      ["README.md", "initial\n"],
      ["src/deleted.ts", "export const deleted = true;\n"],
      ["src/modified.ts", "export const value = 1;\n"],
      ["src/rename-old.ts", "export const renamed = true;\n"],
    ]);
    for (const [path, content] of initialFiles) {
      const absolutePath = resolve(worktreePath, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    }
    await runGit(worktreePath, ["add", "--all"]);
    await runGit(worktreePath, ["commit", "-m", "initial"]);
    await runGit(worktreePath, ["remote", "add", "origin", remotePath]);
    await runGit(worktreePath, ["push", "--set-upstream", "origin", "main"]);
    await runGit(worktreePath, ["switch", "-c", "feature/task7"]);
    return new GitFixture(root, remotePath, worktreePath);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  async git(arguments_: readonly string[]): Promise<string> {
    return runGit(this.worktreePath, arguments_);
  }

  async head(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async targetHead(): Promise<string> {
    return (await this.git(["rev-parse", "refs/remotes/origin/main"])).trim();
  }

  async remoteHead(branch = "feature/task7"): Promise<string | null> {
    try {
      const stdout = await runGit(this.worktreePath, [
        "ls-remote",
        "--exit-code",
        "--refs",
        "origin",
        `refs/heads/${branch}`,
      ]);
      const [oid] = stdout.trim().split(/\s+/u);
      return oid === undefined || oid === "" ? null : oid;
    } catch (error) {
      const candidate = error as { readonly code?: number };
      if (candidate.code === 2) {
        return null;
      }
      throw error;
    }
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const absolutePath = resolve(this.worktreePath, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }

  async remove(path: string): Promise<void> {
    await rm(resolve(this.worktreePath, path), { recursive: true, force: true });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const destination = resolve(this.worktreePath, newPath);
    await mkdir(dirname(destination), { recursive: true });
    await rename(resolve(this.worktreePath, oldPath), destination);
  }

  async commitAll(message: string): Promise<string> {
    await this.git(["add", "--all"]);
    await this.git(["commit", "-m", message]);
    return this.head();
  }

  async commitFile(path: string, content: string, message: string): Promise<string> {
    await this.write(path, content);
    return this.commitAll(message);
  }

  async pushSource(): Promise<void> {
    await this.git([
      "push",
      "--set-upstream",
      "origin",
      "HEAD:refs/heads/feature/task7",
    ]);
  }

  async peerCommitAndPush(path: string, content: string): Promise<string> {
    const peerPath = resolve(this.root, `peer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await runGit(this.root, ["clone", "--branch", "feature/task7", this.remotePath, peerPath]);
    await configureIdentity(peerPath);
    const absolutePath = resolve(peerPath, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
    await runGit(peerPath, ["add", "--all"]);
    await runGit(peerPath, ["commit", "-m", "peer change"]);
    await runGit(peerPath, ["push", "origin", "HEAD:refs/heads/feature/task7"]);
    return (await runGit(peerPath, ["rev-parse", "HEAD"])).trim();
  }

  async fetchSource(): Promise<void> {
    await this.git([
      "fetch",
      "origin",
      "refs/heads/feature/task7:refs/remotes/origin/feature/task7",
    ]);
  }

  async addSubmodule(path = "vendor/dependency"): Promise<void> {
    const subRemotePath = resolve(this.root, "submodule.git");
    const subWorktreePath = resolve(this.root, "submodule-worktree");
    await mkdir(subWorktreePath);
    await runGit(this.root, ["init", "--bare", "--initial-branch=main", subRemotePath]);
    await runGit(subWorktreePath, ["init", "--initial-branch=main"]);
    await configureIdentity(subWorktreePath);
    await writeFile(resolve(subWorktreePath, "module.txt"), "module\n");
    await runGit(subWorktreePath, ["add", "--all"]);
    await runGit(subWorktreePath, ["commit", "-m", "module"]);
    await runGit(subWorktreePath, ["remote", "add", "origin", subRemotePath]);
    await runGit(subWorktreePath, ["push", "origin", "main"]);
    await this.git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      subRemotePath,
      path,
    ]);
  }

  async rejectPushes(): Promise<void> {
    const hookPath = resolve(this.remotePath, "hooks", "pre-receive");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    await chmod(hookPath, 0o755);
  }

  async read(path: string): Promise<string> {
    return readFile(resolve(this.worktreePath, path), "utf8");
  }
}
