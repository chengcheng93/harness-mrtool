import type { LoadedTemplateBundle } from "../../bundle/load.ts";
import { validateTemplateBundle } from "../../bundle/validate.ts";
import { isToolError, ToolError } from "../../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256Utf8,
  type JsonObject,
} from "../../contracts/jcs.ts";
import {
  renderProjectTemplate,
  type ProjectTemplateProfile,
} from "../../render/project-template.ts";
import type { CliCommandExecution, CliCommandHandlers } from "../execute.ts";

const PROJECT_TEMPLATE_PROFILES = ["general", "code", "docs", "ops"] as const;
const LOWER_SHA256 = /^[a-f0-9]{64}$/u;

export interface TrustedBundleSelection {
  readonly bundle: LoadedTemplateBundle;
  readonly bundleManifestHash: string;
  readonly releaseSetId: string;
  readonly releaseTag: string;
}

export interface LocalCommandDependencies {
  readonly cliVersion: string;
  readonly current: TrustedBundleSelection;
  readonly loadHistoricalBundle?: (mrIid: number) => Promise<TrustedBundleSelection>;
  readonly writeProjection?: (
    destination: string,
    contents: string,
  ) => Promise<void> | void;
}

function templateError(reason: string): ToolError<"TEMPLATE_ERROR"> {
  return new ToolError("TEMPLATE_ERROR", "The selected Template Bundle is not trusted", {
    field: "bundle",
    expected: "a verified Bundle selection with a matching manifest hash",
    actual: reason,
    safeNextStep: "Restore the verified release set or refresh the exact historical Bundle before retrying.",
  });
}

function internalError(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "Template projection output is not configured", {
    field: null,
    expected: "a trusted atomic projection writer",
    actual: "projection writer is unavailable",
    safeNextStep: "Reinstall a complete verified CLI build and retry the export.",
  });
}

function scalar(value: string): boolean {
  return value !== "" && value === value.trim() && !/[\r\n\u0000]/u.test(value);
}

function verifySelection(selection: TrustedBundleSelection): TrustedBundleSelection {
  try {
    validateTemplateBundle(selection.bundle);
  } catch (error) {
    if (isToolError(error, "TEMPLATE_ERROR")) throw error;
    throw templateError("Bundle validation failed");
  }
  if (
    !LOWER_SHA256.test(selection.bundleManifestHash) ||
    !scalar(selection.releaseSetId) ||
    !scalar(selection.releaseTag)
  ) {
    throw templateError("Bundle release metadata is invalid");
  }
  const actualHash = sha256Utf8(`${canonicalizeJson(selection.bundle.manifest)}\n`);
  if (actualHash !== selection.bundleManifestHash) {
    throw templateError("Bundle manifest hash does not match the trusted selection");
  }
  return selection;
}

function executionContext(selection: TrustedBundleSelection): NonNullable<CliCommandExecution["context"]> {
  const bundle = selection.bundle;
  return {
    versions: {
      templateVersion: bundle.manifest.version,
      bundleHash: selection.bundleManifestHash,
      releaseSetId: selection.releaseSetId,
      inputSchema: bundle.manifest.inputSchema,
      policySchema: bundle.manifest.policySchema,
    },
  };
}

function bundleData(
  command: string,
  selection: TrustedBundleSelection,
  extra: JsonObject = {},
): CliCommandExecution {
  return {
    context: executionContext(selection),
    output: {
      data: {
        command,
        releaseTag: selection.releaseTag,
        bundleId: selection.bundle.manifest.bundleId,
        ...extra,
      },
    },
  };
}

function profiles(selection: TrustedBundleSelection): JsonObject {
  return Object.fromEntries(PROJECT_TEMPLATE_PROFILES.map((id) => [
    id,
    copyJsonValue(selection.bundle.profiles[id]),
  ])) as JsonObject;
}

export function createLocalCommandHandlers(
  dependencies: LocalCommandDependencies,
): CliCommandHandlers {
  return {
    version: () => {
      const selected = verifySelection(dependencies.current);
      return bundleData("version", selected, { version: dependencies.cliVersion });
    },
    "profiles.list": () => {
      const selected = verifySelection(dependencies.current);
      return bundleData("profiles.list", selected, {
        profileIds: [...PROJECT_TEMPLATE_PROFILES],
        profiles: profiles(selected),
      });
    },
    "schema.show": async (invocation) => {
      const fromMrIid = invocation.command.fromMrIid;
      let selected: TrustedBundleSelection;
      if (fromMrIid === null) {
        selected = verifySelection(dependencies.current);
      } else {
        if (dependencies.loadHistoricalBundle === undefined) {
          throw templateError("Historical Bundle resolver is unavailable");
        }
        selected = verifySelection(await dependencies.loadHistoricalBundle(fromMrIid));
      }
      return bundleData("schema.show", selected, {
        fromMrIid,
        schema: copyJsonValue(selected.bundle.schema),
      });
    },
    "template.show": () => {
      const selected = verifySelection(dependencies.current);
      return bundleData("template.show", selected, {
        layout: selected.bundle.layout.markdown,
        profileIds: [...PROJECT_TEMPLATE_PROFILES],
      });
    },
    "template.export": async (invocation) => {
      const selected = verifySelection(dependencies.current);
      if (dependencies.writeProjection === undefined) throw internalError();
      const profile = invocation.command.profile as ProjectTemplateProfile;
      const contents = renderProjectTemplate(profile, selected.bundle);
      await dependencies.writeProjection(invocation.command.destination, contents);
      return bundleData("template.export", selected, {
        profile,
        bytes: Buffer.byteLength(contents, "utf8"),
        sha256: sha256Utf8(contents),
      });
    },
  };
}
