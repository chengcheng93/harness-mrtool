import { ToolError } from "../contracts/errors.ts";

export const GITLAB_CREDENTIAL_HOST_ENV = "HARNESS_MRTOOL_GITLAB_HOST";
export const GITLAB_CREDENTIAL_TOKEN_ENV = "HARNESS_MRTOOL_GITLAB_TOKEN";

const MAX_TOKEN_LENGTH = 16 * 1024;

export interface GitLabSystemCredentialSource {
  readonly readToken: (host: string) => Promise<string | null>;
}

export interface HostScopedGitLabCredentialProvider {
  readonly tokenForHost: (host: string) => Promise<string>;
}

export interface HostScopedGitLabCredentialProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly systemSource?: GitLabSystemCredentialSource;
}

export type GitLabCredentialFailureReason =
  | "requested-host-invalid"
  | "host-missing"
  | "host-invalid"
  | "host-mismatch"
  | "token-missing"
  | "token-invalid"
  | "source-unavailable";

const credentialFailures: Readonly<Record<GitLabCredentialFailureReason, string>> = Object.freeze({
  "requested-host-invalid": "The selected GitLab host is invalid",
  "host-missing": "The local GitLab credential host is not configured",
  "host-invalid": "The local GitLab credential host is invalid",
  "host-mismatch": "The local GitLab credential belongs to another host",
  "token-missing": "The local GitLab API token is not configured",
  "token-invalid": "The local GitLab API token has an invalid format",
  "source-unavailable": "The local GitLab credential source could not be read",
});

const gitLabCredentialErrors = new WeakSet<object>();

/** Fixed, non-sensitive local diagnostics that are safe to preserve through HTTP adapters. */
export class GitLabCredentialError extends ToolError<"AUTH_ERROR"> {
  readonly reason: GitLabCredentialFailureReason;

  constructor(reason: GitLabCredentialFailureReason) {
    super("AUTH_ERROR", credentialFailures[reason], {
      field: "gitlab.credential",
      expected: "one valid local credential bound to the selected GitLab host",
      actual: reason,
      safeNextStep: `Run the plugin scripts/setup-gitlab.ps1 authorization guide, or rerun the Windows CLI installer with -SetupOnly, then harness-mrtool auth check --output json. Configure ${GITLAB_CREDENTIAL_HOST_ENV} and ${GITLAB_CREDENTIAL_TOKEN_ENV} in the current process if using environment credentials.`,
    });
    this.name = "GitLabCredentialError";
    this.reason = reason;
    gitLabCredentialErrors.add(this);
    Object.freeze(this.details);
    Object.freeze(this);
  }
}

export function isGitLabCredentialError(error: unknown): error is GitLabCredentialError {
  return (typeof error === "object" || typeof error === "function") &&
    error !== null && gitLabCredentialErrors.has(error);
}

function canonicalHost(value: string): string | null {
  if (value === "" || value !== value.trim() || /[\r\n\u0000/@]/u.test(value)) return null;
  try {
    const parsed = new URL(`https://${value}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.host.toLowerCase() !== value.toLowerCase()
    ) {
      return null;
    }
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function validToken(value: unknown): value is string {
  return typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= MAX_TOKEN_LENGTH &&
    !/[\r\n\u0000]/u.test(value);
}

export function createHostScopedGitLabCredentialProvider(
  options: HostScopedGitLabCredentialProviderOptions = {},
): HostScopedGitLabCredentialProvider {
  const environment = options.environment ?? process.env;
  return Object.freeze({
    async tokenForHost(host: string): Promise<string> {
      const requestedHost = canonicalHost(host);
      if (requestedHost === null) throw new GitLabCredentialError("requested-host-invalid");

      if (options.systemSource !== undefined) {
        let systemToken: string | null;
        try {
          systemToken = await options.systemSource.readToken(requestedHost);
        } catch {
          throw new GitLabCredentialError("source-unavailable");
        }
        if (systemToken !== null) {
          if (!validToken(systemToken)) throw new GitLabCredentialError("token-invalid");
          return systemToken;
        }
      }

      const configuredHost = environment[GITLAB_CREDENTIAL_HOST_ENV];
      const environmentToken = environment[GITLAB_CREDENTIAL_TOKEN_ENV];
      if (configuredHost === undefined || configuredHost === "") {
        throw new GitLabCredentialError("host-missing");
      }
      const boundHost = canonicalHost(configuredHost);
      if (boundHost === null) throw new GitLabCredentialError("host-invalid");
      if (boundHost !== requestedHost) throw new GitLabCredentialError("host-mismatch");
      if (environmentToken === undefined || environmentToken === "") {
        throw new GitLabCredentialError("token-missing");
      }
      if (!validToken(environmentToken)) throw new GitLabCredentialError("token-invalid");
      return environmentToken;
    },
  });
}
