import assert from "node:assert/strict";
import test from "node:test";

import { parseCliInvocation } from "../../src/cli/program.ts";
import { ToolError } from "../../src/contracts/errors.ts";
import type { JsonObject } from "../../src/contracts/jcs.ts";
import type { GitLabHttpRequest, GitLabHttpTransport } from "../../src/gitlab/http.ts";
import { runProductionMain } from "../../src/production-main.ts";

const secret = "preflight-secret-value";
const host = "gitlab.example.test";
const origin = `http://${host}`;
const environment = { HARNESS_MRTOOL_GITLAB_HOST: host, HARNESS_MRTOOL_GITLAB_TOKEN: secret };
const user = { id: 117, username: "developer", state: "active" };
const token = { user_id: 117, active: true, revoked: false, scopes: ["api"], expires_at: "2027-11-08" };
const project = { id: 258, path_with_namespace: "team/apps", permissions: { project_access: { access_level: 30 }, group_access: null } };

function fixture(responses: Readonly<Record<string, { readonly status?: number; readonly data: unknown }>> = {}) {
  const requests: GitLabHttpRequest[] = [];
  const transport: GitLabHttpTransport = {
    async request(request) {
      requests.push(request);
      const endpoint = new URL(request.url).pathname;
      const values: Readonly<Record<string, unknown>> = {
        "/api/v4/user": user,
        "/api/v4/personal_access_tokens/self": token,
        "/api/v4/projects/team%2Fapps": project,
      };
      const response = responses[endpoint] ?? { data: values[endpoint] };
      assert.notEqual(response.data, undefined, endpoint);
      return { status: response.status ?? 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(response.data)) };
    },
  };
  return { requests, transport };
}

async function run(arguments_: readonly string[], options: Parameters<typeof runProductionMain>[1] = {}) {
  let stdout = "";
  let stderr = "";
  let bundleLoads = 0;
  const code = await runProductionMain([...arguments_, "--output", "json"], {
    cwd: "/installation-without-a-repository",
    updatePreflight: { run: async () => {} },
    loadCurrentBundle: async () => { bundleLoads += 1; throw new Error("auth check must not load a Bundle"); },
    ...options,
    stdout: { write: chunk => { stdout += chunk; return true; } },
    stderr: { write: chunk => { stderr += chunk; return true; } },
  });
  assert.equal(bundleLoads, 0);
  assert.equal(stderr, "");
  assert.equal(stdout.includes(secret), false);
  return { code, output: JSON.parse(stdout) as { ok: boolean; code: string; error: { field: string; actual: string }; data: JsonObject; remoteWrite: { state: string; operations: string[] } } };
}

const remote = async () => ({ remote: "origin", endpoint: { origin, inferredApiScheme: false, identity: { host, path: "team/apps" } } });

test("auth check routes explicit origins and rejects credential-bearing or non-origin inputs without reflecting them", () => {
  assert.deepEqual(parseCliInvocation(["auth", "check", "--host", origin]).command, { kind: "auth.check", host: origin });
  for (const value of [host, `http://user:${secret}@${host}`, `${origin}/path`, `${origin}?query=1`, `${origin}#fragment`]) {
    assert.throws(() => parseCliInvocation(["auth", "check", "--host", value]), (error: unknown) => {
      assert.equal(error instanceof ToolError && error.code, "INPUT_ERROR");
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  }
});

test("production auth check verifies instance authorization immediately outside a repository without loading templates", async () => {
  const f = fixture();
  const result = await run(["auth", "check", "--host", origin], { authCheck: {
    environment, transport: f.transport,
    inspectRemote: async () => { throw new Error("explicit instance must not inspect the install repository"); },
  } });
  assert.equal(result.code, 0);
  assert.equal(result.output.ok, true);
  assert.deepEqual(result.output.data.project, { status: "not-checked", reason: "explicit-host" });
  assert.deepEqual(result.output.data.apiScope, { status: "verified", scopes: ["api"], expiresAt: "2027-11-08" });
  assert.equal(result.output.data.writePermission, "not-tested");
  assert.deepEqual(f.requests.map(r => r.method), ["GET", "GET"]);
  assert.equal(result.output.remoteWrite.state, "not-attempted");
});

test("repository auth check verifies Developer permission without inspecting branches, changes or workspace cleanliness", async () => {
  const f = fixture();
  const result = await run(["auth", "check"], { authCheck: { environment, transport: f.transport, inspectRemote: remote } });
  assert.equal(result.code, 0);
  assert.deepEqual(result.output.data.project, { status: "verified", id: 258, path: "team/apps", accessLevel: 30 });
  assert.deepEqual(f.requests.map(r => r.method), ["GET", "GET", "GET"]);
});

for (const projectSelected of [false, true]) {
  test(`auth check accepts api plus k8s_proxy for ${projectSelected ? "a project" : "an instance"} without writes`, async () => {
    const scopes = ["api", "read_api", "k8s_proxy"];
    const f = fixture({ "/api/v4/personal_access_tokens/self": { data: { ...token, scopes } } });
    const result = await run(["auth", "check", ...(projectSelected ? [] : ["--host", origin])], {
      authCheck: { environment, transport: f.transport, inspectRemote: remote },
    });
    assert.equal(result.code, 0);
    assert.equal(result.output.ok, true);
    assert.deepEqual(result.output.data.apiScope, { status: "verified", scopes, expiresAt: token.expires_at });
    assert.equal((result.output.data.project as JsonObject).status, projectSelected ? "verified" : "not-checked");
    assert.deepEqual(f.requests.map(r => r.method), projectSelected ? ["GET", "GET", "GET"] : ["GET", "GET"]);
    assert.deepEqual(result.output.remoteWrite, { state: "not-attempted", operations: [] });
  });
}

test("k8s_proxy does not replace the required api scope", async () => {
  const f = fixture({ "/api/v4/personal_access_tokens/self": { data: { ...token, scopes: ["k8s_proxy", "read_api"] } } });
  const result = await run(["auth", "check"], { authCheck: { environment, transport: f.transport, inspectRemote: remote } });
  assert.equal(result.output.code, "AUTH_ERROR");
  assert.equal(result.output.error.actual, "api-scope-missing");
  assert.deepEqual(f.requests.map(r => r.method), ["GET", "GET"]);
  assert.deepEqual(result.output.remoteWrite, { state: "not-attempted", operations: [] });
});

test("auth check still rejects malformed scope metadata without reflecting it or checking the project", async () => {
  for (const scopes of [null, "api", ["api", 8], ["api", ""], ["api", "a".repeat(65)],
    ["api", "K8S_PROXY"], ["api", "k8s-proxy"], ["api", "k8s_proxy\n"], ["api", secret]]) {
    const f = fixture({ "/api/v4/personal_access_tokens/self": { data: { ...token, scopes } } });
    const result = await run(["auth", "check"], { authCheck: { environment, transport: f.transport, inspectRemote: remote } });
    assert.equal(result.output.code, "GITLAB_ERROR");
    assert.equal(result.output.error.actual, "invalid authorization response");
    assert.deepEqual(f.requests.map(r => r.method), ["GET", "GET"]);
    assert.deepEqual(result.output.remoteWrite, { state: "not-attempted", operations: [] });
  }
});

test("numeric scope compatibility does not reflect a credential with valid scope characters", async () => {
  const reflectedCredential = "credential_with_digit8";
  const f = fixture({ "/api/v4/personal_access_tokens/self": { data: { ...token, scopes: ["api", reflectedCredential] } } });
  const result = await run(["auth", "check", "--host", origin], { authCheck: {
    environment: { ...environment, HARNESS_MRTOOL_GITLAB_TOKEN: reflectedCredential }, transport: f.transport,
  } });
  assert.equal(result.output.code, "GITLAB_ERROR");
  assert.equal(JSON.stringify(result.output).includes(reflectedCredential), false);
  assert.deepEqual(f.requests.map(r => r.method), ["GET", "GET"]);
  assert.deepEqual(result.output.remoteWrite, { state: "not-attempted", operations: [] });
});

test("outside a repository auth check can use the existing scoped host while ambiguous remotes are not hidden", async () => {
  const absent = new ToolError("REPOSITORY_ERROR", "No repository", { field: "repository root", expected: "repository", actual: "git exit 128", safeNextStep: "Select a repository." });
  const f = fixture();
  const result = await run(["auth", "check"], { authCheck: { environment, transport: f.transport, inspectRemote: async () => { throw absent; } } });
  assert.equal(result.code, 0);
  assert.deepEqual(result.output.data.project, { status: "not-checked", reason: "no-repository" });
  const ambiguous = new ToolError("REPOSITORY_ERROR", "Ambiguous remote", { field: "remote", expected: "one remote", actual: "2 configured remotes", safeNextStep: "Select a remote." });
  const failure = await run(["auth", "check"], { authCheck: { environment, transport: f.transport, inspectRemote: async () => { throw ambiguous; } } });
  assert.equal(failure.output.code, "REPOSITORY_ERROR");
});

test("missing local credentials are reported before any GitLab request", async () => {
  const f = fixture();
  const result = await run(["auth", "check", "--host", origin], { authCheck: { environment: {}, transport: f.transport } });
  assert.equal(result.output.code, "AUTH_ERROR");
  assert.equal(result.output.error.field, "gitlab.credential");
  assert.equal(result.output.error.actual, "host-missing");
  assert.equal(f.requests.length, 0);
});

test("auth check does not confuse authenticated read access with api scope or project write permission", async () => {
  for (const [data, actual] of [
    [{ ...token, scopes: ["read_api"] }, "api-scope-missing"],
    [{ ...token, active: false }, "token-inactive"],
  ] as const) {
    const f = fixture({ "/api/v4/personal_access_tokens/self": { data } });
    const result = await run(["auth", "check", "--host", origin], { authCheck: { environment, transport: f.transport } });
    assert.equal(result.output.code, "AUTH_ERROR");
    assert.equal(result.output.error.actual, actual);
  }
  const unsupported = fixture({ "/api/v4/personal_access_tokens/self": { status: 404, data: {} } });
  const unknown = await run(["auth", "check", "--host", origin], { authCheck: { environment, transport: unsupported.transport } });
  assert.equal(unknown.output.error.actual, "scope-unverified");
  const limited = fixture({ "/api/v4/projects/team%2Fapps": { data: { ...project, permissions: { project_access: { access_level: 20 }, group_access: null } } } });
  const denied = await run(["auth", "check"], { authCheck: { environment, transport: limited.transport, inspectRemote: remote } });
  assert.equal(denied.output.error.actual, "developer-access-missing");
});

test("auth check preserves remote authentication status and network classification without leaking credentials", async () => {
  for (const status of [401, 403]) {
    const f = fixture({ "/api/v4/user": { status, data: { message: secret } } });
    const result = await run(["auth", "check", "--host", origin], { authCheck: { environment, transport: f.transport } });
    assert.equal(result.output.code, "AUTH_ERROR");
    assert.equal(result.output.error.actual, `HTTP ${status}`);
    assert.equal(f.requests.length, 1);
  }
  const network = await run(["auth", "check", "--host", origin], { authCheck: { environment, transport: { request: async () => { throw new Error(secret); } } } });
  assert.equal(network.output.code, "GITLAB_ERROR");
  assert.equal(network.output.error.actual, "remote network");
});

test("auth check rejects SSH/offline invocations and reflected secrets without making remote writes", async () => {
  for (const flags of [["--auth", "ssh"], ["--offline"]]) {
    const f = fixture();
    const result = await run(["auth", "check", "--host", origin, ...flags], { authCheck: { environment, transport: f.transport } });
    assert.equal(result.output.ok, false);
    assert.equal(f.requests.length, 0);
    assert.equal(result.output.remoteWrite.state, "not-attempted");
  }
  const f = fixture({ "/api/v4/user": { data: { ...user, username: secret } } });
  const result = await run(["auth", "check", "--host", origin], { authCheck: { environment, transport: f.transport } });
  assert.equal(result.output.code, "GITLAB_ERROR");
});


test("authorization preflight remains available when update and installation recovery fail", async () => {
  const f = fixture();
  const forbidden = async (): Promise<never> => { throw new Error("unrelated dependency must not run"); };
  const result = await run(["auth", "check", "--host", origin], {
    updatePreflight: { run: forbidden },
    installationService: { recover: forbidden, apply: forbidden, rollback: forbidden },
    targetProjectResolver: { resolve: forbidden },
    authCheck: { environment, transport: f.transport, inspectRemote: forbidden },
  });
  assert.equal(result.code, 0);
  assert.equal(result.output.ok, true);
  assert.deepEqual(f.requests.map(r => r.method), ["GET", "GET"]);
});

test("an admin flag alone does not certify project write permission", async () => {
  const f = fixture({
    "/api/v4/user": { data: { ...user, is_admin: true } },
    "/api/v4/projects/team%2Fapps": { data: { ...project, permissions: { project_access: { access_level: 20 }, group_access: null } } },
  });
  const result = await run(["auth", "check"], { authCheck: { environment, transport: f.transport, inspectRemote: remote } });
  assert.equal(result.output.code, "AUTH_ERROR");
  assert.equal(result.output.error.actual, "developer-access-missing");
});


test("text authorization output shows scope verification and the untested project/write boundary", async () => {
  const f = fixture();
  let stdout = "";
  let stderr = "";
  const code = await runProductionMain(["auth", "check", "--host", origin], {
    cwd: "/installation-without-a-repository",
    authCheck: { environment, transport: f.transport },
    stdout: { write: chunk => { stdout += chunk; return true; } },
    stderr: { write: chunk => { stderr += chunk; return true; } },
  });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /API scope: verified \(api\)/u);
  assert.match(stdout, /Project permission: not-checked/u);
  assert.match(stdout, /Write permission: not-tested/u);
  assert.equal(stdout.includes(secret), false);
});

test("text authorization failures include the sanitized setup next step", async () => {
  const f = fixture();
  let stdout = "";
  let stderr = "";
  const code = await runProductionMain(["auth", "check", "--host", origin], {
    authCheck: { environment: {}, transport: f.transport },
    stdout: { write: chunk => { stdout += chunk; return true; } },
    stderr: { write: chunk => { stderr += chunk; return true; } },
  });
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /AUTH_ERROR:/u);
  assert.match(stderr, /Safe next step: .*setup-gitlab\.ps1/u);
  assert.equal(stderr.includes(secret), false);
  assert.equal(f.requests.length, 0);
});
