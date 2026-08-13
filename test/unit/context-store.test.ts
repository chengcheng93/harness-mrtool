import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import {
  CandidateContextStore,
  type ContextClock,
  type ContextRandomSource,
} from "../../src/context/store.ts";
import {
  CANDIDATE_CONTEXT_TTL_MS,
  type ContextBinding,
  type IssueContextInput,
} from "../../src/context/types.ts";
import { candidateTokenDigest } from "../../src/context/tokens.ts";
import { ensurePrivateStateDirectory } from "../../src/platform/state-path.ts";

class FakeClock implements ContextClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }

  set(value: number): void {
    this.value = value;
  }
}

class CounterRandom implements ContextRandomSource {
  private counter = 0;

  randomBytes(length: number): Uint8Array {
    assert.equal(length, 32);
    this.counter += 1;
    const bytes = new Uint8Array(length);
    bytes.fill(this.counter);
    return bytes;
  }
}

const binding: ContextBinding = {
  operation: "create",
  gitlabOrigin: "https://gitlab.example.com",
  targetProject: { id: "100", fullPath: "group/project" },
  targetBranch: "develop",
  sourceHeadSha: "a".repeat(40),
  mrIid: null,
  releaseSetId: "stable-42",
  cliVersion: "1.2.3",
  bundle: {
    id: "harness-mr-default",
    version: "1.0.0",
    releaseTag: "templates-v1.0.0",
    manifestHash: "b".repeat(64),
  },
  protocols: { inputSchema: 1, policySchema: 1, skillProtocol: 1 },
};

const snapshot = {
  snapshotVersion: 1,
  targetProject: { id: "100", path: "group/project" },
  sourceHeadSha: "a".repeat(40),
  labelCandidates: [
    { id: "gid://gitlab/ProjectLabel/10", name: "type::bug" },
  ],
  userCandidates: [
    { id: "20", username: "reviewer" },
  ],
};

const issueInput: IssueContextInput = {
  binding,
  snapshot,
  candidates: [
    {
      kind: "label",
      restId: 10,
      globalId: "gid://gitlab/ProjectLabel/10",
      name: "type::bug",
      description: "Bug fix",
      color: "#ff0000",
      scopeKind: "project",
      scopeId: "100",
      scopePath: "group/project",
      policyCategory: "type",
    },
    {
      kind: "assignee",
      userId: "20",
      globalId: "gid://gitlab/User/20",
      username: "reviewer",
      displayName: "Reviewer",
    },
    {
      kind: "reviewer",
      userId: "20",
      globalId: "gid://gitlab/User/20",
      username: "reviewer",
      displayName: "Reviewer",
    },
  ],
};

async function fixture(context: test.TestContext) {
  const directory = await context.mock.method(
    { create: async () => import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(resolve(tmpdir(), "hmr-context-"))) },
    "create",
  )();
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const clock = new FakeClock(Date.UTC(2026, 7, 14, 0, 0, 0));
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 1_000,
  });
  return { directory, clock, store };
}

test("issues 256-bit opaque tokens while persisting only their SHA-256 digests", async (context) => {
  const { directory, store } = await fixture(context);
  const issued = await store.issue(issueInput);

  assert.match(issued.contextId, /^hmrx1_[A-Za-z0-9_-]{43}$/u);
  assert.equal(issued.expiresAtMs - issued.createdAtMs, CANDIDATE_CONTEXT_TTL_MS);
  assert.equal(issued.candidates.length, 3);
  for (const candidate of issued.candidates) {
    assert.match(candidate.token, /^hmrc1_[A-Za-z0-9_-]{43}$/u);
  }

  const persisted = await readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8");
  for (const candidate of issued.candidates) {
    assert.equal(persisted.includes(candidate.token), false);
    assert.equal(persisted.includes(candidateTokenDigest(candidate.token)), true);
  }
  assert.equal(persisted.includes('"token"'), false);
  assert.equal(persisted.includes("hmrc1_"), false);
});

test("resolves only tokens matching context, host, project, kind, release, Bundle and protocol", async (context) => {
  const { store } = await fixture(context);
  const issued = await store.issue(issueInput);
  const label = issued.candidates.find((candidate) => candidate.kind === "label");
  assert.ok(label);

  const resolved = await store.resolve({
    contextId: issued.contextId,
    expectedBinding: binding,
    selections: [{ token: label.token, kind: "label" }],
  });
  assert.deepEqual(resolved.snapshot, snapshot);
  assert.equal(resolved.candidates[0]?.kind, "label");

  const mismatches: ContextBinding[] = [
    { ...binding, gitlabOrigin: "https://other.example.com" },
    { ...binding, targetProject: { ...binding.targetProject, id: "101" } },
    { ...binding, operation: "update", mrIid: 51 },
    { ...binding, targetBranch: "main" },
    { ...binding, sourceHeadSha: "d".repeat(40) },
    { ...binding, releaseSetId: "stable-43" },
    { ...binding, bundle: { ...binding.bundle, manifestHash: "c".repeat(64) } },
    { ...binding, protocols: { ...binding.protocols, inputSchema: 2 } },
    { ...binding, protocols: { ...binding.protocols, policySchema: 2 } },
    { ...binding, protocols: { ...binding.protocols, skillProtocol: 2 } },
  ];
  for (const expectedBinding of mismatches) {
    await assert.rejects(
      store.resolve({
        contextId: issued.contextId,
        expectedBinding,
        selections: [{ token: label.token, kind: "label" }],
      }),
      (error: unknown) => isToolError(error, "INPUT_ERROR", /context.*scope/i),
    );
  }
  await assert.rejects(
    store.resolve({
      contextId: issued.contextId,
      expectedBinding: binding,
      selections: [{ token: label.token, kind: "reviewer" }],
    }),
    (error: unknown) => isToolError(error, "INPUT_ERROR", /candidate.*kind/i),
  );
});

test("expires the entire context at exactly thirty minutes and removes it", async (context) => {
  const { directory, clock, store } = await fixture(context);
  const issued = await store.issue(issueInput);
  const label = issued.candidates[0];
  assert.ok(label);

  clock.advance(CANDIDATE_CONTEXT_TTL_MS - 1);
  await store.resolve({
    contextId: issued.contextId,
    expectedBinding: binding,
    selections: [{ token: label.token, kind: label.kind }],
  });
  clock.advance(1);
  await assert.rejects(
    store.resolve({
      contextId: issued.contextId,
      expectedBinding: binding,
      selections: [{ token: label.token, kind: label.kind }],
    }),
    (error: unknown) => isToolError(error, "INPUT_ERROR", /expired/i),
  );
  const persisted = JSON.parse(await readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8"));
  assert.deepEqual(persisted.contexts, []);
});

test("batch consume is all-or-nothing and prevents replay", async (context) => {
  const { directory, store } = await fixture(context);
  const issued = await store.issue(issueInput);
  const [first, second] = issued.candidates;
  assert.ok(first);
  assert.ok(second);

  await assert.rejects(
    store.resolve({
      contextId: issued.contextId,
      expectedBinding: binding,
      consume: true,
      selections: [
        { token: first.token, kind: first.kind },
        { token: "hmrc1_" + "A".repeat(43), kind: second.kind },
      ],
    }),
    (error: unknown) => isToolError(error, "INPUT_ERROR", /unknown candidate/i),
  );

  await store.resolve({
    contextId: issued.contextId,
    expectedBinding: binding,
    consume: true,
    selections: [
      { token: first.token, kind: first.kind },
      { token: second.token, kind: second.kind },
    ],
  });
  await assert.rejects(
    store.resolve({
      contextId: issued.contextId,
      expectedBinding: binding,
      consume: true,
      selections: [{ token: first.token, kind: first.kind }],
    }),
    (error: unknown) => isToolError(error, "INPUT_ERROR", /consumed/i),
  );

  const persisted = await readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8");
  assert.equal((persisted.match(/"consumedAtMs":null/gu) ?? []).length, 1);
});

test("concurrent stores serialize updates without losing contexts", async (context) => {
  const { directory, clock } = await fixture(context);
  const stores = Array.from({ length: 8 }, (_, index) => {
    let invocation = 0;
    return new CandidateContextStore({
      stateDirectory: directory,
      clock,
      random: {
        randomBytes(length: number) {
          invocation += 1;
          const bytes = new Uint8Array(length);
          bytes.fill(index + 20);
          bytes[length - 1] = invocation;
          return bytes;
        },
      },
      lockTimeoutMs: 2_000,
    });
  });

  await Promise.all(stores.map((store) => store.issue(issueInput)));
  const persisted = JSON.parse(await readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8"));
  assert.equal(persisted.contexts.length, 8);
});

test("corrupt state is quarantined and never treated as an empty store", async (context) => {
  const { directory, store } = await fixture(context);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "candidate-contexts-v1.json"), "{not-json", "utf8");

  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /corrupt/i),
  );
  const entries = await readdir(directory);
  assert.equal(entries.includes("candidate-contexts-v1.json"), false);
  assert.equal(entries.some((entry) => /^candidate-contexts-v1\.json\.corrupt\./u.test(entry)), true);
});

test("private state path rejects symbolic links and applies private POSIX permissions", async (context) => {
  const { directory } = await fixture(context);
  const privateDirectory = resolve(directory, "private");
  await ensurePrivateStateDirectory(privateDirectory);
  const info = await lstat(privateDirectory);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o700);
  }

  const target = resolve(directory, "target");
  const linked = resolve(directory, "linked");
  await mkdir(target);
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    ensurePrivateStateDirectory(linked),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /reparse|symbolic/i),
  );
});

test("token digest rejects malformed bearer values without echoing them", () => {
  const malformed = "secret-not-a-token";
  assert.throws(
    () => candidateTokenDigest(malformed),
    (error: unknown) =>
      isToolError(error, "INPUT_ERROR", /candidate token/i) &&
      !((error as Error).message.includes(malformed)),
  );
  const valid = `hmrc1_${Buffer.alloc(32, 7).toString("base64url")}`;
  assert.equal(
    candidateTokenDigest(valid),
    createHash("sha256").update(valid, "ascii").digest("hex"),
  );
});

test("rejects raw candidate tokens embedded in the tokenless snapshot", async (context) => {
  const { store } = await fixture(context);
  const leakedToken = `hmrc1_${Buffer.alloc(32, 9).toString("base64url")}`;

  await assert.rejects(
    store.issue({
      ...issueInput,
      snapshot: { ...snapshot, leakedToken },
    }),
    (error: unknown) =>
      isToolError(error, "INPUT_ERROR", /tokenless snapshot/i) &&
      !((error as Error).message.includes(leakedToken)),
  );
});

test("rejects a symbolic-link store instead of following it", async (context) => {
  const { directory, store } = await fixture(context);
  const outside = resolve(directory, "outside.json");
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  await writeFile(outside, '{"storeVersion":1,"contexts":[]}\n', "utf8");
  try {
    await symlink(outside, storePath, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("Windows account cannot create file symbolic links");
      return;
    }
    throw error;
  }

  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /corrupt|unsafe/i),
  );
  assert.equal(await readFile(outside, "utf8"), '{"storeVersion":1,"contexts":[]}\n');
});

test("lock contention fails closed within the configured timeout", async (context) => {
  const { directory, clock } = await fixture(context);
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 50,
  });
  await mkdir(resolve(directory, "candidate-contexts-v1.lock"));
  const started = Date.now();

  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /lock timed out/i),
  );
  assert.equal(Date.now() - started < 500, true);
});

test("strict store parsing quarantines unknown fields, duplicate keys and oversized files", async (context) => {
  const mutations: Array<(text: string) => string> = [
    (text) => text.replace('{"contexts":', '{"unexpected":true,"contexts":'),
    (text) => text.replace('"gitlabOrigin":', '"unexpectedBinding":true,"gitlabOrigin":'),
    (text) => text.replace('"metadata":{', '"metadata":{"unexpectedCandidate":true,'),
    (text) => text.replace('"storeVersion":1', '"storeVersion":1,"storeVersion":1'),
    () => " ".repeat(16 * 1024 * 1024 + 1),
  ];

  for (const [index, mutate] of mutations.entries()) {
    const directory = resolve((await fixture(context)).directory, `strict-${String(index)}`);
    const first = new CandidateContextStore({
      stateDirectory: directory,
      clock: new FakeClock(Date.UTC(2026, 7, 14)),
      random: new CounterRandom(),
    });
    await first.issue(issueInput);
    const storePath = resolve(directory, "candidate-contexts-v1.json");
    await writeFile(storePath, mutate(await readFile(storePath, "utf8")), "utf8");

    await assert.rejects(
      first.issue(issueInput),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR", /corrupt/i),
    );
    assert.equal((await readdir(directory)).some((entry) => entry.includes(".corrupt.")), true);
  }
});

test("clock rollback fails closed instead of extending a context", async (context) => {
  const { clock, store } = await fixture(context);
  const issued = await store.issue(issueInput);
  const candidate = issued.candidates[0];
  assert.ok(candidate);
  clock.set(issued.createdAtMs - 1);

  await assert.rejects(
    store.resolve({
      contextId: issued.contextId,
      expectedBinding: binding,
      selections: [{ token: candidate.token, kind: candidate.kind }],
    }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /clock moved backwards/i),
  );
});

test("candidate digest collisions retry and then fail at the bounded limit", async (context) => {
  const directory = (await fixture(context)).directory;
  const clock = new FakeClock(Date.UTC(2026, 7, 14));
  const values = [1, 2, 3, 2, 4];
  const random = {
    randomBytes(length: number) {
      const value = values.shift() ?? 4;
      const bytes = new Uint8Array(length);
      bytes.fill(value);
      return bytes;
    },
  };
  const store = new CandidateContextStore({ stateDirectory: directory, clock, random });
  const singleCandidate = { ...issueInput, candidates: [issueInput.candidates[0]!] };
  const first = await store.issue(singleCandidate);
  const second = await store.issue(singleCandidate);
  assert.notEqual(first.candidates[0]?.token, second.candidates[0]?.token);

  const stuck = new CandidateContextStore({
    stateDirectory: resolve(directory, "stuck"),
    clock,
    random: {
      randomBytes(length: number) {
        const bytes = new Uint8Array(length);
        bytes.fill(9);
        return bytes;
      },
    },
  });
  await assert.rejects(
    stuck.issue({ ...issueInput, candidates: [issueInput.candidates[0]!, issueInput.candidates[1]!] }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /collision limit/i),
  );
});

test("takes over an expired lock without accepting a live lock", async (context) => {
  const { directory, clock } = await fixture(context);
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  await mkdir(lockPath);
  await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({
    lockVersion: 1,
    nonce: "stale-owner",
    expiresAtMs: Date.now() - 1,
  }), "utf8");
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 200,
  });

  const issued = await store.issue(issueInput);
  assert.match(issued.contextId, /^hmrx1_/u);
  assert.equal((await readdir(directory)).some((entry) => entry.includes("lock.stale")), false);
});

test("lost lock ownership fences an old writer before atomic replace", async (context) => {
  const { directory, clock } = await fixture(context);
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    faultInjector: {
      async hit(point: string) {
        if (point === "before-replace") {
          await rm(lockPath, { recursive: true, force: true });
          await mkdir(lockPath);
          await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({
            lockVersion: 1,
            nonce: "replacement-owner",
            expiresAtMs: Date.now() + 10_000,
          }), "utf8");
        }
      },
    },
  });

  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /ownership|fenc|persist/i),
  );
  await assert.rejects(readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8"), /ENOENT/u);
});

test("atomic persistence failure preserves the previous complete document", async (context) => {
  const { directory, clock, store } = await fixture(context);
  await store.issue(issueInput);
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  const before = await readFile(storePath, "utf8");
  const failing = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    faultInjector: {
      async hit(point: string) {
        if (point === "before-replace") {
          throw new Error("injected replace failure");
        }
      },
    },
  });

  await assert.rejects(
    failing.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /persist/i),
  );
  assert.equal(await readFile(storePath, "utf8"), before);
  assert.equal((await readdir(directory)).some((entry) => entry.includes(".tmp.")), false);
});
