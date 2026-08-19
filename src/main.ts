import { isSea } from "node:sea";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
import { executeCliJson, type CliCommandHandlers } from "./cli/execute.ts";
import { consumeInvocationStdin } from "./update/invocation-envelope.ts";
import { parseStrictJson } from "./input/strict-json.ts";
import {
  createLocalCommandHandlers,
  type TrustedBundleSelection,
} from "./cli/commands/local.ts";
import {
  createProductionCommandHandlers,
  createDefaultUpdaterCommandServices,
  mergeCliCommandHandlers,
} from "./cli/commands/production.ts";
import { writeProjectTemplate } from "./cli/projection-writer.ts";

declare const __HARNESS_MRTOOL_VERSION__: string;
declare const __HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__: unknown;

const cliVersion = typeof __HARNESS_MRTOOL_VERSION__ === "string"
  ? __HARNESS_MRTOOL_VERSION__
  : packageMetadata.version;

async function loadBootstrapTemplateBundle(): Promise<LoadedTemplateBundle> {
  const embedded = typeof __HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__ === "undefined"
    ? undefined
    : __HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__;
  if (embedded === undefined) {
    return loadTemplateBundle(resolve(dirname(fileURLToPath(import.meta.url)), "..", "template-bundle"));
  }
  const bundle = copyJsonValue(embedded);
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

async function embeddedBundleSelection(): Promise<TrustedBundleSelection> {
  const bundle = await loadBootstrapTemplateBundle();
  const bundleManifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  return {
    bundle,
    bundleManifestHash,
    releaseSetId: `embedded:${bundleManifestHash}`,
    releaseTag: `templates-v${bundle.manifest.version}`,
  };
}

async function publicCommandHandlers(): Promise<CliCommandHandlers> {
  const current = await embeddedBundleSelection();
  const local = createLocalCommandHandlers({
    cliVersion,
    current,
    writeProjection: writeProjectTemplate,
  });
  const production = createProductionCommandHandlers({
    cliVersion,
    ...createDefaultUpdaterCommandServices(),
  });
  return mergeCliCommandHandlers(local, production);
}

function requestsJsonOutput(arguments_: readonly string[]): boolean {
  return arguments_.some((argument, index) =>
    argument === "--output=json" ||
    (argument === "--output" && arguments_[index + 1] === "json"));
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

async function runRendererProbe(): Promise<void> {
  let titleAccepted = false;
  let descriptionAccepted = false;
  let markerVerified = false;
  let projectTemplateAccepted = false;
  let tamperRejected = false;
  try {
    const bundle = await loadBootstrapTemplateBundle();
    const request = normalizeAndValidateRequest({
      schemaVersion: 1,
      contextId: "context:renderer-probe",
      intent: "draft",
      profileIds: ["general"],
      targetBranch: "develop",
      title: { type: "chore", module: "mrtool", titleSummary: "Probe deterministic renderer" },
      changes: {
        summary: ["Probe the embedded deterministic renderer."],
        technicalChanges: ["Render a complete canonical general-profile request."],
        outOfScope: ["No remote merge request state is changed by this probe."],
      },
      motivation: {
        background: ["The SEA must embed the complete renderer path."],
        whyNeeded: ["A packaged executable must prove the same renderer contract as source."],
      },
      workItem: { relation: "none", noIssueReason: "This is an internal binary renderer probe." },
      impact: {
        areaIds: ["devops"],
        nature: "non-functional",
        details: ["Only the in-process self-test output is affected."],
      },
      verification: {
        items: [{
          id: "unit-tests",
          state: "checked",
          evidenceKind: "command-output",
          command: "self-test --renderer-probe",
          result: "Renderer probe completed",
          evidence: "Executed inside the packaged SEA artifact.",
        }],
        acceptanceEvidence: ["The rendered body has exactly eight canonical sections."],
        knownGaps: ["The probe does not contact GitLab or mutate a repository."],
      },
      documentation: {
        itemIds: ["no-documentation-changes"],
        details: ["No documentation changes are required for an internal self-test."],
      },
      risk: {
        level: "low",
        items: ["The probe operates on embedded immutable fixtures only."],
        compatibilityImpact: ["The probe does not alter the public request contract."],
        rollbackPlan: ["Restore the previous packaged executable if the probe fails."],
      },
      review: {
        reviewerFocus: ["Confirm the packaged renderer matches source behavior."],
        additionalNotes: ["All probe inputs are deterministic and token-free."],
      },
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

async function runInternalApplyUpdate(): Promise<void> {
  try {
    const bytes = await consumeInvocationStdin((async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of process.stdin) {
        yield chunk instanceof Uint8Array ? Uint8Array.from(chunk) : new Uint8Array(chunk);
      }
    })());
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseStrictJson(text);
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "command,payload,schemaVersion" ||
      value.schemaVersion !== 1 || value.command !== "apply-update" ||
      value.payload === null || typeof value.payload !== "object" || Array.isArray(value.payload)
    ) {
      throw new ToolError("INPUT_ERROR", "Invalid internal update envelope", {
        field: "stdin",
        expected: "{schemaVersion:1,command:'apply-update',payload:object}",
        actual: "invalid private envelope",
        safeNextStep: "Invoke internal apply-update only through the verified updater handoff.",
      });
    }
    // The private handoff is intentionally fail-closed until a verified
    // platform updater is injected. It must never claim activation happened.
    throw new ToolError("UPDATE_REQUIRED", "Verified update activation is not configured", {
      field: "activation",
      expected: "a trusted updater helper and release-set verifier",
      actual: "activation service is unavailable",
      safeNextStep: "Install a complete verified release and retry self-update.",
    });
  } catch (error) {
    const failure = error instanceof ToolError
      ? error
      : new ToolError("INPUT_ERROR", "Invalid internal update envelope", {
          field: "stdin",
          expected: "one bounded canonical JSON envelope",
          actual: "unreadable or malformed envelope",
          safeNextStep: "Invoke internal apply-update through the verified updater handoff.",
        });
    writeFailure(failure);
  }
}

async function main(arguments_: readonly string[]): Promise<void> {
  const outputIndex = arguments_.indexOf("--output");
  const output = outputIndex >= 0 ? arguments_[outputIndex + 1] : undefined;
  const command = arguments_[0];

  if (command === "internal") {
    if (arguments_.length === 2 && arguments_[1] === "apply-update") {
      await runInternalApplyUpdate();
      return;
    }
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
    if (requestsJsonOutput(arguments_)) {
      const result = await executeCliJson(arguments_, {
        cliVersion,
        stdout: {
          write(chunk, callback) {
            return process.stdout.write(chunk, callback);
          },
        },
        handlers: await publicCommandHandlers(),
      });
      process.exitCode = result.exitCode;
      return;
    }
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
    await runRendererProbe();
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
