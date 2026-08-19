import { resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonValue } from "../contracts/jcs.ts";
import { GitLabClient } from "../gitlab/client.ts";
import type { GitLabHttpTransport } from "../gitlab/http.ts";
import type { GitLabProject } from "../gitlab/types.ts";
import {
  readGitText,
  type GitLabProjectIdentity,
} from "../git/repository.ts";
import {
  GitRunner,
  type GitRunnerOptions,
  type ProcessRunner,
} from "../git/runner.ts";
import {
  createHostScopedGitLabCredentialProvider,
  type HostScopedGitLabCredentialProvider,
} from "../platform/gitlab-credential.ts";

const REMOTE_NAME = /^(?!-)[A-Za-z0-9._-]+$/u;

export interface ResolvedTargetProject {
  readonly identity: GitLabProjectIdentity;
  readonly project: GitLabProject;
  readonly targetRemote: string;
}

export interface TargetGitLabSession extends ResolvedTargetProject {
  readonly assertNoCredentialExposure: (value: unknown) => void;
  readonly gitlab: GitLabClient;
  readonly origin: string;
}

export interface TargetProjectResolver {
  readonly resolve: (options: { readonly cwd: string }) => Promise<ResolvedTargetProject>;
}

export interface TargetGitLabSessionResolver {
  readonly resolve: (options: { readonly cwd: string }) => Promise<TargetGitLabSession>;
}

export interface GitLabTargetProjectResolverOptions {
  readonly credentials?: HostScopedGitLabCredentialProvider;
  readonly gitRunnerOptions?: GitRunnerOptions;
  readonly maxResponseBytes?: number;
  readonly processRunner?: ProcessRunner;
  readonly targetRemote?: string;
  readonly timeoutMs?: number;
  readonly transport?: GitLabHttpTransport;
}

interface NormalizedGitLabRemote {
  readonly identity: GitLabProjectIdentity;
  readonly origin: string;
}

function repositoryError(
  message: string,
  actual: string,
  safeNextStep: string,
): ToolError<"REPOSITORY_ERROR"> {
  return new ToolError("REPOSITORY_ERROR", message, {
    field: "remote",
    expected: "one canonical credential-free GitLab target remote",
    actual,
    safeNextStep,
  });
}

function credentialExposureError(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "GitLab response failed credential isolation", {
    field: "gitlab.response",
    expected: "credential-free canonical GitLab response data",
    actual: "unsafe GitLab response data",
    safeNextStep: "Retry after removing credential reflection from GitLab metadata.",
  });
}

function credentialExposureAssertion(
  credentials: ReadonlySet<string>,
): TargetGitLabSession["assertNoCredentialExposure"] {
  return (value: unknown): void => {
    let copied: JsonValue;
    try {
      copied = copyJsonValue(value as JsonValue, "$gitlabResponse");
    } catch {
      throw credentialExposureError();
    }
    const visit = (entry: JsonValue): void => {
      if (typeof entry === "string") {
        if ([...credentials].some((credential) => entry.includes(credential))) {
          throw credentialExposureError();
        }
        return;
      }
      if (Array.isArray(entry)) {
        entry.forEach(visit);
        return;
      }
      if (entry !== null && typeof entry === "object") {
        for (const [key, child] of Object.entries(entry)) {
          if ([...credentials].some((credential) => key.includes(credential))) {
            throw credentialExposureError();
          }
          visit(child);
        }
      }
    };
    visit(copied);
  };
}

function normalizedProjectPath(value: string): string | null {
  let path = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const segments = path.split("/");
  return path === "" || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : path;
}

function normalizedRemote(hostValue: string, pathValue: string, origin: string): NormalizedGitLabRemote {
  const host = hostValue.toLowerCase();
  const path = normalizedProjectPath(pathValue);
  if (host === "" || path === null) {
    throw repositoryError(
      "Selected remote URL does not identify one GitLab project",
      "unrecognized remote URL",
      "Configure one canonical GitLab fetch/push URL for the selected remote and retry.",
    );
  }
  return Object.freeze({
    identity: Object.freeze({ host, path }),
    origin,
  });
}

function normalizeGitLabRemote(value: string): NormalizedGitLabRemote {
  if (value === "" || value.includes("\u0000") || /[\r\n]/u.test(value)) {
    throw repositoryError(
      "Selected remote URL is invalid",
      "invalid remote URL",
      "Configure one canonical GitLab fetch/push URL for the selected remote and retry.",
    );
  }
  if (/^[A-Za-z]:/u.test(value)) {
    throw repositoryError(
      "Selected remote URL does not identify one GitLab project",
      "local filesystem path",
      "Configure one canonical GitLab fetch/push URL for the selected remote and retry.",
    );
  }
  const scpLike = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/u.exec(value);
  if (scpLike !== null && !value.includes("://")) {
    const host = scpLike[1];
    const path = scpLike[2];
    if (host !== undefined && path !== undefined) {
      return normalizedRemote(host, path, `https://${host.toLowerCase()}`);
    }
  }
  try {
    const url = new URL(value);
    if (
      url.password !== "" ||
      ((url.protocol === "http:" || url.protocol === "https:") && url.username !== "") ||
      !["git:", "http:", "https:", "ssh:"].includes(url.protocol) ||
      ((url.protocol === "git:" || url.protocol === "ssh:") && url.port !== "") ||
      url.hash !== "" ||
      url.search !== ""
    ) {
      throw new TypeError("unsupported Git remote URL");
    }
    const origin = url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : `https://${url.host.toLowerCase()}`;
    return normalizedRemote(url.host, url.pathname, origin);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw repositoryError(
      "Selected remote URL does not identify one GitLab project",
      "unrecognized remote URL",
      "Configure one canonical GitLab fetch/push URL for the selected remote and retry.",
    );
  }
}

async function configuredRemotes(runner: GitRunner): Promise<readonly string[]> {
  return (await readGitText(runner, ["remote"], "configured remotes"))
    .split(/\r?\n/u)
    .filter((remote) => remote !== "");
}

function selectRemote(remotes: readonly string[], requested: string | undefined): string {
  if (requested === undefined) {
    if (remotes.length !== 1 || remotes[0] === undefined) {
      throw repositoryError(
        "Git remote selection is ambiguous",
        `${String(remotes.length)} configured remotes`,
        "Configure or select exactly one target remote, then retry.",
      );
    }
    return remotes[0];
  }
  if (!REMOTE_NAME.test(requested) || !remotes.includes(requested)) {
    throw repositoryError(
      "Selected Git remote is not configured",
      "invalid or unconfigured remote",
      "Select one configured remote by name and retry.",
    );
  }
  return requested;
}

async function remoteUrl(runner: GitRunner, remote: string, push: boolean): Promise<string> {
  const output = await readGitText(
    runner,
    ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
    push ? "target remote push URL" : "target remote fetch URL",
  );
  const values = output.split(/\r?\n/u).filter((value) => value !== "");
  if (values.length !== 1 || values[0] === undefined) {
    throw repositoryError(
      "Selected remote URL is ambiguous",
      `${String(values.length)} configured URLs`,
      "Configure one canonical fetch URL and one canonical push URL, then retry.",
    );
  }
  return values[0];
}

async function inspectTargetRemote(
  cwd: string,
  options: GitLabTargetProjectResolverOptions,
): Promise<{ readonly remote: string; readonly endpoint: NormalizedGitLabRemote }> {
  const initialRunner = new GitRunner(cwd, options.processRunner, options.gitRunnerOptions);
  const root = resolve(await readGitText(
    initialRunner,
    ["rev-parse", "--show-toplevel"],
    "repository root",
  ));
  const runner = new GitRunner(root, options.processRunner, options.gitRunnerOptions);
  const remote = selectRemote(await configuredRemotes(runner), options.targetRemote);
  const [fetchUrl, pushUrl] = await Promise.all([
    remoteUrl(runner, remote, false),
    remoteUrl(runner, remote, true),
  ]);
  const fetch = normalizeGitLabRemote(fetchUrl);
  const push = normalizeGitLabRemote(pushUrl);
  if (
    fetch.identity.host !== push.identity.host ||
    fetch.identity.path !== push.identity.path
  ) {
    throw repositoryError(
      "Selected remote fetch and push URLs identify different projects",
      "different fetch/push identities",
      "Configure fetch and push URLs for the same GitLab project, then retry.",
    );
  }
  return Object.freeze({ endpoint: fetch, remote });
}

export function createGitLabTargetProjectResolver(
  options: GitLabTargetProjectResolverOptions = {},
): TargetProjectResolver {
  const sessions = createGitLabTargetSessionResolver(options);
  return Object.freeze({
    async resolve({ cwd }: { readonly cwd: string }): Promise<ResolvedTargetProject> {
      const session = await sessions.resolve({ cwd });
      session.assertNoCredentialExposure(session.project);
      return Object.freeze({
        identity: session.identity,
        project: session.project,
        targetRemote: session.targetRemote,
      });
    },
  });
}

export function createGitLabTargetSessionResolver(
  options: GitLabTargetProjectResolverOptions = {},
): TargetGitLabSessionResolver {
  const credentials = options.credentials ?? createHostScopedGitLabCredentialProvider();
  return Object.freeze({
    async resolve({ cwd }: { readonly cwd: string }): Promise<TargetGitLabSession> {
      const target = await inspectTargetRemote(cwd, options);
      const usedCredentials = new Set<string>();
      const assertNoCredentialExposure = credentialExposureAssertion(usedCredentials);
      const client = new GitLabClient({
        origin: target.endpoint.origin,
        tokenProvider: async () => {
          const token = await credentials.tokenForHost(target.endpoint.identity.host);
          usedCredentials.add(token);
          return token;
        },
        ...(options.transport === undefined ? {} : { transport: options.transport }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
        allowInsecureLoopback: target.endpoint.origin.startsWith("http://"),
      });
      const resolvedProject = await client.getProject(target.endpoint.identity.path);
      const identity = Object.freeze({
        host: target.endpoint.identity.host,
        path: target.endpoint.identity.path,
      });
      const project = Object.freeze({
        id: resolvedProject.id,
        fullPath: resolvedProject.fullPath,
        defaultBranch: resolvedProject.defaultBranch,
        webUrl: resolvedProject.webUrl,
      });
      const session = Object.freeze({
        assertNoCredentialExposure,
        gitlab: client,
        identity,
        origin: target.endpoint.origin,
        project,
        targetRemote: target.remote,
      });
      assertNoCredentialExposure({
        identity: session.identity,
        origin: session.origin,
        project: session.project,
        targetRemote: session.targetRemote,
      });
      return session;
    },
  });
}
