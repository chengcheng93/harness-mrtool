import assert from "node:assert/strict";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import {
  INSTALLATION_ENROLLMENT_NAME,
  STATE_ENROLLMENT_NAME,
  encodeManagedInstallationEnrollment,
  parseManagedInstallationEnrollment,
  validateManagedInstallationEnrollment,
  type ManagedInstallationEnrollment,
} from "../../src/update/managed-installation-enrollment.ts";

function fixture(phase: ManagedInstallationEnrollment["phase"] = "enrolled"): ManagedInstallationEnrollment {
  return {
    enrollmentVersion: 1,
    phase,
    enrollmentId: "1".repeat(32),
    installationId: "2".repeat(32),
    repository: { owner: "example-owner", name: "harness-mrtool" },
    platform: "darwin-arm64",
    trustConfigSha256: "a".repeat(64),
    roots: {
      installation: { dev: "3", ino: "300" },
      state: { dev: "4", ino: "400" },
    },
    locators: {
      installation: "/Users/example/.local/share/harness-mrtool",
      state: "/Users/example/.local/state/harness-mrtool",
    },
    bootstrapPolicy: { generation: 7, digest: "b".repeat(64) },
  };
}

function reject(error: unknown): boolean {
  return isToolError(error, "UPDATE_SECURITY_ERROR");
}

test("enrollment records round-trip canonically without exposing mutation authority", () => {
  assert.equal(INSTALLATION_ENROLLMENT_NAME, ".harness-mrtool-managed.json");
  assert.equal(STATE_ENROLLMENT_NAME, "installation-owner.json");
  const value = fixture();
  const bytes = encodeManagedInstallationEnrollment(value);
  const parsed = parseManagedInstallationEnrollment(bytes);
  assert.deepEqual(parsed, value);
  assert.notEqual(bytes, encodeManagedInstallationEnrollment(parsed));
});

test("enrollment phase and root bindings are strict data invariants", () => {
  for (const mutate of [
    (value: any) => { value.enrollmentVersion = 2; },
    (value: any) => { value.phase = "unknown"; },
    (value: any) => { value.enrollmentId = "not-an-id"; },
    (value: any) => { value.roots.installation.ino = "0"; },
    (value: any) => { value.trustConfigSha256 = "x".repeat(64); },
    (value: any) => { value.locators.state = "relative/state"; },
    (value: any) => { value.bootstrapPolicy.generation = 0; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateManagedInstallationEnrollment(value), reject);
    assert.throws(() => encodeManagedInstallationEnrollment(value), reject);
  }
});

test("strict bytes reject duplicate keys, noncanonical JSON and trailing data", () => {
  const text = new TextDecoder().decode(encodeManagedInstallationEnrollment(fixture()));
  const variants = [
    text.replace('"phase":"enrolled"', '"phase":"enrolled","phase":"enrolled"'),
    `${text}\n`,
    text.replace('"enrolled"', '"\\u0065nrolled"'),
    text.replace(/\}\n$/u, "}{}\n"),
  ];
  for (const variant of variants) assert.throws(() => parseManagedInstallationEnrollment(new TextEncoder().encode(variant)), reject);
});
