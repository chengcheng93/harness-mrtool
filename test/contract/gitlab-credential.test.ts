import assert from "node:assert/strict";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import {
  createHostScopedGitLabCredentialProvider,
  GITLAB_CREDENTIAL_HOST_ENV,
  GITLAB_CREDENTIAL_TOKEN_ENV,
  isGitLabCredentialError,
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

for (const [environment, host, reason] of [
  [{}, "gitlab.example.test", "host-missing"],
  [{ [GITLAB_CREDENTIAL_HOST_ENV]: "" }, "gitlab.example.test", "host-missing"],
  [{ [GITLAB_CREDENTIAL_HOST_ENV]: "https://gitlab.example.test" }, "gitlab.example.test", "host-invalid"],
  [{ [GITLAB_CREDENTIAL_HOST_ENV]: "other.example.test", [GITLAB_CREDENTIAL_TOKEN_ENV]: "canary" }, "gitlab.example.test", "host-mismatch"],
  [{ [GITLAB_CREDENTIAL_HOST_ENV]: "gitlab.example.test" }, "gitlab.example.test", "token-missing"],
  [{ [GITLAB_CREDENTIAL_HOST_ENV]: "gitlab.example.test", [GITLAB_CREDENTIAL_TOKEN_ENV]: "" }, "gitlab.example.test", "token-missing"],
  [{ [GITLAB_CREDENTIAL_HOST_ENV]: "gitlab.example.test", [GITLAB_CREDENTIAL_TOKEN_ENV]: " canary " }, "gitlab.example.test", "token-invalid"],
  [{}, "https://gitlab.example.test", "requested-host-invalid"],
] as const) {
  test(`local GitLab credential diagnostics distinguish ${reason} without reflecting configuration`, async () => {
    const provider = createHostScopedGitLabCredentialProvider({ environment });
    await assert.rejects(provider.tokenForHost(host), (error: unknown) => {
      assert.ok(isGitLabCredentialError(error));
      assert.equal(error.code, "AUTH_ERROR");
      assert.equal(error.reason, reason);
      assert.equal(error.details.actual, reason);
      assert.equal(error.details.field, "gitlab.credential");
      assert.match(error.details.safeNextStep, /auth check --output json/u);
      assert.doesNotMatch(JSON.stringify(error), /canary|other\.example\.test/u);
      return true;
    });
  });
}

test("system credential read failures remain local diagnostics without exposing causes", async () => {
  const provider = createHostScopedGitLabCredentialProvider({
    systemSource: { readToken: async () => { throw new Error("system-secret-canary"); } },
  });
  await assert.rejects(provider.tokenForHost("gitlab.example.test"), (error: unknown) => {
    assert.ok(isGitLabCredentialError(error));
    assert.equal(error.reason, "source-unavailable");
    assert.doesNotMatch(JSON.stringify(error), /system-secret-canary/u);
    assert.equal(error.cause, undefined);
    return true;
  });
});
