import {
  createFailureOutput,
  createSuccessOutput,
  serializeOutput,
  type OutputContext,
  type SuccessOptions,
} from "../contracts/output.ts";
import {
  type FailureCode,
  isToolError,
  ToolError,
} from "../contracts/errors.ts";
import { exitCodeFor, type RemoteWriteState } from "../contracts/exit-codes.ts";
import { copyJsonValue, type JsonObject } from "../contracts/jcs.ts";
import {
  getTransactionAudit,
  remoteWriteFromTransactionAudit,
} from "../app/transaction-journal.ts";

const RAW_CONTEXT_BEARER = /(?:hmrc1_|hmrx1_)[A-Za-z0-9_-]{43}/u;

export interface CliOutputSink {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export interface CliOutputResult {
  readonly exitCode: number;
}

function internalFailure(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "The command failed safely", {
    field: null,
    expected: "a classified harness-mrtool result",
    actual: "an unexpected internal failure",
    safeNextStep: "Retry once, then report the command and tool version without including credentials.",
  });
}

function assertNoRawContextBearer(serialized: string): void {
  if (RAW_CONTEXT_BEARER.test(serialized)) {
    throw new TypeError("CLI output contains a raw candidate or context bearer");
  }
}

export function normalizeCliFailure(error: unknown): ToolError<FailureCode> {
  if (isToolError(error) && error.code !== "UPDATE_CHECK_WARNING") {
    return error as ToolError<FailureCode>;
  }
  return internalFailure();
}

function validationIssue(error: ToolError<FailureCode>): {
  readonly code: string;
  readonly field: string | null;
  readonly message: string;
  readonly expected: ReturnType<typeof copyJsonValue>;
  readonly actual: ReturnType<typeof copyJsonValue>;
  readonly safeNextStep: string;
} {
  return {
    code: error.code,
    field: error.details.field,
    message: error.message,
    expected: copyJsonValue(error.details.expected),
    actual: copyJsonValue(error.details.actual),
    safeNextStep: error.details.safeNextStep,
  };
}

function transactionData(error: unknown): {
  readonly remoteWrite?: ReturnType<typeof remoteWriteFromTransactionAudit>;
  readonly data?: JsonObject;
} {
  const transaction = getTransactionAudit(error);
  if (transaction === null) return {};
  const copied = copyJsonValue(transaction);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
    throw new TypeError("Transaction audit must be a JSON object");
  }
  return {
    remoteWrite: remoteWriteFromTransactionAudit(transaction),
    data: { transaction: copied },
  };
}

export class CliJsonOutput {
  private emitted = false;

  constructor(
    private readonly context: OutputContext,
    private readonly sink: CliOutputSink,
  ) {}

  hasStarted(): boolean {
    return this.emitted;
  }

  async success(options: SuccessOptions = {}): Promise<CliOutputResult> {
    const serialized = serializeOutput(createSuccessOutput(this.context, options));
    assertNoRawContextBearer(serialized);
    await this.emit(serialized);
    return Object.freeze({ exitCode: 0 });
  }

  async failure(error: unknown): Promise<CliOutputResult> {
    let serialized: string;
    let outputCode: FailureCode;
    let remoteWriteState: RemoteWriteState = "not-attempted";
    try {
      const normalized = normalizeCliFailure(error);
      const audit = transactionData(error);
      const context: OutputContext = {
        ...this.context,
        validation: {
          valid: false,
          issues: [validationIssue(normalized)],
        },
        ...(audit.remoteWrite === undefined ? {} : { remoteWrite: audit.remoteWrite }),
      };
      serialized = serializeOutput(createFailureOutput(context, normalized, audit.data ?? null));
      assertNoRawContextBearer(serialized);
      outputCode = normalized.code;
      remoteWriteState = audit.remoteWrite?.state ?? context.remoteWrite?.state ?? "not-attempted";
    } catch {
      const fallback = internalFailure();
      serialized = serializeOutput(createFailureOutput({
        cliVersion: this.context.cliVersion,
        validation: { valid: false, issues: [validationIssue(fallback)] },
      }, fallback));
      assertNoRawContextBearer(serialized);
      outputCode = fallback.code;
    }
    await this.emit(serialized);
    return Object.freeze({
      exitCode: exitCodeFor({ code: outputCode, remoteWriteState }),
    });
  }

  private async emit(serialized: string): Promise<void> {
    if (this.emitted) throw new TypeError("CLI output has already emitted a JSON document");
    this.emitted = true;
    await new Promise<void>((resolve, reject) => {
      this.sink.write(serialized, (error) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
  }
}
