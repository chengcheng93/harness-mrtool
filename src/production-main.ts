import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageMetadata from "../package.json" with { type: "json" };

import { loadTemplateBundle, type LoadedTemplateBundle } from "./bundle/load.ts";
import { validateTemplateBundle } from "./bundle/validate.ts";
import {
  createLocalCommandHandlers,
  type TrustedBundleSelection,
} from "./cli/commands/local.ts";
import {
  createDefaultUpdaterCommandServices,
  mergeCliCommandHandlers,
  type ProductionCommandServices,
} from "./cli/commands/production.ts";
import type { ProfileDetectionRepositoryRuntime } from "./cli/commands/repository.ts";
import {
  executeCliJson,
  type CliCommandExecution,
  type CliCommandHandlers,
} from "./cli/execute.ts";
import { CliJsonOutput } from "./cli/output.ts";
import { preprocessProductionInvocation } from "./cli/production-invocation.ts";
import { parseCliInvocation } from "./cli/program.ts";
import {
  createProductionReadOnlyDefaults,
  createProductionRuntime,
  type ProductionReadOnlyDefaultOverrides,
  type ProductionRuntimeDependencies,
} from "./cli/production-runtime.ts";
import { writeProjectTemplate } from "./cli/projection-writer.ts";
import {
  createGitLabTargetProjectResolver,
  type TargetProjectResolver,
} from "./cli/target-project.ts";
import { isToolError, ToolError } from "./contracts/errors.ts";
import { exitCodeFor } from "./contracts/exit-codes.ts";
import { canonicalizeJson, copyJsonValue, sha256Utf8 } from "./contracts/jcs.ts";
import { readCanonicalChangeSet } from "./git/change-set.ts";
import { discoverProfileDetectionRepository } from "./git/target-branch.ts";
import { normalizeRuntimeArguments } from "./runtime-arguments.ts";
import {
  createProductionUpdatePreflight,
  runPublicInvocationPreflight,
  type PublicInvocationPreflight,
} from "./update/preflight.ts";
import { createUpdaterCommandServices } from "./cli/commands/updater.ts";
import { createSkillCommandServices, type SkillCommandService } from "./cli/commands/skill.ts";
import type { UpdateService } from "./update/service.ts";

declare const __HARNESS_MRTOOL_VERSION__: string;
declare const __HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__: unknown;

const cliVersion = typeof __HARNESS_MRTOOL_VERSION__ === "string"
  ? __HARNESS_MRTOOL_VERSION__
  : packageMetadata.version;

interface TextOutput {
  readonly write: (chunk: string) => boolean;
}

export interface ProductionMainDependencies {
  readonly cwd?: string;
  readonly loadCurrentBundle?: () => Promise<TrustedBundleSelection>;
  readonly profileRepository?: ProfileDetectionRepositoryRuntime;
  readonly readOnly?: ProductionRuntimeDependencies["readOnly"];
  readonly readOnlyDefaults?: ProductionReadOnlyDefaultOverrides;
  readonly stderr?: TextOutput;
  readonly stdout?: TextOutput;
  readonly targetProjectResolver?: TargetProjectResolver;
  readonly updatePreflight?: PublicInvocationPreflight;
  readonly updateService?: UpdateService;
  readonly skillService?: SkillCommandService;
}

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

function lazyDefaultUpdaterCommandServices(): Pick<ProductionCommandServices, "selfUpdateStatus"> {
  let resolved: Pick<ProductionCommandServices, "selfUpdateStatus"> | undefined;
  return Object.freeze({
    selfUpdateStatus: async (invocation) => {
      resolved ??= createDefaultUpdaterCommandServices();
      const handler = resolved.selfUpdateStatus;
      if (handler === undefined) throw new TypeError("Default updater status handler is unavailable");
      return handler(invocation);
    },
  });
}

function injectedUpdaterCommandServices(
  service: UpdateService,
): Pick<ProductionCommandServices, "selfUpdateCheck" | "selfUpdateStatus"> {
  return createUpdaterCommandServices(service);
}

async function publicCommandHandlers(
  dependencies: ProductionMainDependencies,
  contextIssueIid: number | null,
): Promise<CliCommandHandlers> {
  const cwd = dependencies.cwd ?? process.cwd();
  const currentBundle = dependencies.loadCurrentBundle === undefined
    ? await embeddedBundleSelection()
    : await dependencies.loadCurrentBundle();
  const local = createLocalCommandHandlers({
    cliVersion,
    current: currentBundle,
    writeProjection: writeProjectTemplate,
  });
  const production = createProductionRuntime({
    cliVersion,
    cwd,
    currentBundle,
    profileRepository: dependencies.profileRepository ?? {
      discover: discoverProfileDetectionRepository,
      readChangeSet: readCanonicalChangeSet,
    },
    readOnly: dependencies.readOnly === undefined
      ? createProductionReadOnlyDefaults({
          cliVersion,
          cwd,
          currentBundle,
          contextIssueIid,
          ...dependencies.readOnlyDefaults,
        })
      : { ...dependencies.readOnly, contextIssueIid },
    targetProjectResolver: dependencies.targetProjectResolver ?? createGitLabTargetProjectResolver(),
    services: {
      ...(dependencies.updateService === undefined
        ? lazyDefaultUpdaterCommandServices()
        : injectedUpdaterCommandServices(dependencies.updateService)),
      ...(dependencies.skillService === undefined
        ? {}
        : createSkillCommandServices(dependencies.skillService)),
    },
  });
  return mergeCliCommandHandlers(local, production);
}

function requestsJsonOutput(arguments_: readonly string[]): boolean {
  return arguments_.some((argument, index) =>
    argument === "--output=json" ||
    (argument === "--output" && arguments_[index + 1] === "json"));
}

function processOutput(stream: NodeJS.WriteStream): TextOutput {
  return { write: (chunk) => stream.write(chunk) };
}

function jsonOutputSink(output: TextOutput) {
  return {
    write(chunk: string, callback: (error?: Error | null) => void): boolean {
      try {
        const accepted = output.write(chunk);
        callback();
        return accepted;
      } catch (error) {
        callback(error instanceof Error ? error : new Error("CLI output failed"));
        return false;
      }
    },
  };
}

function bootstrapError() {
  return new ToolError("INTERNAL_ERROR", "Production CLI bootstrap failed", {
    field: "runtime",
    expected: "a validated embedded Bundle and complete production composition",
    actual: "production composition unavailable",
    safeNextStep: "Reinstall a complete verified release, then retry.",
  });
}

function textProfileOutput(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Profile detection output is invalid");
  }
  const data = value as Readonly<Record<string, unknown>>;
  const targetRefSha = data.targetRefSha;
  const mergeBaseSha = data.mergeBaseSha;
  const sourceHeadSha = data.sourceHeadSha;
  if (
    typeof targetRefSha !== "string" ||
    typeof mergeBaseSha !== "string" ||
    typeof sourceHeadSha !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(targetRefSha) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(mergeBaseSha) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceHeadSha)
  ) {
    throw new TypeError("Profile detection object IDs are invalid");
  }

  let summary: string;
  if (data.kind === "detected" && Array.isArray(data.profileIds) &&
      data.profileIds.length > 0 && data.profileIds.every((value_) => typeof value_ === "string")) {
    summary = `Profiles: ${data.profileIds.join(", ")}\nReason: matched-versioned-profile-rules`;
  } else if (data.kind === "ambiguous" && typeof data.reason === "string") {
    summary = `Profiles: ambiguous\nReason: ${data.reason}`;
  } else {
    throw new TypeError("Profile detection selection is invalid");
  }
  return `${summary}\nTarget ref: ${targetRefSha}\nMerge base: ${mergeBaseSha}\nSource HEAD: ${sourceHeadSha}\n`;
}

function textPreviewOutput(value: unknown): string {
  const copied = copyJsonValue(value);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied) ||
      copied.command !== "preview" || typeof copied.title !== "string" ||
      typeof copied.description !== "string" || !Array.isArray(copied.profileIds) ||
      copied.profileIds.some((profileId) => typeof profileId !== "string")) {
    throw new TypeError("Preview output is invalid");
  }
  const profiles = copied.profileIds as readonly string[];
  const description = copied.description.endsWith("\n")
    ? copied.description
    : `${copied.description}\n`;
  return `Title: ${copied.title}\nProfiles: ${profiles.join(", ")}\n\n${description}`;
}

function textCommandOutput(command: string, value: unknown): string {
  if (command === "profiles.detect") return textProfileOutput(value);
  if (command === "preview") return textPreviewOutput(value);
  if (value !== undefined) {
    const copied = copyJsonValue(value);
    if (copied === null || typeof copied !== "object" || Array.isArray(copied) ||
        copied.command !== command) {
      throw new TypeError("Command output is invalid");
    }
  }
  return `Command: ${command}\nStatus: completed\n`;
}

async function textFailure(error: unknown, stderr: TextOutput): Promise<number> {
  const chunks: string[] = [];
  const result = await new CliJsonOutput(
    { cliVersion },
    {
      write(chunk: string, callback: (writeError?: Error | null) => void): boolean {
        chunks.push(chunk);
        callback();
        return true;
      },
    },
  ).failure(error);
  try {
    const failure = JSON.parse(chunks.join("")) as { readonly code?: unknown; readonly message?: unknown };
    if (typeof failure.code !== "string" || typeof failure.message !== "string") {
      throw new TypeError("Failure output is invalid");
    }
    stderr.write(`${failure.code}: ${failure.message}\n`);
  } catch {
    stderr.write("INTERNAL_ERROR: Command execution failed.\n");
  }
  return result.exitCode;
}

async function executeCliText(
  arguments_: readonly string[],
  handlers: CliCommandHandlers,
  stdout: TextOutput,
  stderr: TextOutput,
): Promise<number> {
  try {
    const invocation = parseCliInvocation(arguments_);
    const handler = handlers[invocation.command.kind] as
      | ((input: typeof invocation) => Promise<CliCommandExecution> | CliCommandExecution)
      | undefined;
    if (handler === undefined) throw new TypeError("Command handler is unavailable");
    const execution = await handler(invocation);
    stdout.write(textCommandOutput(invocation.command.kind, execution.output?.data));
    return 0;
  } catch (error) {
    return textFailure(error, stderr);
  }
}

export async function runProductionMain(
  arguments_: readonly string[],
  dependencies: ProductionMainDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? processOutput(process.stdout);
  const stderr = dependencies.stderr ?? processOutput(process.stderr);
  let invocation;
  try {
    invocation = preprocessProductionInvocation(arguments_);
  } catch (error) {
    if (requestsJsonOutput(arguments_) && isToolError(error)) {
      return (await new CliJsonOutput(
        { cliVersion },
        jsonOutputSink(stdout),
      ).failure(error)).exitCode;
    }
    if (isToolError(error)) {
      return textFailure(error, stderr);
    }
    stderr.write("INTERNAL_ERROR: Production CLI bootstrap failed.\n");
    return 7;
  }
  const sanitizedArguments = invocation.arguments;
  if (
    sanitizedArguments[0] === "internal" ||
    sanitizedArguments[0] === "self-test"
  ) {
    await import("./main.ts");
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  }

  const updatePreflight = dependencies.updatePreflight ?? (
    dependencies.updateService === undefined
      ? undefined
      : Object.freeze({
          run: async (input: Parameters<PublicInvocationPreflight["run"]>[0]): Promise<void> => {
            await dependencies.updateService!.preflight(input);
          },
        })
  ) ?? (
    typeof __HARNESS_MRTOOL_VERSION__ === "string" || isDirectSourceInvocation()
      ? createProductionUpdatePreflight()
      : undefined
  );
  if (updatePreflight !== undefined) {
    try {
      const parsed = parseCliInvocation(sanitizedArguments);
      await runPublicInvocationPreflight(updatePreflight, parsed);
    } catch (error) {
      if (requestsJsonOutput(sanitizedArguments)) {
        return (await new CliJsonOutput(
          { cliVersion },
          jsonOutputSink(stdout),
        ).failure(error)).exitCode;
      }
      return textFailure(error, stderr);
    }
  }

  let handlers: CliCommandHandlers;
  try {
    handlers = await publicCommandHandlers(dependencies, invocation.contextIssueIid);
  } catch {
    if (requestsJsonOutput(sanitizedArguments)) {
      return (await new CliJsonOutput(
        { cliVersion },
        jsonOutputSink(stdout),
      ).failure(bootstrapError())).exitCode;
    }
    stderr.write("INTERNAL_ERROR: Production CLI bootstrap failed.\n");
    return 7;
  }
  if (!requestsJsonOutput(sanitizedArguments)) {
    return executeCliText(sanitizedArguments, handlers, stdout, stderr);
  }
  return (await executeCliJson(sanitizedArguments, {
    cliVersion,
    handlers,
    stdout: jsonOutputSink(stdout),
  })).exitCode;
}

function isDirectSourceInvocation(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  try {
    return resolve(invokedPath) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (typeof __HARNESS_MRTOOL_VERSION__ === "string" || isDirectSourceInvocation()) {
  void runProductionMain(normalizeRuntimeArguments(process.argv)).then(
    (exitCode) => { process.exitCode = exitCode; },
    () => {
      process.stderr.write("INTERNAL_ERROR: Production CLI bootstrap failed.\n");
      process.exitCode = 7;
    },
  );
}
