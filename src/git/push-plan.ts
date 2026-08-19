import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isToolError, ToolError } from "../contracts/errors.ts";
import {
  assertCleanWorktree,
  assertObjectId,
  assertRepositoryUnchanged,
  readGitText,
  type RepositorySnapshot,
  runGitChecked,
} from "./repository.ts";
import { removeTemporaryDirectory } from "./runner.ts";

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

const ENDPOINT_AUTH_KEY = /^(credential|http)\.([A-Za-z][A-Za-z0-9-]*)$/u;
const ENDPOINT_CREDENTIAL_KEYS = new Set([
  "helper",
  "interactive",
  "oauthrefreshtoken",
  "passwordexpiryutc",
  "protectprotocol",
  "provider",
  "sanitizeprompt",
  "usehttppath",
  "username",
]);
const ENDPOINT_HTTP_KEYS = new Set([
  "cookiefile",
  "curloptresolve",
  "delegation",
  "emptyauth",
  "extraheader",
  "followredirects",
  "pinnedpubkey",
  "proactiveauth",
  "proxy",
  "proxyauthmethod",
  "proxysslcainfo",
  "proxysslcert",
  "proxysslcertpasswordprotected",
  "proxysslkey",
  "proxysslverify",
  "savecookies",
  "schannelcheckrevoke",
  "schannelusesslcainfo",
  "sslautoclientcert",
  "sslbackend",
  "sslcainfo",
  "sslcapath",
  "sslcert",
  "sslcertpasswordprotected",
  "sslcerttype",
  "sslcipherlist",
  "sslkey",
  "sslkeytype",
  "ssltry",
  "sslverify",
  "sslversion",
]);

function endpointAuthKeyAllowed(section: string, key: string): boolean {
  const canonicalKey = key.toLowerCase();
  return section === "credential"
    ? ENDPOINT_CREDENTIAL_KEYS.has(canonicalKey)
    : ENDPOINT_HTTP_KEYS.has(canonicalKey);
}

function parseEndpointAuthConfig(output: Buffer): readonly (readonly [string, string])[] {
  if (output.length === 0) return Object.freeze([]);
  if (output.at(-1) !== 0) {
    throw pushError(
      "Cannot isolate Git endpoint authentication configuration",
      "NUL-delimited key/value records",
      "malformed output",
      "Inspect Git configuration and retry.",
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: Array<readonly [string, string]> = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    let record: string;
    try {
      record = decoder.decode(output.subarray(start, end));
    } catch (error) {
      throw pushError(
        "Cannot isolate Git endpoint authentication configuration",
        "valid UTF-8 authentication configuration",
        "invalid bytes",
        "Inspect Git configuration and retry.",
      );
    }
    const separator = record.indexOf("\n");
    if (separator < 1) {
      throw pushError(
        "Cannot isolate Git endpoint authentication configuration",
        "NUL-delimited key/value records",
        "malformed output",
        "Inspect Git configuration and retry.",
      );
    }
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    const match = ENDPOINT_AUTH_KEY.exec(key);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw pushError(
        "Cannot isolate Git endpoint authentication configuration",
        "endpoint-matched credential and HTTP configuration only",
        "unexpected key",
        "Inspect Git configuration and retry.",
      );
    }
    if (endpointAuthKeyAllowed(match[1], match[2])) {
      records.push(Object.freeze([key, value]));
    }
    start = end + 1;
  }
  return Object.freeze(records);
}

function quoteGitConfigValue(value: string): string {
  if (value.includes("\u0000") || value.includes("\r")) {
    throw pushError(
      "Cannot isolate Git endpoint authentication configuration",
      "a serializable Git configuration value",
      "unsupported control character",
      "Remove the invalid authentication configuration and retry.",
    );
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\b", "\\b")}"`;
}

function renderEndpointAuthConfig(
  records: readonly (readonly [string, string])[],
  endpoint: string,
): string {
  return records.map(([key, value]) => {
    const match = ENDPOINT_AUTH_KEY.exec(key);
    if (
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      !endpointAuthKeyAllowed(match[1], match[2])
    ) {
      throw pushError(
        "Cannot isolate Git endpoint authentication configuration",
        "a supported authentication key",
        "unexpected key",
        "Inspect Git configuration and retry.",
      );
    }
    return `[${match[1]} ${quoteGitConfigValue(endpoint)}]\n` +
      `\t${match[2]} = ${quoteGitConfigValue(value)}\n`;
  }).join("");
}

async function readEndpointAuthConfig(
  repository: RepositorySnapshot,
): Promise<readonly (readonly [string, string])[]> {
  if (repository.sourceRemoteIdentity.kind !== "gitlab") return Object.freeze([]);
  let protocol: string;
  try {
    protocol = new URL(repository.sourcePushUrl).protocol;
  } catch {
    return Object.freeze([]);
  }
  if (protocol !== "http:" && protocol !== "https:") return Object.freeze([]);
  const records: Array<readonly [string, string]> = [];
  for (const scope of ["--system", "--global"] as const) {
    for (const section of ["credential", "http"] as const) {
      let result;
      try {
        result = await repository.runner.run([
          "config",
          scope,
          "--null",
          "--get-urlmatch",
          section,
          repository.sourcePushUrl,
        ]);
      } catch (error) {
        throw pushError(
          "Cannot isolate Git endpoint authentication configuration",
          "readable system and user authentication configuration",
          "process failure",
          "Inspect Git configuration and retry.",
        );
      }
      if (result.timedOut || ![0, 1].includes(result.exitCode ?? -1)) {
        throw pushError(
          "Cannot isolate Git endpoint authentication configuration",
          "readable system and user authentication configuration",
          result.timedOut ? "timed out" : `git exit ${String(result.exitCode)}`,
          "Inspect Git configuration and retry.",
        );
      }
      if (result.exitCode === 1 && result.stdout.length !== 0) {
        throw pushError(
          "Cannot isolate Git endpoint authentication configuration",
          "empty output when no endpoint configuration exists",
          "malformed output",
          "Inspect Git configuration and retry.",
        );
      }
      records.push(...parseEndpointAuthConfig(result.stdout));
    }
  }
  return Object.freeze(records);
}

async function createRemoteTransactionView(
  repository: RepositorySnapshot,
): Promise<RemoteTransactionView> {
  const config = await readEndpointAuthConfig(repository);
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
  const authConfigPath = join(temporaryRoot, "auth.gitconfig");
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
      writeFile(
        authConfigPath,
        renderEndpointAuthConfig(config, repository.sourcePushUrl),
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      ),
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
    try {
      await removeTemporaryDirectory(temporaryRoot);
    } catch (cleanupError) {
      throw pushError(
        "Cannot initialize isolated Git transport because temporary cleanup failed",
        "temporary authentication and Git state removed before returning",
        "temporary cleanup failed after initialization failed",
        "Close processes using temporary Git files, remove the temporary directory, and retry.",
        new AggregateError([error, cleanupError]),
      );
    }
    throw error;
  }
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
    GIT_CONFIG: undefined,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: config.length === 0 ? nullDevice : authConfigPath,
    GIT_DIR: gitDirectory,
    GIT_OBJECT_DIRECTORY: objectDirectory,
  };
  return Object.freeze({
    async dispose(): Promise<void> {
      await removeTemporaryDirectory(temporaryRoot);
    },
    environment: Object.freeze(environment),
  });
}

async function withRemoteTransactionView<T>(
  repository: RepositorySnapshot,
  operation: (view: RemoteTransactionView) => Promise<T>,
): Promise<T> {
  const view = await createRemoteTransactionView(repository);
  let operationError: unknown;
  try {
    return await operation(view);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await view.dispose();
    } catch (cleanupError) {
      if (operationError !== undefined) {
        throw remoteCleanupError(operationError, cleanupError);
      }
      throw pushError(
        "Cannot complete Git remote read because temporary cleanup failed",
        "temporary authentication and Git state removed before returning",
        "remote read completed; temporary cleanup failed",
        "Close processes using temporary Git files, remove the temporary directory, and retry.",
        cleanupError,
      );
    }
  }
}

function pushError(
  message: string,
  expected: string,
  actual: string,
  safeNextStep: string,
  cause?: unknown,
): ToolError<"REPOSITORY_ERROR"> {
  return new ToolError(
    "REPOSITORY_ERROR",
    message,
    {
      field: "sourceBranch",
      expected,
      actual,
      safeNextStep,
    },
    cause,
  );
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

function remoteCleanupError(
  operationError: unknown,
  cleanupError: unknown,
): ToolError {
  if (isToolError(operationError)) {
    return new ToolError(
      operationError.code,
      `${operationError.message}; temporary Git state cleanup also failed`,
      {
        ...operationError.details,
        actual: `${JSON.stringify(operationError.details.actual)}; temporary cleanup also failed`,
        safeNextStep: `${operationError.details.safeNextStep} Also close processes using temporary Git files and remove the temporary directory.`,
      },
      new AggregateError([operationError, cleanupError]),
    );
  }
  return pushError(
    "Git remote operation failed and temporary cleanup also failed",
    "a completed remote operation and all temporary authentication state removed",
    "remote operation failed; temporary cleanup also failed",
    "Close processes using temporary Git files, remove the temporary directory, and retry the remote operation.",
    new AggregateError([operationError, cleanupError]),
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
    ], environmentOverride, repository.sourceRemoteIdentity.kind === "local"
      ? [repository.sourceRemoteIdentity.fileIdentity]
      : []);
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
  let operationError: unknown;
  let verifiedRemoteSha: string | null = null;
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
      push = await repository.runner.run(
        exactCommand,
        remoteView.environment,
        repository.sourceRemoteIdentity.kind === "local"
          ? [repository.sourceRemoteIdentity.fileIdentity]
          : [],
      );
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
      verifiedRemoteSha = remoteAfter;
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
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await remoteView.dispose();
    } catch (cleanupError) {
      if (operationError !== undefined) {
        throw remoteCleanupError(operationError, cleanupError);
      }
      if (verifiedRemoteSha !== null) {
        throw partialRemoteError(
          "Remote source SHA was verified, but temporary Git state cleanup failed",
          `remote source SHA verified as ${verifiedRemoteSha}; temporary cleanup failed`,
          cleanupError,
        );
      }
      throw pushError(
        "Cannot complete Git remote transaction because temporary cleanup failed",
        "temporary authentication and Git state removed before returning",
        "remote transaction completed; temporary cleanup failed",
        "Close processes using temporary Git files, remove the temporary directory, and verify the remote source branch before retrying.",
        cleanupError,
      );
    }
  }
}
