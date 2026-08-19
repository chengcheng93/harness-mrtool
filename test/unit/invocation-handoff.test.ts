import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ToolError } from "../../src/contracts/errors.ts";
import {
  MAX_HANDOFF_BYTES,
  runBoundedUpdateHandoff,
  type BoundedUpdateHandoffOptions,
} from "../../src/update/invocation-handoff.ts";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

function options(
  input: AsyncIterable<Uint8Array>,
  overrides: Partial<BoundedUpdateHandoffOptions> = {},
): BoundedUpdateHandoffOptions {
  return {
    input,
    child: {
      executable: "C:\\Program Files\\harness-mrtool\\harness-mrtool.exe",
      arguments: ["internal", "apply-update"],
      cwd: "C:\\workspace\\repo",
      environment: { HMR_CHILD_MODE: "1" },
    },
    release: {
      repository: { owner: "chengcheng93", name: "harness-mrtool" },
      tag: "cli-v1.2.3",
      assetSha256: "a".repeat(64),
      assetSize: 1234,
    },
    spawnChild: async () => ({
      async writeStdin() {},
      async closeStdin() {},
      async readStdout() { return bytes("ok"); },
      async readStderr() { return new Uint8Array(); },
      async wait() { return { exitCode: 0 }; },
    }),
    ...overrides,
  };
}

test("bounded update handoff consumes stdin once and binds its exact hash", async () => {
  let iteratorCalls = 0;
  let received: BoundedUpdateHandoffOptions["spawnChild"] extends (
    input: infer Input,
  ) => Promise<unknown> ? Input : never = undefined as never;
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      iteratorCalls += 1;
      return (async function* () { yield bytes("request"); })();
    },
  };
  const result = await runBoundedUpdateHandoff(options(input, {
    spawnChild: async (descriptor) => {
      received = descriptor;
      return {
        async writeStdin() {},
        async closeStdin() {},
        async readStdout() { return bytes("ok"); },
        async readStderr() { return new Uint8Array(); },
        async wait() { return { exitCode: 0 }; },
      };
    },
  }));

  assert.equal(iteratorCalls, 1);
  assert.equal(result.envelope.inputLength, 7);
  assert.equal(result.envelope.inputSha256, sha256(bytes("request")));
  assert.equal(result.parentExit, 0);
  assert.equal(received?.envelope.inputSha256, result.envelope.inputSha256);
  assert.deepEqual(received?.child.arguments, ["internal", "apply-update"]);
  assert.equal(Object.isFrozen(result.envelope), true);
});

test("bounded update handoff rejects oversized input before spawning a child", async () => {
  let spawned = false;
  const input = (async function* () { yield new Uint8Array(MAX_HANDOFF_BYTES + 1); })();
  await assert.rejects(
    () => runBoundedUpdateHandoff(options(input, {
      spawnChild: async () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    })),
    (error: unknown) => error instanceof ToolError && error.code === "INPUT_ERROR",
  );
  assert.equal(spawned, false);
});

test("bounded update handoff rejects credential-shaped child arguments and environment", async () => {
  for (const bad of [
    { arguments: ["internal", "--token", "secret"] },
    { environment: { PRIVATE_TOKEN: "secret" } },
  ]) {
    await assert.rejects(
      () => runBoundedUpdateHandoff(options((async function* () { yield bytes("request"); })(), {
        child: {
          executable: "harness-mrtool.exe",
          arguments: bad.arguments ?? ["internal", "apply-update"],
          cwd: "C:\\workspace\\repo",
          environment: bad.environment ?? { HMR_CHILD_MODE: "1" },
        },
      })),
      (error: unknown) => error instanceof ToolError && error.code === "INPUT_ERROR",
    );
  }
});

test("bounded update handoff preserves child output and exit status", async () => {
  const result = await runBoundedUpdateHandoff(options(
    (async function* () { yield bytes("request"); })(),
    {
      spawnChild: async () => ({
        async writeStdin() {},
        async closeStdin() {},
        async readStdout() { return bytes("child-output"); },
        async readStderr() { return bytes("child-diagnostic"); },
        async wait() { return { exitCode: 19 }; },
      }),
    },
  ));
  assert.equal(new TextDecoder().decode(result.childStdout), "child-output");
  assert.equal(new TextDecoder().decode(result.childStderr), "child-diagnostic");
  assert.equal(result.childExit, 19);
});
