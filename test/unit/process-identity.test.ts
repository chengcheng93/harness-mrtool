import assert from "node:assert/strict";
import test from "node:test";

import { waitForProcessExit, type ProcessIdentity, type ProcessIdentityProvider } from "../../src/platform/process-identity.ts";

const parent: ProcessIdentity = Object.freeze({ pid: 4242, startKey: "win:123" });

function provider(states: readonly Awaited<ReturnType<ProcessIdentityProvider["inspect"]>>[]): ProcessIdentityProvider {
  let index = 0;
  return {
    current: async () => parent,
    inspect: async () => states[Math.min(index++, states.length - 1)]!,
  };
}

test("waitForProcessExit returns only after the exact parent instance is dead", async () => {
  const seen: number[] = [];
  await waitForProcessExit(parent, {
    provider: {
      current: async () => parent,
      inspect: async (pid) => {
        seen.push(pid);
        return seen.length < 2 ? { state: "alive", startKey: parent.startKey } : { state: "dead" };
      },
    },
    sleep: async () => undefined,
    pollMs: 1,
    timeoutMs: 50,
  });
  assert.deepEqual(seen, [parent.pid, parent.pid]);
});

test("waitForProcessExit rejects PID reuse instead of waiting for another process", async () => {
  await assert.rejects(
    waitForProcessExit(parent, {
      provider: provider([{ state: "alive", startKey: "win:999" }]),
      sleep: async () => undefined,
      pollMs: 1,
      timeoutMs: 50,
    }),
    /process identity changed/u,
  );
});

test("waitForProcessExit fails closed for unknown parent state and timeout", async () => {
  await assert.rejects(
    waitForProcessExit(parent, {
      provider: provider([{ state: "unknown" }]),
      sleep: async () => undefined,
      pollMs: 1,
      timeoutMs: 50,
    }),
    /process identity unavailable/u,
  );
  await assert.rejects(
    waitForProcessExit(parent, {
      provider: provider([{ state: "alive", startKey: parent.startKey }]),
      sleep: async () => undefined,
      pollMs: 1,
      timeoutMs: 2,
    }),
    /process exit wait timed out/u,
  );
});
