import { ToolError } from "../contracts/errors.ts";
import { defaultStateDirectory, type WindowsAclVerifier } from "../platform/state-path.ts";
import { createTrustState, updateSecurityError } from "./envelope.ts";
import { checkStableChannel, type ChannelHttpTransport } from "./http.ts";
import { verifyChannelEnvelope, type VerifiedChannelManifest } from "./manifest.ts";
import { UpdateStateStore, type StoredUpdateState } from "./state-store.ts";
import {
  createProductionUpdateTrustConfig,
  stableChannelEnvelopeUrl,
  updateTrustConfigSha256,
  type UpdateTrustConfig,
} from "./trust-config.ts";

export interface ProductionChannelClientOptions {
  /** Defaults to the private platform state path on the first check, not construction. */
  readonly stateDirectory?: string;
  /** Branded, in-process composition seam; never deserialize trust from requests or env. */
  readonly trustConfig?: UpdateTrustConfig;
  readonly transport?: ChannelHttpTransport;
  /** In-process test/embedding seam; checkStableChannel still requires canonical HTTPS. */
  readonly channelUrl?: string;
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

export interface ProductionChannelCheckResult {
  readonly verified: VerifiedChannelManifest;
  readonly latestVersionConfirmed: boolean;
  readonly reachable: boolean;
}

export interface ProductionChannelClient {
  readonly check: (force: boolean) => Promise<ProductionChannelCheckResult>;
}

function noAcceptedChannel(): ToolError<"UPDATE_REQUIRED"> {
  return new ToolError("UPDATE_REQUIRED", "No authenticated channel is available", {
    field: "update.channel",
    expected: "a signed channel response or a previously accepted signed envelope",
    actual: "the channel is unavailable and no authenticated envelope is cached",
    safeNextStep: "Retry the fixed official update channel when it is available.",
  });
}

/** Authenticates channel metadata only; does not download or activate release assets. */
export function createProductionChannelClient(
  options: ProductionChannelClientOptions = {},
): ProductionChannelClient {
  const trustConfig = options.trustConfig ?? createProductionUpdateTrustConfig();
  // The serializer validates the runtime brand before any state or transport work.
  const trustConfigHash = updateTrustConfigSha256(trustConfig);
  const channelUrl = options.channelUrl ?? stableChannelEnvelopeUrl(trustConfig);
  const stateDirectory = options.stateDirectory;
  const transport = options.transport;
  const windowsAclVerifier = options.windowsAclVerifier;
  let store: UpdateStateStore | undefined;

  function stateStore(): UpdateStateStore {
    store ??= new UpdateStateStore({
      stateDirectory: stateDirectory ?? defaultStateDirectory(),
      trustConfigSha256: trustConfigHash,
      bootstrapKeys: trustConfig.bootstrapKeys,
      ...(windowsAclVerifier === undefined ? {} : { windowsAclVerifier }),
    });
    return store;
  }

  function verifyCached(stored: StoredUpdateState | null): VerifiedChannelManifest {
    const envelope = stored?.trustState.acceptedChannelEnvelope;
    if (stored === null || envelope === null || envelope === undefined) {
      throw updateSecurityError("trusted key state is invalid");
    }
    return verifyChannelEnvelope(
      envelope, stored.trustState, trustConfig.repository, trustConfig.bootstrapKeys,
    );
  }

  return Object.freeze({
    async check(force: boolean): Promise<ProductionChannelCheckResult> {
      if (typeof force !== "boolean") throw new TypeError("Update force flag is invalid");
      const persistent = stateStore();
      const stored = await persistent.load();
      const checked = await checkStableChannel({
        url: channelUrl,
        validators: stored?.validators ?? { etag: null, lastModified: null },
        force,
        ...(transport === undefined ? {} : { transport }),
      });
      if (checked.kind === "security-anomaly") {
        throw updateSecurityError("envelope is invalid");
      }
      if (checked.kind === "unavailable") {
        // Another process may have advanced trust during this request. Do not
        // return a stale snapshot, or treat persisted validators as a signature.
        const current = await persistent.load();
        if (current === null || current.trustState.acceptedChannelEnvelope === null) {
          throw noAcceptedChannel();
        }
        return Object.freeze({
          verified: verifyCached(current),
          latestVersionConfirmed: false,
          reachable: false,
        });
      }
      const verified = checked.kind === "changed"
        ? verifyChannelEnvelope(
            checked.envelope,
            stored?.trustState ?? createTrustState(trustConfig.bootstrapKeys),
            trustConfig.repository,
            trustConfig.bootstrapKeys,
          )
        : verifyCached(stored);
      // Also save on 304: refresh validators only after authenticating the cached
      // envelope, and let the real store reject any concurrent trust regression.
      // No success result escapes a failed durable publication.
      await persistent.save({ trustState: verified.nextTrustState, validators: checked.validators });
      return Object.freeze({ verified, latestVersionConfirmed: true, reachable: true });
    },
  });
}
