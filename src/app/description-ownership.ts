import { validateTemplateBundle } from "../bundle/validate.ts";
import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson, sha256Utf8 } from "../contracts/jcs.ts";
import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { digestDescriptionBody, parseDiagnosticMarker } from "../render/marker.ts";

export interface DescriptionOwnership {
  readonly manuallyChanged: boolean;
}

function ownershipError(
  code: "UNMANAGED_MR" | "MANUAL_DESCRIPTION_CHANGE" | "TEMPLATE_ERROR",
  message: string,
): ToolError {
  return new ToolError(code, message, {
    field: "mergeRequest.description",
    expected: "a final harness-mrtool marker whose body and pinned Bundle are verifiable",
    actual: "managed description ownership could not be proven",
    safeNextStep: code === "MANUAL_DESCRIPTION_CHANGE"
      ? "Map the manual text back into the structured Request, or explicitly confirm --force-replace-description."
      : "Refresh the MR and load the exact immutable Template Bundle named by its verified marker.",
  });
}

export function assertManagedDescription(
  description: string,
  bundle: LoadedTemplateBundle,
  releaseTag: string,
  allowManualReplacement = false,
): DescriptionOwnership {
  validateTemplateBundle(bundle);
  let marker: ReturnType<typeof parseDiagnosticMarker>;
  try {
    marker = parseDiagnosticMarker(description);
  } catch {
    throw ownershipError("UNMANAGED_MR", "The merge request has no valid harness-mrtool marker");
  }
  if (marker.renderPhase !== "final") {
    throw ownershipError("UNMANAGED_MR", "The merge request marker is not a final managed marker");
  }
  const manifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  if (marker.releaseTag !== releaseTag || marker.bundleId !== bundle.manifest.bundleId ||
      marker.bundleVersion !== bundle.manifest.version ||
      marker.bundleManifestHash !== manifestHash ||
      marker.policySchema !== bundle.manifest.policySchema) {
    throw ownershipError("TEMPLATE_ERROR", "The loaded Template Bundle does not match the MR marker");
  }
  const manuallyChanged = marker.bodyDigest !== digestDescriptionBody(description);
  if (manuallyChanged && !allowManualReplacement) {
    throw ownershipError("MANUAL_DESCRIPTION_CHANGE", "The managed description body was edited outside harness-mrtool");
  }
  return Object.freeze({ manuallyChanged });
}
