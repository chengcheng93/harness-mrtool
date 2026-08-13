import { resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import {
  GitRunner,
  type ProcessResult,
  type ProcessRunner,
} from "./runner.ts";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REMOTE_NAME = /^(?!-)[A-Za-z0-9._-]+$/u;

export interface WorktreeState {
  readonly clean: boolean;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

export interface RepositorySnapshot {
  readonly root: string;
  readonly runner: GitRunner;
  readonly sourceBranch: string;
  readonly sourceHeadSha: string;
  readonly sourceRemote: string;
  readonly sourceRemoteRef: string;
  readonly targetBranch: string;
  readonly targetRef: string;
  readonly targetRefSha: string;
  readonly worktree: WorktreeState;
}

export interface DiscoverRepositoryOptions {
  readonly cwd: string;
  readonly processRunner?: ProcessRunner;
  readonly sourceRemote?: string;
  readonly targetBranch: string;
  readonly targetRemote?: string;
}

function repositoryError(
  message: string,
  field: string | null,
  expected: string,
  actual: string,
  safeNextStep: string,
  cause?: unknown,
): ToolError<"REPOSITORY_ERROR"> {
  return new ToolError(
    "REPOSITORY_ERROR",
    message,
    { field, expected, actual, safeNextStep },
    cause,
  );
}

function decodeText(buffer: Buffer, subject: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw repositoryError(
      `Git returned invalid UTF-8 for ${subject}`,
      subject,
      "valid UTF-8",
      "invalid bytes",
      "Inspect the repository metadata with Git and retry.",
      error,
    );
  }
}

export async function runGitChecked(
  runner: GitRunner,
  arguments_: readonly string[],
  subject: string,
): Promise<Buffer> {
  let result: ProcessResult;
  try {
    result = await runner.run(arguments_);
  } catch (error) {
    throw repositoryError(
      `Git failed while reading ${subject}`,
      subject,
      "successful Git command",
      "process failure",
      "Verify that Git is installed and the repository is accessible, then retry.",
      error,
    );
  }
  if (result.timedOut || result.exitCode !== 0) {
    throw repositoryError(
      `Git failed while reading ${subject}`,
      subject,
      "successful Git command",
      result.timedOut ? "timed out" : `git exit ${String(result.exitCode)}`,
      "Resolve the repository state reported by Git, then retry.",
    );
  }
  return result.stdout;
}

export async function readGitText(
  runner: GitRunner,
  arguments_: readonly string[],
  subject: string,
): Promise<string> {
  return decodeText(await runGitChecked(runner, arguments_, subject), subject).trim();
}

export function assertObjectId(value: string, subject: string): string {
  if (!SHA1.test(value) && !SHA256.test(value)) {
    throw repositoryError(
      `Git returned an invalid object ID for ${subject}`,
      subject,
      "a full Git object ID",
      "invalid object ID",
      "Verify repository object integrity, then retry.",
    );
  }
  return value;
}

function validateBranchArgument(value: string, subject: string): void {
  if (
    value === "" ||
    value.startsWith("-") ||
    value.includes("\u0000") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    throw repositoryError(
      `Invalid ${subject}`,
      subject,
      "a valid Git branch name",
      "invalid branch",
      "Select an existing valid branch and retry.",
    );
  }
}

async function validateBranch(
  runner: GitRunner,
  value: string,
  subject: string,
): Promise<void> {
  validateBranchArgument(value, subject);
  const result = await runner.run(["check-ref-format", "--branch", value]);
  if (result.timedOut || result.exitCode !== 0) {
    throw repositoryError(
      `Invalid ${subject}`,
      subject,
      "a valid Git branch name",
      "invalid branch",
      "Select an existing valid branch and retry.",
    );
  }
}

function validateRemote(value: string, subject: string): void {
  if (!REMOTE_NAME.test(value)) {
    throw repositoryError(
      `Invalid ${subject}`,
      subject,
      "a simple configured Git remote name",
      "invalid remote",
      "Select a configured remote by name and retry.",
    );
  }
}

async function readWorktree(runner: GitRunner): Promise<WorktreeState> {
  const output = await runGitChecked(
    runner,
    ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    "worktree status",
  );
  let statusText: string;
  try {
    statusText = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw repositoryError(
      "Git returned invalid UTF-8 for worktree status",
      "worktree",
      "valid UTF-8 porcelain v2 records",
      "invalid bytes",
      "Rename the affected worktree path to valid UTF-8 and retry.",
      error,
    );
  }
  const records = statusText.split("\u0000");
  let staged = false;
  let unstaged = false;
  let untracked = false;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") {
      continue;
    }
    if (record.startsWith("? ")) {
      untracked = true;
      continue;
    }
    if (record.startsWith("! ")) {
      continue;
    }
    if (record.startsWith("u ")) {
      staged = true;
      unstaged = true;
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const xy = record.slice(2, 4);
      staged ||= xy[0] !== ".";
      unstaged ||= xy[1] !== ".";
      if (record.startsWith("2 ")) {
        const originalPath = records[index + 1];
        if (originalPath === undefined || originalPath === "") {
          throw repositoryError(
            "Git returned an incomplete rename worktree status record",
            "worktree",
            "porcelain v2 rename with an original path",
            "missing original path",
            "Inspect the worktree with git status and retry.",
          );
        }
        index += 1;
      }
      continue;
    }
    throw repositoryError(
      "Git returned an unsupported worktree status record",
      "worktree",
      "porcelain v2 status records",
      "unsupported status",
      "Inspect the worktree with git status and retry.",
    );
  }
  return Object.freeze({
    clean: !staged && !unstaged && !untracked,
    staged,
    unstaged,
    untracked,
  });
}

async function resolveRemote(
  runner: GitRunner,
  requested: string | undefined,
): Promise<string> {
  const remotes = (await readGitText(runner, ["remote"], "configured remotes"))
    .split(/\r?\n/u)
    .filter((remote) => remote !== "");
  if (requested !== undefined) {
    validateRemote(requested, "remote");
    if (!remotes.includes(requested)) {
      throw repositoryError(
        "Selected Git remote is not configured",
        "remote",
        "configured remote",
        requested,
        "Select one of the configured remotes and retry.",
      );
    }
    return requested;
  }
  if (remotes.length === 1 && remotes[0] !== undefined) {
    validateRemote(remotes[0], "remote");
    return remotes[0];
  }
  throw repositoryError(
    "Git remote selection is ambiguous",
    "remote",
    "exactly one configured remote or an explicit selection",
    String(remotes.length),
    "Select the source and target remote explicitly, then retry.",
  );
}

export async function discoverRepository(
  options: DiscoverRepositoryOptions,
): Promise<RepositorySnapshot> {
  const initialRunner = new GitRunner(options.cwd, options.processRunner);
  await validateBranch(initialRunner, options.targetBranch, "target branch");
  const root = resolve(await readGitText(
    initialRunner,
    ["rev-parse", "--show-toplevel"],
    "repository root",
  ));
  const runner = new GitRunner(root, options.processRunner);
  const sourceBranch = await readGitText(
    runner,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "source branch",
  );
  await validateBranch(runner, sourceBranch, "source branch");
  const sourceHeadSha = assertObjectId(
    await readGitText(runner, ["rev-parse", "--verify", "HEAD^{commit}"], "source HEAD"),
    "source HEAD",
  );
  const sourceRemote = await resolveRemote(runner, options.sourceRemote);
  const targetRemote = options.targetRemote ?? sourceRemote;
  validateRemote(targetRemote, "target remote");
  const configuredTarget = await resolveRemote(runner, targetRemote);
  const targetRef = `refs/remotes/${configuredTarget}/${options.targetBranch}`;
  const targetRefSha = assertObjectId(
    await readGitText(
      runner,
      ["rev-parse", "--verify", `${targetRef}^{commit}`],
      "target tracking ref",
    ),
    "target tracking ref",
  );
  const worktree = await readWorktree(runner);
  return Object.freeze({
    root,
    runner,
    sourceBranch,
    sourceHeadSha,
    sourceRemote,
    sourceRemoteRef: `refs/heads/${sourceBranch}`,
    targetBranch: options.targetBranch,
    targetRef,
    targetRefSha,
    worktree,
  });
}

export async function assertCleanWorktree(
  repository: RepositorySnapshot,
): Promise<void> {
  const current = await readWorktree(repository.runner);
  if (!current.clean) {
    throw repositoryError(
      "A clean worktree is required before a branch write",
      "worktree",
      "no staged, unstaged, unmerged, or untracked files",
      "dirty",
      "Commit or remove the worktree changes, then retry.",
    );
  }
}

export async function assertRepositoryUnchanged(
  repository: RepositorySnapshot,
): Promise<void> {
  const [branch, head, target] = await Promise.all([
    readGitText(repository.runner, ["symbolic-ref", "--quiet", "--short", "HEAD"], "source branch"),
    readGitText(repository.runner, ["rev-parse", "--verify", "HEAD^{commit}"], "source HEAD"),
    readGitText(
      repository.runner,
      ["rev-parse", "--verify", `${repository.targetRef}^{commit}`],
      "target tracking ref",
    ),
  ]);
  if (
    branch !== repository.sourceBranch ||
    head !== repository.sourceHeadSha ||
    target !== repository.targetRefSha
  ) {
    throw repositoryError(
      "Repository state changed after discovery",
      "repository",
      "the discovered branch and object IDs",
      "changed",
      "Run the command again from a fresh repository snapshot.",
    );
  }
}
