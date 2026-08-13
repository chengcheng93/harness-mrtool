import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolError } from "../contracts/errors.ts";
import {
  GitRunner,
  type GitRunnerOptions,
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

export interface GitLabProjectIdentity {
  readonly host: string;
  readonly path: string;
}

export type RemoteEndpointIdentity =
  | {
      readonly key: string;
      readonly kind: "gitlab";
      readonly project: GitLabProjectIdentity;
    }
  | {
      readonly key: string;
      readonly kind: "local";
      readonly project: null;
    };

export interface RepositorySnapshot {
  readonly gitlabHost: string | null;
  readonly root: string;
  readonly runner: GitRunner;
  readonly sourceBranch: string;
  readonly sourceHeadSha: string;
  readonly sourceProject: GitLabProjectIdentity | null;
  readonly sourceFetchUrl: string;
  readonly sourcePushUrl: string;
  readonly sourceRemote: string;
  readonly sourceRemoteIdentity: RemoteEndpointIdentity;
  readonly sourceRemoteRef: string;
  readonly targetBranch: string;
  readonly targetProject: GitLabProjectIdentity | null;
  readonly targetFetchUrl: string;
  readonly targetPushUrl: string;
  readonly targetRef: string;
  readonly targetRefSha: string;
  readonly targetRemote: string;
  readonly targetRemoteIdentity: RemoteEndpointIdentity;
  readonly worktree: WorktreeState;
}

export interface DiscoverRepositoryOptions {
  readonly cwd: string;
  readonly gitRunnerOptions?: GitRunnerOptions;
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
  environmentOverride: Readonly<Record<string, string | undefined>> = {},
): Promise<Buffer> {
  let result: ProcessResult;
  try {
    result = await runner.run(arguments_, environmentOverride);
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
  environmentOverride: Readonly<Record<string, string | undefined>> = {},
): Promise<string> {
  return decodeText(
    await runGitChecked(runner, arguments_, subject, environmentOverride),
    subject,
  ).trim();
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

function normalizedProjectPath(value: string): string | null {
  let path = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (path.endsWith(".git")) {
    path = path.slice(0, -4);
  }
  const segments = path.split("/");
  if (
    path === "" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return path;
}

function localEndpointIdentity(root: string, value: string): RemoteEndpointIdentity {
  const absolutePath = resolve(root, value);
  const canonicalPath = process.platform === "win32"
    ? absolutePath.replaceAll("\\", "/").toLowerCase()
    : absolutePath;
  return Object.freeze({
    key: `local:${canonicalPath}`,
    kind: "local",
    project: null,
  });
}

function gitLabEndpointIdentity(
  hostValue: string,
  pathValue: string,
): RemoteEndpointIdentity {
  const host = hostValue.toLowerCase();
  const path = normalizedProjectPath(pathValue);
  if (host === "" || path === null) {
    throw repositoryError(
      "Selected remote URL does not identify one GitLab project",
      "remote",
      "a GitLab host and non-empty project path",
      "unrecognized remote URL",
      "Configure one canonical GitLab fetch/push URL for the selected remote and retry.",
    );
  }
  const project = Object.freeze({ host, path });
  return Object.freeze({
    key: `gitlab:${host}/${path}`,
    kind: "gitlab",
    project,
  });
}

function normalizeRemoteEndpoint(
  root: string,
  value: string,
): RemoteEndpointIdentity {
  if (value === "" || value.includes("\u0000") || /[\r\n]/u.test(value)) {
    throw repositoryError(
      "Selected remote URL is invalid",
      "remote",
      "one non-empty remote URL",
      "invalid remote URL",
      "Configure one canonical GitLab fetch/push URL for the selected remote and retry.",
    );
  }
  if (
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("\\\\")
  ) {
    return localEndpointIdentity(root, value);
  }
  if (value.startsWith("file:")) {
    try {
      return localEndpointIdentity(root, fileURLToPath(value));
    } catch (error) {
      throw repositoryError(
        "Selected remote file URL is invalid",
        "remote",
        "one valid local file URL",
        "invalid remote URL",
        "Correct the selected remote URL and retry.",
        error,
      );
    }
  }
  const scpLike = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/u.exec(value);
  if (scpLike !== null && !value.includes("://")) {
    const host = scpLike[1];
    const path = scpLike[2];
    if (host !== undefined && path !== undefined) {
      return gitLabEndpointIdentity(host, path);
    }
  }
  try {
    const url = new URL(value);
    if (
      !["git:", "http:", "https:", "ssh:"].includes(url.protocol) ||
      url.hash !== "" ||
      url.search !== ""
    ) {
      throw new TypeError("unsupported Git transport URL");
    }
    return gitLabEndpointIdentity(url.host, url.pathname);
  } catch (error) {
    throw repositoryError(
      "Selected remote URL does not identify one GitLab project",
      "remote",
      "one canonical GitLab or local repository URL",
      "unrecognized remote URL",
      "Configure one canonical GitLab fetch/push URL for the selected remote and retry.",
      error,
    );
  }
}

async function readRemoteUrl(
  runner: GitRunner,
  remote: string,
  push: boolean,
): Promise<string> {
  const output = decodeText(
    await runGitChecked(
      runner,
      ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
      `${push ? "push" : "fetch"} URL for remote ${remote}`,
    ),
    `${push ? "push" : "fetch"} URL for remote ${remote}`,
  );
  const records = output.split(/\r?\n/u);
  if (records.at(-1) === "") records.pop();
  if (records.length !== 1 || records[0] === undefined || records[0] === "") {
    throw repositoryError(
      "Selected remote URL is ambiguous",
      "remote",
      "exactly one fetch URL and one push URL",
      `${records.length} ${push ? "push" : "fetch"} URLs`,
      "Configure one canonical fetch/push URL for the selected remote and retry.",
    );
  }
  return records[0];
}

async function readRemoteIdentity(
  runner: GitRunner,
  root: string,
  remote: string,
): Promise<{
  readonly fetchUrl: string;
  readonly identity: RemoteEndpointIdentity;
  readonly pushUrl: string;
}> {
  const [fetchUrl, pushUrl] = await Promise.all([
    readRemoteUrl(runner, remote, false),
    readRemoteUrl(runner, remote, true),
  ]);
  const fetchIdentity = normalizeRemoteEndpoint(root, fetchUrl);
  const pushIdentity = normalizeRemoteEndpoint(root, pushUrl);
  if (fetchIdentity.key !== pushIdentity.key) {
    throw repositoryError(
      "Selected remote fetch and push URLs identify different repositories",
      "remote",
      "fetch and push URLs for the same GitLab project",
      "different fetch/push identities",
      "Select or configure a remote whose fetch and push URLs identify the same project.",
    );
  }
  return Object.freeze({ fetchUrl, identity: fetchIdentity, pushUrl });
}

export async function discoverRepository(
  options: DiscoverRepositoryOptions,
): Promise<RepositorySnapshot> {
  const initialRunner = new GitRunner(
    options.cwd,
    options.processRunner,
    options.gitRunnerOptions,
  );
  await validateBranch(initialRunner, options.targetBranch, "target branch");
  const root = resolve(await readGitText(
    initialRunner,
    ["rev-parse", "--show-toplevel"],
    "repository root",
  ));
  const runner = new GitRunner(root, options.processRunner, options.gitRunnerOptions);
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
  const sourceRemoteConfiguration = await readRemoteIdentity(runner, root, sourceRemote);
  const targetRemoteConfiguration = configuredTarget === sourceRemote
    ? sourceRemoteConfiguration
    : await readRemoteIdentity(runner, root, configuredTarget);
  const sourceRemoteIdentity = sourceRemoteConfiguration.identity;
  const targetRemoteIdentity = targetRemoteConfiguration.identity;
  if (sourceRemoteIdentity.kind !== targetRemoteIdentity.kind) {
    throw repositoryError(
      "Source and target remotes do not provide one GitLab host identity",
      "remote",
      "source and target remotes on one GitLab host",
      "mixed local and GitLab remotes",
      "Select explicit source and target remotes on the same GitLab host.",
    );
  }
  if (
    sourceRemoteIdentity.kind === "gitlab" &&
    targetRemoteIdentity.kind === "gitlab" &&
    sourceRemoteIdentity.project.host !== targetRemoteIdentity.project.host
  ) {
    throw repositoryError(
      "Source and target projects are on different GitLab hosts",
      "remote",
      "source and target projects on one GitLab host",
      "different GitLab hosts",
      "Select explicit source and target remotes on the same GitLab host.",
    );
  }
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
  const sourceProject = sourceRemoteIdentity.project;
  const targetProject = targetRemoteIdentity.project;
  return Object.freeze({
    gitlabHost: sourceProject?.host ?? null,
    root,
    runner,
    sourceBranch,
    sourceFetchUrl: sourceRemoteConfiguration.fetchUrl,
    sourceHeadSha,
    sourceProject,
    sourcePushUrl: sourceRemoteConfiguration.pushUrl,
    sourceRemote,
    sourceRemoteIdentity,
    sourceRemoteRef: `refs/heads/${sourceBranch}`,
    targetBranch: options.targetBranch,
    targetFetchUrl: targetRemoteConfiguration.fetchUrl,
    targetProject,
    targetPushUrl: targetRemoteConfiguration.pushUrl,
    targetRef,
    targetRefSha,
    targetRemote: configuredTarget,
    targetRemoteIdentity,
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
  const sourceConfiguration = await readRemoteIdentity(
    repository.runner,
    repository.root,
    repository.sourceRemote,
  );
  const targetConfiguration = repository.targetRemote === repository.sourceRemote
    ? sourceConfiguration
    : await readRemoteIdentity(repository.runner, repository.root, repository.targetRemote);
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
    target !== repository.targetRefSha ||
    sourceConfiguration.identity.key !== repository.sourceRemoteIdentity.key ||
    sourceConfiguration.fetchUrl !== repository.sourceFetchUrl ||
    sourceConfiguration.pushUrl !== repository.sourcePushUrl ||
    targetConfiguration.identity.key !== repository.targetRemoteIdentity.key ||
    targetConfiguration.fetchUrl !== repository.targetFetchUrl ||
    targetConfiguration.pushUrl !== repository.targetPushUrl
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
