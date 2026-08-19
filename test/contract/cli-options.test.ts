import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { MAX_INPUT_BYTES, type InputIo } from "../../src/input/load-input.ts";
import { loadCliInput, resolveCliInputTransport } from "../../src/cli/input.ts";
import { mayPrompt, parseCliOptions } from "../../src/cli/options.ts";

function assertInputError(run: () => unknown, field?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR"), true);
    if (field !== undefined && isToolError(error, "INPUT_ERROR")) {
      assert.equal(error.details.field, field);
    }
    return true;
  });
}

async function* stdin(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

function ioForStdin(...chunks: Uint8Array[]): InputIo {
  return {
    statFile: async () => {
      throw new Error("file metadata must not be read");
    },
    readFile: async () => {
      throw new Error("file content must not be read");
    },
    stdin: stdin(...chunks),
  };
}

test("parses the complete common CLI flag contract without side effects", () => {
  const parsed = parseCliOptions([
    "--input=payload.yaml",
    "--input-format", "json",
    "--non-interactive",
    "--output", "json",
    "--client", "codex-skill",
    "--client-version", "1.2.3-beta.1",
    "--skill-protocol", "2",
    "--push",
    "--dry-run",
    "--offline",
    "--profile", "code+docs",
    "--type", "fix",
    "--module", "luban-studio",
    "--title-summary", "Keep CSS output compatible",
  ]);

  assert.deepEqual(parsed, {
    input: "payload.yaml",
    inputFormat: "json",
    nonInteractive: true,
    output: "json",
    client: "codex-skill",
    clientVersion: "1.2.3-beta.1",
    skillProtocol: 2,
    push: true,
    dryRun: true,
    offline: true,
    noUpdate: false,
    profile: { kind: "explicit", ids: ["code", "docs"] },
    type: "fix",
    module: "luban-studio",
    titleSummary: "Keep CSS output compatible",
  });
});

test("uses explicit stable defaults", () => {
  assert.deepEqual(parseCliOptions([]), {
    input: null,
    inputFormat: null,
    nonInteractive: false,
    output: null,
    client: "manual",
    clientVersion: null,
    skillProtocol: null,
    push: false,
    dryRun: false,
    offline: false,
    noUpdate: false,
    profile: null,
    type: null,
    module: null,
    titleSummary: null,
  });
  assert.deepEqual(parseCliOptions(["--profile", "auto"]).profile, { kind: "auto" });
});

test("enforces coherent client tuples", () => {
  const script = parseCliOptions([
    "--client", "script",
    "--client-version", "4.5.6+runner.1",
  ]);
  assert.equal(script.client, "script");
  assert.equal(script.clientVersion, "4.5.6+runner.1");
  assert.equal(parseCliOptions(["--client", "script"]).clientVersion, null);

  for (const args of [
    ["--client", "codex-skill"],
    ["--client", "codex-skill", "--client-version", "1.2.3"],
    ["--client", "codex-skill", "--skill-protocol", "1"],
    ["--client", "manual", "--client-version", "1.2.3"],
    ["--client", "script", "--skill-protocol", "1"],
    ["--client", "codex-skill", "--client-version", "v1.2.3", "--skill-protocol", "1"],
    ["--client", "codex-skill", "--client-version", "1.2", "--skill-protocol", "1"],
    ["--client", "codex-skill", "--client-version", "1.2.3", "--skill-protocol", "0"],
    ["--client", "codex-skill", "--client-version", "1.2.3", "--skill-protocol", "01"],
  ]) {
    assertInputError(() => parseCliOptions(args));
  }
});

test("rejects duplicates, missing values, unsupported values, and conflicts as INPUT_ERROR", () => {
  const cases: readonly (readonly string[])[] = [
    ["--offline", "--offline"],
    ["--input", "one.json", "--input=two.json"],
    ["--output", "json", "--output", "json"],
    ["--offline", "--no-update"],
    ["--input-format", "json"],
    ["--input", "-"],
    ["--input", "payload.json", "--input-format", "toml"],
    ["--output", "human"],
    ["--client", "agent"],
    ["--title-summary"],
    ["--unknown"],
    ["positional-value"],
    ["--profile", "code++docs"],
    ["--profile", "code+code"],
  ];
  for (const args of cases) {
    assertInputError(() => parseCliOptions(args));
  }
});

test("never includes rejected argv values in errors", () => {
  const secret = "glpat-cli-secret";
  assert.throws(() => parseCliOptions(["--client-version", secret]), (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR"), true);
    assert.equal(error instanceof Error && error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

test("allows prompts only for a manual terminal that is not consuming stdin", () => {
  const interactive = parseCliOptions([]);
  assert.equal(mayPrompt(interactive, true), true);
  assert.equal(mayPrompt(interactive, false), false);
  assert.equal(mayPrompt(parseCliOptions(["--non-interactive"]), true), false);
  assert.equal(mayPrompt(parseCliOptions(["--client", "script"]), true), false);
  assert.equal(mayPrompt(parseCliOptions([
    "--client", "codex-skill",
    "--client-version", "1.0.0",
    "--skill-protocol", "1",
  ]), true), false);
  assert.equal(mayPrompt(parseCliOptions([
    "--input", "-",
    "--input-format", "json",
  ]), true), false);
  assert.equal(mayPrompt(parseCliOptions(["--input", "request.yaml"]), true), true);
});

test("resolves file and stdin transports while leaving file format inference to the input layer", () => {
  assert.equal(resolveCliInputTransport(parseCliOptions([])), null);
  assert.deepEqual(
    resolveCliInputTransport(parseCliOptions(["--input", "request.YML"])),
    { kind: "file", path: "request.YML" },
  );
  assert.deepEqual(
    resolveCliInputTransport(parseCliOptions([
      "--input", "request.data",
      "--input-format", "yaml",
    ])),
    { kind: "file", path: "request.data", format: "yaml" },
  );
  assert.deepEqual(
    resolveCliInputTransport(parseCliOptions([
      "--input", "-",
      "--input-format", "json",
    ])),
    { kind: "stdin", format: "json" },
  );
});

test("loads a real file by inferred extension and reads stdin to EOF", async () => {
  const fixturePath = fileURLToPath(new URL("../fixtures/requests/code-docs.json", import.meta.url));
  const fromFile = await loadCliInput(parseCliOptions(["--input", fixturePath]));
  assert.equal(
    typeof fromFile === "object" && fromFile !== null && !Array.isArray(fromFile)
      ? fromFile.schemaVersion
      : null,
    1,
  );

  const fromStdin = await loadCliInput(
    parseCliOptions(["--input", "-", "--input-format", "json"]),
    ioForStdin(
      Buffer.from('{"first":"one",', "utf8"),
      Buffer.from('"second":"two"}', "utf8"),
    ),
  );
  assert.deepEqual(fromStdin, { first: "one", second: "two" });
});

test("preserves stable UTF-8 and size failures through the CLI transport", async () => {
  await assert.rejects(
    loadCliInput(
      parseCliOptions(["--input", "-", "--input-format", "json"]),
      ioForStdin(Uint8Array.from([0x22, 0xc3, 0x28, 0x22])),
    ),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );

  await assert.rejects(
    loadCliInput(
      parseCliOptions(["--input", "-", "--input-format", "json"]),
      ioForStdin(new Uint8Array(MAX_INPUT_BYTES + 1)),
    ),
    (error: unknown) => isToolError(error, "INPUT_TOO_LARGE"),
  );
});

test("merges equal scalar prefills and rejects inconsistent input without leaking values", async () => {
  const same = await loadCliInput(
    parseCliOptions([
      "--input", "-",
      "--input-format", "json",
      "--profile", "code+docs",
      "--type", "fix",
      "--module", "luban-studio",
      "--title-summary", "Keep CSS compatible",
    ]),
    ioForStdin(Buffer.from(JSON.stringify({
      profileIds: [" code ", "docs"],
      title: {
        type: " fix ",
        module: "luban-studio",
        titleSummary: " Keep CSS compatible ",
      },
    }), "utf8")),
  );
  assert.equal(
    typeof same === "object" && same !== null && !Array.isArray(same)
      ? (same.title as { titleSummary?: unknown }).titleSummary
      : null,
    " Keep CSS compatible ",
  );

  const secret = "glpat-conflicting-title";
  await assert.rejects(
    loadCliInput(
      parseCliOptions([
        "--input", "-",
        "--input-format", "json",
        "--title-summary", secret,
      ]),
      ioForStdin(Buffer.from('{"title":{"titleSummary":"different"}}', "utf8")),
    ),
    (error: unknown) => {
      assert.equal(isToolError(error, "INPUT_ERROR"), true);
      assert.equal(error instanceof Error && error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test("uses scalar flags as prefills when structured fields are absent", async () => {
  const value = await loadCliInput(
    parseCliOptions([
      "--input", "-",
      "--input-format", "yaml",
      "--profile", "docs",
      "--type", "docs",
      "--module", "manual",
      "--title-summary", "Clarify setup",
    ]),
    ioForStdin(Buffer.from("schemaVersion: 1\n", "utf8")),
  );
  assert.deepEqual(value, {
    schemaVersion: 1,
    profileIds: ["docs"],
    title: {
      type: "docs",
      module: "manual",
      titleSummary: "Clarify setup",
    },
  });
});
