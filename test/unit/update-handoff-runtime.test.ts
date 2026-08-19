import assert from "node:assert/strict";
import test from "node:test";

import {
  runUpdateHandoff,
  type HandoffChild,
} from "../../src/update/invocation-envelope.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise?.() };
}

test("handoff consumes stdin once and forwards async child output before completion", async () => {
  let inputReads = 0;
  let legacyReads = 0;
  let cleanups = 0;
  const allowCompletion = deferred();
  const firstForwarded = deferred();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const child: HandoffChild = {
    async writeStdin(bytes) { assert.equal(decode(bytes), "request"); },
    async closeStdin() {},
    async readStdout() { legacyReads += 1; return encode("legacy"); },
    async readStderr() { legacyReads += 1; return new Uint8Array(); },
    async *streamStdout() {
      yield encode("one");
      await allowCompletion.promise;
      yield encode("two");
    },
    async *streamStderr() { yield encode("diagnostic"); },
    async wait() { return { exitCode: 19 }; },
    async cleanup() { cleanups += 1; },
  };
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      inputReads += 1;
      return (async function* () { yield encode("request"); })();
    },
  };

  const running = runUpdateHandoff(input, async () => child, {
    output: {
      stdout(bytes) {
        stdoutChunks.push(decode(bytes));
        firstForwarded.resolve();
      },
      stderr(bytes) { stderrChunks.push(decode(bytes)); },
    },
  });
  const forwardedBeforeCompletion = await Promise.race([
    firstForwarded.promise.then(() => true),
    running.then(() => false),
  ]);
  assert.equal(forwardedBeforeCompletion, true);
  allowCompletion.resolve();
  const result = await running;

  assert.equal(inputReads, 1);
  assert.equal(legacyReads, 0);
  assert.deepEqual(stdoutChunks, ["one", "two"]);
  assert.deepEqual(stderrChunks, ["diagnostic"]);
  assert.equal(decode(result.childStdout), "onetwo");
  assert.equal(result.childExit, 19);
  assert.equal(cleanups, 1);
});

test("handoff drains child output while it is still writing stdin", async () => {
  const outputStarted = deferred();
  const child: HandoffChild = {
    async writeStdin() { await outputStarted.promise; },
    async closeStdin() {},
    async readStdout() { return new Uint8Array(); },
    async readStderr() { return new Uint8Array(); },
    async *streamStdout() {
      outputStarted.resolve();
      yield encode("ready");
    },
    async *streamStderr() {},
    async wait() { return { exitCode: 0 }; },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("timeout"), 100);
  });
  try {
    const outcome = await Promise.race([
      runUpdateHandoff(
        (async function* () { yield encode("request"); })(),
        async () => child,
      ).then(() => "completed" as const),
      timeout,
    ]);
    assert.equal(outcome, "completed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
});

test("legacy handoff readers receive the enforced output cap", async () => {
  const limits: number[] = [];
  const child: HandoffChild = {
    async writeStdin() {},
    async closeStdin() {},
    async readStdout(maxBytes) { limits.push(maxBytes ?? -1); return encode("ok"); },
    async readStderr(maxBytes) { limits.push(maxBytes ?? -1); return new Uint8Array(); },
    async wait() { return { exitCode: 0 }; },
  };
  await runUpdateHandoff(
    (async function* () { yield encode("request"); })(),
    async () => child,
    { maxOutputBytes: 7 },
  );
  assert.deepEqual(limits.sort((left, right) => left - right), [7, 7]);
});

test("handoff terminates and cleans a child whose streamed output exceeds its cap", async () => {
  let terminations = 0;
  let cleanups = 0;
  let streamClosed = false;
  const child: HandoffChild = {
    async writeStdin() {},
    async closeStdin() {},
    async readStdout() { return new Uint8Array(); },
    async readStderr() { return new Uint8Array(); },
    async *streamStdout() {
      try {
        yield new Uint8Array([1, 2, 3, 4]);
      } finally {
        streamClosed = true;
      }
    },
    async *streamStderr() {},
    async wait() { return { exitCode: 0 }; },
    async terminate() { terminations += 1; },
    async cleanup() { cleanups += 1; },
  };

  await assert.rejects(
    runUpdateHandoff((async function* () { yield encode("request"); })(), async () => child, {
      maxOutputBytes: 3,
    }),
    /handoff/u,
  );
  assert.equal(terminations, 1);
  assert.equal(cleanups, 1);
  assert.equal(streamClosed, true);
});

test("handoff terminates and cleans a child after a reader failure", async () => {
  let terminations = 0;
  let cleanups = 0;
  const child: HandoffChild = {
    async writeStdin() {},
    async closeStdin() {},
    async readStdout() { throw new Error("pipe failed"); },
    async readStderr() { return new Uint8Array(); },
    async wait() { return { exitCode: 0 }; },
    async terminate() { terminations += 1; },
    async cleanup() { cleanups += 1; },
  };

  await assert.rejects(
    runUpdateHandoff((async function* () { yield encode("request"); })(), async () => child),
    /handoff/u,
  );
  assert.equal(terminations, 1);
  assert.equal(cleanups, 1);
});
