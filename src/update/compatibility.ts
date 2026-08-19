import { lt } from "semver";

import { requireCanonicalSemVer, updateSecurityError } from "./envelope.ts";

import type { ChannelManifest } from "./manifest.ts";

export type CompatibilityReason =
  | "manifest-version-unsupported"
  | "platform-unsupported"
  | "input-schema-unsupported"
  | "policy-schema-unsupported"
  | "loaded-skill-protocol-unsupported"
  | "cli-version-below-minimum"
  | "cli-version-revoked"
  | "release-set-revoked";

export type ActiveReleaseReason =
  | "active-cli-version-below-minimum"
  | "active-cli-version-revoked"
  | "active-release-set-revoked";

export interface CompatibilityCapabilities {
  readonly platform: string;
  readonly supportedManifestVersions: readonly number[];
  readonly supportedInputSchemas: readonly number[];
  readonly supportedPolicySchemas: readonly number[];
  readonly loadedSkillProtocol: number | null;
  readonly activeCliVersion: string;
  readonly activeReleaseSetId: string;
}

export interface ReleaseCompatibility {
  readonly compatible: boolean;
  readonly candidateCompatible: boolean;
  readonly activeReleaseAllowedForWrites: boolean;
  readonly releaseSetId: string;
  readonly reasons: readonly CompatibilityReason[];
  readonly activeReasons: readonly ActiveReleaseReason[];
}

export function evaluateReleaseCompatibility(
  manifest: ChannelManifest,
  capabilities: CompatibilityCapabilities,
): ReleaseCompatibility {
  let activeCliVersion: string;
  try {
    activeCliVersion = requireCanonicalSemVer(capabilities.activeCliVersion);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  if (
    activeCliVersion !== capabilities.activeCliVersion ||
    typeof capabilities.activeReleaseSetId !== "string" ||
    capabilities.activeReleaseSetId.length === 0
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const reasons: CompatibilityReason[] = [];
  const activeReasons: ActiveReleaseReason[] = [];
  if (!capabilities.supportedManifestVersions.includes(manifest.manifestVersion)) {
    reasons.push("manifest-version-unsupported");
  }
  if (manifest.components.cli.artifacts[capabilities.platform] === undefined) {
    reasons.push("platform-unsupported");
  }
  if (
    !capabilities.supportedInputSchemas.includes(manifest.components.templates.inputSchema) ||
    !manifest.components.cli.inputSchemas.includes(manifest.components.templates.inputSchema)
  ) {
    reasons.push("input-schema-unsupported");
  }
  if (
    !capabilities.supportedPolicySchemas.includes(manifest.components.templates.policySchema) ||
    !manifest.components.cli.policySchemas.includes(manifest.components.templates.policySchema)
  ) {
    reasons.push("policy-schema-unsupported");
  }
  if (
    capabilities.loadedSkillProtocol !== null &&
    !manifest.components.cli.skillProtocols.includes(capabilities.loadedSkillProtocol)
  ) {
    reasons.push("loaded-skill-protocol-unsupported");
  }
  if (lt(manifest.components.cli.version, manifest.security.minimumAllowedCliVersion)) {
    reasons.push("cli-version-below-minimum");
  }
  if (manifest.security.revokedCliVersions.includes(manifest.releaseSet.cli)) {
    reasons.push("cli-version-revoked");
  }
  if (manifest.security.revokedReleaseSetIds.includes(manifest.releaseSet.id)) {
    reasons.push("release-set-revoked");
  }
  if (lt(activeCliVersion, manifest.security.minimumAllowedCliVersion)) {
    activeReasons.push("active-cli-version-below-minimum");
  }
  if (manifest.security.revokedCliVersions.includes(activeCliVersion)) {
    activeReasons.push("active-cli-version-revoked");
  }
  if (manifest.security.revokedReleaseSetIds.includes(capabilities.activeReleaseSetId)) {
    activeReasons.push("active-release-set-revoked");
  }
  return Object.freeze({
    compatible: reasons.length === 0,
    candidateCompatible: reasons.length === 0,
    activeReleaseAllowedForWrites: activeReasons.length === 0,
    releaseSetId: manifest.releaseSet.id,
    reasons: Object.freeze(reasons),
    activeReasons: Object.freeze(activeReasons),
  });
}
