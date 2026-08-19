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

function authenticationError(): ToolError<"AUTH_ERROR"> {
  return new ToolError("AUTH_ERROR", "A host-scoped GitLab credential is unavailable", {
    field: "gitlab.credential",
    expected: "one valid credential bound to the selected GitLab host",
    actual: "credential unavailable or invalid",
    safeNextStep: `Configure ${GITLAB_CREDENTIAL_HOST_ENV} and ${GITLAB_CREDENTIAL_TOKEN_ENV} for the selected host, then retry.`,
  });
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
      if (requestedHost === null) throw authenticationError();

      if (options.systemSource !== undefined) {
        let systemToken: string | null;
        try {
          systemToken = await options.systemSource.readToken(requestedHost);
        } catch {
          throw authenticationError();
        }
        if (systemToken !== null) {
          if (!validToken(systemToken)) throw authenticationError();
          return systemToken;
        }
      }

      const configuredHost = environment[GITLAB_CREDENTIAL_HOST_ENV];
      const environmentToken = environment[GITLAB_CREDENTIAL_TOKEN_ENV];
      if (
        configuredHost === undefined ||
        canonicalHost(configuredHost) !== requestedHost ||
        !validToken(environmentToken)
      ) {
        throw authenticationError();
      }
      return environmentToken;
    },
  });
}
