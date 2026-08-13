import { isSea } from "node:sea";

import {
  createSuccessOutput,
  serializeOutput,
} from "./contracts/output.ts";
import { normalizeRuntimeArguments } from "./runtime-arguments.ts";

declare const __HARNESS_MRTOOL_VERSION__: string;

interface JsonResult {
  readonly ok: boolean;
  readonly code: string;
  readonly sea?: boolean;
  readonly version?: string;
  readonly message?: string;
  readonly validOutputAccepted?: boolean;
  readonly invalidOutputRejected?: boolean;
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

function runContractProbe(): void {
  let validOutputAccepted = false;
  let invalidOutputRejected = false;

  try {
    const serialized = serializeOutput(
      createSuccessOutput(
        { cliVersion: __HARNESS_MRTOOL_VERSION__ },
        { data: { contractProbe: true } },
      ),
    );
    const parsed = JSON.parse(serialized) as {
      readonly schemaVersion?: unknown;
      readonly ok?: unknown;
      readonly code?: unknown;
    };
    validOutputAccepted =
      serialized.endsWith("\n") &&
      parsed.schemaVersion === 1 &&
      parsed.ok === true &&
      parsed.code === "OK";

    try {
      createSuccessOutput({
        cliVersion: __HARNESS_MRTOOL_VERSION__,
        update: { checked: "yes" },
      } as never);
    } catch (error) {
      invalidOutputRejected = error instanceof TypeError;
    }
  } catch {
    validOutputAccepted = false;
  }

  if (!validOutputAccepted || !invalidOutputRejected) {
    writeJson({
      ok: false,
      code: "CONTRACT_PROBE_FAILED",
      message: "Embedded output contract probe failed",
    });
    process.exitCode = 7;
    return;
  }

  writeJson({
    ok: true,
    code: "CONTRACT_PROBE_OK",
    sea: isSea(),
    version: __HARNESS_MRTOOL_VERSION__,
    validOutputAccepted,
    invalidOutputRejected,
  });
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
  if (arguments_.includes("--contract-probe")) {
    runContractProbe();
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
