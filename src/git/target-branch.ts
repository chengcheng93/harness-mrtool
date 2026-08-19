import { ToolError } from "../contracts/errors.ts";
import {
  discoverRepository,
  type DiscoverRepositoryOptions,
  type GitLabProjectIdentity,
  type RepositorySnapshot,
} from "./repository.ts";

export interface DiscoverProfileDetectionRepositoryOptions extends DiscoverRepositoryOptions {
  readonly expectedTargetProject: GitLabProjectIdentity;
}

function repositoryError(
  message: string,
  actual: string,
  safeNextStep: string,
): ToolError<"REPOSITORY_ERROR"> {
  return new ToolError("REPOSITORY_ERROR", message, {
    field: "repository.target",
    expected: "the GitLab target project, default branch, and local tracking metadata to agree",
    actual,
    safeNextStep,
  });
}

function targetProjectError(): ToolError<"REPOSITORY_ERROR"> {
  return repositoryError(
    "Selected remote does not identify the resolved GitLab target project",
    "target project identity mismatch",
    "Select the remote for the resolved target project and retry.",
  );
}

function remoteHeadError(): ToolError<"REPOSITORY_ERROR"> {
  return repositoryError(
    "Local remote HEAD is inconsistent with the GitLab target default branch",
    "inconsistent remote HEAD metadata",
    "Fetch the target remote and repair or remove its stale remote HEAD, then retry.",
  );
}

async function validateRemoteHead(repository: RepositorySnapshot): Promise<void> {
  const remoteHead = `refs/remotes/${repository.targetRemote}/HEAD`;
  let symbolic;
  try {
    symbolic = await repository.runner.run(["symbolic-ref", "--quiet", remoteHead]);
  } catch {
    throw remoteHeadError();
  }
  if (symbolic.timedOut) throw remoteHeadError();
  if (symbolic.exitCode === 0) {
    let target: string;
    try {
      target = new TextDecoder("utf-8", { fatal: true }).decode(symbolic.stdout).trim();
    } catch {
      throw remoteHeadError();
    }
    if (target !== repository.targetRef) throw remoteHeadError();
    return;
  }
  if (symbolic.exitCode !== 1) throw remoteHeadError();

  let direct;
  try {
    direct = await repository.runner.run(["show-ref", "--verify", "--quiet", remoteHead]);
  } catch {
    throw remoteHeadError();
  }
  if (direct.timedOut || (direct.exitCode !== 0 && direct.exitCode !== 1)) {
    throw remoteHeadError();
  }
  if (direct.exitCode === 0) throw remoteHeadError();
}

/**
 * Discovers the committed-diff baseline after GitLab has resolved the target.
 * targetBranch is authoritative project.defaultBranch; remote HEAD is only a
 * local consistency check and is never used as a branch source.
 */
export async function discoverProfileDetectionRepository(
  options: DiscoverProfileDetectionRepositoryOptions,
): Promise<RepositorySnapshot> {
  const { expectedTargetProject, ...repositoryOptions } = options;
  const repository = await discoverRepository(repositoryOptions);
  if (
    repository.targetProject === null ||
    repository.targetProject.host !== expectedTargetProject.host ||
    repository.targetProject.path !== expectedTargetProject.path
  ) {
    throw targetProjectError();
  }
  await validateRemoteHead(repository);
  return repository;
}
