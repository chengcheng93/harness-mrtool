import { isSea } from "node:sea";

import { normalizeRuntimeArguments } from "./runtime-arguments.ts";

declare const __HARNESS_MRTOOL_VERSION__: string;

interface JsonResult {
  readonly ok: boolean;
  readonly code: string;
  readonly sea?: boolean;
  readonly version?: string;
  readonly message?: string;
}

function writeJson(result: JsonResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function fail(message: string, output: string | undefined): void {
  if (output === "json") {
    writeJson({ ok: false, code: "USAGE_ERROR", message });
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 2;
}

function main(arguments_: readonly string[]): void {
  const outputIndex = arguments_.indexOf("--output");
  const output = outputIndex >= 0 ? arguments_[outputIndex + 1] : undefined;
  const command = arguments_.find((argument) => !argument.startsWith("-"));

  if (command !== "self-test") {
    fail("Usage: harness-mrtool self-test --output json", output);
    return;
  }
  if (output !== "json") {
    fail("self-test requires --output json", output);
    return;
  }

  writeJson({
    ok: true,
    code: "OK",
    sea: isSea(),
    version: __HARNESS_MRTOOL_VERSION__,
  });
}

main(normalizeRuntimeArguments(process.argv));
