import requestSchema from "../../schemas/request-v1.schema.json" with { type: "json" };
import { ToolError } from "./errors.ts";
import type { Request } from "./request.ts";

// Historical Requests retain their relations; new submissions have one Issue-first mode.
export const newSubmissionRequestSchema = {
  ...requestSchema,
  definitions: {
    ...requestSchema.definitions,
    workItem: {
      type: "object",
      additionalProperties: false,
      required: ["relation"],
      properties: { relation: { const: "new" } },
    },
  },
};

export function assertNewIssueSubmission(request: Request): void {
  if (request.workItem.relation !== "new") {
    throw new ToolError("INPUT_ERROR", "Every new MR must create and link a new Issue", {
      field: "workItem",
      expected: { relation: "new" },
      actual: request.workItem.relation,
      safeNextStep: "Omit workItem or use relation:new for API create; use update for an existing MR.",
    });
  }
}
