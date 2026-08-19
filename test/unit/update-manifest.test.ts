import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, sha256Utf8, type JsonObject } from "../../src/contracts/jcs.ts";
import {
  createTrustState,
  MAX_SIGNED_ENVELOPE_BYTES,
  verifySignedEnvelope,
} from "../../src/update/envelope.ts";
import {
  verifyChannelEnvelope,
  type ChannelManifest,
} from "../../src/update/manifest.ts";
import { evaluateReleaseCompatibility } from "../../src/update/compatibility.ts";
import {
  verifyBundleReceiptEnvelope,
} from "../../src/update/bundle-receipt.ts";
import {
  checkStableChannel,
  type ChannelHttpRequest,
  type ChannelHttpResponse,
  type ChannelHttpTransport,
} from "../../src/update/http.ts";
import {
  canonicalPayload,
  createSigningFixture,
  signedEnvelope,
  type SigningFixture,
} from "../helpers/signing.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const bundleDirectory = resolve(repositoryRoot, "template-bundle");
const repository = { owner: "example-owner", name: "harness-mrtool" } as const;

function artifact(name: string, size: number): JsonObject {
  return { name, sha256: "a".repeat(64), size };
}

function manifest(
  sequence = 42,
  overrides: Partial<JsonObject> = {},
): JsonObject {
  const signingKeyId = String(overrides.historySigningKeyId ?? "release-key-1");
  const { historySigningKeyId: _historySigningKeyId, ...manifestOverrides } = overrides;
  return {
    manifestVersion: 1,
    sequence,
    channel: "stable",
    issuedAt: "2026-08-13T08:00:00Z",
    repository,
    components: {
      cli: {
        version: "1.2.3",
        tag: "cli-v1.2.3",
        inputSchemas: [1],
        policySchemas: [1],
        skillProtocols: [1],
        artifacts: {
          "windows-x64": artifact("harness-mrtool-windows-x64.zip", 12_345_678),
        },
      },
      templates: {
        version: "1.4.0",
        tag: "templates-v1.4.0",
        inputSchema: 1,
        policySchema: 1,
        minCliVersion: "1.2.0",
        asset: "harness-mr-templates.zip",
        sha256: "b".repeat(64),
        size: 45_678,
      },
      skill: {
        version: "1.1.0",
        tag: "skill-v1.1.0",
        skillProtocol: 1,
        cliVersionRange: ">=1.2.0 <2.0.0",
        asset: "harness-mr-skill.zip",
        sha256: "c".repeat(64),
        size: 12_345,
        activation: "explicit-host-refresh",
      },
    },
    releaseSet: { id: `stable-${String(sequence)}`, cli: "1.2.3", templates: "1.4.0" },
    security: {
      minimumAllowedCliVersion: "1.0.0",
      revokedCliVersions: [],
      revokedReleaseSetIds: [],
    },
    templateHistory: [{
      releaseTag: "templates-v1.4.0",
      bundleManifestHash: "d".repeat(64),
      receiptPayloadSha256: "e".repeat(64),
      signingSequence: 1,
      signingKeyId,
    }],
    recommendedSkillVersion: "1.1.0",
    ...manifestOverrides,
  };
}

function trust(key: SigningFixture) {
  return createTrustState([{
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }]);
}

function assertSecurityError(action: () => unknown, pattern?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.equal(isToolError(error, "UPDATE_SECURITY_ERROR"), true);
    if (pattern !== undefined) assert.match((error as Error).message, pattern);
    return true;
  });
}

test("verifies the exact payload bytes before parsing payload JSON", () => {
  const trusted = createSigningFixture("release-key-1");
  const attacker = createSigningFixture("release-key-1");
  const malformed = new TextEncoder().encode("{not-json");
  const envelope = signedEnvelope(malformed, [attacker]);

  assertSecurityError(
    () => verifySignedEnvelope(envelope, trust(trusted)),
    /signature/i,
  );

  const validSignature = signedEnvelope(malformed, [trusted]);
  const verified = verifySignedEnvelope(validSignature, trust(trusted));
  assert.deepEqual(verified.payloadBytes, malformed);

  const firstView = verified.payloadBytes;
  firstView[0] = 0;
  assert.deepEqual(verified.payloadBytes, malformed);
});

test("trust state cannot forget the accepted payload for a nonzero sequence", () => {
  const key = createSigningFixture("release-key-1");
  assertSecurityError(() => createTrustState([{
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }], 42, null));
  assertSecurityError(() => createTrustState([{
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }], 0, "a".repeat(64)));
});

test("rejects malformed envelopes, padding, duplicate signers and the response size boundary", () => {
  const key = createSigningFixture("release-key-1");
  const state = trust(key);
  const valid = JSON.parse(signedEnvelope(canonicalPayload(manifest()), [key])) as JsonObject;

  for (const bad of [
    { ...valid, unknown: true },
    { ...valid, payload: `${String(valid.payload)}=` },
    { ...valid, signatures: [...valid.signatures as JsonObject[], ...(valid.signatures as JsonObject[])] },
    { ...valid, signatures: [{ ...(valid.signatures as JsonObject[])[0], algorithm: "RSA" }] },
  ]) {
    assertSecurityError(() => verifySignedEnvelope(`${canonicalizeJson(bad)}\n`, state));
  }
  assertSecurityError(() => verifySignedEnvelope("x".repeat(MAX_SIGNED_ENVELOPE_BYTES + 1), state));

  const stateWithUnknownField = { ...state, unknown: true };
  assertSecurityError(() => verifySignedEnvelope(
    signedEnvelope(canonicalPayload(manifest()), [key]),
    stateWithUnknownField as never,
  ));
});

test("accepts a canonical stable manifest and enforces repository, tags, assets and sequence", () => {
  const key = createSigningFixture("release-key-1");
  const initial = trust(key);
  const payload = canonicalPayload(manifest());
  const envelope = signedEnvelope(payload, [key]);
  const verified = verifyChannelEnvelope(envelope, initial, repository);

  assert.equal(verified.manifest.sequence, 42);
  assert.equal(verified.manifest.releaseSet.id, "stable-42");
  assert.equal(verified.nextTrustState.highestSequence, 42);
  assert.equal(verified.nextTrustState.acceptedPayloadSha256, sha256Utf8(new TextDecoder().decode(payload)));
  assert.equal(Object.isFrozen(verified.manifest), true);

  const same = verifyChannelEnvelope(envelope, verified.nextTrustState, repository);
  assert.equal(same.manifest.sequence, 42);
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(41)), [key]),
    verified.nextTrustState,
    repository,
  ), /sequence/i);
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(42, { issuedAt: "2026-08-13T08:00:01Z" })), [key]),
    verified.nextTrustState,
    repository,
  ), /sequence|payload/i);

  for (const bad of [
    manifest(43, { repository: { owner: "other", name: "harness-mrtool" } }),
    manifest(43, { releaseSet: { id: "stable-43", cli: "9.9.9", templates: "1.4.0" } }),
    manifest(43, {
      components: {
        ...(manifest().components as JsonObject),
        cli: { ...((manifest().components as JsonObject).cli as JsonObject), tag: "cli-v9.9.9" },
      },
    }),
  ]) {
    assertSecurityError(() => verifyChannelEnvelope(
      signedEnvelope(canonicalPayload(bad), [key]), initial, repository,
    ));
  }

  const noncanonicalPayload = new TextEncoder().encode(
    JSON.stringify(manifest(43), undefined, 2),
  );
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(noncanonicalPayload, [key]), initial, repository,
  ));
});

test("rotates keys only through a manifest signed by an already trusted key", () => {
  const oldKey = createSigningFixture("release-key-old");
  const newKey = createSigningFixture("release-key-new");
  const initial = trust(oldKey);
  const rotation = manifest(2, {
    historySigningKeyId: oldKey.keyId,
    keyRotation: {
      add: [{
        keyId: newKey.keyId,
        algorithm: "Ed25519",
        publicKeySpki: newKey.publicKeySpki,
        activeFromSequence: 3,
      }],
      revoke: [{ keyId: oldKey.keyId, revokedAtSequence: 4 }],
    },
  });
  const rotated = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(rotation), [oldKey]), initial, repository,
  ).nextTrustState;
  assert.deepEqual(rotated.keys.map((key) => [key.keyId, key.activeFromSequence, key.revokedAtSequence]), [
    ["release-key-new", 3, null],
    ["release-key-old", 1, 4],
  ]);
  const replayed = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(rotation), [oldKey]), rotated, repository,
  );
  assert.deepEqual(replayed.nextTrustState, rotated);

  const accepted = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(3, {
      historySigningKeyId: oldKey.keyId,
    })), [newKey]), rotated, repository,
  );
  assert.equal(accepted.manifest.sequence, 3);
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(4, {
      historySigningKeyId: oldKey.keyId,
    })), [oldKey]),
    accepted.nextTrustState,
    repository,
  ), /signature|trusted key/i);

  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(rotation), [newKey]), initial, repository,
  ), /signature/i);

  const expiringOnly = createTrustState([{
    keyId: oldKey.keyId,
    publicKeySpki: oldKey.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: 3,
  }]);
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(2)), [oldKey]),
    expiringOnly,
    repository,
  ));
});

test("same-sequence replay re-derives the complete accepted key and receipt-anchor transition", () => {
  const oldKey = createSigningFixture("release-key-old");
  const newKey = createSigningFixture("release-key-new");
  const extraKey = createSigningFixture("release-key-extra");
  const payload = canonicalPayload(manifest(2, {
    historySigningKeyId: oldKey.keyId,
    keyRotation: {
      add: [{
        keyId: newKey.keyId,
        algorithm: "Ed25519",
        publicKeySpki: newKey.publicKeySpki,
        activeFromSequence: 3,
      }],
      revoke: [{ keyId: oldKey.keyId, revokedAtSequence: 4 }],
    },
  }));
  const envelope = signedEnvelope(payload, [oldKey]);
  const accepted = verifyChannelEnvelope(envelope, trust(oldKey), repository).nextTrustState;
  assert.deepEqual(verifyChannelEnvelope(envelope, accepted, repository).nextTrustState, accepted);

  const withoutRotation = {
    ...accepted,
    keys: accepted.keys.filter((key) => key.keyId !== newKey.keyId),
  };
  const withExtraKey = {
    ...accepted,
    keys: [...accepted.keys, {
      keyId: extraKey.keyId,
      publicKeySpki: extraKey.publicKeySpki,
      activeFromSequence: 1,
      revokedAtSequence: null,
    }],
  };
  const withoutAnchor = { ...accepted, bundleReceiptAnchors: [] };
  const withDriftedAnchor = {
    ...accepted,
    bundleReceiptAnchors: accepted.bundleReceiptAnchors.map((anchor) => ({
      ...anchor,
      bundleManifestHash: "f".repeat(64),
    })),
  };

  for (const weakened of [withoutRotation, withExtraKey, withoutAnchor, withDriftedAnchor]) {
    assertSecurityError(() => verifyChannelEnvelope(envelope, weakened, repository));
    assertSecurityError(() => createTrustState(
      weakened.keys,
      weakened.highestSequence,
      weakened.acceptedPayloadSha256,
      weakened.bundleReceiptAnchors,
    ));
  }
});

test("a persisted witness cannot be rewritten to authorize an injected key for a later sequence", () => {
  const rootKey = createSigningFixture("release-key-root");
  const rotatedKey = createSigningFixture("release-key-rotated");
  const injectedKey = createSigningFixture("release-key-injected");
  const rotation = manifest(2, {
    historySigningKeyId: rootKey.keyId,
    keyRotation: {
      add: [{
        keyId: rotatedKey.keyId,
        algorithm: "Ed25519",
        publicKeySpki: rotatedKey.publicKeySpki,
        activeFromSequence: 3,
      }],
      revoke: [],
    },
  });
  const accepted = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(rotation), [rootKey]),
    trust(rootKey),
    repository,
  ).nextTrustState;
  const transition = accepted.acceptedTransition;
  if (transition === null) throw new Error("expected accepted transition witness");
  const forgedKeys = [...accepted.keys, {
    keyId: injectedKey.keyId,
    publicKeySpki: injectedKey.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }];
  const forgedPriorKeys = [...transition.priorKeys, {
    keyId: injectedKey.keyId,
    publicKeySpki: injectedKey.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }];
  const transitionHash = (
    priorKeys: readonly JsonObject[],
    keys: readonly JsonObject[],
    anchors = accepted.bundleReceiptAnchors,
  ): string =>
    sha256Utf8(`${canonicalizeJson({
      prior: {
        highestSequence: transition.priorHighestSequence,
        acceptedPayloadSha256: transition.priorAcceptedPayloadSha256,
        keys: priorKeys,
        bundleReceiptAnchors: transition.priorBundleReceiptAnchors,
      },
      accepted: {
        highestSequence: accepted.highestSequence,
        acceptedPayloadSha256: accepted.acceptedPayloadSha256,
        keys,
        bundleReceiptAnchors: anchors,
      },
    } as unknown as JsonObject)}\n`);
  const forged = {
    ...accepted,
    keys: forgedKeys,
    acceptedTransition: {
      ...transition,
      priorKeys: forgedPriorKeys,
      transitionSha256: transitionHash(
        forgedPriorKeys as unknown as JsonObject[],
        forgedKeys as unknown as JsonObject[],
      ),
    },
  };
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(3, {
      historySigningKeyId: injectedKey.keyId,
    })), [injectedKey]),
    forged,
    repository,
  ));

  const forgedAnchors = accepted.bundleReceiptAnchors.map((anchor) => ({
    ...anchor,
    bundleManifestHash: "f".repeat(64),
  }));
  const forgedAnchorState = {
    ...accepted,
    bundleReceiptAnchors: forgedAnchors,
    acceptedTransition: {
      ...transition,
      transitionSha256: transitionHash(
        transition.priorKeys as unknown as JsonObject[],
        accepted.keys as unknown as JsonObject[],
        forgedAnchors,
      ),
    },
  };
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(3, {
      historySigningKeyId: rotatedKey.keyId,
    })), [rotatedKey]),
    forgedAnchorState,
    repository,
  ));
});

test("persisted bootstrap roots are checked when the caller supplies the immutable built-in root", () => {
  const builtInRoot = createSigningFixture("release-key-built-in");
  const forgedRoot = createSigningFixture("release-key-forged-root");
  const forgedState = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(2, {
      historySigningKeyId: forgedRoot.keyId,
    })), [forgedRoot]),
    trust(forgedRoot),
    repository,
  ).nextTrustState;
  const later = signedEnvelope(canonicalPayload(manifest(3, {
    historySigningKeyId: forgedRoot.keyId,
  })), [forgedRoot]);
  assert.doesNotThrow(() => verifyChannelEnvelope(later, forgedState, repository));
  assertSecurityError(() => verifyChannelEnvelope(
    later,
    forgedState,
    repository,
    trust(builtInRoot).keys,
  ));
});

test("unbranded persisted trust states require an immutable bootstrap root", () => {
  const trusted = createSigningFixture("release-key-1");
  const state = trust(trusted);
  const persisted = JSON.parse(JSON.stringify(state)) as typeof state;
  const envelope = signedEnvelope(canonicalPayload(manifest()), [trusted]);

  assertSecurityError(() => verifySignedEnvelope(envelope, persisted));
  assert.deepEqual(
    verifySignedEnvelope(envelope, persisted, [state.bootstrapKeys[0]!]).verifiedKeyIds,
    [trusted.keyId],
  );
});

test("evaluates the release set as one CLI and Template compatibility tuple", () => {
  const key = createSigningFixture("release-key-1");
  const verified = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest()), [key]), trust(key), repository,
  );
  const compatible = evaluateReleaseCompatibility(verified.manifest, {
    platform: "windows-x64",
    supportedManifestVersions: [1],
    supportedInputSchemas: [1],
    supportedPolicySchemas: [1],
    loadedSkillProtocol: 1,
    activeCliVersion: "1.2.3",
    activeReleaseSetId: "stable-42",
  });
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.candidateCompatible, true);
  assert.equal(compatible.activeReleaseAllowedForWrites, true);
  assert.equal(compatible.releaseSetId, "stable-42");

  const incompatible = evaluateReleaseCompatibility(verified.manifest, {
    platform: "windows-x64",
    supportedManifestVersions: [1],
    supportedInputSchemas: [2],
    supportedPolicySchemas: [1],
    loadedSkillProtocol: 2,
    activeCliVersion: "1.2.3",
    activeReleaseSetId: "stable-42",
  });
  assert.equal(incompatible.compatible, false);
  assert.deepEqual(incompatible.reasons, [
    "input-schema-unsupported",
    "loaded-skill-protocol-unsupported",
  ]);

  const securityMinimum = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(43, {
      security: {
        minimumAllowedCliVersion: "2.0.0",
        revokedCliVersions: [],
        revokedReleaseSetIds: [],
      },
    })), [key]),
    trust(key),
    repository,
  );
  assert.deepEqual(evaluateReleaseCompatibility(securityMinimum.manifest, {
    platform: "windows-x64",
    supportedManifestVersions: [1],
    supportedInputSchemas: [1],
    supportedPolicySchemas: [1],
    loadedSkillProtocol: 1,
    activeCliVersion: "1.2.3",
    activeReleaseSetId: "stable-42",
  }).reasons, ["cli-version-below-minimum"]);

  const invalidRange = manifest(43, {
    components: {
      ...(manifest().components as JsonObject),
      skill: {
        ...((manifest().components as JsonObject).skill as JsonObject),
        cliVersionRange: "not a SemVer range",
      },
    },
  });
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(invalidRange), [key]), trust(key), repository,
  ));
});

test("compatibility separately blocks writes when the active release is revoked", () => {
  const key = createSigningFixture("release-key-1");
  const secured = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(43, {
      security: {
        minimumAllowedCliVersion: "1.1.0",
        revokedCliVersions: ["1.0.0"],
        revokedReleaseSetIds: ["stable-old"],
      },
    })), [key]),
    trust(key),
    repository,
  );
  const result = evaluateReleaseCompatibility(secured.manifest, {
    platform: "windows-x64",
    supportedManifestVersions: [1],
    supportedInputSchemas: [1],
    supportedPolicySchemas: [1],
    loadedSkillProtocol: 1,
    activeCliVersion: "1.0.0",
    activeReleaseSetId: "stable-old",
  });
  assert.equal(result.candidateCompatible, true);
  assert.equal(result.activeReleaseAllowedForWrites, false);
  assert.deepEqual(result.activeReasons, [
    "active-cli-version-below-minimum",
    "active-cli-version-revoked",
    "active-release-set-revoked",
  ]);
});

async function bundleReceiptPayload(keyId: string): Promise<{
  readonly payload: JsonObject;
  readonly manifest: JsonObject;
  readonly manifestBytes: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
}> {
  const manifestText = await readFile(resolve(bundleDirectory, "bundle-manifest.json"), "utf8");
  const manifestValue = JSON.parse(manifestText) as JsonObject;
  const manifestBytes = new TextEncoder().encode(manifestText);
  const files = [
    {
      path: "bundle-manifest.json",
      size: manifestBytes.byteLength,
      sha256: sha256Utf8(manifestText),
    },
    ...(manifestValue.files as JsonObject[]),
  ];
  const actualFiles = new Map<string, Uint8Array>([["bundle-manifest.json", manifestBytes]]);
  for (const file of (manifestValue.files as JsonObject[])) {
    actualFiles.set(String(file.path), await readFile(resolve(bundleDirectory, String(file.path))));
  }
  return {
    manifest: manifestValue,
    manifestBytes,
    files: actualFiles,
    payload: {
      receiptVersion: 1,
      receiptType: "template-bundle",
      signingSequence: 42,
      signingKeyId: keyId,
      repository,
      releaseTag: "templates-v1.0.0",
      bundleId: manifestValue.bundleId!,
      bundleVersion: manifestValue.version!,
      bundleManifest: {
        sha256: sha256Utf8(manifestText),
        size: manifestBytes.byteLength,
      },
      inputSchema: manifestValue.inputSchema!,
      policySchema: manifestValue.policySchema!,
      skillProtocols: [1],
      files,
    },
  };
}

function trustHistoricalReceipt(
  key: SigningFixture,
  receiptPayload: JsonObject,
  bundleManifestHash: string,
  overrides: Partial<JsonObject> = {},
) {
  const historyManifest = manifest(42, {
    templateHistory: [
      {
        releaseTag: "templates-v1.0.0",
        bundleManifestHash,
        receiptPayloadSha256: sha256Utf8(`${canonicalizeJson(receiptPayload)}\n`),
        signingSequence: 42,
        signingKeyId: key.keyId,
      },
      {
        releaseTag: "templates-v1.4.0",
        bundleManifestHash: "d".repeat(64),
        receiptPayloadSha256: "e".repeat(64),
        signingSequence: 1,
        signingKeyId: key.keyId,
      },
    ],
    ...overrides,
  });
  return verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(historyManifest), [key]),
    trust(key),
    repository,
  ).nextTrustState;
}

test("historical Bundle requires a signed receipt and binds every manifest file", async () => {
  const key = createSigningFixture("release-key-1");
  const fixture = await bundleReceiptPayload(key.keyId);
  const expectedHash = sha256Utf8(new TextDecoder().decode(fixture.manifestBytes));
  const state = trustHistoricalReceipt(key, fixture.payload, expectedHash);

  assertSecurityError(() => verifyBundleReceiptEnvelope(undefined, state, {
    repository,
    releaseTag: "templates-v1.0.0",
    bundleManifestHash: expectedHash,
  }, fixture.files), /signed.*receipt/i);

  const verified = verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(fixture.payload), [key]),
    state,
    {
      repository,
      releaseTag: "templates-v1.0.0",
      bundleManifestHash: expectedHash,
    },
    fixture.files,
  );
  assert.equal(verified.receipt.bundleVersion, "1.0.0");
  const layoutBefore = verified.readFile("layout.md");
  fixture.files.get("layout.md")![0] = 0;
  assert.deepEqual(verified.readFile("layout.md"), layoutBefore);
  verified.readFile("layout.md")[0] = 1;
  assert.deepEqual(verified.readFile("layout.md"), layoutBefore);

  const tamperedManifestBytes = new TextEncoder().encode(
    `${canonicalizeJson({ ...fixture.manifest, version: "1.0.1" })}\n`,
  );
  assertSecurityError(() => verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(fixture.payload), [key]),
    state,
    {
      repository,
      releaseTag: "templates-v1.0.0",
      bundleManifestHash: expectedHash,
    },
    new Map(fixture.files).set("bundle-manifest.json", tamperedManifestBytes),
  ));
  const badReceipt = {
    ...fixture.payload,
    files: (fixture.payload.files as JsonObject[]).map((file, index) =>
      index === 1 ? { ...file, sha256: "f".repeat(64) } : file),
  };
  const badReceiptState = trustHistoricalReceipt(key, badReceipt, expectedHash);
  assertSecurityError(() => verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(badReceipt), [key]),
    badReceiptState,
    {
      repository,
      releaseTag: "templates-v1.0.0",
      bundleManifestHash: expectedHash,
    },
    fixture.files,
  ));

  const firstPayload = [...fixture.files.entries()].find(([path]) => path !== "bundle-manifest.json")!;
  const tamperedFiles = new Map(fixture.files);
  tamperedFiles.set(firstPayload[0], Uint8Array.from([...firstPayload[1], 0]));
  assertSecurityError(() => verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(fixture.payload), [key]),
    state,
    {
      repository,
      releaseTag: "templates-v1.0.0",
      bundleManifestHash: expectedHash,
    },
    tamperedFiles,
  ));

  const oversizedReceipt = {
    ...fixture.payload,
    files: (fixture.payload.files as JsonObject[]).map((file, index) =>
      index === 1 ? { ...file, size: 2 * 1024 * 1024 + 1 } : file),
  };
  const oversizedState = trustHistoricalReceipt(key, oversizedReceipt, expectedHash);
  assertSecurityError(() => verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(oversizedReceipt), [key]),
    oversizedState,
    {
      repository,
      releaseTag: "templates-v1.0.0",
      bundleManifestHash: expectedHash,
    },
    fixture.files,
  ));

  const invalidVersionReceipt = {
    ...fixture.payload,
    releaseTag: "templates-v01.0.0",
    bundleVersion: "01.0.0",
  };
  const invalidVersionState = trustHistoricalReceipt(key, invalidVersionReceipt, expectedHash);
  assertSecurityError(() => verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(invalidVersionReceipt), [key]),
    invalidVersionState,
    {
      repository,
      releaseTag: "templates-v01.0.0",
      bundleManifestHash: expectedHash,
    },
    fixture.files,
  ));
});

test("malformed signed Bundle manifest entries fail with the update security contract", async () => {
  const key = createSigningFixture("release-key-1");
  const fixture = await bundleReceiptPayload(key.keyId);
  const originalManifestFiles = fixture.manifest.files as JsonObject[];
  const malformedManifest = {
    ...fixture.manifest,
    files: [null, ...originalManifestFiles.slice(1)],
  };
  const malformedManifestText = `${canonicalizeJson(malformedManifest)}\n`;
  const malformedManifestBytes = new TextEncoder().encode(malformedManifestText);
  const malformedManifestHash = sha256Utf8(malformedManifestText);
  const receiptFiles = (fixture.payload.files as JsonObject[]).map((file, index) =>
    index === 0
      ? { ...file, size: malformedManifestBytes.byteLength, sha256: malformedManifestHash }
      : file);
  const receipt = {
    ...fixture.payload,
    bundleManifest: {
      size: malformedManifestBytes.byteLength,
      sha256: malformedManifestHash,
    },
    files: receiptFiles,
  };
  const state = trustHistoricalReceipt(key, receipt, malformedManifestHash);
  const actualFiles = new Map(fixture.files);
  actualFiles.set("bundle-manifest.json", malformedManifestBytes);

  assertSecurityError(() => verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(receipt), [key]),
    state,
    {
      repository,
      releaseTag: "templates-v1.0.0",
      bundleManifestHash: malformedManifestHash,
    },
    actualFiles,
  ));
});

test("a revoked key cannot backdate a new historical Bundle receipt", async () => {
  const key = createSigningFixture("release-key-1");
  const replacementKey = createSigningFixture("release-key-2");
  const fixture = await bundleReceiptPayload(key.keyId);
  const expectedHash = sha256Utf8(new TextDecoder().decode(fixture.manifestBytes));
  const revokedState = trustHistoricalReceipt(key, fixture.payload, expectedHash, {
    keyRotation: {
      add: [{
        keyId: replacementKey.keyId,
        algorithm: "Ed25519",
        publicKeySpki: replacementKey.publicKeySpki,
        activeFromSequence: 43,
      }],
      revoke: [{ keyId: key.keyId, revokedAtSequence: 43 }],
    },
  });

  const historical = verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(fixture.payload), [key]),
    revokedState,
    { repository, releaseTag: "templates-v1.0.0", bundleManifestHash: expectedHash },
    fixture.files,
  );
  assert.equal(historical.receipt.bundleVersion, "1.0.0");

  const forged = { ...fixture.payload, bundleId: "forged-bundle" };

  assertSecurityError(() => verifyBundleReceiptEnvelope(
    signedEnvelope(canonicalPayload(forged), [key]),
    revokedState,
    { repository, releaseTag: "templates-v1.0.0", bundleManifestHash: expectedHash },
    fixture.files,
  ));
});

test("template history is canonical and bound to the current signed channel", () => {
  const key = createSigningFixture("release-key-1");
  const valid = manifest();
  const current = (valid.templateHistory as JsonObject[])[0]!;
  const older = {
    ...current,
    releaseTag: "templates-v1.0.0",
    bundleManifestHash: "1".repeat(64),
    receiptPayloadSha256: "2".repeat(64),
  };

  for (const templateHistory of [
    [current, older],
    [{ ...current, signingSequence: 43 }],
    [{ ...current, signingKeyId: "unknown-key" }],
    [{ ...current, releaseTag: "templates-v1.3.0" }],
  ]) {
    assertSecurityError(() => verifyChannelEnvelope(
      signedEnvelope(canonicalPayload(manifest(42, { templateHistory })), [key]),
      trust(key),
      repository,
    ));
  }
});

test("release tags use canonical SemVer while preserving legal prerelease and build identifiers", () => {
  const key = createSigningFixture("release-key-1");
  const current = (manifest().templateHistory as JsonObject[])[0]!;
  const invalidHistory = [
    {
      ...current,
      releaseTag: "templates-v1.0.0-01",
      bundleManifestHash: "1".repeat(64),
      receiptPayloadSha256: "2".repeat(64),
    },
    current,
  ];
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(42, { templateHistory: invalidHistory })), [key]),
    trust(key),
    repository,
  ));
  assertSecurityError(() => createTrustState([{
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
    activeFromSequence: 1,
    revokedAtSequence: null,
  }], 1, "a".repeat(64), [{
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    releaseTag: "templates-v1.0.0-01",
    bundleManifestHash: "b".repeat(64),
    receiptPayloadSha256: "c".repeat(64),
    signingSequence: 1,
    signingKeyId: key.keyId,
  }]));

  const legalVersion = "1.4.0-rc.1+build.01";
  const base = manifest();
  const components = base.components as JsonObject;
  const templates = components.templates as JsonObject;
  const legal = manifest(42, {
    components: {
      ...components,
      templates: {
        ...templates,
        version: legalVersion,
        tag: `templates-v${legalVersion}`,
      },
    },
    releaseSet: { id: "stable-42", cli: "1.2.3", templates: legalVersion },
    templateHistory: [{
      ...current,
      releaseTag: `templates-v${legalVersion}`,
    }],
  });
  assert.equal(
    verifyChannelEnvelope(signedEnvelope(canonicalPayload(legal), [key]), trust(key), repository)
      .manifest.components.templates.version,
    legalVersion,
  );
});

test("signed template history is append-only across channel sequences", () => {
  const key = createSigningFixture("release-key-1");
  const first = verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(42)), [key]),
    trust(key),
    repository,
  );
  assertSecurityError(() => verifyChannelEnvelope(
    signedEnvelope(canonicalPayload(manifest(43, {
      templateHistory: [{
        releaseTag: "templates-v1.4.0",
        bundleManifestHash: "f".repeat(64),
        receiptPayloadSha256: "e".repeat(64),
        signingSequence: 42,
        signingKeyId: key.keyId,
      }],
    })), [key]),
    first.nextTrustState,
    repository,
  ));
});

test("channel manifest exported type remains immutable JSON data", () => {
  const value: ChannelManifest | null = null;
  assert.equal(value, null);
});

class FakeChannelTransport implements ChannelHttpTransport {
  readonly requests: ChannelHttpRequest[] = [];
  constructor(private readonly responses: Array<ChannelHttpResponse | Error>) {}

  async request(request: ChannelHttpRequest): Promise<ChannelHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("unexpected request");
    return response;
  }
}

function channelResponse(
  status: number,
  body = new Uint8Array(),
  headers: Readonly<Record<string, string>> = {},
): ChannelHttpResponse {
  return { status, body, headers };
}

test("ordinary channel check is one conditional request with fixed two-second budget", async () => {
  const transport = new FakeChannelTransport([
    channelResponse(304, new Uint8Array(), {
      etag: '"stable-42"',
      "last-modified": "Thu, 13 Aug 2026 08:00:00 GMT",
    }),
  ]);
  const result = await checkStableChannel({
    url: "https://example-owner.github.io/harness-mrtool/stable.envelope.json",
    transport,
    validators: {
      etag: '"stable-41"',
      lastModified: "Wed, 12 Aug 2026 08:00:00 GMT",
    },
    force: false,
  });
  assert.deepEqual(result, {
    kind: "not-modified",
    validators: {
      etag: '"stable-42"',
      lastModified: "Thu, 13 Aug 2026 08:00:00 GMT",
    },
    attempts: 1,
  });
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0], {
    url: "https://example-owner.github.io/harness-mrtool/stable.envelope.json",
    headers: {
      accept: "application/json",
      "if-none-match": '"stable-41"',
      "if-modified-since": "Wed, 12 Aug 2026 08:00:00 GMT",
      "user-agent": "harness-mrtool",
    },
    connectTimeoutMs: 1_000,
    totalTimeoutMs: 2_000,
    maxResponseBytes: MAX_SIGNED_ENVELOPE_BYTES,
  });
});

test("force channel check retries only transient failures inside the fifteen-second budget", async () => {
  const transport = new FakeChannelTransport([
    channelResponse(429),
    new Error("network unavailable"),
    channelResponse(200, new TextEncoder().encode("signed-envelope"), {
      etag: '"stable-43"',
    }),
  ]);
  let now = 1_000;
  const sleeps: number[] = [];
  const result = await checkStableChannel({
    url: "https://example-owner.github.io/harness-mrtool/stable.envelope.json",
    transport,
    validators: { etag: null, lastModified: null },
    force: true,
    clock: { now: () => now },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") throw new Error("expected changed");
  assert.equal(new TextDecoder().decode(result.envelope), "signed-envelope");
  assert.deepEqual(sleeps, [250, 750]);
  assert.deepEqual(transport.requests.map((request) => request.totalTimeoutMs), [
    15_000, 14_750, 14_000,
  ]);
});

test("force retry backoff is truncated to the remaining total budget after late failures", async () => {
  for (const lateFailure of ["rate-limit", "transport"] as const) {
    let now = 1_000;
    const sleeps: number[] = [];
    const requests: ChannelHttpRequest[] = [];
    const result = await checkStableChannel({
      url: "https://example-owner.github.io/harness-mrtool/stable.envelope.json",
      transport: {
        async request(request) {
          requests.push(request);
          now = 15_999;
          if (lateFailure === "transport") throw new Error("late transport failure");
          return channelResponse(429);
        },
      },
      validators: { etag: null, lastModified: null },
      force: true,
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, [1]);
    assert.equal(now - 1_000, 15_000);
    assert.equal(result.attempts, 1);
    assert.equal(result.kind, "unavailable");
    if (result.kind !== "unavailable") throw new Error("expected unavailable");
    assert.equal(result.reason, lateFailure === "rate-limit" ? "rate-limited" : "network");
  }
});

test("force retry fails closed when the injected clock becomes invalid or moves backwards", async () => {
  for (const invalidNow of [Number.NaN, 999]) {
    let now = 1_000;
    await assert.rejects(checkStableChannel({
      url: "https://example-owner.github.io/harness-mrtool/stable.envelope.json",
      transport: {
        async request() {
          now = invalidNow;
          throw new Error("transport failure");
        },
      },
      validators: { etag: null, lastModified: null },
      force: true,
      clock: { now: () => now },
      sleep: async () => undefined,
    }), (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"));
  }
});

test("ordinary transient failure returns unavailable without retry or leaking transport errors", async () => {
  const transport = new FakeChannelTransport([new Error("credential-canary network detail")]);
  const result = await checkStableChannel({
    url: "https://example-owner.github.io/harness-mrtool/stable.envelope.json",
    transport,
    validators: { etag: null, lastModified: null },
    force: false,
  });
  assert.deepEqual(result, {
    kind: "unavailable",
    reason: "network",
    attempts: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /credential-canary/u);
  assert.equal(transport.requests.length, 1);
});

test("channel HTTP rejects redirects, invalid validators, unexpected status and oversized bodies", async () => {
  for (const response of [
    channelResponse(302),
    channelResponse(404),
    channelResponse(200, new Uint8Array(MAX_SIGNED_ENVELOPE_BYTES + 1)),
    channelResponse(200, new Uint8Array([1]), { etag: "bad\r\nheader" }),
    channelResponse(304, new Uint8Array([1])),
  ]) {
    const result = await checkStableChannel({
      url: "https://example-owner.github.io/harness-mrtool/stable.envelope.json",
      transport: new FakeChannelTransport([response]),
      validators: { etag: null, lastModified: null },
      force: false,
    });
    assert.deepEqual(result, {
      kind: "security-anomaly",
      reason: "invalid-response",
      attempts: 1,
    });
  }
});

test("channel client rejects caller credentials, fragments, non-HTTPS and noncanonical URLs", async () => {
  for (const url of [
    "http://example.test/stable.json",
    "https://token@example.test/stable.json",
    "https://example.test/stable.json#fragment",
    "https://EXAMPLE.test/stable.json",
    "https://example.test/a/../stable.json",
  ]) {
    await assert.rejects(
      checkStableChannel({
        url,
        transport: new FakeChannelTransport([]),
        validators: { etag: null, lastModified: null },
        force: false,
      }),
      (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
    );
  }
});
