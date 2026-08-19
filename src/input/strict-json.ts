import {
  createScanner,
  printParseErrorCode,
  SyntaxKind,
  visit,
} from "jsonc-parser";

import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonValue } from "../contracts/jcs.ts";

export const MAX_JSON_NESTING_DEPTH = 256;

function assertNestingDepth(text: string): void {
  const scanner = createScanner(text, false);
  let depth = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      depth += 1;
      if (depth > MAX_JSON_NESTING_DEPTH) {
        throw inputError(`JSON nesting exceeds ${String(MAX_JSON_NESTING_DEPTH)} levels`);
      }
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) {
      depth = Math.max(0, depth - 1);
    }
  }
}

function inputError(reason: string): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", `Invalid JSON input: ${reason}`, {
    field: null,
    expected: "one strict JSON document",
    actual: reason,
    safeNextStep: "Provide a valid JSON request without duplicate keys or trailing content.",
  });
}

export function parseStrictJson(text: string): JsonValue {
  assertNestingDepth(text);
  const objectKeys: Set<string>[] = [];
  let duplicateKey: string | undefined;
  let syntaxError: string | undefined;

  try {
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
  } catch {
    throw inputError("JSON parser rejected excessive or invalid nesting");
  }

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
