import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { ensurePrivateStateDirectory } from "../platform/state-path.ts";
import {
  SkillManager,
  type SkillFile,
  type SkillRelease,
  type SkillReleaseVerifier,
  type SkillStagedRelease,
} from "./manager.ts";
import { verifySkillPublicationReceipt, type VerifiedSkillPublicationReceipt } from "./publication-receipt.ts";
import type { SkillCommandService } from "../cli/commands/skill.ts";
import type { SkillInvocationPin } from "./manager.ts";
import {
  createProductionChannelClient,
  type ProductionChannelClientOptions,
} from "../update/production-channel.ts";
import {
  createProductionReleaseSource,
  type ProductionReleaseSource,
} from "../update/production-release-source.ts";
import { createProductionUpdateTrustConfig, type UpdateTrustConfig } from "../update/trust-config.ts";
import type { SkillComponent } from "../update/manifest.ts";

const SKILL_ASSET_NAME = "harness-mr-skill.zip";

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "The signed Skill release is not coherent", {
    field: "skill.release",
    expected: "a signed, channel-bound Skill archive and receipt",
    actual,
    safeNextStep: "Keep the current Skill active and retry the fixed official channel.",
  });
}

function defaultActivePath(): string {
  return resolve(homedir(), ".local", "share", "harness-mrtool", "skill", "harness-mr");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function filesFromPublication(publication: VerifiedSkillPublicationReceipt): readonly SkillFile[] {
  return Object.freeze([...publication.files.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([path, contents]) => Object.freeze({ path, contents: Uint8Array.from(contents) })));
}

function assertComponentMatchesPublication(component: SkillComponent, publication: VerifiedSkillPublicationReceipt): void {
  const receipt = publication.receipt;
  if (receipt.releaseTag !== component.tag || receipt.version !== component.version ||
      receipt.skillProtocol !== component.skillProtocol || receipt.cliVersionRange !== component.cliVersionRange ||
      receipt.asset.sha256 !== component.sha256 || receipt.asset.size !== component.size ||
      receipt.asset.name !== component.asset || component.asset !== SKILL_ASSET_NAME) {
    throw failure("channel-component-receipt-mismatch");
  }
}

function assertReleaseMatchesPublication(
  release: SkillRelease | SkillStagedRelease,
  publication: VerifiedSkillPublicationReceipt,
): void {
  if (release.version !== publication.receipt.version || release.tag !== publication.receipt.releaseTag ||
      release.skillProtocol !== publication.receipt.skillProtocol || release.cliVersionRange !== publication.receipt.cliVersionRange ||
      release.activation !== "explicit-host-refresh" || release.assetSha256 !== publication.receipt.asset.sha256 ||
      release.assetSize !== publication.receipt.asset.size) {
    throw failure("skill-release-metadata-mismatch");
  }
  const expected = publication.files;
  const actual = new Map<string, Uint8Array>(release.files.map((file) => [file.path, file.contents instanceof Uint8Array ? file.contents : new TextEncoder().encode(file.contents)]));
  if (actual.size !== expected.size || [...expected].some(([path, contents]) => !sameBytes(actual.get(path) ?? new Uint8Array(), contents))) {
    throw failure("skill-release-files-mismatch");
  }
}

export interface ProductionSkillServiceOptions extends ProductionChannelClientOptions {
  readonly cliVersion: string;
  readonly stateDirectory: string;
  readonly trustConfig?: UpdateTrustConfig;
  readonly supportedProtocols?: readonly number[];
  readonly defaultActivePath?: string;
  readonly fetch?: typeof globalThis.fetch;
}

function validOptions(options: ProductionSkillServiceOptions): void {
  if (options === null || typeof options !== "object" || typeof options.cliVersion !== "string" ||
      typeof options.stateDirectory !== "string" || options.stateDirectory.length === 0) {
    throw new TypeError("Production Skill service options are invalid");
  }
}

export function createProductionSkillCommandService(
  options: ProductionSkillServiceOptions,
): SkillCommandService {
  validOptions(options);
  const trustConfig = options.trustConfig ?? createProductionUpdateTrustConfig();
  const stateDirectory = resolve(options.stateDirectory);
  const stagingPath = resolve(stateDirectory, "skill");
  const activeDefault = options.defaultActivePath ?? defaultActivePath();
  const supportedProtocols = Object.freeze([...(options.supportedProtocols ?? [1])]);
  const channel = createProductionChannelClient({
    ...options,
    stateDirectory,
    trustConfig,
  });
  const source: ProductionReleaseSource = createProductionReleaseSource({
    repository: trustConfig.repository,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const trusted = new Map<string, VerifiedSkillPublicationReceipt>();

  async function downloadPublication(component: SkillComponent): Promise<VerifiedSkillPublicationReceipt> {
    const archive = await source.downloadAsset({
      repository: trustConfig.repository,
      tag: component.tag,
      asset: { name: component.asset, sha256: component.sha256, size: component.size },
    });
    const receipt = await source.downloadSkillReceipt({ repository: trustConfig.repository, tag: component.tag });
    const publication = verifySkillPublicationReceipt({
      envelope: receipt,
      archiveBytes: archive,
      expectedTag: component.tag,
      expectedVersion: component.version,
      trustConfig,
    });
    assertComponentMatchesPublication(component, publication);
    return publication;
  }

  async function latestRelease(): Promise<SkillRelease> {
    const first = await channel.check(true);
    const component = first.verified.manifest.components.skill;
    if (!first.latestVersionConfirmed || !supportedProtocols.includes(component.skillProtocol)) {
      throw failure("skill-channel-is-not-current-or-compatible");
    }
    const publication = await downloadPublication(component);
    const latest = await channel.check(false);
    if (!latest.latestVersionConfirmed || latest.verified.payloadSha256 !== first.verified.payloadSha256) {
      throw new ToolError("CONCURRENT_UPDATE", "Signed Skill authorization changed during download", {
        field: "skill.channel",
        expected: "the same signed channel payload before and after Skill download",
        actual: "Skill candidate authorization is stale",
        safeNextStep: "Retry the Skill refresh; no active Skill path was changed.",
      });
    }
    const release: SkillRelease = Object.freeze({
      version: component.version,
      tag: component.tag,
      skillProtocol: component.skillProtocol,
      cliVersionRange: component.cliVersionRange,
      activation: "explicit-host-refresh",
      verified: true,
      files: filesFromPublication(publication),
      assetSha256: component.sha256,
      assetSize: component.size,
    });
    trusted.set(`${release.version}\0${release.assetSha256}\0${release.assetSize}`, publication);
    return release;
  }

  async function publicationForStaged(release: SkillStagedRelease): Promise<VerifiedSkillPublicationReceipt> {
    const cached = trusted.get(`${release.version}\0${release.assetSha256}\0${release.assetSize}`);
    if (cached !== undefined) return cached;
    const component: SkillComponent = {
      version: release.version,
      tag: release.tag,
      skillProtocol: release.skillProtocol,
      cliVersionRange: release.cliVersionRange,
      activation: "explicit-host-refresh",
      asset: SKILL_ASSET_NAME,
      sha256: release.assetSha256,
      size: release.assetSize,
    };
    const publication = await downloadPublication(component);
    trusted.set(`${release.version}\0${release.assetSha256}\0${release.assetSize}`, publication);
    return publication;
  }

  const verifier: SkillReleaseVerifier = Object.freeze({
    verify(release: SkillRelease) {
      const publication = trusted.get(`${release.version}\0${release.assetSha256}\0${release.assetSize}`);
      if (release.verified !== true || publication === undefined) throw failure("skill-release-is-not-authenticated");
      assertReleaseMatchesPublication(release, publication);
    },
    async verifyStaged(release: SkillStagedRelease) {
      const publication = await publicationForStaged(release);
      assertReleaseMatchesPublication(release, publication);
    },
  });

  async function prepareDefaultActiveParent(): Promise<void> {
    await mkdir(dirname(activeDefault), { recursive: true, mode: 0o700 });
    await ensurePrivateStateDirectory(dirname(activeDefault));
  }

  function managerFor(path: string): SkillManager {
    return new SkillManager({
      activePath: resolve(path),
      stagingPath,
      cliVersion: options.cliVersion,
      supportedProtocols,
      releaseVerifier: verifier,
      ...(options.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: options.windowsAclVerifier }),
    });
  }

  return Object.freeze({
    async install(path: string, pin?: SkillInvocationPin) {
      const manager = managerFor(path);
      return manager.stage(await latestRelease(), pin);
    },
    async activate(version: string, path: string, pin?: SkillInvocationPin) {
      const manager = managerFor(path);
      return manager.activate(version, pin);
    },
    async status(pin?: SkillInvocationPin) {
      await prepareDefaultActiveParent();
      return managerFor(activeDefault).status(pin);
    },
  });
}
