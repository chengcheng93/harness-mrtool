import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { assertUpdateLockLease, withUpdateLock } from "../../src/platform/lock.ts";
import { systemProcessLockProvider, type ProcessLockLease } from "../../src/platform/process-lock.ts";
import { createProductionChannelClient } from "../../src/update/production-channel.ts";
import type { ChannelHttpResponse } from "../../src/update/http.ts";
import { UpdateStateStore } from "../../src/update/state-store.ts";
import { updateTrustConfigSha256 } from "../../src/update/trust-config.ts";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";
import { canonicalPayload, signedEnvelope } from "../helpers/signing.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "channel-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = resolve(directory, "state");
  const signed = await exactReleaseFixture();
  const envelope = signedEnvelope(canonicalPayload(signed.channelPayload), [signed.signingKey]);
  const windowsAclVerifier = { verify: async (): Promise<void> => undefined };
  const store = new UpdateStateStore({ stateDirectory, bootstrapKeys: signed.bootstrapKeys,
    trustConfigSha256: updateTrustConfigSha256(signed.trustConfig), windowsAclVerifier });
  let requests = 0;
  let response: ChannelHttpResponse | Error = { status: 200, headers: { etag: '"42"' }, body: Buffer.from(envelope) };
  const client = createProductionChannelClient({ stateDirectory, trustConfig: signed.trustConfig, windowsAclVerifier,
    channelUrl: "https://fixture.example.test/stable.envelope.json",
    transport: { async request() { requests += 1; if (response instanceof Error) throw response; return response; } } });
  return { directory, stateDirectory, signed, store, client, requests: () => requests,
    respond: (next: ChannelHttpResponse | Error) => { response = next; } };
}

function countAcquisitions(t: TestContext) {
  const acquire = systemProcessLockProvider.acquire.bind(systemProcessLockProvider);
  let active = false;
  let count = 0;
  t.mock.method(systemProcessLockProvider, "acquire", async (path: string, timeout: number) => {
    assert.equal(active, false, "nested lock acquisition");
    const lease = await acquire(path, timeout); active = true; count += 1;
    return { assertHeld: () => lease.assertHeld(), async release() { try { await lease.release(); } finally { active = false; } } };
  });
  return () => count;
}

test("channel 200, 304 and unavailable fallback consume one branded outer lease", async t => {
  const f = await fixture(t);
  const count = countAcquisitions(t);
  await withUpdateLock(f.stateDirectory, async lease => {
    const changed = await f.client.check(false, lease);
    assert.equal(changed.verified.manifest.sequence, 42);
    assert.equal(changed.latestVersionConfirmed, true);
    assert.equal((await f.store.load(lease))?.trustState.highestSequence, 42);
    f.respond({ status: 304, headers: { etag: '"42-new-validator"' }, body: new Uint8Array() });
    const cached = await f.client.check(true, lease);
    assert.equal(cached.latestVersionConfirmed, true);
    assert.equal((await f.store.load(lease))?.validators.etag, '"42-new-validator"');
    f.respond(new Error("offline"));
    const offline = await f.client.check(false, lease);
    assert.equal(offline.latestVersionConfirmed, false);
    assert.equal(offline.reachable, false);
    assert.equal(offline.verified.manifest.sequence, 42);
    assertUpdateLockLease(lease, f.stateDirectory);
    assert.equal(count(), 1);
  });
  assert.equal(count(), 1);
  assert.equal(f.requests(), 3);
});

test("state save reuses its branded lease without releasing the owner", async t => {
  const f = await fixture(t);
  const count = countAcquisitions(t);
  await withUpdateLock(f.stateDirectory, async lease => {
    const result = await f.store.save({ trustState: f.signed.trustState, validators: { etag: null, lastModified: null } }, lease);
    assert.equal(result.trustState.highestSequence, 42);
    assert.deepEqual(await f.store.load(lease), result);
    assertUpdateLockLease(lease, f.stateDirectory);
    assert.equal(count(), 1);
  });
  assert.equal(count(), 1);
});

for (const operation of ["check", "save"] as const) {
  for (const invalid of ["foreign", "forged", "copied", "expired"] as const) {
    test(`${operation} rejects ${invalid} lease before network or state publication`, async t => {
      const f = await fixture(t);
      await f.client.check(false);
      const before = await readFile(f.store.statePath);
      const invoke = async (lease: ProcessLockLease) => {
        const requests = f.requests();
        await assert.rejects(operation === "check" ? f.client.check(false, lease) :
          f.store.save({ trustState: f.signed.trustState, validators: { etag: '"forbidden"', lastModified: null } }, lease));
        assert.equal(f.requests(), requests);
        assert.deepEqual(await readFile(f.store.statePath), before);
      };
      if (invalid === "expired") {
        let expired: ProcessLockLease | undefined;
        await withUpdateLock(f.stateDirectory, async lease => { expired = lease; });
        await invoke(expired!);
      } else {
        await withUpdateLock(invalid === "foreign" ? resolve(f.directory, "other") : f.stateDirectory, async lease => {
          await invoke(invalid === "forged" ? { assertHeld() {}, async release() {} } : invalid === "copied" ? { ...lease } : lease);
          assertUpdateLockLease(lease, invalid === "foreign" ? resolve(f.directory, "other") : f.stateDirectory);
        });
      }
    });
  }
}
