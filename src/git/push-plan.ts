import { ToolError } from "../contracts/errors.ts";
import {
  assertCleanWorktree,
  assertObjectId,
  assertRepositoryUnchanged,
  type RepositorySnapshot,
} from "./repository.ts";

export type SourceBranchRelation = "absent" | "equal" | "behind";

interface PushPlanCommon {
  readonly beforeSha: string | null;
  readonly command: readonly string[] | null;
  readonly localHeadSha: string;
  readonly relation: SourceBranchRelation;
  readonly remote: string;
  readonly remoteRef: string;
}

export type SourceBranchPushPlan =
  | (PushPlanCommon & { readonly kind: "up-to-date"; readonly relation: "equal" })
  | (PushPlanCommon & {
      readonly kind: "confirmation-required";
      readonly relation: "absent" | "behind";
    })
  | (PushPlanCommon & {
      readonly kind: "ready";
      readonly relation: "absent" | "behind";
    });

export interface PlanPushOptions {
  readonly allowPush: boolean;
  readonly dryRun?: boolean;
}

export type PushResult =
  | {
      readonly kind: "not-written";
      readonly beforeSha: string | null;
      readonly afterSha: string | null;
    }
  | {
      readonly kind: "pushed";
      readonly beforeSha: string | null;
      readonly afterSha: string;
    }
  | {
      readonly kind: "synchronized-after-unknown";
      readonly beforeSha: string | null;
      readonly afterSha: string;
    };

export interface ExecutePushOptions {
  readonly authorized: boolean;
  readonly dryRun?: boolean;
}

function pushError(
  message: string,
  expected: string,
  actual: string,
  safeNextStep: string,
): ToolError<"REPOSITORY_ERROR"> {
  return new ToolError("REPOSITORY_ERROR", message, {
    field: "sourceBranch",
    expected,
    actual,
    safeNextStep,
  });
}

function partialRemoteError(message: string, actual: string, cause?: unknown): ToolError<"PARTIAL_REMOTE_STATE"> {
  return new ToolError(
    "PARTIAL_REMOTE_STATE",
    message,
    {
      field: "sourceBranch",
      expected: "a verified remote source SHA equal to the planned local HEAD",
      actual,
      safeNextStep: "Read the remote source branch again before retrying any write.",
    },
    cause,
  );
}

function concurrentUpdateError(actual: string, cause?: unknown): ToolError<"CONCURRENT_UPDATE"> {
  return new ToolError(
    "CONCURRENT_UPDATE",
    "Remote source branch SHA changed during push execution",
    {
      field: "sourceBranch",
      expected: "the planned local HEAD after push",
      actual,
      safeNextStep: "Create a fresh repository snapshot and push plan before retrying.",
    },
    cause,
  );
}

async function readRemoteSha(repository: RepositorySnapshot): Promise<string | null> {
  let result;
  try {
    result = await repository.runner.run([
      "ls-remote",
      "--exit-code",
      "--refs",
      "--",
      repository.sourceRemote,
      repository.sourceRemoteRef,
    ]);
  } catch (error) {
    throw new ToolError(
      "REPOSITORY_ERROR",
      "Failed to read the remote source branch",
      {
        field: "sourceBranch",
        expected: "a readable source ref",
        actual: "Git process failure",
        safeNextStep: "Check the selected remote and credentials, then retry.",
      },
      error,
    );
  }
  if (result.timedOut) {
    throw pushError(
      "Timed out while reading the remote source branch",
      "a readable source ref",
      "timed out",
      "Check remote connectivity and retry.",
    );
  }
  if (result.exitCode === 2 && result.stdout.length === 0) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw pushError(
      "Failed to read the remote source branch",
      "a readable source ref",
      `git exit ${String(result.exitCode)}`,
      "Check the selected remote and credentials, then retry.",
    );
  }
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
  } catch (error) {
    throw new ToolError(
      "REPOSITORY_ERROR",
      "Remote source branch returned invalid UTF-8",
      {
        field: "sourceBranch",
        expected: "one ls-remote record",
        actual: "invalid bytes",
        safeNextStep: "Inspect the remote ref with Git and retry.",
      },
      error,
    );
  }
  const records = output === "" ? [] : output.split(/\r?\n/u);
  if (records.length !== 1) {
    throw pushError(
      "Remote source branch lookup was ambiguous",
      "one exact source ref",
      `${records.length} records`,
      "Select one exact source project, remote, and branch, then retry.",
    );
  }
  const [oid, ref, ...extra] = records[0]?.split("\t") ?? [];
  if (oid === undefined || ref !== repository.sourceRemoteRef || extra.length !== 0) {
    throw pushError(
      "Remote source branch lookup returned a malformed record",
      "one exact source ref",
      "malformed record",
      "Inspect the remote ref with Git and retry.",
    );
  }
  return assertObjectId(oid, "remote source ref");
}

async function isAncestor(
  repository: RepositorySnapshot,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await repository.runner.run([
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw pushError(
    "Cannot determine source branch ancestry",
    "both source commits available locally",
    `git exit ${String(result.exitCode)}`,
    "Fetch the selected source branch without modifying it, then retry.",
  );
}

function commandFor(repository: RepositorySnapshot): readonly string[] {
  return Object.freeze([
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    repository.sourceRemote,
    `${repository.sourceHeadSha}:${repository.sourceRemoteRef}`,
  ]);
}

function commandsEqual(left: readonly string[] | null, right: readonly string[]): boolean {
  return left !== null &&
    left.length === right.length &&
    left.every((argument, index) => argument === right[index]);
}

function assertPushPlan(repository: RepositorySnapshot, plan: SourceBranchPushPlan): void {
  const commonMatches = plan.remote === repository.sourceRemote &&
    plan.remoteRef === repository.sourceRemoteRef &&
    plan.localHeadSha === repository.sourceHeadSha;
  const expectedCommand = commandFor(repository);
  const shapeMatches = plan.kind === "up-to-date"
    ? plan.relation === "equal" &&
      plan.beforeSha === repository.sourceHeadSha &&
      plan.command === null
    : (plan.relation === "absent" || plan.relation === "behind") &&
      (plan.relation === "absent" ? plan.beforeSha === null : plan.beforeSha !== null) &&
      commandsEqual(plan.command, expectedCommand);
  if (!commonMatches || !shapeMatches) {
    throw pushError(
      "Push plan or command does not match the discovered repository",
      "an unchanged exact source branch push plan",
      "tampered or stale plan",
      "Create a fresh push plan and retry.",
    );
  }
}

export async function planSourceBranchPush(
  repository: RepositorySnapshot,
  options: PlanPushOptions,
): Promise<SourceBranchPushPlan> {
  const remoteSha = await readRemoteSha(repository);
  if (remoteSha === repository.sourceHeadSha) {
    return Object.freeze({
      kind: "up-to-date",
      relation: "equal",
      beforeSha: remoteSha,
      command: null,
      localHeadSha: repository.sourceHeadSha,
      remote: repository.sourceRemote,
      remoteRef: repository.sourceRemoteRef,
    });
  }
  let relation: "absent" | "behind";
  if (remoteSha === null) {
    relation = "absent";
  } else if (await isAncestor(repository, remoteSha, repository.sourceHeadSha)) {
    relation = "behind";
  } else if (await isAncestor(repository, repository.sourceHeadSha, remoteSha)) {
    throw pushError(
      "Remote source branch is ahead of local HEAD",
      repository.sourceHeadSha,
      remoteSha,
      "Update the local branch explicitly and retry; the tool will not overwrite the remote branch.",
    );
  } else {
    throw pushError(
      "Remote source branch has diverged from local HEAD",
      "a fast-forward relationship",
      "diverged",
      "Reconcile the branches explicitly and retry; the tool will not force push.",
    );
  }
  const ready = options.allowPush && options.dryRun !== true;
  return Object.freeze({
    kind: ready ? "ready" : "confirmation-required",
    relation,
    beforeSha: remoteSha,
    command: commandFor(repository),
    localHeadSha: repository.sourceHeadSha,
    remote: repository.sourceRemote,
    remoteRef: repository.sourceRemoteRef,
  });
}

export async function executeSourceBranchPush(
  repository: RepositorySnapshot,
  plan: SourceBranchPushPlan,
  options: ExecutePushOptions,
): Promise<PushResult> {
  assertPushPlan(repository, plan);
  if (
    plan.kind === "up-to-date" ||
    plan.kind === "confirmation-required" ||
    !options.authorized ||
    options.dryRun === true
  ) {
    return Object.freeze({
      kind: "not-written",
      beforeSha: plan.beforeSha,
      afterSha: plan.beforeSha,
    });
  }
  await assertCleanWorktree(repository);
  await assertRepositoryUnchanged(repository);
  const exactCommand = commandFor(repository);
  const remoteBefore = await readRemoteSha(repository);
  if (remoteBefore !== plan.beforeSha) {
    throw pushError(
      "Remote source branch changed after push planning",
      plan.beforeSha ?? "absent",
      remoteBefore ?? "absent",
      "Create a fresh push plan and retry.",
    );
  }
  let push;
  let processFailure: unknown;
  try {
    push = await repository.runner.run(exactCommand);
  } catch (error) {
    processFailure = error;
  }
  let remoteAfter: string | null;
  try {
    remoteAfter = await readRemoteSha(repository);
  } catch (error) {
    throw partialRemoteError(
      "Remote source branch could not be read after a push attempt",
      "readback unavailable",
      error,
    );
  }
  const pushSucceeded = processFailure === undefined &&
    push !== undefined &&
    !push.timedOut &&
    push.exitCode === 0 &&
    push.signal === null;
  if (remoteAfter === repository.sourceHeadSha) {
    try {
      await assertRepositoryUnchanged(repository);
    } catch (error) {
      throw concurrentUpdateError("local repository changed after push", error);
    }
    return Object.freeze({
      kind: pushSucceeded ? "pushed" : "synchronized-after-unknown",
      beforeSha: remoteBefore,
      afterSha: remoteAfter,
    });
  }
  if (processFailure !== undefined || push === undefined || push.timedOut || push.exitCode === null || push.signal !== null) {
    throw partialRemoteError(
      "Push outcome is unknown and the remote source SHA is not the planned local HEAD",
      remoteAfter ?? "absent",
      processFailure,
    );
  }
  if (push === undefined) {
    throw partialRemoteError(
      "Push process result is unavailable after a push attempt",
      remoteAfter ?? "absent",
    );
  }
  if (push.exitCode !== 0 && remoteAfter === remoteBefore) {
    throw pushError(
      "Remote rejected the source branch push",
      repository.sourceHeadSha,
      remoteAfter ?? "absent",
      "Resolve the server rejection without force pushing, then retry.",
    );
  }
  throw concurrentUpdateError(remoteAfter ?? "absent");
}
