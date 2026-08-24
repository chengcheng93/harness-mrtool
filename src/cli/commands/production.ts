import { ToolError, type ErrorCode } from "../../contracts/errors.ts";
import { defaultStateDirectory, type WindowsAclVerifier } from "../../platform/state-path.ts";
import {
  UpdateCache,
  type LoadedReleaseSet,
  type ReleaseSetSnapshotVerifier,
  type VerifiedManifestInput,
} from "../../update/cache.ts";
import type { CliCommandExecution, CliCommandHandlers } from "../execute.ts";
import type { CliInvocation } from "../program.ts";

/**
 * The production command layer is deliberately dependency-injected.  The CLI
 * process owns parsing/output, while repository, GitLab, updater, and Skill
 * implementations are supplied by the platform composition root.  This keeps
 * an incomplete installation fail-closed without making a route disappear.
 */
export type ProductionCommandHandler = (
  invocation: CliInvocation,
) => Promise<CliCommandExecution> | CliCommandExecution;

export interface ProductionCommandServices {
  readonly cliVersion: string;
  readonly doctor?: ProductionCommandHandler;
  readonly context?: ProductionCommandHandler;
  readonly create?: ProductionCommandHandler;
  readonly update?: ProductionCommandHandler;
  readonly verify?: ProductionCommandHandler;
  readonly preview?: ProductionCommandHandler;
  readonly manual?: ProductionCommandHandler;
  readonly profilesDetect?: ProductionCommandHandler;
  readonly labelsList?: ProductionCommandHandler;
  readonly templateRefresh?: ProductionCommandHandler;
  readonly selfUpdateCheck?: ProductionCommandHandler;
  readonly selfUpdateStatus?: ProductionCommandHandler;
  readonly selfUpdateApply?: ProductionCommandHandler;
  readonly selfUpdateRollback?: ProductionCommandHandler;
  readonly skillInstall?: ProductionCommandHandler;
  readonly skillActivate?: ProductionCommandHandler;
  readonly skillStatus?: ProductionCommandHandler;
}

function rejectSshApiMode(invocation: CliInvocation, kind: string): void {
  if (invocation.options.authMode !== "ssh") return;
  throw new ToolError("AUTH_ERROR", `The ${kind} command is API-only in SSH mode`, {
    field: "authMode",
    expected: "auto or api for GitLab API commands",
    actual: "ssh",
    safeNextStep: "Use manual --auth ssh for token-free SSH-first flow, or explicitly choose --auth api.",
  });
}

export interface DefaultUpdaterCommandOptions {
  readonly stateDirectory?: string;
  readonly windowsAclVerifier?: WindowsAclVerifier;
  /**
   * The signed-channel/bundle verifier supplied by the updater composition
   * root. A cache hash is only local integrity; it is not trust evidence.
   */
  readonly verifySnapshot?: ReleaseSetSnapshotVerifier;
  /** Optional already-authenticated channel policy used for write blocking. */
  readonly verifiedManifest?: VerifiedManifestInput;
}

function updateStatusExecution(
  loaded: LoadedReleaseSet | null,
): CliCommandExecution {
  const record = loaded?.record;
  return {
    context: {
      update: {
        checked: true,
        reachable: null,
        usingLastKnownGood: loaded !== null,
        latestVersionConfirmed: false,
        warning: loaded === null
          ? "No verified active release set is installed."
          : loaded.writesBlocked
            ? "The active release set is integrity-checked but write-blocked by update policy."
            : "Active release set loaded; no network check was requested.",
        securityAnomaly: loaded?.writesBlocked ?? false,
        activationRequired: false,
        hostRefreshMayBeRequired: false,
        persistencePending: false,
        executedVersion: record?.cliVersion ?? "unknown",
        installedVersion: record?.cliVersion ?? "unknown",
      },
      ...(record === undefined ? {} : {
        versions: {
          templateVersion: record.templateVersion,
          releaseSetId: record.releaseSetId,
          inputSchema: record.inputSchema,
          policySchema: record.policySchema,
          manifestSequence: record.manifestSequence,
        },
      }),
    },
    output: {
      data: {
        command: "self-update.status",
        state: loaded === null ? "empty" : loaded.writesBlocked ? "write-blocked" : "ready",
        ...(record === undefined ? {} : {
          releaseSetId: record.releaseSetId,
          transactionId: record.transactionId,
          cliVersion: record.cliVersion,
          templateVersion: record.templateVersion,
          manifestSequence: record.manifestSequence,
          writeBlockReasons: [...(loaded?.writeBlockReasons ?? [])],
        }),
      },
    },
  };
}

/**
 * Read-only updater wiring available even when the network updater is not
 * installed. Mutation/check handlers remain fail-closed until a signed
 * channel client is injected by the composition root.
 */
export function createDefaultUpdaterCommandServices(
  options: DefaultUpdaterCommandOptions = {},
): Pick<ProductionCommandServices, "selfUpdateStatus"> {
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const cache = new UpdateCache({
    stateDirectory,
    ...(options.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: options.windowsAclVerifier }),
    ...(options.verifySnapshot === undefined ? {} : { verifySnapshot: options.verifySnapshot }),
  });
  return {
    selfUpdateStatus: async () => updateStatusExecution(await cache.loadLastKnownGoodOrNull(
      options.verifiedManifest === undefined ? {} : { verifiedManifest: options.verifiedManifest },
    )),
  };
}

function unavailable(kind: string, code: ErrorCode): never {
  throw new ToolError(code, "The installed CLI cannot run this command yet", {
    field: "runtime",
    expected: "a verified repository, credential, and platform runtime",
    actual: `runtime dependency for ${kind} is unavailable`,
    safeNextStep: "Run doctor, install a complete verified release, and retry.",
  });
}

function fallback(kind: string, code: ErrorCode): ProductionCommandHandler {
  return () => unavailable(kind, code);
}

function handler(
  value: ProductionCommandHandler | undefined,
  kind: string,
  code: ErrorCode,
): ProductionCommandHandler {
  return value ?? fallback(kind, code);
}

export function createProductionCommandHandlers(
  services: ProductionCommandServices,
): CliCommandHandlers {
  if (typeof services.cliVersion !== "string" || services.cliVersion.trim() === "") {
    throw new TypeError("Production command services require a CLI version");
  }
  const handlers: Record<string, ProductionCommandHandler> = {
    doctor: async (invocation) => { rejectSshApiMode(invocation, "doctor"); return handler(services.doctor, "doctor", "AUTH_ERROR")(invocation); },
    context: async (invocation) => { rejectSshApiMode(invocation, "context"); return handler(services.context, "context", "AUTH_ERROR")(invocation); },
    create: async (invocation) => { rejectSshApiMode(invocation, "create"); return handler(services.create, "create", "AUTH_ERROR")(invocation); },
    update: async (invocation) => { rejectSshApiMode(invocation, "update"); return handler(services.update, "update", "AUTH_ERROR")(invocation); },
    verify: async (invocation) => { rejectSshApiMode(invocation, "verify"); return handler(services.verify, "verify", "AUTH_ERROR")(invocation); },
    preview: async (invocation) => { rejectSshApiMode(invocation, "preview"); return handler(services.preview, "preview", "REPOSITORY_ERROR")(invocation); },
    manual: handler(services.manual, "manual", "REPOSITORY_ERROR"),
    "profiles.detect": handler(services.profilesDetect, "profiles.detect", "REPOSITORY_ERROR"),
    "labels.list": async (invocation) => { rejectSshApiMode(invocation, "labels.list"); return handler(services.labelsList, "labels.list", "AUTH_ERROR")(invocation); },
    "template.refresh": handler(services.templateRefresh, "template.refresh", "UPDATE_REQUIRED"),
    "self-update.check": handler(services.selfUpdateCheck, "self-update.check", "UPDATE_REQUIRED"),
    "self-update.status": handler(services.selfUpdateStatus, "self-update.status", "UPDATE_REQUIRED"),
    "self-update.apply": handler(services.selfUpdateApply, "self-update.apply", "UPDATE_REQUIRED"),
    "self-update.rollback": handler(services.selfUpdateRollback, "self-update.rollback", "UPDATE_REQUIRED"),
    "skill.install": handler(services.skillInstall, "skill.install", "UPDATE_REQUIRED"),
    "skill.activate": handler(services.skillActivate, "skill.activate", "UPDATE_REQUIRED"),
    "skill.status": handler(services.skillStatus, "skill.status", "UPDATE_REQUIRED"),
  };
  return Object.freeze(handlers) as unknown as CliCommandHandlers;
}

export function mergeCliCommandHandlers(
  ...sources: readonly CliCommandHandlers[]
): CliCommandHandlers {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    for (const [kind, value] of Object.entries(source)) {
      if (value !== undefined) merged[kind] = value;
    }
  }
  return Object.freeze(merged) as CliCommandHandlers;
}
