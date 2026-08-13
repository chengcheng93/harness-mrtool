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
    execution = await invokeHandler(options.handlers, invocation);
  } catch (error) {
    return await new CliJsonOutput(
      { cliVersion: options.cliVersion },
      options.stdout,
    ).failure(error);
  }
  const output = new CliJsonOutput(
    { ...execution.context, cliVersion: options.cliVersion },
    options.stdout,
  );
  try {
    return await output.success(execution.output);
  } catch (error) {
    if (output.hasStarted()) throw error;
    return await new CliJsonOutput(
      { cliVersion: options.cliVersion },
      options.stdout,
    ).failure(error);
  }
}
