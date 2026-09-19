import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createProductionSkillCommandService } from "../../src/skill/production-service.ts";
import { createSigningFixture } from "../helpers/signing.ts";
import { createTestOnlyUpdateTrustConfig } from "../../src/update/trust-config.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "production-skill-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = createSigningFixture("fixture-skill-service-key");
  const trustConfig = createTestOnlyUpdateTrustConfig({
    repository: { owner: "fixture-owner", name: "harness-mrtool" },
    pagesOrigin: "http://127.0.0.1:43123",
    bootstrapKeys: [{ keyId: key.keyId, publicKeySpki: key.publicKeySpki, activeFromSequence: 1, revokedAtSequence: null }],
  });
  return { root, trustConfig };
}

test("default Skill service exposes private status without activating a user path", async (t) => {
  const f = await fixture(t);
  const service = createProductionSkillCommandService({
    cliVersion: "0.1.6",
    stateDirectory: resolve(f.root, "state"),
    defaultActivePath: resolve(f.root, "user", "harness-mr"),
    trustConfig: f.trustConfig,
    channelUrl: "https://fixture.example.test/stable.envelope.json",
    transport: { request: async () => { throw new Error("network unavailable"); } },
  });
  const status = await service.status();
  assert.equal(status.installedSkillVersion, null);
  assert.equal(status.stagedSkillVersion, null);
  await assert.rejects(service.install(resolve(f.root, "user", "harness-mr")));
  await assert.rejects(stat(resolve(f.root, "user", "harness-mr")), { code: "ENOENT" });
});
