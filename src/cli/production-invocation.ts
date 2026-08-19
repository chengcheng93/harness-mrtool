import { ToolError } from "../contracts/errors.ts";

export interface ProductionInvocation {
  readonly arguments: readonly string[];
  readonly contextIssueIid: number | null;
}

function invalidIssueOption(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Invalid context issue option", {
    field: "issue",
    expected: "one positive integer --issue option on the context command",
    actual: "invalid or out-of-scope issue option",
    safeNextStep: "Use --issue <positive-iid> once with the context command and retry.",
  });
}

export function preprocessProductionInvocation(
  arguments_: readonly string[],
): ProductionInvocation {
  const command = arguments_[0];
  const sanitized: string[] = [];
  let contextIssueIid: number | null = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) throw invalidIssueOption();
    if (argument.startsWith("--issue=")) throw invalidIssueOption();
    if (argument !== "--issue") {
      sanitized.push(argument);
      continue;
    }
    if (command !== "context" || contextIssueIid !== null) throw invalidIssueOption();
    const rawIid = arguments_[index + 1];
    if (rawIid === undefined || !/^[1-9][0-9]*$/u.test(rawIid)) throw invalidIssueOption();
    const iid = Number(rawIid);
    if (!Number.isSafeInteger(iid)) throw invalidIssueOption();
    contextIssueIid = iid;
    index += 1;
  }

  return Object.freeze({
    arguments: Object.freeze(sanitized),
    contextIssueIid,
  });
}
