import assert from "node:assert/strict";
import test from "node:test";

import { ToolError } from "../../src/contracts/errors.ts";
import {
  executeCliJson,
  type CliCommandExecution,
  type CliCommandHandlers,
} from "../../src/cli/execute.ts";

interface CapturedSink {
  readonly chunks: string[];
  readonly sink: {
    write(chunk: string, callback: (error?: Error | null) => void): boolean;
  };
  flush(): void;
}

function delayedSink(): CapturedSink {
  const chunks: string[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  return {
    chunks,
    sink: {
      write(chunk, callback) {
        chunks.push(chunk);
        callbacks.push(callback);
        return false;
      },
    },
    flush() {
      const callback = callbacks.shift();
      assert.notEqual(callback, undefined);
      callback!();
    },
  };
}

function immediateSink(): CapturedSink {
  const chunks: string[] = [];
  return {
    chunks,
    sink: {
      write(chunk, callback) {
        chunks.push(chunk);
        callback();
        return true;
      },
    },
    flush() {
      throw new Error("Immediate sink has no pending callback");
    },
  };
}

const success: CliCommandExecution = {
  context: {
    versions: {
      templateVersion: "1.0.0",
      bundleHash: "a".repeat(64),
      inputSchema: 1,
      policySchema: 1,
    },
  },
  output: {
    message: "Version inspected",
    data: { command: "version" },
  },
};

test("dispatches one typed command and waits for the JSON stdout flush", async () => {
  const captured = delayedSink();
  let calls = 0;
  const handlers: CliCommandHandlers = {
    version(invocation) {
      calls += 1;
      assert.equal(invocation.command.kind, "version");
      assert.equal(invocation.options.output, "json");
      return Promise.resolve(success);
    },
  };

  let settled = false;
  const execution = executeCliJson(
    ["version", "--output", "json"],
    { cliVersion: "0.1.0-dev", stdout: captured.sink, handlers },
  ).then((result) => {
    settled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(captured.chunks.length, 1);
  captured.flush();

  assert.deepEqual(await execution, { exitCode: 0 });
  assert.equal(calls, 1);
  assert.equal(captured.chunks.length, 1);
  const parsed = JSON.parse(captured.chunks[0]!) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, "OK");
  assert.deepEqual(parsed.data, { command: "version" });
  assert.equal(captured.chunks[0]!.trimEnd().split("\n").length, 1);
});

test("maps parse and handler failures into one stable output-v1 document", async () => {
  const parseSink = immediateSink();
  const parseResult = await executeCliJson(
    ["unknown", "--output", "json"],
    { cliVersion: "0.1.0-dev", stdout: parseSink.sink, handlers: {} },
  );
  assert.equal(parseResult.exitCode, 2);
  assert.equal(parseSink.chunks.length, 1);
  const parseOutput = JSON.parse(parseSink.chunks[0]!) as Record<string, unknown>;
  assert.equal(parseOutput.schemaVersion, 1);
  assert.equal(parseOutput.code, "INPUT_ERROR");

  const handlerSink = immediateSink();
  const handlers: CliCommandHandlers = {
    doctor: () => Promise.reject(new ToolError("AUTH_ERROR", "GitLab authentication failed", {
      field: "credential",
      expected: "a valid GitLab credential",
      actual: "authentication was rejected",
      safeNextStep: "Refresh the credential and run doctor again.",
    })),
  };
  const handlerResult = await executeCliJson(
    ["doctor", "--output", "json"],
    { cliVersion: "0.1.0-dev", stdout: handlerSink.sink, handlers },
  );
  assert.equal(handlerResult.exitCode, 3);
  assert.equal(handlerSink.chunks.length, 1);
  const handlerOutput = JSON.parse(handlerSink.chunks[0]!) as Record<string, unknown>;
  assert.equal(handlerOutput.code, "AUTH_ERROR");
});

test("fails closed when a parsed command has no registered handler", async () => {
  const captured = immediateSink();
  const result = await executeCliJson(
    ["version", "--output", "json"],
    { cliVersion: "0.1.0-dev", stdout: captured.sink, handlers: {} },
  );
  assert.equal(result.exitCode, 7);
  const output = JSON.parse(captured.chunks[0]!) as Record<string, unknown>;
  assert.equal(output.code, "INTERNAL_ERROR");
  assert.equal(output.data, null);
  assert.equal(JSON.stringify(output).includes('"actual":"version"'), false);
});

test("requires explicit JSON mode at the machine dispatcher boundary", async () => {
  const captured = immediateSink();
  let called = false;
  const result = await executeCliJson(
    ["version"],
    {
      cliVersion: "0.1.0-dev",
      stdout: captured.sink,
      handlers: {
        version: () => {
          called = true;
          return Promise.resolve(success);
        },
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(called, false);
  const output = JSON.parse(captured.chunks[0]!) as Record<string, unknown>;
  assert.equal(output.code, "INPUT_ERROR");
});

test("does not serialize rejected candidate or context bearers", async () => {
  const captured = immediateSink();
  const bearer = `hmrc1_${"A".repeat(43)}`;
  const result = await executeCliJson(
    ["verify", bearer, "--level", "ready", "--output", "json"],
    { cliVersion: "0.1.0-dev", stdout: captured.sink, handlers: {} },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(captured.chunks[0]!.includes(bearer), false);
});

test("does not write a second document after stdout has started and then fails", async () => {
  const chunks: string[] = [];
  const outputFailure = new Error("stdout closed");
  const sink = {
    write(chunk: string, callback: (error?: Error | null) => void): boolean {
      chunks.push(chunk);
      callback(outputFailure);
      return false;
    },
  };

  await assert.rejects(
    executeCliJson(
      ["version", "--output", "json"],
      {
        cliVersion: "0.1.0-dev",
        stdout: sink,
        handlers: { version: () => Promise.resolve(success) },
      },
    ),
    (error: unknown) => error === outputFailure,
  );
  assert.equal(chunks.length, 1);
});

test("does not let a handler replace the trusted CLI version", async () => {
  const captured = immediateSink();
  const result = await executeCliJson(
    ["version", "--output", "json"],
    {
      cliVersion: "0.1.0-dev",
      stdout: captured.sink,
      handlers: {
        version: () => ({
          context: { cliVersion: "forged" } as never,
          output: { data: { version: "0.1.0-dev" } },
        }),
      },
    },
  );
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(captured.chunks[0]!) as {
    readonly versions: { readonly cliVersion: string };
  };
  assert.equal(output.versions.cliVersion, "0.1.0-dev");
});

test("turns an invalid handler result into one failure document before output starts", async () => {
  const captured = immediateSink();
  const result = await executeCliJson(
    ["version", "--output", "json"],
    {
      cliVersion: "0.1.0-dev",
      stdout: captured.sink,
      handlers: {
        version: () => ({
          context: { update: { checked: "yes" } } as never,
        }),
      },
    },
  );
  assert.equal(result.exitCode, 7);
  assert.equal(captured.chunks.length, 1);
  const output = JSON.parse(captured.chunks[0]!) as Record<string, unknown>;
  assert.equal(output.code, "INTERNAL_ERROR");
});

test("authorizes context bearers from the parsed command instead of the handler", async () => {
  const context = `hmrx1_${"B".repeat(43)}`;
  const candidate = `hmrc1_${"A".repeat(43)}`;
  const captured = immediateSink();
  const result = await executeCliJson(
    ["context", "--output", "json"],
    {
      cliVersion: "0.1.0-dev",
      stdout: captured.sink,
      handlers: {
        context: () => ({
          output: {
            data: {
              command: "context",
              contextId: context,
              labelCandidates: [{ token: candidate }],
              userCandidates: [],
            },
          },
        }),
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(captured.chunks[0]!.includes(context), true);
  assert.equal(captured.chunks[0]!.includes(candidate), true);

  const forged = immediateSink();
  const forgedResult = await executeCliJson(
    ["version", "--output", "json"],
    {
      cliVersion: "0.1.0-dev",
      stdout: forged.sink,
      handlers: {
        version: () => ({ output: { data: { contextId: context } } }),
      },
    },
  );
  assert.equal(forgedResult.exitCode, 7);
  assert.equal(forged.chunks[0]!.includes(context), false);
});

test("turns null, undefined, and accessor handler results into one failure document", async () => {
  for (const handler of [
    () => undefined as never,
    () => null as never,
    () => Object.defineProperty({}, "context", {
      enumerable: true,
      get() { throw new Error("accessor executed"); },
    }) as never,
  ]) {
    const captured = immediateSink();
    const result = await executeCliJson(
      ["version", "--output", "json"],
      {
        cliVersion: "0.1.0-dev",
        stdout: captured.sink,
        handlers: { version: handler },
      },
    );
    assert.equal(result.exitCode, 7);
    assert.equal(captured.chunks.length, 1);
    assert.equal((JSON.parse(captured.chunks[0]!) as { code: string }).code, "INTERNAL_ERROR");
  }
});
