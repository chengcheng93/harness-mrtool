import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { composeProfiles } from "../bundle/compose.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import type { Request } from "../contracts/request.ts";
import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson, copyJsonValue, type JsonObject } from "../contracts/jcs.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";

function renderError(reason: string): ToolError<"RENDER_ERROR"> {
  return new ToolError("RENDER_ERROR", `Merge request title rendering failed: ${reason}`, {
    field: "title",
    expected: "a canonical request and a Bundle-defined title type producing at most 100 Unicode scalars",
    actual: reason,
    safeNextStep: "Use a normalized request with a supported title type and shorten the title fields.",
  });
}

function titleTypes(bundle: LoadedTemplateBundle): readonly string[] {
  const registry = bundle.registries.fields as JsonObject;
  if (!Array.isArray(registry.titleTypes) ||
      registry.titleTypes.some((value) => typeof value !== "string")) {
    throw renderError("the Bundle title type registry is invalid");
  }
  return registry.titleTypes as string[];
}

export function renderTitle(
  requestValue: Request | unknown,
  bundleValue: LoadedTemplateBundle | unknown,
): string {
  try {
    const requestSnapshot = copyJsonValue(requestValue);
    const request = normalizeAndValidateRequest(requestSnapshot);
    if (canonicalizeJson(requestSnapshot) !== canonicalizeJson(request)) {
      throw renderError("the request is not in canonical normalized form");
    }
    const bundle = copyJsonValue(bundleValue) as unknown as LoadedTemplateBundle;
    validateTemplateBundle(bundle);
    composeProfiles(bundle, request.profileIds, { impactNature: request.impact.nature });
    if (!titleTypes(bundle).includes(request.title.type)) {
      throw renderError("the title type is not declared by the Bundle");
    }
    const prefix = request.intent === "draft" ? "Draft: " : "";
    const title = `${prefix}[${request.title.type}][${request.title.module}] ${request.title.titleSummary}`;
    if ([...title].length > 100) {
      throw renderError("the rendered title exceeds 100 Unicode scalar values");
    }
    return title;
  } catch (error) {
    if (error instanceof ToolError && error.code === "RENDER_ERROR") {
      throw error;
    }
    throw renderError("the renderer input is invalid");
  }
}
