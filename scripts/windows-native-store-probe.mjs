import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createNativeExecutableStore } from "../src/update/native-executable-store.ts";
import { createAuthenticatedReleaseSnapshot } from "../src/update/release-set-verifier.ts";
import { nativeReleaseFixture } from "../test/helpers/native-release-fixture.ts";

const SAFE = /^(?:windows-helper|windows-lock-helper|native-store|native-readiness|managed-installation|update-state|installation-journal):[a-z-]{1,32}$/u;
const root = await mkdtemp(resolve(await realpath(tmpdir()), "harness-mrtool-native-probe-"));
try {
  const fixture = await nativeReleaseFixture("windows-x64");
  const snapshot = await createAuthenticatedReleaseSnapshot(fixture.options);
  const store = createNativeExecutableStore({
    stateDirectory: root,
    platform: "windows-x64",
    trustConfig: fixture.signed.trustConfig,
    windowsAclVerifier: { verify: async () => undefined },
  });
  try {
    await store.materialize(snapshot);
    process.stdout.write("::notice::Native store probe succeeded\n");
  } catch (error) {
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
    const actual = error && typeof error === "object" && error.details && typeof error.details.actual === "string"
      ? error.details.actual
      : error && typeof error === "object" && typeof error.diagnostic === "string" ? error.diagnostic : undefined;
    process.stdout.write(`::notice::Native store probe code=${code}${actual !== undefined && SAFE.test(actual) ? ` diagnostic=${actual}` : ""}\n`);
  }
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
