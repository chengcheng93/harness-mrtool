import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  MUTATION_FILENAME,
  openNativeMutationExecutor,
  prepareMutation,
} from "../../src/platform/native-mutation-executor.ts";

async function temporaryInstallation(t: { after(callback: () => void | Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "native-mutation-executor-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function target(root: string): string {
  return resolve(root, MUTATION_FILENAME);
}

const darwin = { skip: process.platform !== "darwin" };

test("Darwin native executor reserves without mutating and admits through its fixed slot", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const original = Uint8Array.from(Buffer.from('{"transaction":"native"}\n', "utf8"));
  const mutation = prepareMutation(original);
  original.fill(0x58);
  const executor = await openNativeMutationExecutor(root);
  t.after(() => executor.close());

  assert.match(executor.epoch.attemptId, /^[0-9a-f-]{36}$/u);
  await assert.rejects(access(target(root)), { code: "ENOENT" });
  await executor.reserve(mutation);
  assert.deepEqual(await readdir(root), [".update.lock"]);
  assert.deepEqual(Buffer.from(mutation.bytes), Buffer.from('{"transaction":"native"}\n', "utf8"));

  const exposedBytes = mutation.bytes;
  exposedBytes.fill(0x59);
  const receipt = await executor.admit(mutation);
  assert.equal(receipt.slot, "transaction");
  assert.equal(receipt.operationId, mutation.operationId);
  assert.equal(receipt.epochId, executor.epoch.attemptId);
  assert.match(receipt.bytesSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await readFile(target(root)), Buffer.from('{"transaction":"native"}\n', "utf8"));

  const targetStat = await stat(target(root), { bigint: true });
  assert.equal(targetStat.isFile(), true);
  assert.equal(targetStat.nlink, 1n);
  assert.equal(targetStat.uid, BigInt(process.getuid!()));
  assert.equal(Number(targetStat.mode) & 0o7777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), [".update.lock", MUTATION_FILENAME].sort());
  await executor.close();
});

test("prepared bytes are copied before asynchronous execution", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const original = Uint8Array.from([1, 2, 3, 4]);
  const mutation = prepareMutation(original);
  const executor = await openNativeMutationExecutor(root);
  t.after(() => executor.close());
  original.set([9, 9, 9, 9]);
  await executor.reserve(mutation);
  original.set([8, 8, 8, 8]);
  await executor.admit(mutation);
  assert.deepEqual(await readFile(target(root)), Buffer.from([1, 2, 3, 4]));
  await executor.close();
});

test("a reservation from a settled epoch cannot cross to a successor executor", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const mutation = prepareMutation(Uint8Array.from([7, 8, 9]));
  const first = await openNativeMutationExecutor(root);
  await first.reserve(mutation);
  const firstEpoch = first.epoch.attemptId;
  await first.close();

  const second = await openNativeMutationExecutor(root);
  t.after(() => second.close());
  assert.notEqual(second.epoch.attemptId, firstEpoch);
  await assert.rejects(second.admit(mutation), { code: "UPDATE_SECURITY_ERROR" });
  await assert.rejects(access(target(root)), { code: "ENOENT" });

  const fresh = prepareMutation(Uint8Array.from([10, 11]));
  await second.reserve(fresh);
  const receipt = await second.admit(fresh);
  assert.equal(receipt.epochId, second.epoch.attemptId);
  assert.notEqual(receipt.operationId, mutation.operationId);
  await second.close();
});

test("structural clones and receipts do not mint mutation authority", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const mutation = prepareMutation(Uint8Array.from([1, 2, 3]));
  const clone = structuredClone(mutation);
  const receiptLike = {
    slot: "transaction",
    operationId: mutation.operationId,
    epochId: "00000000-0000-4000-8000-000000000000",
    bytesSha256: "0".repeat(64),
  };
  const executor = await openNativeMutationExecutor(root);
  t.after(() => executor.close());

  await assert.rejects(executor.reserve(clone as typeof mutation), { code: "UPDATE_SECURITY_ERROR" });
  await assert.rejects(executor.reserve(receiptLike as unknown as typeof mutation), { code: "UPDATE_SECURITY_ERROR" });
  assert.deepEqual((await readdir(root)).sort(), [".update.lock"]);
  await executor.close();
});

test("the native child remains the lock owner until executor close", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const first = await openNativeMutationExecutor(root);
  let successorResolved = false;
  const successor = openNativeMutationExecutor(root).then((executor) => {
    successorResolved = true;
    return executor;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(successorResolved, false);
  await first.close();
  const second = await successor;
  assert.equal(successorResolved, true);
  await second.close();
});


test("revoke releases a reservation without creating the fixed slot", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const mutation = prepareMutation(Uint8Array.from([4, 5, 6]));
  const executor = await openNativeMutationExecutor(root);
  t.after(() => executor.close());
  await executor.reserve(mutation);
  await executor.revoke(mutation);
  assert.deepEqual((await readdir(root)).sort(), [".update.lock"]);
  await executor.reserve(mutation);
  await executor.admit(mutation);
  assert.deepEqual(await readFile(target(root)), Buffer.from([4, 5, 6]));
  await executor.close();
});

test("a lock symlink is rejected without creating through its target", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const outside = await mkdtemp(resolve(await realpath(tmpdir()), "native-mutation-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(resolve(outside, "lock-target"), resolve(root, ".update.lock"));
  await assert.rejects(openNativeMutationExecutor(root), { code: "UPDATE_SECURITY_ERROR" });
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(root), [".update.lock"]);
});

test("coordinator loss after reserve leaves no target and permits a successor", darwin, async (t) => {
  const root = await temporaryInstallation(t);
  const script = [
    'import { openNativeMutationExecutor, prepareMutation } from "./src/platform/native-mutation-executor.ts";',
    'const executor = await openNativeMutationExecutor(process.env.NME_ROOT);',
    'await executor.reserve(prepareMutation(Uint8Array.from([21, 22, 23])));',
    'process.exit(0);',
  ].join("\n");
  const coordinator = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, NME_ROOT: root },
    stdio: "ignore",
  });
  t.after(() => {
    if (coordinator.exitCode === null && coordinator.signalCode === null) coordinator.kill("SIGKILL");
  });
  const [code, signal] = await once(coordinator, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0);
  assert.equal(signal, null);
  await assert.rejects(access(target(root)), { code: "ENOENT" });
  const successor = await openNativeMutationExecutor(root);
  await successor.close();
});

test("unsupported platforms fail closed before creating lock or target", { skip: process.platform === "darwin" }, async (t) => {
  const root = await temporaryInstallation(t);
  await assert.rejects(openNativeMutationExecutor(root), { code: "UPDATE_SECURITY_ERROR" });
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(access(target(root)), { code: "ENOENT" });
});
