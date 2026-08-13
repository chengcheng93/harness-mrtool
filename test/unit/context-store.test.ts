import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  appendFile,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
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
import {
  ensurePrivateStateDirectory,
  resolveWindowsPowerShellPath,
  type WindowsAclVerifier,
} from "../../src/platform/state-path.ts";

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

const allowTestAcl: WindowsAclVerifier = { verify: async () => undefined };

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
    windowsAclVerifier: allowTestAcl,
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
  assert.equal(persisted.includes("hmrx1_"), false);
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
    (error: unknown) => isToolError(error, first.kind === "label" ? "LABEL_ERROR" : "INPUT_ERROR", /consumed/i),
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
      windowsAclVerifier: allowTestAcl,
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
  await ensurePrivateStateDirectory(privateDirectory, { windowsAclVerifier: allowTestAcl });
  const info = await lstat(privateDirectory);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o700);
  }

  const target = resolve(directory, "target");
  const linked = resolve(directory, "linked");
  await mkdir(target);
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    ensurePrivateStateDirectory(linked, { windowsAclVerifier: allowTestAcl }),
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

test("rejects candidate or context bearer values anywhere in the document before persistence", async (context) => {
  const { directory, store } = await fixture(context);
  const first = await store.issue(issueInput);
  const before = await readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8");
  const bearerValues = [first.contextId, first.candidates[0]!.token];
  const labelCandidate = issueInput.candidates.find((candidate) => candidate.kind === "label");
  assert.ok(labelCandidate);

  for (const bearer of bearerValues) {
    for (const input of [
      { ...issueInput, candidates: [{ ...labelCandidate, description: `prefix ${bearer} suffix` }] },
      { ...issueInput, snapshot: { ...snapshot, note: `prefix ${bearer} suffix` } },
      { ...issueInput, snapshot: { ...snapshot, note: `prefix ${bearer}A suffix` } },
      { ...issueInput, snapshot: { ...snapshot, [bearer]: "bearer used as an object key" } },
    ]) {
      await assert.rejects(
        store.issue(input),
        (error: unknown) =>
          isToolError(error, "INPUT_ERROR", /bearer|token/i) &&
          !((error as Error).message.includes(bearer)),
      );
      assert.equal(await readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8"), before);
    }
  }

  const nearMatches = [
    `hmrc1_${"A".repeat(42)}`,
    `hmrx1_${"A".repeat(42)}!`,
  ];
  await store.issue({
    ...issueInput,
    candidates: nearMatches.map((description, index) => ({
      ...labelCandidate,
      restId: labelCandidate.restId + index + 1,
      globalId: `${labelCandidate.globalId}-${String(index)}`,
      description: `prefix ${description} suffix`,
    })),
  });
});

test("Windows ACL executable is resolved only from a canonical trusted SystemRoot", () => {
  assert.equal(
    resolveWindowsPowerShellPath({ SystemRoot: "C:\\Windows" }),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  for (const systemRoot of [
    "Windows",
    ".\\Windows",
    "C:\\Windows\\..\\attacker",
    "\\\\server\\share\\Windows",
    "\\\\?\\C:\\Windows",
    "C:\\Windows\\",
  ]) {
    assert.throws(
      () => resolveWindowsPowerShellPath({ SystemRoot: systemRoot }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR", /SystemRoot|state path/i),
      systemRoot,
    );
  }
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
    windowsAclVerifier: allowTestAcl,
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
      windowsAclVerifier: allowTestAcl,
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

test("read validation quarantines a raw bearer injected into persisted metadata", async (context) => {
  const { directory, store } = await fixture(context);
  const issued = await store.issue(issueInput);
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  const document = JSON.parse(await readFile(storePath, "utf8"));
  document.contexts[0].candidates[0].metadata.description = issued.candidates[0]!.token;
  await writeFile(storePath, `${JSON.stringify(document)}\n`, "utf8");

  await assert.rejects(
    store.cleanup(),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /corrupt/i),
  );
  assert.equal((await readdir(directory)).some((entry) => entry.includes(".corrupt.")), true);
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

test("resolve and cleanup reject non-finite clocks without mutating valid contexts", async (context) => {
  const { directory, clock, store } = await fixture(context);
  const issued = await store.issue(issueInput);
  const candidate = issued.candidates[0]!;
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  const before = await readFile(storePath, "utf8");

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
    clock.set(invalid);
    await assert.rejects(
      store.resolve({
        contextId: issued.contextId,
        expectedBinding: binding,
        selections: [{ token: candidate.token, kind: candidate.kind }],
      }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR", /clock/i),
    );
    await assert.rejects(
      store.cleanup(),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR", /clock/i),
    );
    assert.equal(await readFile(storePath, "utf8"), before);
  }
});

test("issue rejects non-finite clocks before creating a store", async (context) => {
  const { directory, clock, store } = await fixture(context);
  clock.set(Number.NaN);
  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /clock/i),
  );
  await assert.rejects(
    readFile(resolve(directory, "candidate-contexts-v1.json"), "utf8"),
    /ENOENT/u,
  );
});

test("issue rejects a clock whose TTL would exceed the safe integer range without mutation", async (context) => {
  const { directory, clock, store } = await fixture(context);
  await store.issue(issueInput);
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  const before = await readFile(storePath, "utf8");
  clock.set(Number.MAX_SAFE_INTEGER - CANDIDATE_CONTEXT_TTL_MS + 1);

  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /clock/i),
  );
  assert.equal(await readFile(storePath, "utf8"), before);

  const emptyDirectory = resolve(directory, "empty");
  const emptyStore = new CandidateContextStore({
    stateDirectory: emptyDirectory,
    clock,
    random: new CounterRandom(),
    windowsAclVerifier: allowTestAcl,
  });
  await assert.rejects(
    emptyStore.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /clock/i),
  );
  await assert.rejects(
    readFile(resolve(emptyDirectory, "candidate-contexts-v1.json"), "utf8"),
    /ENOENT/u,
  );
});

test("label selections use LABEL_ERROR for malformed, unknown, wrong-kind and consumed tokens", async (context) => {
  const { store } = await fixture(context);
  const issued = await store.issue(issueInput);
  const label = issued.candidates.find((candidate) => candidate.kind === "label")!;
  const reviewer = issued.candidates.find((candidate) => candidate.kind === "reviewer")!;
  const cases = [
    "malformed",
    `hmrc1_${Buffer.alloc(32, 99).toString("base64url")}`,
    reviewer.token,
  ];

  for (const token of cases) {
    await assert.rejects(
      store.resolve({
        contextId: issued.contextId,
        expectedBinding: binding,
        selections: [{ token, kind: "label" }],
      }),
      (error: unknown) => isToolError(error, "LABEL_ERROR"),
    );
  }

  await store.resolve({
    contextId: issued.contextId,
    expectedBinding: binding,
    selections: [{ token: label.token, kind: "label" }],
    consume: true,
  });
  await assert.rejects(
    store.resolve({
      contextId: issued.contextId,
      expectedBinding: binding,
      selections: [{ token: label.token, kind: "label" }],
    }),
    (error: unknown) => isToolError(error, "LABEL_ERROR"),
  );
});

test("user candidate failures remain INPUT_ERROR", async (context) => {
  const { store } = await fixture(context);
  const issued = await store.issue(issueInput);
  for (const kind of ["assignee", "reviewer"] as const) {
    await assert.rejects(
      store.resolve({
        contextId: issued.contextId,
        expectedBinding: binding,
        selections: [{ token: "malformed", kind }],
      }),
      (error: unknown) => isToolError(error, "INPUT_ERROR"),
    );
  }
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
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random,
    windowsAclVerifier: allowTestAcl,
  });
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
    windowsAclVerifier: allowTestAcl,
  });
  await assert.rejects(
    stuck.issue({ ...issueInput, candidates: [issueInput.candidates[0]!, issueInput.candidates[1]!] }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /collision limit/i),
  );
});

test("takes over a lock whose recorded owner process is dead", async (context) => {
  const { directory, clock } = await fixture(context);
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  await mkdir(lockPath);
  await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({
    lockVersion: 1,
    nonce: "stale-owner",
    pid: 2_147_483_647,
  }), "utf8");
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 200,
    windowsAclVerifier: allowTestAcl,
  });

  const issued = await store.issue(issueInput);
  assert.match(issued.contextId, /^hmrx1_/u);
  assert.equal((await readdir(directory)).some((entry) => entry.includes("lock.stale")), false);
});

test("never takes over an old lock while its owner process is alive", async (context) => {
  const { directory, clock } = await fixture(context);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  context.after(() => child.kill());
  assert.ok(child.pid);
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  await mkdir(lockPath);
  await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({
    lockVersion: 1,
    nonce: "live-cross-process-owner",
    pid: child.pid,
  }), "utf8");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 50,
    windowsAclVerifier: allowTestAcl,
  });
  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /lock timed out/i),
  );
});

test("takes over a lock only after its owner process is proven dead", async (context) => {
  const { directory, clock } = await fixture(context);
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(child.pid);
  const deadPid = child.pid;
  await once(child, "exit");
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  await mkdir(lockPath);
  await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({
    lockVersion: 1,
    nonce: "dead-cross-process-owner",
    pid: deadPid,
  }), "utf8");

  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 500,
    windowsAclVerifier: allowTestAcl,
  });
  const issued = await store.issue(issueInput);
  assert.match(issued.contextId, /^hmrx1_/u);
});

test("release deletes only its atomically isolated lock directory", async (context) => {
  const { directory, clock } = await fixture(context);
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  const replacementOwner = {
    lockVersion: 1,
    nonce: "replacement-owner",
    pid: process.pid,
  };
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    faultInjector: {
      async hit(point: string) {
        if (point === "after-lock-release-rename") {
          await mkdir(lockPath);
          await writeFile(resolve(lockPath, "owner.json"), JSON.stringify(replacementOwner), "utf8");
        }
      },
    },
    windowsAclVerifier: allowTestAcl,
  });

  await store.issue(issueInput);
  assert.deepEqual(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")), replacementOwner);
});

test("failed lock initialization never recursively deletes a replacement stable lock", async (context) => {
  const { directory, clock } = await fixture(context);
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  const abandonedPath = resolve(directory, "abandoned-lock");
  const replacementOwner = { lockVersion: 1, nonce: "replacement-owner", pid: process.pid };
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    faultInjector: {
      async hit(point: string) {
        if (point === "after-lock-directory-create") {
          await rename(lockPath, abandonedPath);
          await mkdir(lockPath);
          await writeFile(resolve(lockPath, "owner.json"), JSON.stringify(replacementOwner), "utf8");
          throw new Error("injected owner creation failure");
        }
      },
    },
    windowsAclVerifier: allowTestAcl,
  });

  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /lock/i),
  );
  assert.deepEqual(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")), replacementOwner);
});

test("recovers old ownerless and malformed locks but does not steal a fresh ownerless lock", async (context) => {
  const { directory, clock } = await fixture(context);
  for (const [index, owner] of [null, "not-json"] .entries()) {
    const stateDirectory = resolve(directory, `orphan-${String(index)}`);
    const lockPath = resolve(stateDirectory, "candidate-contexts-v1.lock");
    await mkdir(lockPath, { recursive: true });
    if (owner !== null) {
      await writeFile(resolve(lockPath, "owner.json"), owner, "utf8");
    }
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const store = new CandidateContextStore({
      stateDirectory,
      clock,
      random: new CounterRandom(),
      lockTimeoutMs: 200,
      windowsAclVerifier: allowTestAcl,
    });
    const issued = await store.issue(issueInput);
    assert.match(issued.contextId, /^hmrx1_/u);
  }

  const freshDirectory = resolve(directory, "fresh-orphan");
  await mkdir(resolve(freshDirectory, "candidate-contexts-v1.lock"), { recursive: true });
  const fresh = new CandidateContextStore({
    stateDirectory: freshDirectory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 30,
    windowsAclVerifier: allowTestAcl,
  });
  await assert.rejects(
    fresh.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /lock timed out/i),
  );
});

test("ownerless takeover restores a live owner that appears before atomic isolation", async (context) => {
  const { directory, clock } = await fixture(context);
  const lockPath = resolve(directory, "candidate-contexts-v1.lock");
  await mkdir(lockPath);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const liveOwner = { lockVersion: 1, nonce: "late-live-owner", pid: process.pid };
  let injected = false;
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    lockTimeoutMs: 50,
    faultInjector: {
      async hit(point: string) {
        if (point === "before-incomplete-lock-isolation" && !injected) {
          injected = true;
          await writeFile(resolve(lockPath, "owner.json"), JSON.stringify(liveOwner), "utf8");
        }
      },
    },
    windowsAclVerifier: allowTestAcl,
  });

  await assert.rejects(
    store.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /lock timed out/i),
  );
  assert.deepEqual(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")), liveOwner);
});

test("Windows state preparation invokes an injected ACL verifier and propagates rejection", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows ACL contract");
    return;
  }
  const { directory } = await fixture(context);
  let verifiedPath: string | undefined;
  const verifier: WindowsAclVerifier = {
    async verify(path) {
      verifiedPath = path;
      throw new Error("unsafe inherited ACL");
    },
  };
  await assert.rejects(
    ensurePrivateStateDirectory(resolve(directory, "acl-rejected"), { windowsAclVerifier: verifier }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /ACL|private state path/i),
  );
  assert.equal(verifiedPath, resolve(directory, "acl-rejected"));
});

test("default Windows ACL adapter secures and verifies a newly created directory", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows ACL integration contract");
    return;
  }
  const { directory } = await fixture(context);
  await ensurePrivateStateDirectory(resolve(directory, "acl-default"));
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
            pid: process.pid,
          }), "utf8");
        }
      },
    },
    windowsAclVerifier: allowTestAcl,
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
    windowsAclVerifier: allowTestAcl,
  });

  await assert.rejects(
    failing.issue(issueInput),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /persist/i),
  );
  assert.equal(await readFile(storePath, "utf8"), before);
  assert.equal((await readdir(directory)).some((entry) => entry.includes(".tmp.")), false);
});

test("rejects a document above the read limit before replacing the previous store", async (context) => {
  const { directory, clock, store } = await fixture(context);
  await store.issue(issueInput);
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  const before = await readFile(storePath, "utf8");
  const oversized = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    windowsAclVerifier: allowTestAcl,
  });
  const label = issueInput.candidates.find((candidate) => candidate.kind === "label")!;

  await assert.rejects(
    oversized.issue({
      ...issueInput,
      candidates: [{ ...label, description: "X".repeat(17 * 1024 * 1024) }],
    }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /size|large|persist/i),
  );
  assert.equal(await readFile(storePath, "utf8"), before);
  assert.equal((await readdir(directory)).some((entry) => entry.includes(".tmp.")), false);
});

test("rejects a state directory reached through an ancestor reparse point", async (context) => {
  const { directory } = await fixture(context);
  const target = resolve(directory, "ancestor-target");
  const linked = resolve(directory, "ancestor-link");
  await mkdir(target);
  try {
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("Windows account cannot create directory junctions");
      return;
    }
    throw error;
  }
  await assert.rejects(
    ensurePrivateStateDirectory(resolve(linked, "nested-state"), { windowsAclVerifier: allowTestAcl }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /ancestor|reparse|symbolic/i),
  );
});

test("bounded single-handle reads reject growth after opening the store", async (context) => {
  const { directory, clock, store } = await fixture(context);
  await store.issue(issueInput);
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  let injected = false;
  const racing = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    faultInjector: {
      async hit(point: string) {
        if (point === "after-store-open") {
          injected = true;
          await appendFile(storePath, " ".repeat(17 * 1024 * 1024), "utf8");
        }
      },
    },
    windowsAclVerifier: allowTestAcl,
  });

  await assert.rejects(
    racing.cleanup(),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /corrupt|read|identity|size/i),
  );
  assert.equal(injected, true);
  assert.equal((await readdir(directory)).some((entry) => entry.includes(".corrupt.")), true);
});

test("quarantine restores a replacement whose identity differs from the opened store", async (context) => {
  const { directory, clock, store } = await fixture(context);
  await store.issue(issueInput);
  const storePath = resolve(directory, "candidate-contexts-v1.json");
  const openedPath = resolve(directory, "opened-corrupt.json");
  const replacement = '{"replacement":true}\n';
  const racing = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    faultInjector: {
      async hit(point: string) {
        if (point === "after-store-open") {
          await appendFile(storePath, " ", "utf8");
        }
        if (point === "before-store-quarantine") {
          await rename(storePath, openedPath);
          await writeFile(storePath, replacement, "utf8");
        }
      },
    },
    windowsAclVerifier: allowTestAcl,
  });

  await assert.rejects(
    racing.cleanup(),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR", /corrupt|quarantine|changed/i),
  );
  assert.equal(await readFile(storePath, "utf8"), replacement);
});

test("POSIX atomic replacement syncs the parent directory", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX directory fsync contract");
    return;
  }
  const { directory, clock } = await fixture(context);
  let parentSynced = false;
  const store = new CandidateContextStore({
    stateDirectory: directory,
    clock,
    random: new CounterRandom(),
    faultInjector: {
      hit(point: string) {
        if (point === "after-parent-sync") parentSynced = true;
      },
    },
    windowsAclVerifier: allowTestAcl,
  });
  await store.issue(issueInput);
  assert.equal(parentSynced, true);
});
