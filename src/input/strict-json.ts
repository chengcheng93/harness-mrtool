import { printParseErrorCode, visit } from "jsonc-parser";

import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonValue } from "../contracts/jcs.ts";

function inputError(reason: string): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", `Invalid JSON input: ${reason}`, {
    field: null,
    expected: "one strict JSON document",
    actual: reason,
    safeNextStep: "Provide a valid JSON request without duplicate keys or trailing content.",
  });
}

export function parseStrictJson(text: string): JsonValue {
  const objectKeys: Set<string>[] = [];
  let duplicateKey: string | undefined;
  let syntaxError: string | undefined;

  visit(
    text,
    {
      onObjectBegin: () => {
        objectKeys.push(new Set());
      },
      onObjectProperty: (property) => {
        const keys = objectKeys.at(-1);
        if (keys?.has(property)) {
          duplicateKey ??= property;
        } else {
          keys?.add(property);
        }
      },
      onObjectEnd: () => {
        objectKeys.pop();
      },
      onError: (code) => {
        syntaxError ??= printParseErrorCode(code);
      },
    },
    { allowTrailingComma: false, disallowComments: true },
  );

  if (duplicateKey !== undefined) {
    throw inputError("duplicate object key");
  }
  if (syntaxError !== undefined) {
    throw inputError(`JSON syntax error: ${syntaxError}`);
  }

  try {
    return copyJsonValue(JSON.parse(text));
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw inputError("JSON syntax error");
  }
}
