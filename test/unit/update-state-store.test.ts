import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { canonicalizeJson, type JsonObject } from "../../src/contracts/jcs.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { createTrustState, type UpdateTrustState } from "../../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import {
  ProcessLockError,
  type ProcessLockProvider,
} from "../../src/platform/process-lock.ts";
import {
  MAX_UPDATE_STATE_BYTES,
  UpdateStateStore,
} from "../../src/update/state-store.ts";
import {
  canonicalPayload,
  createSigningFixture,
  signedEnvelope,
  type SigningFixture,
} from "../helpers/signing.ts";

const TRUST_CONFIG_SHA256 = "a".repeat(64);
const allowTestAcl = { verify: async (_path: string): Promise<void> => undefined };
const repository = { owner: "example-owner", name: "harness-mrtool" } as const;

function securityError(forbidden?: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal(isToolError(error, "UPDATE_SECURITY_ERROR"), true);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    if (forbidden !== undefined) assert.equal(rendered.includes(forbidden), false);
    return true;
  };
}

function persistenceError(forbidden?: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal(isToolError(error, "INTERNAL_ERROR"), true);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    if (forbidden !== undefined) assert.equal(rendered.includes(forbidden), false);
    return true;
  };
}

function serialLockProvider() {
  let tail = Promise.resolve();
  let maximumActive = 0;
  let active = 0;
  const paths: string[] = [];
  const provider: ProcessLockProvider = {
    async acquire(path) {
      paths.push(path);
      const predecessor = tail;
      let releaseGate!: () => void;
      tail = tail.then(() => new Promise<void>((resolveGate) => { releaseGate = resolveGate; }));
      await predecessor;
      let held = true;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return {
        assertHeld() {
          if (!held) throw new ProcessLockError("unavailable");
        },
        async release() {
          if (!held) return;
          held = false;
          active -= 1;
          releaseGate();
        },
      };
    },
  };
  return {
    provider,
    paths,
    maximumActive: () => maximumActive,
  };
}

function bootstrapKeys(fixture = createSigningFixture("release-key-1")) {
  return [{
    keyId: fixture.keyId,
    publicKeySpki: fixture.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }] as const;
}

function artifact(name: string, size: number): JsonObject {
  return { name, sha256: "a".repeat(64), size };
}

function manifest(
  key: SigningFixture,
  sequence = 42,
  issuedAt = "2026-08-13T08:00:00Z",
): JsonObject {
  return {
    manifestVersion: 1,
    sequence,
    channel: "stable",
    issuedAt,
    repository,
    components: {
      cli: {
        version: "1.2.3",
        tag: "cli-v1.2.3",
        inputSchemas: [1],
        policySchemas: [1],
        skillProtocols: [1],
        artifacts: { "windows-x64": artifact("harness-mrtool-windows-x64.zip", 12_345_678) },
      },
      templates: {
        version: "1.4.0",
        tag: "templates-v1.4.0",
        inputSchema: 1,
        policySchema: 1,
        minCliVersion: "1.2.0",
        asset: "harness-mr-templates.zip",
        sha256: "b".repeat(64),
        size: 45_678,
      },
      skill: {
        version: "1.1.0",
        tag: "skill-v1.1.0",
        skillProtocol: 1,
        cliVersionRange: ">=1.2.0 <2.0.0",
        asset: "harness-mr-skill.zip",
        sha256: "c".repeat(64),
        size: 12_345,
        activation: "explicit-host-refresh",
      },
    },
    releaseSet: { id: `stable-${String(sequence)}`, cli: "1.2.3", templates: "1.4.0" },
    security: {
      minimumAllowedCliVersion: "1.0.0",
      revokedCliVersions: [],
      revokedReleaseSetIds: [],
    },
    templateHistory: [{
      releaseTag: "templates-v1.4.0",
      bundleManifestHash: "d".repeat(64),
      receiptPayloadSha256: "e".repeat(64),
      signingSequence: 1,
      signingKeyId: key.keyId,
    }],
    recommendedSkillVersion: "1.1.0",
  };
}

function acceptState(
  signing: SigningFixture,
  keys: ReturnType<typeof bootstrapKeys>,
  prior: UpdateTrustState,
  sequence: number,
  issuedAt?: string,
): UpdateTrustState {
  return verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(signing, sequence, issuedAt)), [signing]),
    prior,
    repository,
    keys,
  ).nextTrustState;
}

async function stateFixture(t: { after(callback: () => void | Promise<void>): void }) {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-update-state-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const signing = createSigningFixture("release-key-1");
  const keys = bootstrapKeys(signing);
  return {
    stateDirectory,
    signing,
    keys,
    store: new UpdateStateStore({
      stateDirectory,
      trustConfigSha256: TRUST_CONFIG_SHA256,
      bootstrapKeys: keys,
      windowsAclVerifier: allowTestAcl,
      lockProvider: serialLockProvider().provider,
    }),
  };
}

test("returns null for a missing update state and prepares a private directory", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-update-state-"));
  await rm(stateDirectory, { recursive: true, force: true });
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const store = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: bootstrapKeys(),
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
  });

  assert.equal(await store.load(), null);
  const metadata = await lstat(stateDirectory);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o700);
});

test("saves canonical accepted state and loads immutable complete copies", async (t) => {
  const { store, signing, keys } = await stateFixture(t);
  const initial = createTrustState(keys);
  const envelope = signedEnvelope(canonicalPayload(manifest(signing)), [signing]);
  const trustState = verifyChannelEnvelope(
    envelope,
    initial,
    repository,
    keys,
  ).nextTrustState;
  const validators = { etag: "\"stable-42\"", lastModified: "Wed, 13 Aug 2026 08:00:00 GMT" };

  const saved = await store.save({ trustState, validators });
  validators.etag = "\"mutated\"";
  const serialized = await readFile(store.statePath, "utf8");
  assert.equal(serialized, `${canonicalizeJson(saved)}\n`);
  assert.equal(saved.stateVersion, 1);
  assert.equal(saved.trustConfigSha256, TRUST_CONFIG_SHA256);
  assert.equal(saved.trustState.acceptedChannelEnvelope, envelope);
  assert.equal(saved.validators.etag, "\"stable-42\"");
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.trustState), true);
  assert.equal(Object.isFrozen(saved.trustState.keys), true);
  assert.equal(Object.isFrozen(saved.validators), true);

  const first = await store.load();
  const second = await store.load();
  assert.deepEqual(first, saved);
  assert.deepEqual(second, saved);
  assert.notEqual(first, second);
  assert.notEqual(first?.trustState, saved.trustState);
  assert.equal(first?.trustState.acceptedChannelEnvelope, envelope);
  const replay = verifyChannelEnvelope(
    first!.trustState.acceptedChannelEnvelope!,
    first!.trustState,
    repository,
    keys,
  );
  assert.equal(replay.manifest.sequence, 42);
  assert.deepEqual(replay.nextTrustState, first!.trustState);
});

test("preserves sequence monotonicity and rejects same-sequence equivocation", async (t) => {
  const { store, signing, keys } = await stateFixture(t);
  const initial = createTrustState(keys);
  const accepted = acceptState(signing, keys, initial, 42);
  const validators = { etag: "\"stable-42\"", lastModified: null };
  await store.save({ trustState: accepted, validators });

  await assert.rejects(
    store.save({ trustState: initial, validators }),
    (error: unknown) => (error as { code?: string }).code === "UPDATE_SECURITY_ERROR",
  );
  assert.deepEqual((await store.load())?.trustState, accepted);

  const equivocation = acceptState(
    signing,
    keys,
    initial,
    42,
    "2026-08-13T08:00:01Z",
  );
  await assert.rejects(
    store.save({ trustState: equivocation, validators }),
    (error: unknown) => (error as { code?: string }).code === "UPDATE_SECURITY_ERROR",
  );
  assert.deepEqual((await store.load())?.trustState, accepted);

  const next = acceptState(signing, keys, accepted, 43);
  const saved = await store.save({
    trustState: next,
    validators: { etag: "\"stable-43\"", lastModified: null },
  });
  assert.equal(saved.trustState.highestSequence, 43);
  assert.equal((await store.load())?.trustState.highestSequence, 43);
});

test("independent writers serialize validation and atomic publication through the shared lock", async (t) => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-update-state-lock-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const signing = createSigningFixture("release-key-1");
  const keys = bootstrapKeys(signing);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  const lock = serialLockProvider();
  let blockWriters = false;
  let entered = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const faultInjector = {
    async hit(point: string): Promise<void> {
      if (!blockWriters || point !== "after-current-state-load") return;
      entered += 1;
      if (entered === 1) await firstGate;
    },
  };
  const options = {
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: lock.provider,
    faultInjector,
  };
  const firstStore = new UpdateStateStore(options);
  const secondStore = new UpdateStateStore(options);
  await firstStore.save({
    trustState: accepted,
    validators: { etag: "\"initial\"", lastModified: null },
  });

  blockWriters = true;
  const firstWrite = firstStore.save({
    trustState: accepted,
    validators: { etag: "\"first\"", lastModified: null },
  });
  for (let attempt = 0; attempt < 100 && entered === 0; attempt += 1) {
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 1));
  }
  assert.equal(entered, 1, "first writer did not enter the guarded critical section");
  const secondWrite = secondStore.save({
    trustState: accepted,
    validators: { etag: "\"second\"", lastModified: null },
  });
  await new Promise<void>((resolveTick) => setTimeout(resolveTick, 25));
  assert.equal(entered, 1, "second writer entered before the first lease was released");
  releaseFirst();
  await Promise.all([firstWrite, secondWrite]);

  assert.equal(entered, 2);
  assert.equal(lock.maximumActive(), 1);
  assert.ok(lock.paths.length >= 3);
  assert.equal(new Set(lock.paths).size, 1);
  assert.equal(lock.paths[0], resolve(stateDirectory, ".update.lock"));
  assert.equal((await secondStore.load())?.validators.etag, "\"second\"");
});

test("rejects a temporary-file identity swap before atomic publication", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const initial = createTrustState(keys);
  const accepted = acceptState(signing, keys, initial, 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const next = acceptState(signing, keys, accepted, 43);
  const lock = serialLockProvider();
  const attacked = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: lock.provider,
    faultInjector: {
      async hit(point) {
        if (point !== "before-publish") return;
        const temporaryName = (await readdir(stateDirectory)).find((entry) =>
          entry.startsWith("update-state.json.tmp."));
        assert.notEqual(temporaryName, undefined);
        const temporary = resolve(stateDirectory, temporaryName!);
        await rename(temporary, resolve(stateDirectory, "attacker-temp-moved"));
        await writeFile(temporary, "attacker-controlled-state\n", { mode: 0o600 });
      },
    },
  });

  await assert.rejects(
    attacked.save({
      trustState: next,
      validators: { etag: "\"stable-43\"", lastModified: null },
    }),
    (error: unknown) => (error as { code?: string }).code === "UPDATE_SECURITY_ERROR",
  );
  const loaded = await store.load();
  assert.equal(loaded?.trustState.highestSequence, 42);
  assert.equal(loaded?.validators.etag, "\"stable-42\"");
});

test("rejects destination identity drift before replacing the committed state", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const initial = createTrustState(keys);
  const accepted = acceptState(signing, keys, initial, 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const next = acceptState(signing, keys, accepted, 43);
  const priorPath = `${store.statePath}.prior`;
  const outside = resolve(stateDirectory, "outside-sentinel.txt");
  await writeFile(outside, "sentinel\n", { mode: 0o600 });
  const attacked = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
    faultInjector: {
      async hit(point) {
        if (point !== "before-publish") return;
        await rename(store.statePath, priorPath);
        await link(outside, store.statePath);
      },
    },
  });

  await assert.rejects(
    attacked.save({
      trustState: next,
      validators: { etag: "\"stable-43\"", lastModified: null },
    }),
    (error: unknown) => (error as { code?: string }).code === "UPDATE_SECURITY_ERROR",
  );
  assert.equal(await readFile(outside, "utf8"), "sentinel\n");
  await rm(store.statePath, { force: true });
  await rename(priorPath, store.statePath);
  assert.equal((await store.load())?.trustState.highestSequence, 42);
});

test("cleans bounded stale temporary files and rejects an excessive temp set", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const stale = `${store.statePath}.tmp.${"1".repeat(24)}`;
  await writeFile(stale, "stale\n", { mode: 0o600 });

  assert.equal((await store.load())?.trustState.highestSequence, 42);
  await assert.rejects(lstat(stale), /ENOENT/u);

  await Promise.all(Array.from({ length: 33 }, async (_unused, index) => {
    const suffix = index.toString(16).padStart(24, "0");
    await writeFile(`${store.statePath}.tmp.${suffix}`, "stale\n", { mode: 0o600 });
  }));
  await assert.rejects(
    store.load(),
    (error: unknown) => (error as { code?: string }).code === "UPDATE_SECURITY_ERROR",
  );
  assert.equal(await readFile(store.statePath, "utf8").then((value) => value.length > 0), true);
  assert.equal((await readdir(stateDirectory)).filter((entry) =>
    entry.startsWith("update-state.json.tmp.")).length, 33);
});

test("rejects a committed-file identity swap between rename and directory sync", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const initial = createTrustState(keys);
  const accepted = acceptState(signing, keys, initial, 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const next = acceptState(signing, keys, accepted, 43);
  const published = resolve(stateDirectory, "published-state-moved");
  const attacked = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
    faultInjector: {
      async hit(point) {
        if (point !== "after-publish") return;
        await rename(store.statePath, published);
        await writeFile(store.statePath, "attacker-controlled-state\n", { mode: 0o600 });
      },
    },
  });

  await assert.rejects(
    attacked.save({
      trustState: next,
      validators: { etag: "\"stable-43\"", lastModified: null },
    }),
    (error: unknown) => (error as { code?: string }).code === "UPDATE_SECURITY_ERROR",
  );
  await rm(store.statePath, { force: true });
  await rename(published, store.statePath);
  assert.equal((await store.load())?.trustState.highestSequence, 43);
});

test("rejects noncanonical, open, corrupt, and hash-only persisted documents without echoing contents", async (t) => {
  const { store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const original = await readFile(store.statePath, "utf8");
  const record = JSON.parse(original) as Record<string, unknown>;
  const openRecord = { ...record, unexpected: true };
  const hashOnly = structuredClone(record);
  (hashOnly.trustState as Record<string, unknown>).acceptedChannelEnvelope = null;
  const cases = [
    JSON.stringify(record, undefined, 2) + "\n",
    `${canonicalizeJson(openRecord)}\n`,
    '{"stateVersion":1,"stateVersion":1}\n',
    `${canonicalizeJson({ ...record, stateVersion: 2 })}\n`,
    `${canonicalizeJson(hashOnly)}\n`,
    '{"secret":"glpat-state-store-secret-123456"}\n',
    "{not-json\n",
  ];

  for (const serialized of cases) {
    await writeFile(store.statePath, serialized, { mode: 0o600 });
    await assert.rejects(
      store.load(),
      securityError("glpat-state-store-secret-123456"),
    );
  }
  await writeFile(store.statePath, original, { mode: 0o600 });
  assert.equal((await store.load())?.trustState.acceptedChannelEnvelope,
    accepted.acceptedChannelEnvelope);
});

test("rejects trust-config and bootstrap-key drift without changing persisted state", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const changedDigest = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: "b".repeat(64),
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
  });
  await assert.rejects(changedDigest.load(), securityError("b".repeat(64)));

  const otherKey = createSigningFixture("release-key-other");
  const changedKeys = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: bootstrapKeys(otherKey),
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
  });
  await assert.rejects(changedKeys.load(), securityError(otherKey.publicKeySpki));
  assert.deepEqual((await store.load())?.trustState, accepted);
});

test("rejects invalid validators, open save values, and oversized trust-state entry sets", async (t) => {
  const { store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  const validators = { etag: "\"stable-42\"", lastModified: null };
  await store.save({ trustState: accepted, validators });
  const invalidValidators = [
    { etag: "", lastModified: null },
    { etag: "x".repeat(4_097), lastModified: null },
    { etag: "bad\nheader", lastModified: null },
    { etag: null, lastModified: null, unexpected: true },
  ];
  for (const value of invalidValidators) {
    await assert.rejects(
      store.save({ trustState: accepted, validators: value as never }),
      securityError(),
    );
  }
  await assert.rejects(
    store.save({ trustState: accepted, validators, unexpected: true } as never),
    securityError(),
  );
  await assert.rejects(
    store.save({
      trustState: {
        ...accepted,
        keyRotationProofs: Array.from({ length: 33 }, () => accepted.acceptedChannelEnvelope!),
      },
      validators,
    }),
    securityError(),
  );
  assert.deepEqual((await store.load())?.trustState, accepted);
});

test("rejects a sparse state larger than the read cap before allocation", async (t) => {
  const { store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  await store.save({
    trustState: accepted,
    validators: { etag: null, lastModified: null },
  });
  const handle = await open(store.statePath, "w");
  try {
    await handle.truncate(MAX_UPDATE_STATE_BYTES + 1);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assert.rejects(store.load(), securityError());
});

test("creates a private state file and rejects hard-linked committed state", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  await store.save({
    trustState: accepted,
    validators: { etag: null, lastModified: null },
  });
  if (process.platform !== "win32") {
    assert.equal((await lstat(store.statePath)).mode & 0o777, 0o600);
  }
  const alias = resolve(stateDirectory, "update-state-alias.json");
  await link(store.statePath, alias);
  await assert.rejects(store.load(), securityError());
  await rm(alias);
  if (process.platform !== "win32") await chmod(store.statePath, 0o600);
  assert.equal((await store.load())?.trustState.highestSequence, 42);
});

test("rejects a committed-state symlink without reading or changing its target", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  await store.save({
    trustState: accepted,
    validators: { etag: null, lastModified: null },
  });
  const prior = `${store.statePath}.prior`;
  const outside = resolve(stateDirectory, "outside-state.json");
  await writeFile(outside, "sentinel\n", { mode: 0o600 });
  await rename(store.statePath, prior);
  try {
    await symlink(outside, store.statePath, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    await rename(prior, store.statePath);
    if ((error as NodeJS.ErrnoException).code === "EPERM" ||
        (error as NodeJS.ErrnoException).code === "EACCES") {
      t.skip("symbolic links are unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(store.load(), securityError());
  assert.equal(await readFile(outside, "utf8"), "sentinel\n");
  await rm(store.statePath);
  await rename(prior, store.statePath);
});

test("fsyncs before publish and keeps atomic old-or-new state across injected failures", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const initial = createTrustState(keys);
  const accepted = acceptState(signing, keys, initial, 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const next = acceptState(signing, keys, accepted, 43);
  const prePublish = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
    faultInjector: {
      hit(point) {
        if (point === "before-publish") throw new Error("SECRET_PREPUBLISH_CAUSE");
      },
    },
  });
  await assert.rejects(
    prePublish.save({
      trustState: next,
      validators: { etag: "\"stable-43\"", lastModified: null },
    }),
    persistenceError("SECRET_PREPUBLISH_CAUSE"),
  );
  assert.equal((await store.load())?.trustState.highestSequence, 42);
  assert.equal((await readdir(stateDirectory)).some((entry) =>
    /^update-state\.json\.tmp\.[a-f0-9]{24}$/u.test(entry)), false);

  const events: string[] = [];
  const postSync = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
    faultInjector: {
      hit(point) {
        events.push(point);
        if (point === "after-directory-sync") throw new Error("SECRET_POSTSYNC_CAUSE");
      },
    },
  });
  await assert.rejects(
    postSync.save({
      trustState: next,
      validators: { etag: "\"stable-43\"", lastModified: null },
    }),
    persistenceError("SECRET_POSTSYNC_CAUSE"),
  );
  assert.deepEqual(events, [
    "after-lock-acquired",
    "after-read-open",
    "after-current-state-load",
    "after-temp-open",
    "after-file-sync",
    "before-publish",
    "after-publish",
    "after-directory-sync",
  ]);
  assert.equal((await store.load())?.trustState.highestSequence, 43);
  assert.equal((await store.load())?.validators.etag, "\"stable-43\"");
});

test("rejects a hard-linked stale temp without changing its external target", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const accepted = acceptState(signing, keys, createTrustState(keys), 42);
  await store.save({
    trustState: accepted,
    validators: { etag: null, lastModified: null },
  });
  const outside = resolve(stateDirectory, "outside-temp-target");
  const stale = `${store.statePath}.tmp.${"f".repeat(24)}`;
  await writeFile(outside, "sentinel\n", { mode: 0o600 });
  await link(outside, stale);

  await assert.rejects(store.load(), securityError());
  assert.equal(await readFile(outside, "utf8"), "sentinel\n");
  assert.equal(await readFile(stale, "utf8"), "sentinel\n");
});

test("rejects a junction state root before acquiring the process lock", async (t) => {
  const container = await mkdtemp(resolve(tmpdir(), "harness-mrtool-state-link-"));
  const target = await mkdtemp(resolve(tmpdir(), "harness-mrtool-state-target-"));
  t.after(async () => Promise.all([
    rm(container, { recursive: true, force: true }),
    rm(target, { recursive: true, force: true }),
  ]).then(() => undefined));
  const linked = resolve(container, "state");
  try {
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" ||
        (error as NodeJS.ErrnoException).code === "EACCES") {
      t.skip("directory links are unavailable");
      return;
    }
    throw error;
  }
  let acquisitions = 0;
  const lockProvider: ProcessLockProvider = {
    async acquire() {
      acquisitions += 1;
      throw new Error("lock provider must not be reached");
    },
  };
  const store = new UpdateStateStore({
    stateDirectory: linked,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: bootstrapKeys(),
    windowsAclVerifier: allowTestAcl,
    lockProvider,
  });

  await assert.rejects(store.load(), (error: unknown) => isToolError(error, "INTERNAL_ERROR"));
  assert.equal(acquisitions, 0);
});

test("requires the Windows private-state ACL verifier and redacts verifier failures", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows ACL contract");
    return;
  }
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-state-acl-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  let verifications = 0;
  const store = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: bootstrapKeys(),
    windowsAclVerifier: {
      async verify() {
        verifications += 1;
      },
    },
    lockProvider: serialLockProvider().provider,
  });
  assert.equal(await store.load(), null);
  assert.ok(verifications >= 1);

  const failing = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: bootstrapKeys(),
    windowsAclVerifier: {
      async verify() {
        throw new Error("SECRET_ACL_CAUSE");
      },
    },
    lockProvider: serialLockProvider().provider,
  });
  await assert.rejects(failing.load(), persistenceError("SECRET_ACL_CAUSE"));
});

test("rejects replacement of the plain state root after lock acquisition", async (t) => {
  const { stateDirectory, store, signing, keys } = await stateFixture(t);
  const initial = createTrustState(keys);
  const accepted = acceptState(signing, keys, initial, 42);
  await store.save({
    trustState: accepted,
    validators: { etag: "\"stable-42\"", lastModified: null },
  });
  const next = acceptState(signing, keys, accepted, 43);
  const movedRoot = `${stateDirectory}.moved`;
  t.after(async () => rm(movedRoot, { recursive: true, force: true }));
  const attacked = new UpdateStateStore({
    stateDirectory,
    trustConfigSha256: TRUST_CONFIG_SHA256,
    bootstrapKeys: keys,
    windowsAclVerifier: allowTestAcl,
    lockProvider: serialLockProvider().provider,
    faultInjector: {
      async hit(point) {
        if (point !== "after-lock-acquired") return;
        await rename(stateDirectory, movedRoot);
        await mkdir(stateDirectory, { mode: 0o700 });
      },
    },
  });

  await assert.rejects(
    attacked.save({
      trustState: next,
      validators: { etag: "\"stable-43\"", lastModified: null },
    }),
    securityError(),
  );
  await assert.rejects(lstat(resolve(stateDirectory, "update-state.json")), /ENOENT/u);
  await rm(stateDirectory, { recursive: true, force: true });
  await rename(movedRoot, stateDirectory);
  assert.equal((await store.load())?.trustState.highestSequence, 42);
});
