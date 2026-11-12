import { isToolError, ToolError } from "../../contracts/errors.ts";
import type { JsonObject, JsonValue } from "../../contracts/jcs.ts";
import { GitLabHttpClient, isGitLabRequestError, type GitLabHttpTransport } from "../../gitlab/http.ts";
import {
  createHostScopedGitLabCredentialProvider,
  GITLAB_CREDENTIAL_HOST_ENV,
  GitLabCredentialError,
  type HostScopedGitLabCredentialProvider,
} from "../../platform/gitlab-credential.ts";
import type { CliCommandHandlers } from "../execute.ts";
import { inspectGitLabTargetRemote, type GitLabTargetProjectResolverOptions } from "../target-project.ts";

export interface AuthCheckOptions {
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly credentials?: HostScopedGitLabCredentialProvider;
  readonly transport?: GitLabHttpTransport;
  readonly remoteOptions?: GitLabTargetProjectResolverOptions;
  readonly inspectRemote?: typeof inspectGitLabTargetRemote;
}

function responseError(): ToolError<"GITLAB_ERROR"> {
  return new ToolError("GITLAB_ERROR", "GitLab authorization probe returned an invalid response", {
    field: "gitlab.authorization", expected: "a consistent credential-free authorization response",
    actual: "invalid authorization response", safeNextStep: "Verify the GitLab instance and retry auth check; no write was attempted.",
  });
}

function authorizationError(field: string, reason: string, message: string): ToolError<"AUTH_ERROR"> {
  return new ToolError("AUTH_ERROR", message, {
    field, expected: "an active API token and, when a project is selected, Developer access or higher",
    actual: reason,
    safeNextStep: "Run the plugin scripts/setup-gitlab.ps1 guide, or rerun the Windows CLI installer with -SetupOnly; configure a token with api scope for this instance, and rerun harness-mrtool auth check --output json. Project checks also require Developer access or higher.",
  });
}

function record(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw responseError();
  return value;
}
function positiveId(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw responseError();
  return value;
}

function inferredOrigin(host: string): string {
  try {
    const origin = new URL(`http://${host}`);
    if (host === "" || host !== host.trim() || /[\r\n\u0000/@]/u.test(host) || origin.username !== "" ||
        origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
        origin.host.toLowerCase() !== host.toLowerCase()) throw new TypeError();
    return origin.origin;
  } catch { throw new GitLabCredentialError("host-invalid"); }
}

function mayUseHttps(error: unknown): boolean {
  return isGitLabRequestError(error) && (error.kind === "network" || error.kind === "timeout" ||
    (error.kind === "http" && error.status !== null && [301, 302, 303, 307, 308, 404, 405, 426].includes(error.status)));
}

/** Read-only authorization preflight: intentionally independent of templates, diffs and branch state. */
export function createAuthCheckCommandHandlers(options: AuthCheckOptions): CliCommandHandlers {
  return Object.freeze({
    "auth.check": async (invocation) => {
      if (invocation.options.authMode === "ssh") {
        throw authorizationError("authMode", "ssh-is-not-api", "GitLab API authorization cannot be checked with SSH authentication");
      }
      if (invocation.options.offline) {
        throw new ToolError("INPUT_ERROR", "GitLab authorization requires an online check", {
          field: "--offline", expected: "online auth check", actual: "offline authorization cannot be verified",
          safeNextStep: "Remove --offline and rerun harness-mrtool auth check --output json.",
        });
      }
      const environment = options.environment ?? process.env;
      let origin: string;
      let inferred = false;
      let projectPath: string | null = null;
      let projectReason = "explicit-host";
      if (invocation.command.host !== null) {
        origin = invocation.command.host;
      } else {
        try {
          const target = await (options.inspectRemote ?? inspectGitLabTargetRemote)(options.cwd, options.remoteOptions ?? {});
          origin = target.endpoint.origin;
          inferred = target.endpoint.inferredApiScheme;
          projectPath = target.endpoint.identity.path;
        } catch (error) {
          // Only an absent Git worktree permits an instance-only environment fallback.
          // Ambiguous or unsafe configured remotes must still fail visibly.
          if (!isToolError(error, "REPOSITORY_ERROR") || error.details.field !== "repository root" ||
              error.details.actual !== "git exit 128") throw error;
          const host = environment[GITLAB_CREDENTIAL_HOST_ENV];
          if (host === undefined || host === "") throw new GitLabCredentialError("host-missing");
          origin = inferredOrigin(host);
          inferred = true;
          projectReason = "no-repository";
        }
      }
      const credentials = options.credentials ?? createHostScopedGitLabCredentialProvider({ environment });
      const usedTokens = new Set<string>();
      const tokenProvider = async () => {
        const token = await credentials.tokenForHost(new URL(origin).host);
        usedTokens.add(token.toLowerCase());
        return token;
      };
      const httpFor = () => new GitLabHttpClient({ origin, tokenProvider,
        ...(options.transport === undefined ? {} : { transport: options.transport }) });
      let http = httpFor();
      let userData: JsonValue;
      try { userData = (await http.requestJson("GET", "/api/v4/user")).data; }
      catch (error) {
        if (!inferred || !mayUseHttps(error)) throw error;
        origin = `https://${new URL(origin).host}`;
        http = httpFor();
        userData = (await http.requestJson("GET", "/api/v4/user")).data;
      }
      const user = record(userData);
      const userId = positiveId(user.id);
      if (typeof user.username !== "string" || !/^[A-Za-z0-9_.-]{1,255}$/u.test(user.username)) throw responseError();
      if (user.state !== "active") throw authorizationError("gitlab.user", "account-inactive", "The GitLab account is not active");
      let tokenData: JsonValue;
      try { tokenData = (await http.requestJson("GET", "/api/v4/personal_access_tokens/self")).data; }
      catch (error) {
        if (isGitLabRequestError(error) && error.kind === "http" && error.status !== null && [404, 405].includes(error.status)) {
          throw authorizationError("gitlab.scope", "scope-unverified", "GitLab authenticated the account, but this instance cannot verify the token API scope");
        }
        throw error;
      }
      const token = record(tokenData);
      if (token.active !== true || token.revoked === true) {
        throw authorizationError("gitlab.scope", "token-inactive", "The GitLab API token is inactive or revoked");
      }
      if (token.user_id !== undefined && positiveId(token.user_id) !== userId) throw responseError();
      if (!Array.isArray(token.scopes) || token.scopes.some(scope => typeof scope !== "string" || !/^[a-z0-9_]{1,64}$/u.test(scope))) throw responseError();
      const scopes = token.scopes as string[];
      if (!scopes.includes("api")) {
        throw authorizationError("gitlab.scope", "api-scope-missing", "The GitLab token does not have the api scope required for MR operations");
      }
      const expiresAt = token.expires_at;
      if (expiresAt !== null && (typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(expiresAt))) throw responseError();
      let project: JsonObject = { status: "not-checked", reason: projectReason };
      if (projectPath !== null) {
        const selected = record((await http.requestJson("GET", `/api/v4/projects/${encodeURIComponent(projectPath)}`)).data);
        const projectId = positiveId(selected.id);
        if (selected.path_with_namespace !== projectPath) throw responseError();
        const permissions = record(selected.permissions ?? null);
        const access = (value: JsonValue | undefined): number => {
          if (value === null || value === undefined) return 0;
          const level = record(value).access_level;
          if (typeof level !== "number" || !Number.isSafeInteger(level) || level < 0 || level > 50) throw responseError();
          return level;
        };
        const accessLevel = Math.max(access(permissions.project_access), access(permissions.group_access));
        if (accessLevel < 30) {
          throw authorizationError("gitlab.permission", "developer-access-missing", "The GitLab account needs Developer access or higher for the selected project");
        }
        project = { status: "verified", id: projectId, path: projectPath, accessLevel };
      }
      const data: JsonObject = {
        command: "auth.check", origin, authenticated: true,
        user: { id: userId, username: user.username },
        apiScope: { status: "verified", scopes: [...scopes], expiresAt },
        project, writePermission: "not-tested",
      };
      // Output contains only selected metadata; still reject reflection of any used credential.
      const serialized = JSON.stringify(data).toLowerCase();
      if ([...usedTokens].some(value => serialized.includes(value))) throw responseError();
      return { output: { message: "GitLab API authorization verified", data } };
    },
  });
}
