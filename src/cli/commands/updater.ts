import type { CliCommandExecution } from "../execute.ts";
import type { CliInvocation } from "../program.ts";
import type { ProductionCommandHandler } from "./production.ts";
import type { UpdatePreflightResult, UpdateService } from "../../update/service.ts";

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
