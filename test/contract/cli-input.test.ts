import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  canonicalRequestBytes,
  createProductionRequestSource,
} from "../../src/cli/production-input.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import type { InputIo } from "../../src/input/load-input.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const jsonPath = resolve(repositoryRoot, "test/fixtures/requests/code-docs.json");
const yamlPath = resolve(repositoryRoot, "test/fixtures/requests/code-docs.yml");

function stdinIo(bytes: Uint8Array): { readonly io: InputIo; readonly reads: () => number } {
  let iteratorReads = 0;
  const source: InputIo["stdin"] = {
    [Symbol.asyncIterator]() {
      iteratorReads += 1;
      return (async function* () {
        yield bytes;
      })();
    },
  };
  return {
    io: {
      statFile: async () => { throw new Error("file stat must not run"); },
      readFile: async () => { throw new Error("file read must not run"); },
      stdin: source,
    },
    reads: () => iteratorReads,
  };
}

function failOnIo(): { readonly io: InputIo; readonly reads: () => number } {
  let iteratorReads = 0;
  const source: InputIo["stdin"] = {
    [Symbol.asyncIterator]() {
      iteratorReads += 1;
      return (async function* () {
        throw new Error("stdin must not be read");
      })();
    },
  };
  return {
    io: {
      statFile: async () => { throw new Error("file stat must not run"); },
      readFile: async () => { throw new Error("file read must not run"); },
      stdin: source,
    },
    reads: () => iteratorReads,
  };
}

test("YAML/JSON files and explicit YAML/JSON stdin converge to one immutable Request", async () => {
  const jsonBytes = await readFile(jsonPath);
  const yamlBytes = await readFile(yamlPath);
  const jsonStdin = stdinIo(jsonBytes);
  const yamlStdin = stdinIo(yamlBytes);

  const fromJsonFile = await createProductionRequestSource({
    stdinIsTerminal: () => false,
  }).read(parseCliInvocation(["preview", "--input", jsonPath]));
  const fromYamlFile = await createProductionRequestSource({
    stdinIsTerminal: () => false,
  }).read(parseCliInvocation(["preview", "--input", yamlPath]));
  const fromJsonStdin = await createProductionRequestSource({
    inputIo: jsonStdin.io,
    stdinIsTerminal: () => false,
  }).read(parseCliInvocation(["preview", "--input", "-", "--input-format", "json"]));
  const fromYamlStdin = await createProductionRequestSource({
    inputIo: yamlStdin.io,
    stdinIsTerminal: () => false,
  }).read(parseCliInvocation(["preview", "--input", "-", "--input-format", "yaml"]));

  const requests = [fromJsonFile, fromYamlFile, fromJsonStdin, fromYamlStdin];
  for (const request of requests) {
    assert.deepEqual(request, fromJsonFile);
    assert.deepEqual(canonicalRequestBytes(request), canonicalRequestBytes(fromJsonFile));
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.changes), true);
    assert.equal(Object.isFrozen(request.changes.summary), true);
  }
  assert.equal(jsonStdin.reads(), 1);
  assert.equal(yamlStdin.reads(), 1);
});

test("non-TTY request commands without --input fail before touching stdin", async () => {
  const invocations = [
    ["create"],
    ["update", "123"],
    ["preview"],
    ["update", "123", "--migrate-template"],
  ] as const;

  for (const arguments_ of invocations) {
    const fixture = failOnIo();
    const source = createProductionRequestSource({
      inputIo: fixture.io,
      stdinIsTerminal: () => false,
    });
    await assert.rejects(
      source.read(parseCliInvocation(arguments_)),
      (error: unknown) => isToolError(error, "INPUT_ERROR") &&
        error.message === "Structured input is required for non-interactive execution",
    );
    assert.equal(fixture.reads(), 0, arguments_.join(" "));
  }
});

test("a pipe is consumed only when the invocation explicitly declares --input -", async () => {
  const jsonBytes = await readFile(jsonPath);
  const missing = stdinIo(jsonBytes);
  const sourceWithoutInput = createProductionRequestSource({
    inputIo: missing.io,
    stdinIsTerminal: () => false,
  });

  await assert.rejects(
    sourceWithoutInput.read(parseCliInvocation(["preview"])),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );
  assert.equal(missing.reads(), 0);

  const explicit = stdinIo(jsonBytes);
  const request = await createProductionRequestSource({
    inputIo: explicit.io,
    stdinIsTerminal: () => false,
  }).read(parseCliInvocation(["preview", "--input", "-", "--input-format", "json"]));

  assert.equal(request.schemaVersion, 1);
  assert.equal(explicit.reads(), 1);
});

test("--non-interactive on a TTY requires structured input and never starts the wizard", async () => {
  const fixture = failOnIo();
  let wizardCalls = 0;
  const source = createProductionRequestSource({
    inputIo: fixture.io,
    stdinIsTerminal: () => true,
    wizard: {
      collect: async () => {
        wizardCalls += 1;
        throw new Error("wizard must not run");
      },
    },
  });

  await assert.rejects(
    source.read(parseCliInvocation(["preview", "--non-interactive"])),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );
  assert.equal(wizardCalls, 0);
  assert.equal(fixture.reads(), 0);
});

test("non-TTY migration requires the explicit hash flag before reading any input source", async () => {
  let statCalls = 0;
  let readCalls = 0;
  let stdinReads = 0;
  const source = createProductionRequestSource({
    inputIo: {
      statFile: async () => {
        statCalls += 1;
        return { size: 2 };
      },
      readFile: async () => {
        readCalls += 1;
        return Buffer.from("{}", "utf8");
      },
      stdin: {
        [Symbol.asyncIterator]() {
          stdinReads += 1;
          return (async function* () { yield Buffer.from("{}"); })();
        },
      },
    },
    stdinIsTerminal: () => false,
  });

  await assert.rejects(
    source.read(parseCliInvocation([
      "update",
      "123",
      "--migrate-template",
      "--input",
      "request.json",
    ])),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      error.message === "Template migration confirmation is required for automation",
  );
  assert.equal(statCalls, 0);
  assert.equal(readCalls, 0);
  assert.equal(stdinReads, 0);
});
