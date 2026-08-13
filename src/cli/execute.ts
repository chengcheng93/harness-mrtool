import { ToolError } from "../contracts/errors.ts";
import type {
  OutputContext,
  SuccessOptions,
} from "../contracts/output.ts";
import { CliJsonOutput, type CliOutputResult, type CliOutputSink } from "./output.ts";
import {
  parseCliInvocation,
  type CliCommand,
  type CliInvocation,
} from "./program.ts";

type CommandKind = CliCommand["kind"];
type InvocationFor<Kind extends CommandKind> = Omit<CliInvocation, "command"> & {
  readonly command: Extract<CliCommand, { readonly kind: Kind }>;
};

export interface CliCommandExecution {
  readonly context?: Omit<OutputContext, "cliVersion">;
  readonly output?: SuccessOptions;
}

export type CliCommandHandlers = {
  readonly [Kind in CommandKind]?: (
    invocation: InvocationFor<Kind>,
  ) => Promise<CliCommandExecution> | CliCommandExecution;
};

export interface ExecuteCliJsonOptions {
  readonly cliVersion: string;
  readonly stdout: CliOutputSink;
  readonly handlers: CliCommandHandlers;
}

function inputError(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "JSON output mode is required", {
    field: "--output",
    expected: "json",
    actual: "missing output mode",
    safeNextStep: "Pass --output json when invoking the machine command interface.",
  });
}

function missingHandler(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "The command is not available in this build", {
    field: null,
    expected: "a registered V1 command implementation",
    actual: "command implementation is unavailable",
    safeNextStep: "Run doctor to inspect the installed CLI, then reinstall a complete verified release if needed.",
  });
}

async function invokeHandler(
  handlers: CliCommandHandlers,
  invocation: CliInvocation,
): Promise<CliCommandExecution> {
  const handler = handlers[invocation.command.kind] as
    | ((value: CliInvocation) => Promise<CliCommandExecution> | CliCommandExecution)
    | undefined;
  if (handler === undefined) throw missingHandler();
  return await handler(invocation);
}

function executionDataProperty(
  value: object,
  key: "context" | "output",
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new TypeError("CLI command result contains an accessor");
  return descriptor.value;
}

function validateExecution(value: unknown): CliCommandExecution {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("CLI command result must be a plain object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "context" && key !== "output")) {
    throw new TypeError("CLI command result contains an unsupported field");
  }
  const hasContext = keys.includes("context");
  const hasOutput = keys.includes("output");
  const context = hasContext ? executionDataProperty(value, "context") : undefined;
  const output = hasOutput ? executionDataProperty(value, "output") : undefined;
  if (hasContext && context === undefined) {
    throw new TypeError("CLI command context cannot be undefined");
  }
  if (hasOutput && output === undefined) {
    throw new TypeError("CLI command output cannot be undefined");
  }
  if (hasContext && hasOutput) {
    return {
      context: context as NonNullable<CliCommandExecution["context"]>,
      output: output as NonNullable<CliCommandExecution["output"]>,
    };
  }
  if (hasContext) {
    return { context: context as NonNullable<CliCommandExecution["context"]> };
  }
  if (hasOutput) {
    return { output: output as NonNullable<CliCommandExecution["output"]> };
  }
  return {};
}

export async function executeCliJson(
  arguments_: readonly string[],
  options: ExecuteCliJsonOptions,
): Promise<CliOutputResult> {
  let invocation: CliInvocation;
  try {
    invocation = parseCliInvocation(arguments_);
    if (invocation.options.output !== "json") throw inputError();
  } catch (error) {
    return await new CliJsonOutput(
      { cliVersion: options.cliVersion },
      options.stdout,
    ).failure(error);
  }

  let execution: CliCommandExecution;
  try {
    execution = validateExecution(await invokeHandler(options.handlers, invocation));
  } catch (error) {
    return await new CliJsonOutput(
      { cliVersion: options.cliVersion },
      options.stdout,
    ).failure(error);
  }
  let output: CliJsonOutput | null = null;
  try {
    const executionContext = execution.context === undefined
      ? {}
      : execution.context;
    output = new CliJsonOutput(
      { ...executionContext, cliVersion: options.cliVersion },
      options.stdout,
      { contextBearers: invocation.command.kind === "context" },
    );
    return await output.success(execution.output);
  } catch (error) {
    if (output?.hasStarted() === true) throw error;
    return await new CliJsonOutput(
      { cliVersion: options.cliVersion },
      options.stdout,
    ).failure(error);
  }
}
