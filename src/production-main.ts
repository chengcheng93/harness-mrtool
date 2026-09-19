import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageMetadata from "../package.json" with { type: "json" };

import {
  loadTemplateBundle,
  type LoadedTemplateBundle,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PAYLOAD_BYTES,
  MAX_BUNDLE_TOTAL_PAYLOAD_BYTES,
} from "./bundle/load.ts";
import { validateTemplateBundle } from "./bundle/validate.ts";
import { TEMPLATE_BUNDLE_PAYLOAD_PATHS } from "./bundle/types.ts";
import {
  createLocalCommandHandlers,
  type TrustedBundleSelection,
} from "./cli/commands/local.ts";
import {
  createDefaultUpdaterCommandServices,
  mergeCliCommandHandlers,
  type ProductionCommandServices,
} from "./cli/commands/production.ts";
import { createManualCommandServices } from "./cli/commands/manual.ts";
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
import { createUpdaterCommandServices, createInstallationCommandServices } from "./cli/commands/updater.ts";
import { createProductionChannelCheckHandler, type ProductionChannelCommandDefaults } from "./cli/commands/production-channel.ts";
import { createSkillCommandServices, type SkillCommandService } from "./cli/commands/skill.ts";
import { createProductionSkillCommandService } from "./skill/production-service.ts";
import type { UpdateService } from "./update/service.ts";
import type { ProductionInstallationService } from "./update/managed-installation-types.ts";
import { defaultStateDirectory } from "./platform/state-path.ts";
import { createProductionInstallationService } from "./update/production-installation-service.ts";
import {
  authenticateReleaseSnapshot,
  createReleaseSetSnapshotVerifier,
} from "./update/release-set-verifier.ts";
import { currentReleasePlatform } from "./update/production-release-preparation.ts";
import { UpdateCache } from "./update/cache.ts";
import { loadTemplateBundleSnapshot } from "./update/historical-bundle-loader.ts";
import { unpackTemplatePublicationArchive } from "./update/production-historical-source.ts";
import { MAX_SIGNED_ENVELOPE_BYTES } from "./update/envelope.ts";

declare const __HARNESS_MRTOOL_VERSION__: string;
declare const __HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__: unknown;

const cliVersion = typeof __HARNESS_MRTOOL_VERSION__ === "string"
  ? __HARNESS_MRTOOL_VERSION__
  : packageMetadata.version;

const INSTALL_MARKER_NAME = ".harness-mrtool-install.json";

async function hasManagedInstallationMarker(): Promise<boolean> {
  try {
    const info = await lstat(resolve(dirname(resolve(process.execPath)), INSTALL_MARKER_NAME));
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ToolError("UPDATE_SECURITY_ERROR", "Managed installation marker is unsafe", {
        field: "update.installation.marker",
        expected: "a regular marker file beside the installed executable",
        actual: "marker is not a regular file",
        safeNextStep: "Run self-update repair or reinstall a complete verified release.",
      });
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

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
  readonly installationService?: ProductionInstallationService;
  readonly updateChannelDefaults?: ProductionChannelCommandDefaults;
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

async function activeBundleSelection(
  channelDefaults: ProductionChannelCommandDefaults = {},
): Promise<TrustedBundleSelection | null> {
  // Source/test invocations must not probe or create the user's default state
  // path. An explicit state path is the in-process test seam. For a packaged
  // binary, the default cache is authoritative only after the executable has
  // been enrolled by the immutable installer; an arbitrary Node application
  // bundle must still be able to run its embedded local commands. Startup
  // recovery has already rejected a malformed active installation before this
  // selection point.
  const explicitStateDirectory = channelDefaults.stateDirectory !== undefined;
  if (!explicitStateDirectory && typeof __HARNESS_MRTOOL_VERSION__ !== "string") return null;
  if (!explicitStateDirectory && !(await hasManagedInstallationMarker())) return null;
  const platform = channelDefaults.platform ?? currentReleasePlatform();
  const trustConfig = channelDefaults.trustConfig;
  const verifier = createReleaseSetSnapshotVerifier({
    platform,
    ...(trustConfig === undefined ? {} : { trustConfig }),
  });
  const cache = new UpdateCache({
    stateDirectory: channelDefaults.stateDirectory ?? defaultStateDirectory(),
    verifySnapshot: verifier,
    ...(channelDefaults.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: channelDefaults.windowsAclVerifier }),
  });
  const active = await cache.loadLastKnownGoodOrNull();
  if (active === null) return null;
  const files = unpackTemplatePublicationArchive(active.templateBytes, {
    filePaths: ["bundle-manifest.json", ...TEMPLATE_BUNDLE_PAYLOAD_PATHS],
    limits: {
      receiptEnvelopeBytes: MAX_SIGNED_ENVELOPE_BYTES,
      manifestBytes: MAX_BUNDLE_MANIFEST_BYTES,
      payloadBytes: MAX_BUNDLE_PAYLOAD_BYTES,
      totalPayloadBytes: MAX_BUNDLE_TOTAL_PAYLOAD_BYTES,
    },
  });
  const bundle = await loadTemplateBundleSnapshot(files);
  const bundleManifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  return Object.freeze({
    bundle,
    bundleManifestHash,
    releaseSetId: active.record.releaseSetId,
    releaseTag: `templates-v${active.record.templateVersion}`,
  });
}

async function defaultBundleSelection(
  channelDefaults: ProductionChannelCommandDefaults = {},
): Promise<TrustedBundleSelection> {
  return await activeBundleSelection(channelDefaults) ?? await embeddedBundleSelection();
}

function lazyDefaultUpdaterCommandServices(
  channelDefaults: ProductionChannelCommandDefaults = {},
): Pick<ProductionCommandServices, "selfUpdateCheck" | "selfUpdateStatus"> {
  let resolved: Pick<ProductionCommandServices, "selfUpdateStatus"> | undefined;
  return Object.freeze({
    selfUpdateCheck: createProductionChannelCheckHandler(cliVersion, channelDefaults),
    selfUpdateStatus: async (invocation) => {
      resolved ??= createDefaultUpdaterCommandServices({
        executedCliVersion: cliVersion,
        ...(channelDefaults.stateDirectory === undefined ? {} : { stateDirectory: channelDefaults.stateDirectory }),
        ...(channelDefaults.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: channelDefaults.windowsAclVerifier }),
        verifySnapshot: {
          async verify(snapshot) {
            await authenticateReleaseSnapshot(snapshot, {
              platform: channelDefaults.platform ?? currentReleasePlatform(),
              ...(channelDefaults.trustConfig === undefined ? {} : { trustConfig: channelDefaults.trustConfig }),
            });
          },
        },
      });
      const handler = resolved.selfUpdateStatus;
      if (handler === undefined) throw new TypeError("Default updater status handler is unavailable");
      return handler(invocation);
    },
  });
}

function lazyDefaultSkillCommandServices(
  channelDefaults: ProductionChannelCommandDefaults = {},
): Pick<ProductionCommandServices, "skillInstall" | "skillActivate" | "skillStatus"> {
  let resolved: SkillCommandService | undefined;
  function service(): SkillCommandService {
    if (resolved === undefined) {
      resolved = createProductionSkillCommandService({
        ...channelDefaults,
        cliVersion,
        stateDirectory: channelDefaults.stateDirectory ?? defaultStateDirectory(),
      });
    }
    return resolved;
  }
  return createSkillCommandServices({
    install: (path, pin) => service().install(path, pin),
    activate: (version, path, pin) => service().activate(version, path, pin),
    status: (pin) => service().status(pin),
  });
}

function createDefaultInstallationService(
  channelDefaults: ProductionChannelCommandDefaults = {},
): ProductionInstallationService {
  return createProductionInstallationService({
    ...channelDefaults,
    stateDirectory: channelDefaults.stateDirectory ?? defaultStateDirectory(),
    // In a packaged SEA, process.execPath is the installed native binary.
    // Development invocations therefore fail closed at the canonical
    // installation verification gate instead of mutating the Node runtime.
    // The explicit path is an in-process composition/test seam only; it is
    // never sourced from CLI arguments or environment variables.
    installationDirectory: channelDefaults.installationDirectory ?? dirname(resolve(process.execPath)),
  });
}

function lazyDefaultInstallationCommandServices(
  channelDefaults: ProductionChannelCommandDefaults = {},
): Pick<ProductionCommandServices, "selfUpdateRepair" | "selfUpdateApply" | "selfUpdateRollback"> {
  let resolved: ReturnType<typeof createInstallationCommandServices> | undefined;
  function service(): ReturnType<typeof createInstallationCommandServices> {
    resolved ??= createInstallationCommandServices(createDefaultInstallationService(channelDefaults));
    return resolved;
  }
  return Object.freeze({
    selfUpdateRepair: (invocation) => service().selfUpdateRepair(invocation),
    selfUpdateApply: (invocation) => service().selfUpdateApply(invocation),
    selfUpdateRollback: (invocation) => service().selfUpdateRollback(invocation),
  });
}

function injectedUpdaterCommandServices(
  service: UpdateService,
): Pick<ProductionCommandServices, "selfUpdateCheck" | "selfUpdateStatus"> {
  return createUpdaterCommandServices(service);
}

function commandUsesActiveBundle(
  commandKind: ReturnType<typeof parseCliInvocation>["command"]["kind"],
): boolean {
  return !commandKind.startsWith("self-update.") && !commandKind.startsWith("skill.");
}

async function publicCommandHandlers(
  dependencies: ProductionMainDependencies,
  contextIssueIid: number | null,
  commandKind: ReturnType<typeof parseCliInvocation>["command"]["kind"],
): Promise<CliCommandHandlers> {
  const cwd = dependencies.cwd ?? process.cwd();
  const currentBundle = dependencies.loadCurrentBundle === undefined
    ? commandUsesActiveBundle(commandKind)
      ? await defaultBundleSelection(dependencies.updateChannelDefaults)
      : await embeddedBundleSelection()
    : await dependencies.loadCurrentBundle();
  const local = createLocalCommandHandlers({
    cliVersion,
    current: currentBundle,
    writeProjection: writeProjectTemplate,
  });
  const readOnly = dependencies.readOnly === undefined
    ? createProductionReadOnlyDefaults({
        cliVersion,
        cwd,
        currentBundle,
        contextIssueIid,
        ...dependencies.readOnlyDefaults,
      })
    : { ...dependencies.readOnly, contextIssueIid };
  const production = createProductionRuntime({
    cliVersion,
    cwd,
    currentBundle,
    profileRepository: dependencies.profileRepository ?? {
      discover: discoverProfileDetectionRepository,
      readChangeSet: readCanonicalChangeSet,
    },
    readOnly,
    targetProjectResolver: dependencies.targetProjectResolver ?? createGitLabTargetProjectResolver(),
    writeDefaults: { cliVersion, cwd, currentBundle, contextIssueIid, ...dependencies.readOnlyDefaults },
    services: {
      ...(dependencies.updateService === undefined
        ? lazyDefaultUpdaterCommandServices(dependencies.updateChannelDefaults)
        : injectedUpdaterCommandServices(dependencies.updateService)),
      ...(dependencies.installationService === undefined
        ? lazyDefaultInstallationCommandServices(dependencies.updateChannelDefaults)
        : createInstallationCommandServices(dependencies.installationService)),
      ...(dependencies.skillService === undefined
        ? lazyDefaultSkillCommandServices(dependencies.updateChannelDefaults)
        : createSkillCommandServices(dependencies.skillService)),
      ...createManualCommandServices({
        cliVersion,
        cwd,
        currentBundle,
        requestSource: readOnly.requestSource,
      }),
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

async function recoverInstallationBeforePublicInvocation(
  dependencies: ProductionMainDependencies,
  commandKind: Awaited<ReturnType<typeof parseCliInvocation>>["command"]["kind"],
): Promise<void> {
  // The explicit repair command owns its single recovery call. All other
  // public commands must recover a durable handoff before ordinary work.
  if (commandKind === "self-update.repair") return;
  const service = dependencies.installationService ?? (
    typeof __HARNESS_MRTOOL_VERSION__ === "string"
      ? createDefaultInstallationService(dependencies.updateChannelDefaults)
      : undefined
  );
  if (dependencies.installationService === undefined && service !== undefined && !(await hasManagedInstallationMarker())) {
    // A packaged application can be executed for its immutable self-test or
    // local read-only commands before the installer has enrolled its canonical
    // executable. Do not probe the user's default state path in that phase.
    return;
  }
  await service?.recover();
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

  try {
    const parsed = parseCliInvocation(sanitizedArguments);
    await recoverInstallationBeforePublicInvocation(dependencies, parsed.command.kind);
  } catch (error) {
    if (requestsJsonOutput(sanitizedArguments)) {
      return (await new CliJsonOutput(
        { cliVersion },
        jsonOutputSink(stdout),
      ).failure(error)).exitCode;
    }
    return textFailure(error, stderr);
  }

  let handlers: CliCommandHandlers;
  try {
    handlers = await publicCommandHandlers(dependencies, invocation.contextIssueIid, parseCliInvocation(sanitizedArguments).command.kind);
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
