import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { SemVer } from "semver";
import { verifyBundleReceiptEnvelope } from "../../src/update/bundle-receipt.ts";
import { copyTrustState, createTrustState, requireCanonicalSemVer, type UpdateTrustState } from "../../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import type { SupportedReleasePlatform } from "../../src/update/release-set-verifier.ts";
import { exactReleaseFixture } from "./default-historical-fixture.ts";
import { canonicalPayload, signedEnvelope } from "./signing.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type NativeReleaseOrigin = Awaited<ReturnType<typeof exactReleaseFixture>>;

export interface NativeReleaseFixtureOptions {
  readonly variantByte?: number;
  readonly sequence?: number;
  readonly cliVersion?: string;
  readonly releaseSetId?: string;
}

/** Copy mutable fixture data, never generic-clone KeyObject or branded config. */
function detachedOrigin(origin: NativeReleaseOrigin): NativeReleaseOrigin {
  const copyFiles = (files: ReadonlyMap<string, Uint8Array>) =>
    new Map([...files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
  const files = copyFiles(origin.assets.files);
  return {
    reference: { ...origin.reference },
    // These authorities are immutable; keep the config's runtime brand and the
    // private key's native handle, but detach their replaceable outer slots.
    trustConfig: origin.trustConfig,
    trustState: copyTrustState(origin.trustState, origin.bootstrapKeys),
    bootstrapKeys: Object.freeze(origin.bootstrapKeys.map(key => Object.freeze({ ...key }))),
    signingKey: { ...origin.signingKey },
    assets: {
      ...origin.assets,
      repository: { ...origin.assets.repository },
      receiptEnvelope: typeof origin.assets.receiptEnvelope === "string"
        ? origin.assets.receiptEnvelope : Uint8Array.from(origin.assets.receiptEnvelope),
      files,
    },
    // Preserve the fixture's intentional map alias inside each detached copy.
    mutableFiles: origin.mutableFiles === origin.assets.files ? files : copyFiles(origin.mutableFiles),
    receiptPayload: structuredClone(origin.receiptPayload),
    channelPayload: structuredClone(origin.channelPayload),
  };
}

function fixtureOptions(options: NativeReleaseFixtureOptions, defaultSequence: number) {
  const fields = ["variantByte", "sequence", "cliVersion", "releaseSetId"];
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("invalid native release fixture options");
  }
  const { variantByte = 0, sequence = defaultSequence, cliVersion = "0.1.6", releaseSetId = `stable-${cliVersion}` } = options;
  if (!Number.isInteger(variantByte) || variantByte < 0 || variantByte > 255) {
    throw new TypeError("variantByte must be an integer from 0 to 255");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError("sequence must be a positive safe integer");
  }
  requireCanonicalSemVer(cliVersion);
  if (new SemVer(cliVersion).compare("0.1.0") < 0) {
    throw new TypeError("cliVersion is below the fixture security floor");
  }
  if (typeof releaseSetId !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u.test(releaseSetId)) {
    throw new TypeError("invalid releaseSetId");
  }
  return { variantByte, sequence, cliVersion, releaseSetId };
}

function buildFixture(
  releasePlatform: SupportedReleasePlatform,
  input: NativeReleaseFixtureOptions,
  signed: NativeReleaseOrigin,
  priorTrust: UpdateTrustState,
  defaultSequence: number,
) {
  if (releasePlatform !== "darwin-arm64" && releasePlatform !== "windows-x64") {
    throw new TypeError("unsupported native release fixture platform");
  }
  const { variantByte, sequence, cliVersion, releaseSetId } = fixtureOptions(input, defaultSequence);
  // Header-only authentication fixtures: NOT runnable SEA binaries, self-test
  // evidence, or proof of a successful native OS installation.
  const native = Buffer.alloc(512);
  if (releasePlatform === "darwin-arm64") {
    native.writeUInt32LE(0xfeedfacf, 0);
    native.writeUInt32LE(0x0100000c, 4);
    native.writeUInt32LE(2, 12);
  } else {
    native.writeUInt16LE(0x5a4d, 0);
    native.writeUInt32LE(128, 0x3c);
    native.writeUInt32LE(0x4550, 128);
    native.writeUInt16LE(0x8664, 132);
    native.writeUInt16LE(0x20b, 152);
  }
  native[511] = variantByte; // Outside both fixture headers, including the PE optional header.
  const executableName = releasePlatform === "darwin-arm64" ? "harness-mrtool" : "harness-mrtool.exe";
  const receipt = signed.assets.receiptEnvelope;
  const templateReceipt = typeof receipt === "string" ? Buffer.from(receipt) : Buffer.from(receipt);
  const cliFiles: Record<string, Uint8Array> = {
    [executableName]: native,
    "bundle-receipt.envelope.json": templateReceipt,
    "THIRD_PARTY_NOTICES.md": Buffer.from("notice"),
    "licenses/Node.txt": Buffer.from("license"),
  };
  cliFiles.SHA256SUMS = Buffer.from(Object.keys(cliFiles).sort().map(path => `${hash(cliFiles[path]!)}  ${path}`).join("\n") + "\n");
  // fflate encodes local DOS calendar fields, not an absolute UTC timestamp.
  // Fixed local midnight therefore stays byte-identical across time AND zones.
  const zipOptions = { level: 0 as const, mtime: new Date(2000, 0, 1, 0, 0, 0) };
  const cliArchive = zipSync(cliFiles, zipOptions);
  const templateArchive = zipSync(Object.fromEntries(signed.assets.files), zipOptions);
  // Keep the mutable payload/verify escape hatch used by existing negative tests.
  const payload: any = structuredClone(signed.channelPayload);
  payload.sequence = sequence;
  payload.components.cli = {
    ...payload.components.cli, version: cliVersion, tag: `cli-v${cliVersion}`,
    artifacts: { [releasePlatform]: { name: `harness-mrtool-${releasePlatform}.zip`, sha256: hash(cliArchive), size: cliArchive.length } },
  };
  payload.components.templates = { ...payload.components.templates, minCliVersion: cliVersion, sha256: hash(templateArchive), size: templateArchive.length };
  payload.components.skill = {
    ...payload.components.skill, version: cliVersion, tag: `skill-v${cliVersion}`,
    cliVersionRange: `>=${cliVersion} <${new SemVer(cliVersion).major + 1}.0.0`,
  };
  payload.recommendedSkillVersion = cliVersion;
  payload.releaseSet = { id: releaseSetId, cli: cliVersion, templates: signed.reference.bundleVersion };
  payload.security.minimumAllowedCliVersion = "0.1.0";
  // Deliberate low-level re-signing hook for malicious-payload tests. It does NOT
  // register a valid family candidate or advance the family's accepted state.
  const verify = (p = payload) => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(p), [signed.signingKey]), priorTrust,
    signed.trustConfig.repository, signed.bootstrapKeys,
  );
  const options = { verified: verify(), cliArchive, templateArchive, templateReceipt, platform: releasePlatform, trustConfig: signed.trustConfig };
  return { signed: detachedOrigin(signed), payload, verify, options, native };
}

/** Independent signing root per call; legacy defaults remain native channel 42. */
export async function nativeReleaseFixture(
  releasePlatform: SupportedReleasePlatform = "darwin-arm64",
  options: NativeReleaseFixtureOptions = {},
) {
  const signed = await exactReleaseFixture();
  // The origin's placeholder channel42 is NOT the same native channel42. Start
  // from fresh bootstrap trust for this backward-compatible standalone fixture.
  return buildFixture(releasePlatform, options, signed, createTrustState(signed.bootstrapKeys), 42);
}

/**
 * Own one family per exactReleaseFixture origin. No global key or registry.
 * Valid candidates advance the same accepted trust state and cannot republish
 * different bytes under an existing platform/CLI tag. Reauthorization of the
 * exact old asset at a later sequence models rollback without rewriting history.
 */
export function nativeReleaseFixtureFamily(source: NativeReleaseOrigin) {
  // Capture once; neither the caller nor returned signed wrappers can mutate it.
  const origin = detachedOrigin(source);
  const verifiedOrigin = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(origin.channelPayload), [origin.signingKey]),
    origin.trustState, origin.trustConfig.repository, origin.trustConfig.bootstrapKeys,
  );
  let trust = verifiedOrigin.nextTrustState;
  verifyBundleReceiptEnvelope(origin.assets.receiptEnvelope, trust, {
    repository: origin.trustConfig.repository, releaseTag: origin.reference.releaseTag,
    bundleManifestHash: origin.reference.bundleManifestHash,
  }, origin.assets.files, origin.bootstrapKeys);
  // Accepted origin commitments remain immutable even when their bytes are only
  // placeholders. Reserve each published platform/tag before generating a member.
  const originCli = verifiedOrigin.manifest.components.cli;
  const immutableAssets = new Map<string, string>(Object.entries(originCli.artifacts)
    .map(([platform, artifact]) => [`${platform}/${originCli.tag}`, artifact.sha256]));
  return async (platform: SupportedReleasePlatform = "darwin-arm64", options: NativeReleaseFixtureOptions = {}) => {
    const fixture = buildFixture(platform, options, origin, trust, trust.highestSequence + 1);
    const cli = fixture.options.verified.manifest.components.cli;
    const key = `${platform}/${cli.tag}`;
    const digest = hash(fixture.options.cliArchive);
    const previous = immutableAssets.get(key);
    if (previous !== undefined && previous !== digest) {
      throw new TypeError(`immutable CLI asset conflict for ${key}`);
    }
    // Neither the origin nor family state changes when candidate creation fails.
    immutableAssets.set(key, digest);
    trust = fixture.options.verified.nextTrustState;
    return fixture;
  };
}
