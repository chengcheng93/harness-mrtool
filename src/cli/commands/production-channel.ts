import { ToolError } from "../../contracts/errors.ts";
import { defaultStateDirectory } from "../../platform/state-path.ts";
import {
  createProductionChannelClient,
  type ProductionChannelClientOptions,
} from "../../update/production-channel.ts";
import type { ProductionCommandHandler } from "./production.ts";

/** In-process embedding/test seams only. No public flags or env can supply roots/URLs. */
export type ProductionChannelCommandDefaults = ProductionChannelClientOptions & {
  /** Trusted in-process asset transport seam; never taken from CLI/environment. */
  readonly fetch?: typeof globalThis.fetch;
  /** Trusted in-process platform seam; never taken from CLI arguments/environment. */
  readonly platform?: import("../../update/release-set-verifier.ts").SupportedReleasePlatform;
  /** Trusted in-process Skill active-path seam; never taken from CLI arguments/environment. */
  readonly defaultActivePath?: string;
  /** Trusted in-process managed-installation root seam; never taken from CLI arguments/environment. */
  readonly installationDirectory?: string;
};

/** Checking is not installing: no cache pointer, executable or Skill is activated here. */
export function createProductionChannelCheckHandler(
  cliVersion: string,
  defaults: ProductionChannelCommandDefaults = {},
): ProductionCommandHandler {
  let client: ReturnType<typeof createProductionChannelClient> | undefined;
  return async (invocation) => {
    if (invocation.command.kind !== "self-update.check") {
      throw new TypeError("Expected self-update check");
    }
    if (invocation.options.offline || invocation.options.noUpdate) {
      throw new ToolError("INPUT_ERROR", "An explicit channel check requires network access", {
        field: invocation.options.offline ? "--offline" : "--no-update",
        expected: "self-update check without network-disabling flags",
        actual: "network checks are disabled",
        safeNextStep: "Use self-update status for local state, or retry check without the network-disabling flag.",
      });
    }
    client ??= createProductionChannelClient({
      ...defaults,
      stateDirectory: defaults.stateDirectory ?? defaultStateDirectory(),
    });
    const checked = await client.check(invocation.command.force);
    const manifest = checked.verified.manifest;
    return {
      context: {
        update: {
          checked: true,
          reachable: checked.reachable,
          usingLastKnownGood: false,
          latestVersionConfirmed: checked.latestVersionConfirmed,
          warning: checked.latestVersionConfirmed ? null :
            "Channel unavailable; reporting authenticated cached metadata only, not a confirmed latest release or installed release set.",
          securityAnomaly: false,
          activationRequired: false,
          hostRefreshMayBeRequired: false,
          persistencePending: false,
          executedVersion: cliVersion,
          installedVersion: "unknown",
        },
      },
      output: {
        data: {
          command: "self-update.check",
          availableCliVersion: manifest.components.cli.version,
          availableTemplateVersion: manifest.components.templates.version,
          availableSkillVersion: manifest.components.skill.version,
          availablePlatforms: Object.keys(manifest.components.cli.artifacts).sort(),
          releaseSetId: manifest.releaseSet.id,
          manifestSequence: manifest.sequence,
          latestVersionConfirmed: checked.latestVersionConfirmed,
          installed: false,
        },
      },
    };
  };
}
