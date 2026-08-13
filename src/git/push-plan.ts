import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import {
  assertCleanWorktree,
  assertObjectId,
  assertRepositoryUnchanged,
  readGitText,
  type RepositorySnapshot,
  runGitChecked,
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

interface RemoteTransactionView {
  readonly dispose: () => Promise<void>;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const TRANSPORT_CONFIG_PATTERN =
  "^(credential\\.|http\\.|https\\.|core\\.(gitproxy|sshcommand)$|ssh\\.variant$|protocol\\.version$)";
const TRANSPORT_CONFIG_KEY =
  /^(?:credential\.|http\.|https\.|core\.(?:gitproxy|sshcommand)$|ssh\.variant$|protocol\.version$)/u;

function parseTransportConfig(output: Buffer): readonly (readonly [string, string])[] {
  const records: Array<readonly [string, string]> = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) {
      throw pushError(
        "Cannot isolate Git transport configuration",
        "NUL-delimited key/value records",
        "malformed output",
        "Inspect Git configuration and retry.",
      );
    }
    const record = output.subarray(start, end);
    const separator = record.indexOf(10);
    if (separator < 1) {
      throw pushError(
        "Cannot isolate Git transport configuration",
        "NUL-delimited key/value records",
        "malformed output",
        "Inspect Git configuration and retry.",
      );
    }
    let key: string;
    let value: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      key = decoder.decode(record.subarray(0, separator));
      value = decoder.decode(record.subarray(separator + 1));
    } catch (error) {
      throw pushError(
        "Cannot isolate Git transport configuration",
        "valid UTF-8 transport configuration",
        "invalid bytes",
        "Inspect Git configuration and retry.",
      );
    }
    if (!TRANSPORT_CONFIG_KEY.test(key)) {
      throw pushError(
        "Cannot isolate Git transport configuration",
        "credential and transport configuration only",
        "unexpected key",
        "Inspect Git configuration and retry.",
      );
    }
    records.push(Object.freeze([key, value]));
    start = end + 1;
  }
  return Object.freeze(records);
}

async function createRemoteTransactionView(
  repository: RepositorySnapshot,
): Promise<RemoteTransactionView> {
  const config = (
    await Promise.all(["--system", "--global"].map(async (scope) => {
      let result;
      try {
        result = await repository.runner.run([
          "config",
          scope,
          "--null",
          "--get-regexp",
          TRANSPORT_CONFIG_PATTERN,
        ]);
      } catch (error) {
        throw pushError(
          "Cannot isolate Git transport configuration",
          "readable system and user transport configuration",
          "process failure",
          "Inspect Git configuration and retry.",
        );
      }
      if (result.timedOut || ![0, 1].includes(result.exitCode ?? -1)) {
        throw pushError(
          "Cannot isolate Git transport configuration",
          "readable system and user transport configuration",
          result.timedOut ? "timed out" : `git exit ${String(result.exitCode)}`,
          "Inspect Git configuration and retry.",
        );
      }
      if (result.exitCode === 1 && result.stdout.length !== 0) {
        throw pushError(
          "Cannot isolate Git transport configuration",
          "empty output when no transport configuration exists",
          "malformed output",
          "Inspect Git configuration and retry.",
        );
      }
      return parseTransportConfig(result.stdout);
    }))
  ).flat();
  const objectDirectory = await realpath(await readGitText(
    repository.runner,
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    "repository object directory",
  ));
  if (!(await stat(objectDirectory)).isDirectory()) {
    throw pushError(
      "Cannot isolate Git transport configuration",
      "a repository object directory",
      "not a directory",
      "Inspect repository object storage and retry.",
    );
  }
  const objectFormat = await readGitText(
    repository.runner,
    ["rev-parse", "--show-object-format"],
    "repository object format",
  );
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw pushError(
      "Cannot isolate Git transport configuration",
      "a supported repository object format",
      "unsupported object format",
      "Inspect repository object storage and retry.",
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "harness-mrtool-push-"));
  const gitDirectory = join(temporaryRoot, "git");
  const templateDirectory = join(temporaryRoot, "template");
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const baseEnvironment: Record<string, string | undefined> = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_CONFIG: nullDevice,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_WORK_TREE: undefined,
    XDG_CONFIG_HOME: join(temporaryRoot, "xdg"),
  };
  try {
    await Promise.all([
      mkdir(templateDirectory),
      mkdir(join(temporaryRoot, "xdg")),
    ]);
    await runGitChecked(
      repository.runner,
      [
        "init",
        "--bare",
        "--quiet",
        `--object-format=${objectFormat}`,
        `--template=${templateDirectory}`,
        gitDirectory,
      ],
      "isolated push repository",
      baseEnvironment,
    );
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
    GIT_CONFIG_COUNT: String(config.length),
    GIT_DIR: gitDirectory,
    GIT_OBJECT_DIRECTORY: objectDirectory,
  };
  config.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${String(index)}`] = key;
    environment[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  });
  return Object.freeze({
    async dispose(): Promise<void> {
      await rm(temporaryRoot, { force: true, recursive: true });
    },
    environment: Object.freeze(environment),
  });
}

async function withRemoteTransactionView<T>(
  repository: RepositorySnapshot,
  operation: (view: RemoteTransactionView) => Promise<T>,
): Promise<T> {
  const view = await createRemoteTransactionView(repository);
  try {
    return await operation(view);
  } finally {
    await view.dispose();
  }
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
    "Remote source branch SHA changed after push planning or during execution",
    {
      field: "sourceBranch",
      expected: "the planned local HEAD after push",
      actual,
      safeNextStep: "Create a fresh repository snapshot and push plan before retrying.",
    },
    cause,
  );
}

async function readRemoteSha(
  repository: RepositorySnapshot,
  environmentOverride: Readonly<Record<string, string | undefined>> = {},
): Promise<string | null> {
  let result;
  try {
    result = await repository.runner.run([
      "ls-remote",
      "--exit-code",
      "--refs",
      "--",
      repository.sourcePushUrl,
      repository.sourceRemoteRef,
    ], environmentOverride);
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
  const remoteSha = await withRemoteTransactionView(
    repository,
    async (view) => readRemoteSha(repository, view.environment),
  );
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
  if (plan.kind === "up-to-date") {
    await assertCleanWorktree(repository);
    await assertRepositoryUnchanged(repository);
    const remoteSha = await withRemoteTransactionView(
      repository,
      async (view) => readRemoteSha(repository, view.environment),
    );
    if (remoteSha !== repository.sourceHeadSha) {
      throw concurrentUpdateError(remoteSha ?? "absent");
    }
    return Object.freeze({
      kind: "not-written",
      beforeSha: plan.beforeSha,
      afterSha: remoteSha,
    });
  }
  if (
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
  const remoteView = await createRemoteTransactionView(repository);
  try {
    const remoteBefore = await readRemoteSha(repository, remoteView.environment);
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
      push = await repository.runner.run(exactCommand, remoteView.environment);
    } catch (error) {
      processFailure = error;
    }
    let remoteAfter: string | null;
    try {
      remoteAfter = await readRemoteSha(repository, remoteView.environment);
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
    if (push.exitCode !== 0 && remoteAfter === remoteBefore) {
      throw pushError(
        "Remote rejected the source branch push",
        repository.sourceHeadSha,
        remoteAfter ?? "absent",
        "Resolve the server rejection without force pushing, then retry.",
      );
    }
    throw concurrentUpdateError(remoteAfter ?? "absent");
  } finally {
    await remoteView.dispose();
  }
}
