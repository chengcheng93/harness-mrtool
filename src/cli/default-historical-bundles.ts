import type { HistoricalBundleLoader, VerificationBundleReference } from "../app/verify-mr.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { canonicalizeJson, copyJsonValue, sha256Utf8 } from "../contracts/jcs.ts";
import { defaultStateDirectory } from "../platform/state-path.ts";
import type { ProcessLockProvider } from "../platform/process-lock.ts";
import { copyTrustState, createTrustState, isCanonicalTemplateReleaseTag, updateSecurityError, type UpdateTrustState } from "../update/envelope.ts";
import { createHistoricalBundleLoader, type HistoricalBundleReleaseAssetSource } from "../update/historical-bundle-loader.ts";
import { checkStableChannel, type ChannelHttpTransport } from "../update/http.ts";
import { verifyChannelEnvelope } from "../update/manifest.ts";
import { createProductionHistoricalBundleSource } from "../update/production-historical-source.ts";
import { UpdateStateStore } from "../update/state-store.ts";
import { createProductionUpdateTrustConfig, stableChannelEnvelopeUrl, updateTrustConfigSha256, type UpdateTrustConfig } from "../update/trust-config.ts";
import type { TrustedBundleSelection } from "./commands/local.ts";

export interface DefaultHistoricalBundleLoaderOptions {
  readonly stateDirectory?: string | undefined;
  readonly lockProvider?: ProcessLockProvider;
  /** Explicit in-process composition seams; never sourced from MR metadata or environment. */
  readonly trustConfig?: UpdateTrustConfig;
  readonly trustState?: UpdateTrustState;
  readonly releaseAssets?: HistoricalBundleReleaseAssetSource;
  readonly stateStore?: Pick<UpdateStateStore, "load" | "save">;
  readonly channelTransport?: ChannelHttpTransport;
  /** Explicit embedding/test transport URL; still subject to canonical HTTPS checks. */
  readonly channelUrl?: string;
}

function strictReference(value: VerificationBundleReference): VerificationBundleReference {
  const copied = copyJsonValue(value);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied) ||
      Object.keys(copied).sort().join(",") !== "bundleId,bundleManifestHash,bundleVersion,policySchema,releaseTag" ||
      !isCanonicalTemplateReleaseTag(copied.releaseTag) ||
      typeof copied.bundleVersion !== "string" ||
      copied.releaseTag !== `templates-v${copied.bundleVersion}` ||
      typeof copied.bundleId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(copied.bundleId) ||
      typeof copied.bundleManifestHash !== "string" || !/^[a-f0-9]{64}$/u.test(copied.bundleManifestHash) ||
      !Number.isSafeInteger(copied.policySchema) || Number(copied.policySchema) < 1) {
    throw updateSecurityError("envelope is invalid");
  }
  return Object.freeze(copied) as unknown as VerificationBundleReference;
}

/** No state directory or network is touched until an actual historical lookup. */
export function createDefaultHistoricalBundleLoader(
  current: TrustedBundleSelection,
  options: DefaultHistoricalBundleLoaderOptions = {},
): HistoricalBundleLoader {
  async function historical(): Promise<HistoricalBundleLoader> {
    const trustConfig = options.trustConfig ?? createProductionUpdateTrustConfig();
    let trustState: UpdateTrustState;
    if (options.trustState !== undefined) {
      trustState = copyTrustState(options.trustState, trustConfig.bootstrapKeys);
    } else {
      const store = options.stateStore ?? new UpdateStateStore({
        stateDirectory: options.stateDirectory ?? defaultStateDirectory(),
        trustConfigSha256: updateTrustConfigSha256(trustConfig),
        bootstrapKeys: trustConfig.bootstrapKeys,
        ...(options.lockProvider === undefined ? {} : { lockProvider: options.lockProvider }),
      });
      const stored = await store.load();
      trustState = stored?.trustState ?? createTrustState(trustConfig.bootstrapKeys);
      const checked = await checkStableChannel({
        url: options.channelUrl ?? stableChannelEnvelopeUrl(trustConfig),
        validators: stored?.validators ?? { etag: null, lastModified: null },
        force: true,
        ...(options.channelTransport === undefined ? {} : { transport: options.channelTransport }),
      });
      if (checked.kind === "security-anomaly") throw updateSecurityError("envelope is invalid");
      if (checked.kind === "changed") {
        const verified = verifyChannelEnvelope(checked.envelope, trustState, trustConfig.repository, trustConfig.bootstrapKeys);
        // Persist the authenticated transition before using its anchors, preserving rollback protection.
        trustState = (await store.save({ trustState: verified.nextTrustState, validators: checked.validators })).trustState;
      } else if (stored === null) {
        throw updateSecurityError("trusted key state is invalid");
      }
    }
    return createHistoricalBundleLoader({
      trustConfig,
      trustState,
      releaseAssets: options.releaseAssets ?? createProductionHistoricalBundleSource(),
    });
  }

  return Object.freeze({
    async loadVerifiedExact(value: VerificationBundleReference) {
      const reference = strictReference(value);
      const manifest = current.bundle.manifest;
      if (reference.releaseTag === current.releaseTag &&
          reference.bundleId === manifest.bundleId &&
          reference.bundleVersion === manifest.version &&
          reference.policySchema === manifest.policySchema &&
          reference.bundleManifestHash === current.bundleManifestHash) {
        validateTemplateBundle(current.bundle);
        if (sha256Utf8(`${canonicalizeJson(manifest)}\n`) !== current.bundleManifestHash) {
          throw updateSecurityError("envelope is invalid");
        }
        return Object.freeze({ trusted: true as const, bundle: current.bundle });
      }
      // An unavailable/mismatched historical release can never select today's bundle.
      return (await historical()).loadVerifiedExact(reference);
    },
  });
}
