import type { CliCommandExecution } from "../execute.ts";
import type { CliInvocation } from "../program.ts";
import type { ProductionCommandHandler } from "./production.ts";
import type { UpdatePreflightResult, UpdateService } from "../../update/service.ts";
import type { InstallationResult, ProductionInstallationService } from "../../update/managed-installation-types.ts";

function execution(command: "self-update.check" | "self-update.status", value: UpdatePreflightResult): CliCommandExecution {
  return {
    context: {
      update: {
        checked: true,
        reachable: value.mode === "checked" ? true : null,
        usingLastKnownGood: value.usingLastKnownGood,
        latestVersionConfirmed: value.latestVersionConfirmed,
        warning: value.mode === "offline"
          ? "Only the verified last-known-good release was used."
          : value.mode === "no-update"
            ? "Network update checks were disabled for this invocation."
            : null,
        securityAnomaly: false,
        activationRequired: false,
        hostRefreshMayBeRequired: false,
        persistencePending: false,
        executedVersion: "unknown",
        installedVersion: "unknown",
      },
    },
    output: {
      data: {
        command,
        mode: value.mode,
        usingLastKnownGood: value.usingLastKnownGood,
        latestVersionConfirmed: value.latestVersionConfirmed,
        manifestSequence: value.manifestSequence,
      },
    },
  };
}

function requireCommand(
  invocation: CliInvocation,
  kind: "self-update.check" | "self-update.status",
): void {
  if (invocation.command.kind !== kind) throw new TypeError("Updater command invocation is invalid");
}

function installationExecution(command: "self-update.apply" | "self-update.rollback", result: InstallationResult): CliCommandExecution {
  const pending = result.status === "persistence-pending";
  const active = pending ? null : result.active;
  const executing = pending ? result.executing : null;
  return {
    context: {
      update: {
        checked: true,
        reachable: true,
        usingLastKnownGood: active !== null,
        latestVersionConfirmed: true,
        warning: pending
          ? "The signed release executed, but canonical persistence is pending and must be repaired before it is reported installed."
          : null,
        securityAnomaly: false,
        activationRequired: false,
        hostRefreshMayBeRequired: false,
        persistencePending: pending,
        executedVersion: "unknown",
        installedVersion: active?.cliVersion ?? "unknown",
      },
    },
    output: {
      data: {
        command,
        status: result.status,
        persistencePending: pending,
        ...(active === null ? {executingVersion: executing!.cliVersion} : {
          cliVersion: active.cliVersion,
          releaseSetId: active.releaseSetId,
          manifestSequence: active.manifestSequence,
        }),
      },
    },
  };
}

export function createInstallationCommandServices(
  service: ProductionInstallationService,
): {
  readonly selfUpdateApply: ProductionCommandHandler;
  readonly selfUpdateRollback: ProductionCommandHandler;
} {
  if (service === null || typeof service !== "object" ||
      typeof service.apply !== "function" || typeof service.rollback !== "function") {
    throw new TypeError("Installation service is invalid");
  }
  return Object.freeze({
    selfUpdateApply: async (invocation: CliInvocation): Promise<CliCommandExecution> => {
      if (invocation.command.kind !== "self-update.apply") throw new TypeError("Installation command invocation is invalid");
      return installationExecution("self-update.apply", await service.apply(false));
    },
    selfUpdateRollback: async (invocation: CliInvocation): Promise<CliCommandExecution> => {
      if (invocation.command.kind !== "self-update.rollback") throw new TypeError("Installation command invocation is invalid");
      return installationExecution("self-update.rollback", await service.rollback(invocation.command.version));
    },
  });
}

export function createUpdaterCommandServices(
  service: UpdateService,
): {
  readonly selfUpdateCheck: ProductionCommandHandler;
  readonly selfUpdateStatus: ProductionCommandHandler;
} {
  if (service === null || typeof service !== "object" ||
      typeof service.check !== "function" || typeof service.status !== "function") {
    throw new TypeError("Updater service is invalid");
  }
  return Object.freeze({
    selfUpdateCheck: async (invocation: CliInvocation): Promise<CliCommandExecution> => {
      if (invocation.command.kind !== "self-update.check") {
        throw new TypeError("Updater command invocation is invalid");
      }
      return execution("self-update.check", await service.check(invocation.command.force));
    },
    selfUpdateStatus: async (invocation: CliInvocation): Promise<CliCommandExecution> => {
      requireCommand(invocation, "self-update.status");
      return execution("self-update.status", await service.status());
    },
  });
}
