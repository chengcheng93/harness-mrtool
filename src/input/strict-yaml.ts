import {
  isAlias,
  isNode,
  isPair,
  isScalar,
  parseAllDocuments,
  visit,
} from "yaml";

import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonValue } from "../contracts/jcs.ts";

function inputError(reason: string, cause?: unknown): ToolError<"INPUT_ERROR"> {
  return new ToolError(
    "INPUT_ERROR",
    `Invalid YAML input: ${reason}`,
    {
      field: null,
      expected: "one strict YAML document using JSON-compatible core values",
      actual: reason,
      safeNextStep: "Provide one YAML request without aliases, anchors, tags, merge keys, or complex keys.",
    },
    cause,
  );
}

export function parseStrictYaml(text: string): JsonValue {
  let documents;
  try {
    documents = parseAllDocuments(text, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw inputError("YAML syntax error", error);
  }

  if (documents.length !== 1) {
    throw inputError("exactly one non-empty YAML document is required");
  }
  const document = documents[0];
  if (document === undefined || document.contents === null) {
    throw inputError("exactly one non-empty YAML document is required");
  }
  if (isScalar(document.contents) &&
      document.contents.value === null && document.contents.source === "") {
    throw inputError("exactly one non-empty YAML document is required");
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw inputError("YAML syntax or schema error");
  }

  let unsafeReason: string | undefined;
  try {
    visit(document, (key, node) => {
      if (unsafeReason !== undefined) {
        return visit.BREAK;
      }
      if (isAlias(node)) {
        unsafeReason = "aliases are not permitted";
        return visit.BREAK;
      }
      if (isPair(node)) {
        if (!isScalar(node.key) || typeof node.key.value !== "string") {
          unsafeReason = "mapping keys must be strings";
          return visit.BREAK;
        }
        if (node.key.value === "<<") {
          unsafeReason = "merge keys are not permitted";
          return visit.BREAK;
        }
        return undefined;
      }
      if (isNode(node) && typeof node.anchor === "string") {
        unsafeReason = "anchors are not permitted";
        return visit.BREAK;
      }
      if (isNode(node) && typeof node.tag === "string") {
        unsafeReason = "explicit tags are not permitted";
        return visit.BREAK;
      }
      if (isScalar(node) && typeof node.value === "number" && !Number.isFinite(node.value)) {
        unsafeReason = "non-finite numbers are not permitted";
        return visit.BREAK;
      }
      return undefined;
    });
  } catch (error) {
    throw inputError("YAML structure is too deeply nested or invalid", error);
  }

  if (unsafeReason !== undefined) {
    throw inputError(unsafeReason);
  }

  try {
    return copyJsonValue(document.toJS({ mapAsMap: false, maxAliasCount: 0 }));
  } catch (error) {
    throw inputError("YAML value is not JSON-compatible", error);
  }
}
