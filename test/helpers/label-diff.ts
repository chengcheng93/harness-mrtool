import type { CanonicalLabelChangeSet } from "../../src/git/change-set.ts";
import type { LabelDiffBinding } from "../../src/app/mandatory-labels.ts";

/** A concrete before/after regression diff for transaction fixtures, not caller title evidence. */
export function bugLabelDiff(binding: LabelDiffBinding): CanonicalLabelChangeSet {
  return {
    sourceHeadSha: binding.sourceHeadSha,
    targetRefSha: binding.targetRefSha,
    mergeBaseSha: binding.mergeBaseSha,
    items: [{ status: "modified", newPath: "src/limit.ts", binary: false, submodule: false,
      before: "if (attempts > max) { return false; }", after: "if (attempts >= max) { return false; }",
    }],
  };
}
