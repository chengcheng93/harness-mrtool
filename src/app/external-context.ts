import { copyJsonValue, sha256CanonicalJson } from "../contracts/jcs.ts";
import type {
  Candidate,
  ContextBinding,
  IssuedContext,
  IssueContextInput,
} from "../context/types.ts";
import type { ExternalContextSnapshot } from "../render/marker.ts";
import {
  getContext,
  type DiscoveredContext,
  type GetContextOptions,
} from "./get-context.ts";

export type ExternalContextReadOptions = Omit<GetContextOptions, "store">;

export interface ExternalContextReadResult {
  readonly binding: ContextBinding;
  readonly snapshot: ExternalContextSnapshot;
  readonly candidates: readonly Candidate[];
  readonly requiredLabelCategories: DiscoveredContext["requiredLabelCategories"];
  readonly lifecycleLabelNames: DiscoveredContext["lifecycleLabelNames"];
  readonly audit: DiscoveredContext["audit"];
}

export interface ExternalContextReader {
  readonly read: (options: ExternalContextReadOptions) => Promise<ExternalContextReadResult>;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function copyAndFreezeIssueInput(input: IssueContextInput): IssueContextInput {
  return deepFreeze(copyJsonValue(input, "$capture") as unknown as IssueContextInput);
}

function projectedResult(
  input: IssueContextInput,
  discovered: DiscoveredContext,
): ExternalContextReadResult {
  return deepFreeze(copyJsonValue({
    binding: input.binding,
    snapshot: input.snapshot,
    candidates: input.candidates,
    requiredLabelCategories: discovered.requiredLabelCategories,
    lifecycleLabelNames: discovered.lifecycleLabelNames,
    audit: discovered.audit,
  }, "$externalContext") as unknown as ExternalContextReadResult);
}

export async function readExternalContext(
  options: ExternalContextReadOptions,
): Promise<ExternalContextReadResult> {
  const capture: { input?: IssueContextInput } = {};
  const store: GetContextOptions["store"] = {
    issue: async (input): Promise<IssuedContext> => {
      if (capture.input !== undefined) {
        throw new Error("External context capture was invoked more than once");
      }
      const captured = copyAndFreezeIssueInput(input);
      capture.input = captured;
      return Object.freeze({
        contextId: "external-context-capture",
        createdAtMs: 0,
        expiresAtMs: 0,
        externalSnapshotDigest: sha256CanonicalJson(captured.snapshot),
        candidates: Object.freeze(captured.candidates.map((metadata, index) => Object.freeze({
          kind: metadata.kind,
          token: `external-context-candidate-${String(index)}`,
          metadata,
        }))),
      });
    },
  };

  const discovered = await getContext({ ...options, store });
  if (capture.input === undefined) {
    throw new Error("External context capture did not complete");
  }
  return projectedResult(capture.input, discovered);
}

export const defaultExternalContextReader: ExternalContextReader = Object.freeze({
  read: readExternalContext,
});
