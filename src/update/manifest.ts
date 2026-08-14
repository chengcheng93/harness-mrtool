import { createHash } from "node:crypto";

import { SemVer, satisfies } from "semver";

import { canonicalizeJson, copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import {
  copyTrustState,
  createAcceptedTrustState,
  isCanonicalTemplateReleaseTag,
  requireCanonicalSemVer,
  signingKeyIsActive,
  updateSecurityError,
  verifySignedEnvelope,
  type TrustedSigningKey,
  type TrustedBundleReceiptAnchor,
  type UpdateTrustState,
} from "./envelope.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const RELEASE_SET_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u;
const ASSET_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const PLATFORM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const KEY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const MAX_CLI_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_TEMPLATE_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_SKILL_ASSET_BYTES = 16 * 1024 * 1024;

export interface ReleaseRepository {
  readonly owner: string;
  readonly name: string;
}

export interface ReleaseAsset {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

export interface CliComponent {
  readonly version: string;
  readonly tag: string;
  readonly inputSchemas: readonly number[];
  readonly policySchemas: readonly number[];
  readonly skillProtocols: readonly number[];
  readonly artifacts: Readonly<Record<string, ReleaseAsset>>;
}

export interface TemplateComponent {
  readonly version: string;
  readonly tag: string;
  readonly inputSchema: number;
  readonly policySchema: number;
  readonly minCliVersion: string;
  readonly asset: string;
  readonly sha256: string;
  readonly size: number;
}

export interface SkillComponent {
  readonly version: string;
  readonly tag: string;
  readonly skillProtocol: number;
  readonly cliVersionRange: string;
  readonly asset: string;
  readonly sha256: string;
  readonly size: number;
  readonly activation: "explicit-host-refresh";
}

export interface ChannelKeyRotation {
  readonly add: readonly {
    readonly keyId: string;
    readonly algorithm: "Ed25519";
    readonly publicKeySpki: string;
    readonly activeFromSequence: number;
  }[];
  readonly revoke: readonly {
    readonly keyId: string;
    readonly revokedAtSequence: number;
  }[];
}

export interface ChannelManifest {
  readonly manifestVersion: 1;
  readonly sequence: number;
  readonly channel: "stable";
  readonly issuedAt: string;
  readonly repository: ReleaseRepository;
  readonly components: {
    readonly cli: CliComponent;
    readonly templates: TemplateComponent;
    readonly skill: SkillComponent;
  };
  readonly releaseSet: {
    readonly id: string;
    readonly cli: string;
    readonly templates: string;
  };
  readonly security: {
    readonly minimumAllowedCliVersion: string;
    readonly revokedCliVersions: readonly string[];
    readonly revokedReleaseSetIds: readonly string[];
  };
  readonly recommendedSkillVersion: string;
  readonly templateHistory: readonly {
    readonly releaseTag: string;
    readonly bundleManifestHash: string;
    readonly receiptPayloadSha256: string;
    readonly signingSequence: number;
    readonly signingKeyId: string;
  }[];
  readonly keyRotation?: ChannelKeyRotation;
}

export interface VerifiedChannelManifest {
  readonly manifest: ChannelManifest;
  readonly payloadSha256: string;
  readonly signingKeyIds: readonly string[];
  readonly nextTrustState: UpdateTrustState;
}

// A frozen object with the same TypeScript shape is not evidence that the
// channel signature and trust-state transition were actually verified.
const verifiedManifestBrands = new WeakSet<object>();

export function isVerifiedChannelManifest(value: unknown): value is VerifiedChannelManifest {
  return typeof value === "object" && value !== null && verifiedManifestBrands.has(value);
}

function record(value: unknown, subject: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw updateSecurityError("envelope is invalid");
  }
  return value as JsonObject;
}

function exact(value: JsonObject, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw updateSecurityError("envelope is invalid");
  }
}

function strictSemver(value: unknown): string {
  return requireCanonicalSemVer(value);
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw updateSecurityError("envelope is invalid");
  }
  return value;
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw updateSecurityError("envelope is invalid");
  }
  return value;
}

function ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function uniqueSortedStrings(
  value: unknown,
  validator: (item: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value) || value.length > 1024) throw updateSecurityError("envelope is invalid");
  const items = value.map((item) => {
    if (typeof item !== "string" || !validator(item)) throw updateSecurityError("envelope is invalid");
    return item;
  });
  if (items.some((item, index) => index > 0 && ordinal(items[index - 1]!, item) >= 0)) {
    throw updateSecurityError("envelope is invalid");
  }
  return items;
}

function uniqueSortedIntegers(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw updateSecurityError("envelope is invalid");
  }
  const items = value.map(positiveInteger);
  if (items.some((item, index) => index > 0 && items[index - 1]! >= item)) {
    throw updateSecurityError("envelope is invalid");
  }
  return items;
}

function asset(value: unknown, maximum: number): ReleaseAsset {
  const item = record(value, "asset");
  exact(item, ["name", "sha256", "size"]);
  if (
    typeof item.name !== "string" ||
    !ASSET_NAME.test(item.name) ||
    typeof item.sha256 !== "string" ||
    !SHA256.test(item.sha256)
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const size = positiveInteger(item.size);
  if (size > maximum) throw updateSecurityError("envelope is invalid");
  return { name: item.name, sha256: item.sha256, size };
}

function repository(value: unknown): ReleaseRepository {
  const item = record(value, "repository");
  exact(item, ["owner", "name"]);
  if (
    typeof item.owner !== "string" ||
    typeof item.name !== "string" ||
    !REPOSITORY_PART.test(item.owner) ||
    !REPOSITORY_PART.test(item.name)
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  return { owner: item.owner, name: item.name };
}

function parseCli(value: unknown): CliComponent {
  const item = record(value, "cli");
  exact(item, ["version", "tag", "inputSchemas", "policySchemas", "skillProtocols", "artifacts"]);
  const version = strictSemver(item.version);
  if (item.tag !== `cli-v${version}`) throw updateSecurityError("envelope is invalid");
  const rawArtifacts = record(item.artifacts, "artifacts");
  const entries = Object.entries(rawArtifacts).sort(([left], [right]) => ordinal(left, right));
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    entries.some(([platform]) => !PLATFORM_ID.test(platform)) ||
    Object.keys(rawArtifacts).some((key, index) => key !== entries[index]?.[0])
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const artifacts = Object.fromEntries(entries.map(([platform, value]) => [
    platform,
    asset(value, MAX_CLI_ASSET_BYTES),
  ]));
  return {
    version,
    tag: item.tag,
    inputSchemas: uniqueSortedIntegers(item.inputSchemas),
    policySchemas: uniqueSortedIntegers(item.policySchemas),
    skillProtocols: uniqueSortedIntegers(item.skillProtocols),
    artifacts,
  };
}

function parseTemplates(value: unknown): TemplateComponent {
  const item = record(value, "templates");
  exact(item, [
    "version", "tag", "inputSchema", "policySchema", "minCliVersion", "asset", "sha256", "size",
  ]);
  const version = strictSemver(item.version);
  const minCliVersion = strictSemver(item.minCliVersion);
  const parsedAsset = asset({ name: item.asset, sha256: item.sha256, size: item.size }, MAX_TEMPLATE_ASSET_BYTES);
  if (item.tag !== `templates-v${version}`) throw updateSecurityError("envelope is invalid");
  return {
    version,
    tag: item.tag,
    inputSchema: positiveInteger(item.inputSchema),
    policySchema: positiveInteger(item.policySchema),
    minCliVersion,
    asset: parsedAsset.name,
    sha256: parsedAsset.sha256,
    size: parsedAsset.size,
  };
}

function parseSkill(value: unknown): SkillComponent {
  const item = record(value, "skill");
  exact(item, [
    "version", "tag", "skillProtocol", "cliVersionRange", "asset", "sha256", "size", "activation",
  ]);
  const version = strictSemver(item.version);
  const parsedAsset = asset({ name: item.asset, sha256: item.sha256, size: item.size }, MAX_SKILL_ASSET_BYTES);
  if (
    item.tag !== `skill-v${version}` ||
    typeof item.cliVersionRange !== "string" ||
    item.cliVersionRange.trim() !== item.cliVersionRange ||
    item.cliVersionRange === "" ||
    item.activation !== "explicit-host-refresh"
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  try {
    satisfies("0.0.0", item.cliVersionRange, { loose: false });
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  return {
    version,
    tag: item.tag,
    skillProtocol: positiveInteger(item.skillProtocol),
    cliVersionRange: item.cliVersionRange,
    asset: parsedAsset.name,
    sha256: parsedAsset.sha256,
    size: parsedAsset.size,
    activation: "explicit-host-refresh",
  };
}

function parseRotation(value: unknown, sequence: number): ChannelKeyRotation {
  const item = record(value, "keyRotation");
  exact(item, ["add", "revoke"]);
  if (!Array.isArray(item.add) || !Array.isArray(item.revoke) || item.add.length > 16 || item.revoke.length > 16) {
    throw updateSecurityError("envelope is invalid");
  }
  const add = item.add.map((entry) => {
    const key = record(entry, "keyRotation.add");
    exact(key, ["keyId", "algorithm", "publicKeySpki", "activeFromSequence"]);
    if (
      typeof key.keyId !== "string" || !KEY_ID.test(key.keyId) ||
      key.algorithm !== "Ed25519" ||
      typeof key.publicKeySpki !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(key.publicKeySpki) ||
      positiveInteger(key.activeFromSequence) <= sequence
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    return {
      keyId: key.keyId,
      algorithm: "Ed25519" as const,
      publicKeySpki: key.publicKeySpki,
      activeFromSequence: key.activeFromSequence as number,
    };
  });
  const revoke = item.revoke.map((entry) => {
    const key = record(entry, "keyRotation.revoke");
    exact(key, ["keyId", "revokedAtSequence"]);
    if (
      typeof key.keyId !== "string" || !KEY_ID.test(key.keyId) ||
      positiveInteger(key.revokedAtSequence) <= sequence
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    return { keyId: key.keyId, revokedAtSequence: key.revokedAtSequence as number };
  });
  for (const values of [add, revoke]) {
    if (values.some((entry, index) => index > 0 && ordinal(values[index - 1]!.keyId, entry.keyId) >= 0)) {
      throw updateSecurityError("envelope is invalid");
    }
  }
  return { add, revoke };
}

function parseIssuedAt(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw updateSecurityError("envelope is invalid");
  }
  const parsed = new Date(value);
  const canonical = parsed.toISOString();
  if (
    Number.isNaN(parsed.valueOf()) ||
    (canonical !== value && canonical.replace(/\.000Z$/u, "Z") !== value)
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  return value;
}

function parseTemplateHistory(value: unknown): ChannelManifest["templateHistory"] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_048) {
    throw updateSecurityError("envelope is invalid");
  }
  const history = value.map((entry) => {
    const item = record(entry, "templateHistory");
    exact(item, [
      "releaseTag", "bundleManifestHash", "receiptPayloadSha256", "signingSequence", "signingKeyId",
    ]);
    if (
      typeof item.releaseTag !== "string" ||
      !isCanonicalTemplateReleaseTag(item.releaseTag) ||
      typeof item.bundleManifestHash !== "string" || !SHA256.test(item.bundleManifestHash) ||
      typeof item.receiptPayloadSha256 !== "string" || !SHA256.test(item.receiptPayloadSha256) ||
      typeof item.signingKeyId !== "string" || !KEY_ID.test(item.signingKeyId)
    ) {
      throw updateSecurityError("envelope is invalid");
    }
    const signingSequence = positiveInteger(item.signingSequence);
    return {
      releaseTag: item.releaseTag,
      bundleManifestHash: item.bundleManifestHash,
      receiptPayloadSha256: item.receiptPayloadSha256,
      signingSequence,
      signingKeyId: item.signingKeyId,
    };
  });
  if (history.some((entry, index) =>
    index > 0 && ordinal(history[index - 1]!.releaseTag, entry.releaseTag) >= 0)) {
    throw updateSecurityError("envelope is invalid");
  }
  return history;
}

function parseManifest(value: unknown): ChannelManifest {
  const item = record(value, "manifest");
  const hasRotation = Object.hasOwn(item, "keyRotation");
  exact(item, [
    "manifestVersion", "sequence", "channel", "issuedAt", "repository", "components",
    "releaseSet", "security", "recommendedSkillVersion",
    "templateHistory",
    ...(hasRotation ? ["keyRotation"] : []),
  ]);
  if (item.manifestVersion !== 1 || item.channel !== "stable") {
    throw updateSecurityError("envelope is invalid");
  }
  const sequence = positiveInteger(item.sequence);
  const components = record(item.components, "components");
  exact(components, ["cli", "templates", "skill"]);
  const cli = parseCli(components.cli);
  const templates = parseTemplates(components.templates);
  const skill = parseSkill(components.skill);
  const releaseSet = record(item.releaseSet, "releaseSet");
  exact(releaseSet, ["id", "cli", "templates"]);
  if (
    typeof releaseSet.id !== "string" || !RELEASE_SET_ID.test(releaseSet.id) ||
    releaseSet.cli !== cli.version || releaseSet.templates !== templates.version ||
    !cli.inputSchemas.includes(templates.inputSchema) ||
    !cli.policySchemas.includes(templates.policySchema) ||
    !cli.skillProtocols.includes(skill.skillProtocol) ||
    !satisfies(cli.version, skill.cliVersionRange, { loose: false }) ||
    new SemVer(cli.version).compare(new SemVer(templates.minCliVersion)) < 0 ||
    item.recommendedSkillVersion !== skill.version
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const security = record(item.security, "security");
  exact(security, ["minimumAllowedCliVersion", "revokedCliVersions", "revokedReleaseSetIds"]);
  const minimumAllowedCliVersion = strictSemver(security.minimumAllowedCliVersion);
  const revokedCliVersions = uniqueSortedStrings(security.revokedCliVersions, (entry) => {
    try { return strictSemver(entry) === entry; } catch { return false; }
  });
  const revokedReleaseSetIds = uniqueSortedStrings(
    security.revokedReleaseSetIds,
    (entry) => RELEASE_SET_ID.test(entry),
  );
  const templateHistory = parseTemplateHistory(item.templateHistory);
  if (
    templateHistory.some((entry) => entry.signingSequence > sequence) ||
    !templateHistory.some((entry) => entry.releaseTag === templates.tag)
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  const result: ChannelManifest = {
    manifestVersion: 1,
    sequence,
    channel: "stable",
    issuedAt: parseIssuedAt(item.issuedAt),
    repository: repository(item.repository),
    components: { cli, templates, skill },
    releaseSet: {
      id: releaseSet.id,
      cli: cli.version,
      templates: templates.version,
    },
    security: { minimumAllowedCliVersion, revokedCliVersions, revokedReleaseSetIds },
    recommendedSkillVersion: skill.version,
    templateHistory,
    ...(hasRotation ? { keyRotation: parseRotation(item.keyRotation!, sequence) } : {}),
  };
  return result;
}

function nextBundleReceiptAnchors(
  priorAnchors: readonly TrustedBundleReceiptAnchor[],
  manifest: ChannelManifest,
): readonly TrustedBundleReceiptAnchor[] {
  const prior = new Map(priorAnchors.map((anchor) => [anchor.releaseTag, anchor]));
  for (const item of manifest.templateHistory) {
    const existing = prior.get(item.releaseTag);
    if (existing !== undefined && (
      existing.repositoryOwner !== manifest.repository.owner ||
      existing.repositoryName !== manifest.repository.name ||
      existing.bundleManifestHash !== item.bundleManifestHash ||
      existing.receiptPayloadSha256 !== item.receiptPayloadSha256 ||
      existing.signingSequence !== item.signingSequence ||
      existing.signingKeyId !== item.signingKeyId
    )) {
      throw updateSecurityError("manifest sequence is not monotonic");
    }
    prior.set(item.releaseTag, {
      repositoryOwner: manifest.repository.owner,
      repositoryName: manifest.repository.name,
      releaseTag: item.releaseTag,
      bundleManifestHash: item.bundleManifestHash,
      receiptPayloadSha256: item.receiptPayloadSha256,
      signingSequence: item.signingSequence,
      signingKeyId: item.signingKeyId,
    });
  }
  if (manifest.templateHistory.length < priorAnchors.length) {
    throw updateSecurityError("manifest sequence is not monotonic");
  }
  for (const anchor of priorAnchors) {
    if (!manifest.templateHistory.some((item) => item.releaseTag === anchor.releaseTag)) {
      throw updateSecurityError("manifest sequence is not monotonic");
    }
  }
  return [...prior.values()];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameRepository(left: ReleaseRepository, right: ReleaseRepository): boolean {
  return left.owner === right.owner && left.name === right.name;
}

function applyRotation(
  priorKeys: readonly TrustedSigningKey[],
  manifest: ChannelManifest,
): readonly TrustedSigningKey[] {
  const keys = new Map(priorKeys.map((key) => [key.keyId, { ...key }]));
  const rotation = manifest.keyRotation;
  if (rotation !== undefined) {
    for (const addition of rotation.add) {
      if (keys.has(addition.keyId)) throw updateSecurityError("envelope is invalid");
      keys.set(addition.keyId, {
        keyId: addition.keyId,
        publicKeySpki: addition.publicKeySpki,
        activeFromSequence: addition.activeFromSequence,
        revokedAtSequence: null,
      });
    }
    for (const revocation of rotation.revoke) {
      const existing = keys.get(revocation.keyId);
      if (existing === undefined || existing.revokedAtSequence !== null) {
        throw updateSecurityError("envelope is invalid");
      }
      keys.set(existing.keyId, { ...existing, revokedAtSequence: revocation.revokedAtSequence });
    }
  }
  if (![...keys.values()].some((key) => signingKeyIsActive(key, manifest.sequence + 1))) {
    throw updateSecurityError("envelope is invalid");
  }
  return [...keys.values()];
}

function sameTrustCollections(
  leftKeys: readonly TrustedSigningKey[],
  leftAnchors: readonly TrustedBundleReceiptAnchor[],
  rightKeys: readonly TrustedSigningKey[],
  rightAnchors: readonly TrustedBundleReceiptAnchor[],
): boolean {
  const value = (
    keys: readonly TrustedSigningKey[],
    anchors: readonly TrustedBundleReceiptAnchor[],
  ): string => canonicalizeJson({
    keys: keys.map((key) => ({ ...key })).sort((left, right) => ordinal(left.keyId, right.keyId)),
    bundleReceiptAnchors: anchors.map((anchor) => ({ ...anchor }))
      .sort((left, right) => ordinal(left.releaseTag, right.releaseTag)),
  } as unknown as JsonObject);
  return value(leftKeys, leftAnchors) === value(rightKeys, rightAnchors);
}

export function verifyChannelEnvelope(
  envelope: string | Uint8Array,
  trustState: UpdateTrustState,
  expectedRepository: ReleaseRepository,
  expectedBootstrapKeys?: readonly TrustedSigningKey[],
): VerifiedChannelManifest {
  const trustedState = copyTrustState(trustState, expectedBootstrapKeys);
  const verified = verifySignedEnvelope(envelope, trustedState, expectedBootstrapKeys);
  let payloadText: string;
  let parsed: JsonValue;
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(verified.payloadBytes);
    parsed = parseStrictJson(payloadText);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  if (payloadText !== `${canonicalizeJson(parsed)}\n`) {
    throw updateSecurityError("envelope is invalid");
  }
  const manifest = parseManifest(parsed);
  if (!sameRepository(manifest.repository, expectedRepository)) {
    throw updateSecurityError("envelope is invalid");
  }
  const activeSignerIds = new Set(trustedState.keys
    .filter((key) => signingKeyIsActive(key, manifest.sequence))
    .map((key) => key.keyId));
  const signingKeyIds = verified.verifiedKeyIds.filter((keyId) => activeSignerIds.has(keyId));
  if (signingKeyIds.length === 0) throw updateSecurityError("signature validation failed");
  if (manifest.sequence < trustedState.highestSequence) {
    throw updateSecurityError("manifest sequence is not monotonic");
  }
  if (
    manifest.sequence === trustedState.highestSequence &&
    trustedState.acceptedPayloadSha256 !== null &&
    trustedState.acceptedPayloadSha256 !== verified.payloadSha256
  ) {
    throw updateSecurityError("manifest sequence is not monotonic");
  }
  const isAcceptedReplay =
    manifest.sequence === trustedState.highestSequence &&
    trustedState.acceptedPayloadSha256 === verified.payloadSha256;
  let nextTrustState: UpdateTrustState;
  if (isAcceptedReplay) {
    const transition = trustedState.acceptedTransition;
    if (transition === null) throw updateSecurityError("trusted key state is invalid");
    const expectedKeys = applyRotation(transition.priorKeys, manifest);
    const expectedAnchors = nextBundleReceiptAnchors(
      transition.priorBundleReceiptAnchors,
      manifest,
    );
    if (!sameTrustCollections(
      expectedKeys,
      expectedAnchors,
      trustedState.keys,
      trustedState.bundleReceiptAnchors,
    )) {
      throw updateSecurityError("trusted key state is invalid");
    }
    nextTrustState = trustedState;
  } else {
    const nextKeys = applyRotation(trustedState.keys, manifest);
    const nextAnchors = nextBundleReceiptAnchors(trustedState.bundleReceiptAnchors, manifest);
    const acceptedEnvelope = typeof envelope === "string"
      ? envelope
      : new TextDecoder("utf-8", { fatal: true }).decode(envelope);
    nextTrustState = createAcceptedTrustState(
      trustedState,
      nextKeys,
      manifest.sequence,
      verified.payloadSha256,
      nextAnchors,
      acceptedEnvelope,
      manifest.keyRotation === undefined
        ? undefined
        : acceptedEnvelope,
    );
  }
  const result = Object.freeze({
    manifest: deepFreeze(copyJsonValue(manifest) as unknown as ChannelManifest),
    payloadSha256: verified.payloadSha256,
    signingKeyIds: Object.freeze([...signingKeyIds].sort(ordinal)),
    nextTrustState,
  });
  verifiedManifestBrands.add(result);
  return result;
}

export function channelPayloadSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
