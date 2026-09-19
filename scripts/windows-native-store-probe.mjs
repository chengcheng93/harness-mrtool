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
    const codes = [];
    const diagnostics = [];
    const reasons = [];
    const shapes = [];
    const seen = new Set();
    let current = error;
    for (let depth = 0; depth < 8 && current && typeof current === "object" && !seen.has(current); depth += 1) {
      seen.add(current);
      shapes.push(Object.getOwnPropertyNames(current).filter((key) => /^[A-Za-z][A-Za-z0-9]*$/u.test(key)).sort().join("|"));
      if (typeof current.code === "string" && /^[A-Z0-9_]{2,48}$/u.test(current.code)) codes.push(current.code);
      const actual = current.details && typeof current.details.actual === "string"
        ? current.details.actual
        : typeof current.diagnostic === "string" ? current.diagnostic : undefined;
      const safeReason = new Set(["envelope is invalid", "envelope exceeds the size limit", "manifest sequence is not monotonic", "signature validation failed", "signed bundle receipt is missing", "trusted key state is invalid"]);
      if (actual !== undefined && safeReason.has(actual) && !reasons.includes(actual)) reasons.push(actual);
      if (actual !== undefined && SAFE.test(actual) && !diagnostics.includes(actual)) diagnostics.push(actual);
      current = current.cause;
    }
    process.stdout.write(`::notice::Native store probe code=${codes.join(",") || "unknown"}${reasons.length > 0 ? ` reasons=${reasons.join(",")}` : ""}${diagnostics.length > 0 ? ` diagnostics=${diagnostics.join(",")}` : ""} shape=${shapes.join("/")}\n`);
  }
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
