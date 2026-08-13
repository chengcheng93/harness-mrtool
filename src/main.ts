import { isSea } from "node:sea";

import packageMetadata from "../package.json" with { type: "json" };

import {
  createFailureOutput,
  createSuccessOutput,
  serializeOutput,
} from "./contracts/output.ts";
import { type FailureCode, isToolError, ToolError } from "./contracts/errors.ts";
import { exitCodeFor } from "./contracts/exit-codes.ts";
import { canonicalizeJson, sha256Utf8 } from "./contracts/jcs.ts";
import { copyJsonValue } from "./contracts/jcs.ts";
import { loadTemplateBundle, type LoadedTemplateBundle } from "./bundle/load.ts";
import { validateTemplateBundle } from "./bundle/validate.ts";
import { normalizeAndValidateRequest } from "./input/normalize.ts";
import { renderDescription } from "./render/markdown.ts";
import { verifyDiagnosticMarker } from "./render/marker.ts";
import { renderProjectTemplate } from "./render/project-template.ts";
import { renderTitle } from "./render/title.ts";
import { normalizeRuntimeArguments } from "./runtime-arguments.ts";

declare const __HARNESS_MRTOOL_VERSION__: string;
declare const __HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__: unknown;

const cliVersion = typeof __HARNESS_MRTOOL_VERSION__ === "string"
  ? __HARNESS_MRTOOL_VERSION__
  : packageMetadata.version;

function loadBootstrapTemplateBundle(): LoadedTemplateBundle {
  const bundle = copyJsonValue(__HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__);
  validateTemplateBundle(bundle);
  return bundle as unknown as LoadedTemplateBundle;
}

interface JsonResult {
  readonly ok: boolean;
  readonly code: string;
  readonly sea?: boolean;
  readonly version?: string;
  readonly message?: string;
  readonly validOutputAccepted?: boolean;
  readonly invalidOutputRejected?: boolean;
  readonly requestValidAccepted?: boolean;
  readonly requestInvalidRejected?: boolean;
  readonly titleAccepted?: boolean;
  readonly descriptionAccepted?: boolean;
  readonly markerVerified?: boolean;
  readonly projectTemplateAccepted?: boolean;
  readonly tamperRejected?: boolean;
}

function writeJson(result: JsonResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function fail(message: string, output: string | undefined): void {
  if (output === "json") {
    writeJson({ ok: false, code: "USAGE_ERROR", message });
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 2;
}

function writeFailure(error: ToolError<FailureCode>): void {
  process.stdout.write(serializeOutput(createFailureOutput(
    { cliVersion },
    error,
  )));
  process.exitCode = exitCodeFor({
    code: error.code,
    remoteWriteState: "not-attempted",
  });
}

function runContractProbe(): void {
  let validOutputAccepted = false;
  let invalidOutputRejected = false;
  let requestValidAccepted = false;
  let requestInvalidRejected = false;

  try {
    const serialized = serializeOutput(
      createSuccessOutput(
        { cliVersion },
        { data: { contractProbe: true } },
      ),
    );
    const parsed = JSON.parse(serialized) as {
      readonly schemaVersion?: unknown;
      readonly ok?: unknown;
      readonly code?: unknown;
    };
    validOutputAccepted =
      serialized.endsWith("\n") &&
      parsed.schemaVersion === 1 &&
      parsed.ok === true &&
      parsed.code === "OK";

    try {
      createSuccessOutput({
        cliVersion,
        update: { checked: "yes" },
      } as never);
    } catch (error) {
      invalidOutputRejected = error instanceof TypeError;
    }

    const requestProbe = {
      schemaVersion: 1,
      contextId: "context:contract-probe",
      intent: "draft",
      profileIds: ["general"],
      targetBranch: "develop",
      title: { type: "chore", module: "mrtool", titleSummary: "Probe request contract" },
      changes: { summary: ["Probe the embedded request schema"] },
      motivation: { background: ["The SEA must include request validation"] },
      workItem: { relation: "none", noIssueReason: "This is an internal binary probe" },
      impact: { areaIds: ["devops"], nature: "non-functional" },
      verification: {
        items: [{
          id: "self-test",
          state: "checked",
          evidenceKind: "command-output",
          command: "self-test --contract-probe",
          result: "Embedded request schema accepted",
          evidence: "Executed inside the packaged SEA artifact",
        }],
      },
      documentation: {},
      risk: { level: "low" },
      review: {},
      mergeRequest: { removeSourceBranch: false, squash: false },
    };
    requestValidAccepted =
      normalizeAndValidateRequest(requestProbe).contextId === "context:contract-probe";
    try {
      normalizeAndValidateRequest({ ...requestProbe, unsupportedField: true });
    } catch {
      requestInvalidRejected = true;
    }
  } catch {
    validOutputAccepted = false;
  }

  if (!validOutputAccepted || !invalidOutputRejected ||
      !requestValidAccepted || !requestInvalidRejected) {
    writeJson({
      ok: false,
      code: "CONTRACT_PROBE_FAILED",
      message: "Embedded output contract probe failed",
    });
    process.exitCode = 7;
    return;
  }

  writeJson({
    ok: true,
    code: "CONTRACT_PROBE_OK",
    sea: isSea(),
    version: cliVersion,
    validOutputAccepted,
    invalidOutputRejected,
    requestValidAccepted,
    requestInvalidRejected,
  });
}

function runRendererProbe(): void {
  let titleAccepted = false;
  let descriptionAccepted = false;
  let markerVerified = false;
  let projectTemplateAccepted = false;
  let tamperRejected = false;
  try {
    const bundle = loadBootstrapTemplateBundle();
    const request = normalizeAndValidateRequest({
      schemaVersion: 1,
      contextId: "context:renderer-probe",
      intent: "draft",
      profileIds: ["general"],
      targetBranch: "develop",
      title: { type: "chore", module: "mrtool", titleSummary: "Probe deterministic renderer" },
      changes: { summary: ["Probe the embedded deterministic renderer."] },
      motivation: { background: ["The SEA must embed the complete renderer path."] },
      workItem: { relation: "none", noIssueReason: "This is an internal binary renderer probe." },
      impact: { areaIds: ["devops"], nature: "non-functional" },
      verification: {
        items: [{
          id: "unit-tests",
          state: "checked",
          evidenceKind: "command-output",
          command: "self-test --renderer-probe",
          result: "Renderer probe completed",
          evidence: "Executed inside the packaged SEA artifact.",
        }],
      },
      documentation: { itemIds: ["no-documentation-changes"] },
      risk: { level: "low" },
      review: {},
      mergeRequest: { removeSourceBranch: false, squash: false },
    });
    const title = renderTitle(request, bundle);
    const writePlan = {
      writePlanVersion: 1 as const,
      title,
      labelIds: ["label:priority", "label:status", "label:type", "label:week"],
      assigneeUserId: "user:author",
      reviewerUserIds: [],
      removeSourceBranch: false,
      squash: false,
    };
    const snapshot = {
      snapshotVersion: 1 as const,
      targetProject: { id: "project:target", path: "team/target" },
      sourceProject: { id: "project:source", path: "team/source" },
      targetRefSha: "a".repeat(40),
      mergeBaseSha: "a".repeat(40),
      sourceHeadSha: "b".repeat(40),
      issue: { kind: "none" as const },
      labelCandidates: [
        { id: "label:priority", name: "priority::p1" },
        { id: "label:status", name: "status::doing" },
        { id: "label:type", name: "type::chore" },
        { id: "label:week", name: "week::probe" },
      ],
      userCandidates: [{ id: "user:author", username: "author", displayName: "Author User" }],
      mergeRequest: {
        iid: 1,
        authorUserId: "user:author",
        lifecycle: "draft" as const,
        labelIds: ["label:priority", "label:status", "label:type", "label:week"],
        assigneeUserId: "user:author",
        reviewerUserIds: [],
      },
      localChecks: {
        commitConvention: { status: "passed" as const, evidence: "Commit check completed." },
        secretScan: { status: "passed" as const, evidence: "Secret scan completed." },
        repositoryHygiene: { status: "passed" as const, evidence: "Repository check completed." },
      },
      metadataRead: { status: "available" as const, evidence: "MR metadata was read." },
      ci: { status: "pending" as const },
      review: { approvedByUserIds: [], qualifiedReviewerUserIds: [], unresolvedDiscussions: 0 },
    };
    const description = renderDescription({
      request,
      snapshot,
      writePlan,
      bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion,
      renderPhase: "final",
    });
    const marker = verifyDiagnosticMarker(description);
    const projectTemplate = renderProjectTemplate("general", bundle);
    titleAccepted = title === "Draft: [chore][mrtool] Probe deterministic renderer";
    descriptionAccepted = description.match(/^## /gmu)?.length === 8;
    markerVerified = marker.renderPhase === "final";
    projectTemplateAccepted = projectTemplate.match(/^## /gmu)?.length === 8 &&
      !projectTemplate.includes("harness-mrtool:v1");
    try {
      verifyDiagnosticMarker(description.replace("### Summary", "### Tampered"));
    } catch {
      tamperRejected = true;
    }
  } catch {
    titleAccepted = false;
  }
  if (!titleAccepted || !descriptionAccepted || !markerVerified ||
      !projectTemplateAccepted || !tamperRejected) {
    writeJson({ ok: false, code: "RENDERER_PROBE_FAILED", message: "Embedded renderer probe failed" });
    process.exitCode = 7;
    return;
  }
  writeJson({
    ok: true,
    code: "RENDERER_PROBE_OK",
    sea: isSea(),
    version: cliVersion,
    titleAccepted,
    descriptionAccepted,
    markerVerified,
    projectTemplateAccepted,
    tamperRejected,
  });
}

async function runBundleValidation(bundleDirectory: string): Promise<void> {
  try {
    const bundle = await loadTemplateBundle(bundleDirectory);
    const bundleHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
    process.stdout.write(serializeOutput(createSuccessOutput(
      {
        cliVersion,
        versions: {
          templateVersion: bundle.manifest.version,
          bundleHash,
          inputSchema: bundle.manifest.inputSchema,
          policySchema: bundle.manifest.policySchema,
        },
      },
      {
        message: "Template bundle validation passed",
        data: {
          bundleId: bundle.manifest.bundleId,
          payloadCount: bundle.manifest.files.length,
        },
      },
    )));
  } catch (error) {
    const failure = isToolError(error, "TEMPLATE_ERROR")
      ? error
      : new ToolError("INTERNAL_ERROR", "Template bundle validation failed safely", {
          field: null,
          expected: "a verifiable template bundle",
          actual: "an unexpected internal validation failure",
          safeNextStep: "Retry with a complete verified Bundle or report the internal failure.",
        });
    writeFailure(failure);
  }
}

async function main(arguments_: readonly string[]): Promise<void> {
  const outputIndex = arguments_.indexOf("--output");
  const output = outputIndex >= 0 ? arguments_[outputIndex + 1] : undefined;
  const command = arguments_.find((argument) => !argument.startsWith("-"));

  if (command === "internal") {
    if (
      arguments_.length === 3 &&
      arguments_[0] === "internal" &&
      arguments_[1] === "validate-bundle" &&
      typeof arguments_[2] === "string" &&
      arguments_[2] !== ""
    ) {
      await runBundleValidation(arguments_[2]);
      return;
    }
    writeFailure(new ToolError(
      "INPUT_ERROR",
      "Invalid internal validate-bundle arguments",
      {
        field: "arguments",
        expected: ["internal", "validate-bundle", "<directory>"],
        actual: "invalid command shape",
        safeNextStep: "Use: harness-mrtool internal validate-bundle <directory>",
      },
    ));
    return;
  }

  if (command !== "self-test") {
    fail("Usage: harness-mrtool self-test --output json", output);
    return;
  }
  if (output !== "json") {
    fail("self-test requires --output json", output);
    return;
  }
  if (arguments_.includes("--contract-probe")) {
    runContractProbe();
    return;
  }
  if (arguments_.includes("--renderer-probe")) {
    runRendererProbe();
    return;
  }

  writeJson({
    ok: true,
    code: "OK",
    sea: isSea(),
    version: cliVersion,
  });
}

void main(normalizeRuntimeArguments(process.argv));
