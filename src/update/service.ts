import { isToolError, ToolError } from "../contracts/errors.ts";
import type { LoadedReleaseSet } from "./cache.ts";
import {
  isVerifiedChannelManifest,
  type VerifiedChannelManifest,
} from "./manifest.ts";
import {
  canonicalUpdateTrustConfigJson,
  type UpdateTrustConfig,
} from "./trust-config.ts";
import type { PublicInvocationPreflightInput } from "./preflight.ts";

export interface UpdatePreflightResult {
  readonly mode: "offline" | "no-update" | "checked";
  readonly usingLastKnownGood: boolean;
  readonly latestVersionConfirmed: boolean;
  readonly manifestSequence: number | null;
}

export interface UpdateServiceOptions {
  readonly trustConfig: UpdateTrustConfig;
  readonly loadLastKnownGoodOrNull: () => Promise<LoadedReleaseSet | null>;
  readonly checkChannel?: (input: {
    readonly force: boolean;
  }) => Promise<VerifiedChannelManifest | null>;
}

export interface UpdateService {
  readonly preflight: (input: PublicInvocationPreflightInput) => Promise<UpdatePreflightResult>;
  readonly check: (force: boolean) => Promise<UpdatePreflightResult>;
  readonly status: () => Promise<UpdatePreflightResult>;
}

function securityFailure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Signed update metadata could not be verified", {
    field: "update",
    expected: "a branded signed channel manifest and trusted release set",
    actual: "the updater trust boundary was not satisfied",
    safeNextStep: "Keep the last-known-good release set and retry from the fixed official update origin.",
  });
}

function requiredFailure(): ToolError<"UPDATE_REQUIRED"> {
  return new ToolError("UPDATE_REQUIRED", "A verified release set is required", {
    field: "update",
    expected: "a previously verified last-known-good release set",
    actual: "no verified release set is available",
    safeNextStep: "Install a complete verified release, then retry the command.",
  });
}

function result(
  mode: UpdatePreflightResult["mode"],
  loaded: LoadedReleaseSet | null,
  latestVersionConfirmed: boolean,
  manifestSequence: number | null,
): UpdatePreflightResult {
  return Object.freeze({
    mode,
    usingLastKnownGood: loaded !== null,
    latestVersionConfirmed,
    manifestSequence,
  });
}

function assertTrustConfig(config: UpdateTrustConfig): void {
  try {
    // The canonical serializer is branded and rejects caller-forged configs.
    canonicalUpdateTrustConfigJson(config);
  } catch (error) {
    if (isToolError(error, "UPDATE_SECURITY_ERROR")) throw error;
    throw securityFailure();
  }
}

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  if (options === null || typeof options !== "object") throw new TypeError("Update service options are invalid");
  assertTrustConfig(options.trustConfig);
  if (typeof options.loadLastKnownGoodOrNull !== "function") {
    throw new TypeError("Update service requires a last-known-good loader");
  }

  const check = async (force: boolean): Promise<UpdatePreflightResult> => {
    if (typeof force !== "boolean") throw new TypeError("Update force flag is invalid");
    const checkChannel = options.checkChannel;
    if (typeof checkChannel !== "function") throw securityFailure();

    let verified: VerifiedChannelManifest | null;
    try {
      verified = await checkChannel({ force });
    } catch (error) {
      if (isToolError(error, "UPDATE_SECURITY_ERROR")) throw error;
      throw securityFailure();
    }
    if (verified !== null && !isVerifiedChannelManifest(verified)) throw securityFailure();

    const loaded = await options.loadLastKnownGoodOrNull();
    if (verified === null && loaded === null) throw requiredFailure();
    return result(
      "checked",
      loaded,
      verified !== null,
      verified?.manifest.sequence ?? loaded?.record.manifestSequence ?? null,
    );
  };

  const preflight = async (
    input: PublicInvocationPreflightInput,
  ): Promise<UpdatePreflightResult> => {
    if (input === null || typeof input !== "object") throw new TypeError("Update preflight input is invalid");
    if (input.noUpdate) return result("no-update", null, false, null);
    if (input.offline) {
      const loaded = await options.loadLastKnownGoodOrNull();
      if (loaded === null) throw requiredFailure();
      return result("offline", loaded, false, loaded.record.manifestSequence);
    }
    return check(false);
  };

  const status = async (): Promise<UpdatePreflightResult> => {
    const loaded = await options.loadLastKnownGoodOrNull();
    return result("offline", loaded, false, loaded?.record.manifestSequence ?? null);
  };

  return Object.freeze({ preflight, check, status });
}
