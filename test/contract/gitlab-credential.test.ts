import assert from "node:assert/strict";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import {
  createHostScopedGitLabCredentialProvider,
  GITLAB_CREDENTIAL_HOST_ENV,
  GITLAB_CREDENTIAL_TOKEN_ENV,
} from "../../src/platform/gitlab-credential.ts";

test("GitLab credential provider binds an automation token to one exact host", async () => {
  const token = "credential-canary-token";
  const provider = createHostScopedGitLabCredentialProvider({
    environment: {
      [GITLAB_CREDENTIAL_HOST_ENV]: "gitlab.example.test",
      [GITLAB_CREDENTIAL_TOKEN_ENV]: token,
    },
  });

  assert.equal(await provider.tokenForHost("gitlab.example.test"), token);
  await assert.rejects(
    provider.tokenForHost("other.example.test"),
    (error: unknown) =>
      isToolError(error, "AUTH_ERROR") &&
      !JSON.stringify(error).includes(token) &&
      !JSON.stringify(error).includes("other.example.test"),
  );
});

test("GitLab credential provider prefers the injected system source and validates tokens", async () => {
  const calls: string[] = [];
  const provider = createHostScopedGitLabCredentialProvider({
    environment: {
      [GITLAB_CREDENTIAL_HOST_ENV]: "gitlab.example.test",
      [GITLAB_CREDENTIAL_TOKEN_ENV]: "environment-token",
    },
    systemSource: {
      readToken: async (host) => {
        calls.push(host);
        return "system-token";
      },
    },
  });

  assert.equal(await provider.tokenForHost("gitlab.example.test"), "system-token");
  assert.deepEqual(calls, ["gitlab.example.test"]);

  const rejected = createHostScopedGitLabCredentialProvider({
    environment: {
      [GITLAB_CREDENTIAL_HOST_ENV]: "gitlab.example.test",
      [GITLAB_CREDENTIAL_TOKEN_ENV]: " credential-canary ",
    },
  });
  await assert.rejects(
    rejected.tokenForHost("gitlab.example.test"),
    (error: unknown) =>
      isToolError(error, "AUTH_ERROR") && !JSON.stringify(error).includes("credential-canary"),
  );
});
