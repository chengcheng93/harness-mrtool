import type { CliInvocation } from "../cli/program.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import { createProductionUpdateTrustConfig } from "./trust-config.ts";


export interface PublicInvocationPreflightInput {
  readonly commandKind: CliInvocation["command"]["kind"];
  readonly noUpdate: boolean;
  readonly offline: boolean;
}


export interface PublicInvocationPreflight {
  readonly run: (input: PublicInvocationPreflightInput) => Promise<void>;
}


function unavailableProductionTrust(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Production update trust is unavailable", {
    field: "update.trust",
    expected: "source-pinned production bootstrap keys",
    actual: "production trust configuration is not provisioned",
    safeNextStep: "Install a release built with the pinned production trust configuration, then retry.",
  });
}


/**
 * Validate the immutable production trust configuration before a public
 * invocation. The configuration is source-pinned and included in the
 * bundled production executable; a valid configuration is sufficient to
 * continue. Network update checks remain owned by the update service when a
 * service is provisioned.
 */
export function createProductionUpdatePreflight(): PublicInvocationPreflight {
  return Object.freeze({
    run: async (input: PublicInvocationPreflightInput): Promise<void> => {
      if (input.noUpdate) return;
      try {
        createProductionUpdateTrustConfig();
      } catch (error) {
        if (isToolError(error, "UPDATE_SECURITY_ERROR")) throw error;
        throw unavailableProductionTrust();
      }
    },
  });
}


export async function runPublicInvocationPreflight(
  preflight: PublicInvocationPreflight,
  invocation: CliInvocation,
): Promise<void> {
  if (preflight === null || typeof preflight !== "object" || typeof preflight.run !== "function") {
    throw new TypeError("Production update preflight is invalid");
  }
  await preflight.run(Object.freeze({
    commandKind: invocation.command.kind,
    noUpdate: invocation.options.noUpdate,
    offline: invocation.options.offline,
  }));
}
