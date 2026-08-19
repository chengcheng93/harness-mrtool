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
const EXACT_CONTEXT_BEARER = /^hmrx1_[A-Za-z0-9_-]{43}$/u;
const EXACT_CANDIDATE_BEARER = /^hmrc1_[A-Za-z0-9_-]{43}$/u;
const SECRET_SHAPES = [
  /glpat-[A-Za-z0-9_-]{8,}/iu,
  /github_pat_[A-Za-z0-9_]{8,}/iu,
  /gh[pousr]_[A-Za-z0-9]{8,}/iu,
  /authorization\s*:\s*(?:bearer|basic)\s+[^\s"']+/iu,
  /\bbearer\s+[A-Za-z0-9._~+\/-]{8,}/iu,
  /[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:[^\s\/@]+@/iu,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
] as const;

export interface CliOutputPolicy {
  readonly contextBearers?: boolean;
}

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

function allowedContextBearer(path: readonly (string | number)[], value: string): boolean {
  if (path.length === 2 && path[0] === "data" && path[1] === "contextId") {
    return EXACT_CONTEXT_BEARER.test(value);
  }
  if (
    path.length === 4 &&
    path[0] === "data" &&
    (path[1] === "labelCandidates" || path[1] === "userCandidates") &&
    typeof path[2] === "number" &&
    path[3] === "token"
  ) {
    return EXACT_CANDIDATE_BEARER.test(value);
  }
  return false;
}

function assertSafeOutputValue(
  value: unknown,
  policy: CliOutputPolicy,
  path: readonly (string | number)[] = [],
): void {
  if (typeof value === "string") {
    for (const pattern of SECRET_SHAPES) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) throw new TypeError("CLI output contains a secret-shaped value");
    }
    RAW_CONTEXT_BEARER.lastIndex = 0;
    if (RAW_CONTEXT_BEARER.test(value) &&
        !(policy.contextBearers === true && allowedContextBearer(path, value))) {
      throw new TypeError("CLI output contains a raw candidate or context bearer");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeOutputValue(child, policy, [...path, index]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertSafeOutputValue(child, policy, [...path, key]);
    }
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
    private readonly policy: CliOutputPolicy = {},
  ) {}

  hasStarted(): boolean {
    return this.emitted;
  }

  async success(options: SuccessOptions = {}): Promise<CliOutputResult> {
    const envelope = createSuccessOutput(this.context, options);
    if (this.policy.contextBearers === true &&
        (envelope.data === null || envelope.data.command !== "context")) {
      throw new TypeError("Context bearer output requires the context command envelope");
    }
    assertSafeOutputValue(envelope, this.policy);
    const serialized = serializeOutput(envelope);
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
      assertSafeOutputValue(JSON.parse(serialized) as unknown, {});
      outputCode = normalized.code;
      remoteWriteState = audit.remoteWrite?.state ?? context.remoteWrite?.state ?? "not-attempted";
    } catch {
      const fallback = internalFailure();
      serialized = serializeOutput(createFailureOutput({
        cliVersion: this.context.cliVersion,
        validation: { valid: false, issues: [validationIssue(fallback)] },
      }, fallback));
      assertSafeOutputValue(JSON.parse(serialized) as unknown, {});
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
