import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { canonicalizeJson, type JsonObject } from "../../src/contracts/jcs.ts";

export interface SigningFixture {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeySpki: string;
}

export function createSigningFixture(keyId: string): SigningFixture {
  const pair = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey: pair.privateKey,
    publicKeySpki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

export function canonicalPayload(value: JsonObject): Uint8Array {
  return new TextEncoder().encode(`${canonicalizeJson(value)}\n`);
}

export function signedEnvelope(
  payload: Uint8Array,
  signers: readonly SigningFixture[],
): string {
  const envelope = {
    payload: Buffer.from(payload).toString("base64url"),
    signatures: signers.map((signer) => ({
      keyId: signer.keyId,
      algorithm: "Ed25519",
      signature: sign(null, payload, signer.privateKey).toString("base64url"),
    })),
  };
  return `${canonicalizeJson(envelope)}\n`;
}
