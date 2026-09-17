import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, type JsonObject } from "../../src/contracts/jcs.ts";
import { createTrustState } from "../../src/update/envelope.ts";
import type { ChannelHttpRequest, ChannelHttpResponse, ChannelHttpTransport } from "../../src/update/http.ts";
import { isVerifiedChannelManifest, verifyChannelEnvelope } from "../../src/update/manifest.ts";
import { createProductionChannelClient, type ProductionChannelClientOptions } from "../../src/update/production-channel.ts";
import { UpdateStateStore } from "../../src/update/state-store.ts";
import { PRODUCTION_UPDATE_CHANNEL_URL, updateTrustConfigSha256 } from "../../src/update/trust-config.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";
import { canonicalPayload, createSigningFixture, signedEnvelope } from "../helpers/signing.ts";

const channelUrl = "https://fixture.example.test/harness-mrtool/stable.envelope.json";
const allowTestAcl = { verify: async (_path: string): Promise<void> => undefined };
const lastModified = "Thu, 17 Sep 2026 00:00:00 GMT";

function securityError(error: unknown): boolean {
  assert.equal(isToolError(error, "UPDATE_SECURITY_ERROR"), true, String(error));
  return true;
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "production-channel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = resolve(root, "state");
  const signed = await exactReleaseFixture();
  const requests: ChannelHttpRequest[] = [];
  const envelope = (overrides: JsonObject = {}): string =>
    signedEnvelope(canonicalPayload({ ...signed.channelPayload, ...overrides }), [signed.signingKey]);
  let response: ChannelHttpResponse = {
    status: 200,
    headers: { etag: '"channel-42"', "last-modified": lastModified },
    body: Buffer.from(envelope()),
  };
  let beforeResponse: (() => Promise<void>) | undefined;
  let networkError = false;
  const transport: ChannelHttpTransport = {
    async request(request) {
      requests.push(request);
      await beforeResponse?.();
      if (networkError) throw new Error("Unreachable test transport");
      return response;
    },
  };
  const options: ProductionChannelClientOptions = {
    stateDirectory,
    trustConfig: signed.trustConfig,
    transport,
    channelUrl,
    windowsAclVerifier: allowTestAcl,
  };
  const store = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: updateTrustConfigSha256(signed.trustConfig),
    bootstrapKeys: signed.bootstrapKeys,
    windowsAclVerifier: allowTestAcl,
  });
  return {
    root, stateDirectory, signed, requests, envelope, options, store, transport,
    client: () => createProductionChannelClient(options),
    respond(next: ChannelHttpResponse) { response = next; },
    failNetwork() { networkError = true; },
    beforeResponse(callback: () => Promise<void>) { beforeResponse = callback; },
    stateBytes: () => readFile(store.statePath, "utf8"),
  };
}

test("constructing the channel client performs no filesystem or network work", async (t) => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal(typeof client.check, "function");
  assert.equal(f.requests.length, 0);
  await assert.rejects(access(f.stateDirectory), { code: "ENOENT" });
});

test("a signed 200 is persisted before returning a branded verified result", async (t) => {
  const f = await fixture(t);
  const result = await f.client().check(false);
  assert.equal(isVerifiedChannelManifest(result.verified), true);
  assert.equal(result.verified.manifest.sequence, 42);
  assert.equal(result.latestVersionConfirmed, true);
  assert.equal(result.reachable, true);
  const stored = await f.store.load();
  assert.equal(stored?.trustState.highestSequence, 42);
  assert.equal(stored?.trustState.acceptedChannelEnvelope, f.envelope());
  assert.deepEqual(stored?.validators, { etag: '"channel-42"', lastModified });
  assert.equal(f.requests[0]?.url, channelUrl);
  assert.equal(f.requests[0]?.headers["if-none-match"], undefined);
});

test("a fresh client re-verifies a persisted envelope on 304 and persists validators", async (t) => {
  const f = await fixture(t);
  await f.client().check(false);
  f.respond({ status: 304, headers: { etag: '"channel-42-refreshed"' }, body: new Uint8Array() });
  const result = await f.client().check(true);
  assert.equal(isVerifiedChannelManifest(result.verified), true);
  assert.equal(result.verified.manifest.sequence, 42);
  assert.equal(result.latestVersionConfirmed, true);
  assert.equal(result.reachable, true);
  assert.equal(f.requests[1]?.headers["if-none-match"], '"channel-42"');
  assert.equal(f.requests[1]?.headers["if-modified-since"], lastModified);
  assert.ok(f.requests[1]!.totalTimeoutMs > f.requests[0]!.totalTimeoutMs);
  assert.equal((await f.store.load())?.validators.etag, '"channel-42-refreshed"');
});

for (const seededValidators of [false, true]) {
  test(`untrusted 304 without an accepted envelope fails closed (validators=${seededValidators})`, async (t) => {
    const f = await fixture(t);
    if (seededValidators) {
      await f.store.save({
        trustState: createTrustState(f.signed.bootstrapKeys),
        validators: { etag: '"untrusted-validator"', lastModified: null },
      });
    }
    const before = seededValidators ? await f.stateBytes() : null;
    f.respond({ status: 304, headers: { etag: '"attacker-validator"' }, body: new Uint8Array() });
    await assert.rejects(f.client().check(false), securityError);
    if (before === null) await assert.rejects(access(f.store.statePath), { code: "ENOENT" });
    else assert.equal(await f.stateBytes(), before);
  });
}

for (const failure of ["network", "server", "rate-limited"] as const) {
  test(`unavailable ${failure} returns authenticated cache without claiming latest or overwriting state`, async (t) => {
    const f = await fixture(t);
    await f.client().check(false);
    const before = await f.stateBytes();
    if (failure === "network") f.failNetwork();
    else f.respond({ status: failure === "server" ? 503 : 429, headers: {}, body: new Uint8Array() });
    const result = await f.client().check(false);
    assert.equal(isVerifiedChannelManifest(result.verified), true);
    assert.equal(result.verified.manifest.sequence, 42);
    assert.equal(result.latestVersionConfirmed, false);
    assert.equal(result.reachable, false);
    assert.equal(await f.stateBytes(), before);
  });
}

test("unavailability without an accepted envelope is a typed failure, not latest success", async (t) => {
  const f = await fixture(t);
  f.failNetwork();
  await assert.rejects(f.client().check(false), (error: unknown) => isToolError(error, "UPDATE_REQUIRED"));
  await assert.rejects(access(f.store.statePath), { code: "ENOENT" });
});

for (const attack of ["invalid", "unsigned", "zero-signature", "wrong-key", "wrong-repository", "rollback", "equivocation", "http-404"] as const) {
  test(`${attack} fails closed without overwriting accepted signed state`, async (t) => {
    const f = await fixture(t);
    f.respond({ status: 200, headers: { etag: '"channel-43"' }, body: Buffer.from(f.envelope({ sequence: 43 })) });
    await f.client().check(false);
    const before = await f.stateBytes();
    let hostile = "not JSON";
    let status = 200;
    switch (attack) {
      case "invalid": break;
      case "unsigned": hostile = canonicalizeJson({ ...f.signed.channelPayload, sequence: 44 }); break;
      case "zero-signature": {
        // Use a newer, otherwise valid payload so rollback rejection cannot hide
        // a missing signature check.
        const parsed = JSON.parse(f.envelope({ sequence: 44 }));
        parsed.signatures[0].signature = Buffer.alloc(64).toString("base64url");
        hostile = `${canonicalizeJson(parsed)}\n`;
        break;
      }
      case "wrong-key": hostile = signedEnvelope(canonicalPayload({ ...f.signed.channelPayload, sequence: 44 }), [createSigningFixture(f.signed.signingKey.keyId)]); break;
      case "wrong-repository": hostile = f.envelope({ sequence: 44, repository: { owner: "other-owner", name: "harness-mrtool" } }); break;
      case "rollback": hostile = f.envelope(); break;
      case "equivocation": hostile = f.envelope({ sequence: 43, issuedAt: "2026-09-17T00:00:00Z" }); break;
      case "http-404": status = 404; hostile = "not found"; break;
    }
    f.respond({ status, headers: { etag: '"hostile"' }, body: Buffer.from(hostile) });
    await assert.rejects(f.client().check(false), securityError);
    assert.equal(await f.stateBytes(), before);
    assert.equal((await f.store.load())?.trustState.highestSequence, 43);
  });
}

test("a newer signed channel advances persistent trust across client restarts", async (t) => {
  const f = await fixture(t);
  await f.client().check(false);
  f.respond({ status: 200, headers: { etag: '"channel-43"' }, body: Buffer.from(f.envelope({ sequence: 43 })) });
  const result = await f.client().check(false);
  assert.equal(result.verified.manifest.sequence, 43);
  assert.equal((await f.store.load())?.trustState.highestSequence, 43);
});

test("tampered persisted envelope is rejected before requesting or falling back", async (t) => {
  const f = await fixture(t);
  await f.client().check(false);
  const state = JSON.parse(await f.stateBytes());
  state.trustState.acceptedChannelEnvelope = "{}\n";
  const hostile = `${canonicalizeJson(state)}\n`;
  await writeFile(f.store.statePath, hostile, { mode: 0o600 });
  f.respond({ status: 304, headers: {}, body: new Uint8Array() });
  await assert.rejects(f.client().check(false), securityError);
  assert.equal(f.requests.length, 1);
  assert.equal(await f.stateBytes(), hostile);
});

test("a storage publication failure never returns an apparently verified success", async (t) => {
  const f = await fixture(t);
  f.beforeResponse(async () => { await mkdir(f.store.statePath); });
  await assert.rejects(f.client().check(false), securityError);
});

test("forged trust configuration is rejected without filesystem or transport work", async (t) => {
  const f = await fixture(t);
  assert.throws(() => createProductionChannelClient({ ...f.options, trustConfig: { ...f.signed.trustConfig } }), securityError);
  assert.equal(f.requests.length, 0);
  await assert.rejects(access(f.stateDirectory), { code: "ENOENT" });
});

for (const invalidUrl of ["http://127.0.0.1:43123/stable.envelope.json", `${channelUrl}?extra=1`, "https://fixture.example.test:443/stable.envelope.json"]) {
  test(`in-process URL still requires canonical HTTPS: ${invalidUrl}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(async () => createProductionChannelClient({ ...f.options, channelUrl: invalidUrl }).check(false), securityError);
    assert.equal(f.requests.length, 0);
  });
}

test("omitted trust and URL use the fixed production roots, rejecting fixture signatures", async (t) => {
  const f = await fixture(t);
  const client = createProductionChannelClient({ stateDirectory: f.stateDirectory, transport: f.transport, windowsAclVerifier: allowTestAcl });
  await assert.rejects(client.check(false), securityError);
  assert.equal(f.requests[0]?.url, PRODUCTION_UPDATE_CHANNEL_URL);
  await assert.rejects(access(f.store.statePath), { code: "ENOENT" });
});

test("invalid force input is rejected before any state or network work", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client().check("true" as unknown as boolean), TypeError);
  assert.equal(f.requests.length, 0);
  await assert.rejects(access(f.stateDirectory), { code: "ENOENT" });
});


test("default state directory is resolved on first check, not at construction", async (t) => {
  const f = await fixture(t);
  const variable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_STATE_HOME";
  const original = process.env[variable];
  const { stateDirectory: _stateDirectory, ...options } = f.options;
  try {
    delete process.env[variable];
    const client = createProductionChannelClient(options);
    process.env[variable] = f.root;
    const result = await client.check(false);
    assert.equal(result.latestVersionConfirmed, true);
    const expected = process.platform === "win32"
      ? resolve(f.root, "harness-mrtool", "state", "update-state.json")
      : resolve(f.root, "harness-mrtool", "update-state.json");
    const stored = JSON.parse(await readFile(expected, "utf8"));
    assert.equal(stored.trustState.highestSequence, 42);
    await assert.rejects(access(f.stateDirectory), { code: "ENOENT" });
  } finally {
    if (original === undefined) delete process.env[variable];
    else process.env[variable] = original;
  }
});


test("unavailable fallback reloads newer authenticated state rather than returning a stale snapshot", async (t) => {
  const f = await fixture(t);
  await f.client().check(false);
  f.beforeResponse(async () => {
    const current = await f.store.load();
    assert.ok(current);
    const newer = verifyChannelEnvelope(f.envelope({ sequence: 43 }), current.trustState,
      f.signed.trustConfig.repository, f.signed.bootstrapKeys);
    await f.store.save({ trustState: newer.nextTrustState, validators: { etag: '\"channel-43\"', lastModified: null } });
  });
  f.failNetwork();
  const result = await f.client().check(false);
  assert.equal(result.verified.manifest.sequence, 43);
  assert.equal(result.latestVersionConfirmed, false);
  assert.equal(result.reachable, false);
});

test("a 304 racing a newer accepted channel cannot overwrite it or report stale latest success", async (t) => {
  const f = await fixture(t);
  await f.client().check(false);
  f.beforeResponse(async () => {
    const current = await f.store.load();
    assert.ok(current);
    const newer = verifyChannelEnvelope(f.envelope({ sequence: 43 }), current.trustState,
      f.signed.trustConfig.repository, f.signed.bootstrapKeys);
    await f.store.save({ trustState: newer.nextTrustState, validators: { etag: '\"channel-43\"', lastModified: null } });
  });
  f.respond({ status: 304, headers: { etag: '\"stale-42\"' }, body: new Uint8Array() });
  await assert.rejects(f.client().check(false), securityError);
  const stored = await f.store.load();
  assert.equal(stored?.trustState.highestSequence, 43);
  assert.equal(stored?.validators.etag, '\"channel-43\"');
});
