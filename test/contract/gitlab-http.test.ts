import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { GitLabClient } from "../../src/gitlab/client.ts";
import { GitLabHttpClient, isGitLabRequestError, normalizeGitLabOrigin } from "../../src/gitlab/http.ts";
import { createHostScopedGitLabCredentialProvider, GitLabCredentialError, isGitLabCredentialError } from "../../src/platform/gitlab-credential.ts";
import { FakeGitLab } from "../helpers/fake-gitlab.ts";

for (const origin of ["http://gitlab.example.test:8080", "https://gitlab.example.test"]) {
  test(`${origin} supports authenticated REST and GraphQL label discovery`, async () => {
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/7", { body: {
      id: 7, path_with_namespace: "group/project", default_branch: "develop",
      web_url: `${origin}/group/project`,
    } });
    fake.enqueue("GET", "/api/v4/projects/7/groups?with_shared=false&per_page=100&page=1", {
      headers: { "x-next-page": "" }, body: [],
    });
    fake.enqueue("GET", "/api/v4/projects/7/labels?include_ancestor_groups=false&per_page=100&page=1", {
      headers: { "x-next-page": "" }, body: [{
        id: 1, name: "type::bug", color: "#123456", description: "Bug fix", archived: false,
      }],
    });
    fake.enqueue("POST", "/api/graphql", { body: { data: { project: {
      id: "gid://gitlab/Project/7", fullPath: "group/project", labels: {
        nodes: [{ id: "gid://gitlab/ProjectLabel/1", title: "type::bug" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    } } } });
    const token = "http-contract-secret-canary";
    const api = new GitLabClient({ origin, tokenProvider: async () => token, transport: fake });

    const labels = await api.listLabels("7");

    assert.equal(api.origin, origin);
    assert.deepEqual(labels.map(({ name, globalId }) => ({ name, globalId })), [
      { name: "type::bug", globalId: "gid://gitlab/ProjectLabel/1" },
    ]);
    assert.equal(fake.requests.length, 4);
    assert.equal(fake.requests.every((request) => new URL(request.url).origin === origin), true);
    assert.equal(fake.requests.every((request) => request.headers["private-token"] === token), true);
    assert.equal(fake.requests.filter((request) => request.url.endsWith("/api/graphql")).length, 1);
    assert.doesNotMatch(JSON.stringify({ labels, audit: api.audit() }), /http-contract-secret-canary/u);
  });

  test(`${origin} rejects endpoint escapes before loading a credential`, async () => {
    let tokenReads = 0;
    let transportCalls = 0;
    const api = new GitLabHttpClient({
      origin,
      tokenProvider: async () => { tokenReads += 1; return "never-read-secret"; },
      transport: { request: async () => { transportCalls += 1; throw new Error("must not request"); } },
    });
    for (const endpoint of [
      "http://other.example.test/api/v4/user", "//other.example.test/api/v4/user",
      "/api/v4/../admin", "/api/v4/../../outside", "/api/\\other.example.test/user",
    ]) {
      await assert.rejects(api.requestJson("GET", endpoint), TypeError);
    }
    assert.equal(tokenReads, 0);
    assert.equal(transportCalls, 0);
  });
}

test("HTTP and HTTPS origins canonicalize independently of the deprecated loopback option", () => {
  for (const legacyOption of [undefined, false, true]) {
    assert.equal(normalizeGitLabOrigin("http://GITLAB.example.test:8080/", legacyOption), "http://gitlab.example.test:8080");
    assert.equal(normalizeGitLabOrigin("https://GITLAB.example.test:443/", legacyOption), "https://gitlab.example.test");
  }
});

test("origin validation rejects unsupported schemes, credentials, and non-origin URL components", () => {
  for (const origin of [
    "ftp://gitlab.example.test", "ssh://gitlab.example.test", "file:///gitlab", "gitlab.example.test",
    "http://user:secret@gitlab.example.test", "https://user@gitlab.example.test",
    "http://gitlab.example.test/api", "https://gitlab.example.test/?query=1",
    "http://gitlab.example.test/#fragment",
  ]) {
    assert.throws(() => normalizeGitLabOrigin(origin), (error: unknown) => isToolError(error, "GITLAB_ERROR"));
  }
});

test("HTTP transport refuses redirects without sending the credential to another origin or leaking it", async (t) => {
  const receivedTokens: (string | undefined)[] = [];
  let redirectedRequests = 0;
  const sink = createServer((_request, response) => {
    redirectedRequests += 1;
    response.end("{}");
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => sink.close((error) => error ? reject(error) : resolve())));
  const sinkAddress = sink.address();
  assert.ok(sinkAddress !== null && typeof sinkAddress === "object");
  const token = "redirect-secret-canary";
  const redirect = createServer((request, response) => {
    receivedTokens.push(request.headers["private-token"] as string | undefined);
    response.writeHead(302, { location: `http://127.0.0.1:${sinkAddress.port}/api/v4/${token}` });
    response.end();
  });
  await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => redirect.close((error) => error ? reject(error) : resolve())));
  const address = redirect.address();
  assert.ok(address !== null && typeof address === "object");
  const api = new GitLabHttpClient({ origin: `http://127.0.0.1:${address.port}`, tokenProvider: async () => token });

  await assert.rejects(api.requestJson("GET", "/api/v4/user"), (error: unknown) => {
    assert.equal(isToolError(error, "GITLAB_ERROR"), true);
    assert.doesNotMatch(inspect(error, { depth: 10 }), /redirect-secret-canary/u);
    assert.doesNotMatch(JSON.stringify(error), /redirect-secret-canary/u);
    return true;
  });
  assert.deepEqual(receivedTokens, [token]);
  assert.equal(redirectedRequests, 0);
});

test("HTTP credential preflight preserves trusted local errors and never contacts GitLab", async () => {
  const credential = createHostScopedGitLabCredentialProvider({ environment: {} });
  let calls = 0;
  const api = new GitLabHttpClient({
    origin: "https://gitlab.example.test",
    tokenProvider: () => credential.tokenForHost("gitlab.example.test"),
    transport: { request: async () => { calls += 1; throw new Error("must not contact GitLab"); } },
  });
  await assert.rejects(api.requestJson("GET", "/api/v4/user"), (error: unknown) => {
    assert.ok(isGitLabCredentialError(error));
    assert.equal(error.reason, "host-missing");
    assert.equal(error.details.field, "gitlab.credential");
    assert.doesNotMatch(error.message, /rejected|permission|remote/u);
    return true;
  });
  assert.equal(calls, 0);

  const original = new GitLabCredentialError("token-missing");
  const throwing = new GitLabHttpClient({
    origin: "https://gitlab.example.test", tokenProvider: async () => { throw original; },
  });
  await assert.rejects(throwing.requestJson("GET", "/api/v4/user"), (error: unknown) => error === original);
});

test("untrusted credential provider failures and malformed tokens are local, sanitized failures", async () => {
  for (const [tokenProvider, reason] of [
    [async () => { throw new Error("provider-secret-canary"); }, "source-unavailable"],
    [async () => " provider-secret-canary ", "token-invalid"],
  ] as const) {
    let calls = 0;
    const api = new GitLabHttpClient({
      origin: "https://gitlab.example.test", tokenProvider,
      transport: { request: async () => { calls += 1; throw new Error("must not contact GitLab"); } },
    });
    await assert.rejects(api.requestJson("GET", "/api/v4/user"), (error: unknown) => {
      assert.ok(isGitLabCredentialError(error));
      assert.equal(error.reason, reason);
      assert.doesNotMatch(inspect(error, { depth: 10 }), /provider-secret-canary/u);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 0);
  }
});

for (const status of [401, 403]) {
  test(`remote HTTP ${status} keeps its status and actionable authentication diagnostic`, async () => {
    const token = "http-auth-secret-canary";
    let calls = 0;
    const api = new GitLabHttpClient({
      origin: "https://gitlab.example.test", tokenProvider: async () => token,
      transport: { request: async () => {
        calls += 1;
        return { status, headers: { "x-request-id": "req-auth" }, body: new TextEncoder().encode(token) };
      } },
    });
    await assert.rejects(api.requestJson("GET", "/api/v4/user"), (error: unknown) => {
      assert.ok(isGitLabRequestError(error));
      assert.equal(error.code, "AUTH_ERROR");
      assert.equal(error.kind, "auth");
      assert.equal(error.status, status);
      assert.equal(error.details.actual, `HTTP ${status}; request-id req-auth`);
      assert.match(error.message, new RegExp(`HTTP ${status}`, "u"));
      assert.match(error.details.safeNextStep, status === 401 ? /expired or revoked/u : /scope.*permission/u);
      assert.doesNotMatch(inspect(error, { depth: 10 }), /http-auth-secret-canary/u);
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const name of ["Error", "AbortError"]) {
  test(`transport ${name} remains a network failure without suggesting credential rejection`, async () => {
    const api = new GitLabHttpClient({
      origin: "https://gitlab.example.test", tokenProvider: async () => "network-secret-canary",
      transport: { request: async () => { const error = new Error("network-secret-canary"); error.name = name; throw error; } },
    });
    await assert.rejects(api.requestJson("GET", "/api/v4/user"), (error: unknown) => {
      assert.ok(isGitLabRequestError(error));
      assert.equal(error.code, "GITLAB_ERROR");
      assert.equal(error.kind, name === "AbortError" ? "timeout" : "network");
      assert.equal(error.status, null);
      assert.doesNotMatch(error.message, /credential|permission|rejected/u);
      assert.doesNotMatch(inspect(error, { depth: 10 }), /network-secret-canary/u);
      return true;
    });
  });
}

test("error-message whitespace normalization cannot reconstruct the active credential", async () => {
  const token = "opaque active credential";
  let calls = 0;
  const api = new GitLabHttpClient({origin: "https://gitlab.example.test", tokenProvider: async () => token, transport: {async request() {
    calls += 1;
    return {status: 400, headers: {"x-request-id": "req-normalized"}, body: new TextEncoder().encode(JSON.stringify({message: "opaque \n active credential"}))};
  }}});
  await assert.rejects(api.requestJson("GET", "/api/v4/user"), (error: unknown) => {
    assert.ok(isGitLabRequestError(error));
    assert.equal(error.status, 400);
    assert.equal(error.requestId, "req-normalized");
    assert.equal(error.remoteMessage, null);
    assert.equal(inspect(error, {depth: 10}).includes(token), false);
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
  assert.equal(calls, 1);
});
