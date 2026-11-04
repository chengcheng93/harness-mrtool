import type { CliCommandExecution } from "../execute.ts";
import type { CliInvocation } from "../program.ts";
import type { SkillActivationResult, SkillInvocationPin, SkillStageResult, SkillStatus } from "../../skill/manager.ts";

export interface SkillCommandService {
  readonly install: (path: string, pin?: SkillInvocationPin) => Promise<SkillStageResult>;
  readonly activate: (version: string, path: string, pin?: SkillInvocationPin) => Promise<SkillActivationResult>;
  readonly status: (pin?: SkillInvocationPin) => Promise<SkillStatus>;
}

function invocationPin(invocation: CliInvocation): SkillInvocationPin | undefined {
  const version = invocation.options.clientVersion;
  const protocol = invocation.options.skillProtocol;
  if (version === null && protocol === null) return undefined;
  if (version === null || protocol === null) {
    throw new TypeError("Skill invocation pin is incomplete");
  }
  return Object.freeze({ loadedSkillVersion: version, loadedSkillProtocol: protocol });
}

const STATUS_FIELDS = [
  "loadedSkillVersion",
  "loadedSkillProtocol",
  "installedSkillVersion",
  "installedSkillProtocol",
  "stagedSkillVersion",
  "stagedSkillProtocol",
  "activationRequired",
  "hostRefreshMayBeRequired",
  "persistencePending",
] as const;

function statusProjection(value: SkillStatus): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of STATUS_FIELDS) output[field] = value[field];
  return output;
}

function execution(command: "skill.install" | "skill.activate" | "skill.status", status: SkillStatus): CliCommandExecution {
  return {
    context: {
      update: {
        checked: true,
        reachable: null,
        usingLastKnownGood: false,
        latestVersionConfirmed: false,
        warning: null,
        securityAnomaly: false,
        activationRequired: status.activationRequired,
        hostRefreshMayBeRequired: status.hostRefreshMayBeRequired,
        persistencePending: status.persistencePending,
        executedVersion: "unknown",
        installedVersion: "unknown",
      },
    },
    output: { data: { command, ...statusProjection(status) } },
  };
}

function assertService(service: SkillCommandService): void {
  if (service === null || typeof service !== "object" ||
      typeof service.install !== "function" ||
      typeof service.activate !== "function" ||
      typeof service.status !== "function") {
    throw new TypeError("Skill command service is invalid");
  }
}

export function createSkillCommandServices(service: SkillCommandService): {
  readonly skillInstall: (invocation: CliInvocation) => Promise<CliCommandExecution>;
  readonly skillActivate: (invocation: CliInvocation) => Promise<CliCommandExecution>;
  readonly skillStatus: (invocation: CliInvocation) => Promise<CliCommandExecution>;
} {
  assertService(service);
  return Object.freeze({
    skillInstall: async (invocation: CliInvocation): Promise<CliCommandExecution> => {
      if (invocation.command.kind !== "skill.install") throw new TypeError("Skill install invocation is invalid");
      const staged = await service.install(invocation.command.path, invocationPin(invocation));
      return execution("skill.install", staged);
    },
    skillActivate: async (invocation: CliInvocation): Promise<CliCommandExecution> => {
      if (invocation.command.kind !== "skill.activate") throw new TypeError("Skill activate invocation is invalid");
      const activated = await service.activate(invocation.command.version, invocation.command.path, invocationPin(invocation));
      return execution("skill.activate", activated);
    },
    skillStatus: async (invocation: CliInvocation): Promise<CliCommandExecution> => {
      if (invocation.command.kind !== "skill.status") throw new TypeError("Skill status invocation is invalid");
      return execution("skill.status", await service.status(invocationPin(invocation)));
    },
  });
}
