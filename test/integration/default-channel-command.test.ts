import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runProductionMain } from "../../src/production-main.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";
import { canonicalPayload, signedEnvelope } from "../helpers/signing.ts";

const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });

async function fixture(t: test.TestContext) {
  const stateDirectory = await mkdtemp(resolve(await realpath(tmpdir()), "default-channel-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const signed = await exactReleaseFixture();
  const requests: string[] = [];
  let hostile = false;
  const defaults = {
    stateDirectory,
    trustConfig: signed.trustConfig,
    windowsAclVerifier: allowTestAcl,
    channelUrl: "https://fixture.example.test/harness-mrtool/stable.envelope.json",
    transport: { async request(input: { url: string }) {
      requests.push(input.url);
      return { status: 200, headers: {}, body: Buffer.from(hostile ? "{}" :
        signedEnvelope(canonicalPayload(signed.channelPayload), [signed.signingKey])) };
    } },
  };
  async function run(args: string[]) {
    let stdout = "", stderr = "";
    const code = await runProductionMain([...args, "--output", "json"], {
      // Keep the default command handler; imported runProductionMain does not
      // activate the direct-entry default preflight. Actual source invocation
      // is covered separately below. Only signing/transport/state seams vary here.
      updateChannelDefaults: defaults,
      stdout: { write: (s) => { stdout += s; return true; } },
      stderr: { write: (s) => { stderr += s; return true; } },
    });
    return { code, stderr, json: JSON.parse(stdout) };
  }
  return { run, requests, signed, makeHostile() { hostile = true; } };
}

test("default production self-update check authenticates the channel without installing anything", async (t) => {
  const f = await fixture(t);
  const result = await f.run(["self-update", "check"]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stderr, "");
  assert.equal(result.json.data.command, "self-update.check");
  assert.equal(result.json.data.availableCliVersion, "1.2.3");
  assert.deepEqual(result.json.data.availablePlatforms, ["windows-x64"]);
  assert.equal(result.json.update.reachable, true);
  assert.equal(result.json.update.latestVersionConfirmed, true);
  assert.equal(result.json.data.installed, false);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(result.json.remoteWrite, { state: "not-attempted", operations: [] });
});

test("default production channel command rejects unsigned responses", async (t) => {
  const f = await fixture(t);
  f.makeHostile();
  const result = await f.run(["self-update", "check"]);
  assert.notEqual(result.code, 0);
  assert.equal(result.json.code, "UPDATE_SECURITY_ERROR");
  assert.equal(f.requests.length, 1);
});

for (const flag of ["--offline", "--no-update"]) {
  test(`default channel check respects ${flag} without network or installation`, async (t) => {
    const f = await fixture(t);
    const result = await f.run(["self-update", "check", flag]);
    assert.notEqual(result.code, 0);
    assert.equal(result.json.code, "INPUT_ERROR");
    assert.deepEqual(f.requests, []);
  });
}

for (const flag of ["--offline", "--no-update"]) {
  test(`actual source entry rejects check ${flag} without creating private update state`, async (t) => {
    const root = await mkdtemp(resolve(await realpath(tmpdir()), "channel-source-entry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: resolve(root, "state"), LOCALAPPDATA: resolve(root, "appdata") };
    for (const key of Object.keys(env)) {
      if (/^(?:NODE_OPTIONS|NODE_TEST_CONTEXT|HARNESS_MRTOOL_GITLAB_TOKEN|HARNESS_MRTOOL_GITLAB_HOST)$/iu.test(key)) delete env[key];
    }
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      resolve(import.meta.dirname, "../../src/production-main.ts"), "self-update", "check", flag, "--output", "json"], {
      cwd: root, env, encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.code, "INPUT_ERROR");
    assert.equal(output.error.field, flag);
    assert.deepEqual(output.remoteWrite, { state: "not-attempted", operations: [] });
    assert.deepEqual(await readdir(root), [], "source preflight/disabled check must not bootstrap private state");
  });
}
