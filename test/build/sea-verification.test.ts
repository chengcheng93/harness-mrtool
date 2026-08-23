import assert from "node:assert/strict";
import test from "node:test";

// The SEA build helper is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The build helper intentionally has no declaration file.
import { expectedSeaContractProbeStdout, expectedSeaRendererProbeStdout, expectedSeaSelfTestStdout, finalizeSeaExecutable, verifySeaExecutable } from "../../scripts/sea-verification.mjs";

const expectedStdout = expectedSeaSelfTestStdout("0.1.0");
const expectedProbeStdout = JSON.stringify({
  ok: true,
  code: "CONTRACT_PROBE_OK",
  sea: true,
  version: "0.1.0",
  validOutputAccepted: true,
  invalidOutputRejected: true,
  requestValidAccepted: true,
  requestInvalidRejected: true,
});
const expectedRendererProbeStdout = JSON.stringify({
  ok: true,
  code: "RENDERER_PROBE_OK",
  sea: true,
  version: "0.1.0",
  titleAccepted: true,
  descriptionAccepted: true,
  markerVerified: true,
  projectTemplateAccepted: true,
  tamperRejected: true,
});

test("pins the embedded request and output contract probe result", () => {
  assert.equal(expectedSeaContractProbeStdout("0.1.0"), expectedProbeStdout);
  assert.equal(expectedSeaRendererProbeStdout("0.1.0"), expectedRendererProbeStdout);
});

test("rejects an injected executable whose self-test violates the contract", async () => {
  const invocations: unknown[] = [];
  const removedDirectories: string[] = [];

  await assert.rejects(
    verifySeaExecutable("C:\\release\\harness-mrtool.exe", {
      createEmptyWorkingDirectory: async () => "C:\\empty-self-test-cwd",
      removeWorkingDirectory: async (path: string) => removedDirectories.push(path),
      runProcess: (
        executable: string,
        arguments_: readonly string[],
        options: Record<string, unknown>,
      ) => {
        invocations.push({ executable, arguments_, options });
        return {
          error: undefined,
          status: 17,
          stderr: "unexpected runtime warning\n",
          stdout: '{"ok":false}\n',
        };
      },
      systemRoot: "C:\\Windows",
      expectedStdout,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SEA self-test failed/);
      assert.match(error.message, /"status": 17/);
      assert.match(error.message, /unexpected runtime warning/);
      assert.match(error.message, /\\"ok\\":false/);
      return true;
    },
  );

  assert.deepEqual(invocations, [
    {
      executable: "C:\\release\\harness-mrtool.exe",
      arguments_: ["self-test", "--output", "json"],
      options: {
        cwd: "C:\\empty-self-test-cwd",
        env: { NO_COLOR: "1", SystemRoot: "C:\\Windows" },
      },
    },
  ]);
  assert.deepEqual(removedDirectories, ["C:\\empty-self-test-cwd"]);
});

test("accepts only the exact self-test JSON with an optional trailing newline", async () => {
  for (const stdout of [
    expectedStdout,
    `${expectedStdout}\n`,
    `${expectedStdout}\r\n`,
  ]) {
    await assert.doesNotReject(
      verifySeaExecutable("C:\\release\\harness-mrtool.exe", {
        createEmptyWorkingDirectory: async () => "C:\\empty-self-test-cwd",
        removeWorkingDirectory: async () => undefined,
        runProcess: (_executable: string, arguments_: readonly string[]) =>
          arguments_.includes("--contract-probe")
            ? {
                error: undefined,
                status: 0,
                stderr: "",
                stdout: expectedProbeStdout,
              }
            : arguments_.includes("--renderer-probe")
              ? {
                  error: undefined,
                  status: 0,
                  stderr: "",
                  stdout: expectedRendererProbeStdout,
                }
            : {
                error: undefined,
                status: 0,
                stderr: "",
                stdout,
              },
        systemRoot: "C:\\Windows",
        expectedStdout,
      }),
    );
  }
});

test("runs the embedded output contract probe after self-test", async () => {
  const invocations: readonly string[][] = [];

  await assert.doesNotReject(
    verifySeaExecutable("C:\\release\\harness-mrtool.exe", {
      createEmptyWorkingDirectory: async () => "C:\\empty-self-test-cwd",
      removeWorkingDirectory: async () => undefined,
      runProcess: (
        _executable: string,
        arguments_: readonly string[],
      ) => {
        (invocations as string[][]).push([...arguments_]);
        return {
          error: undefined,
          status: 0,
          stderr: "",
          stdout: arguments_.includes("--contract-probe")
            ? expectedProbeStdout
            : arguments_.includes("--renderer-probe")
              ? expectedRendererProbeStdout
              : expectedStdout,
        };
      },
      systemRoot: "C:\\Windows",
      expectedStdout,
      expectedProbeStdout,
      expectedRendererProbeStdout,
    }),
  );

  assert.deepEqual(invocations, [
    ["self-test", "--output", "json"],
    ["self-test", "--contract-probe", "--output", "json"],
    ["self-test", "--renderer-probe", "--output", "json"],
  ]);
});

test("rejects an executable whose embedded renderer probe fails", async () => {
  await assert.rejects(
    verifySeaExecutable("C:\\release\\harness-mrtool.exe", {
      createEmptyWorkingDirectory: async () => "C:\\empty-self-test-cwd",
      removeWorkingDirectory: async () => undefined,
      runProcess: (_executable: string, arguments_: readonly string[]) => ({
        error: undefined,
        status: arguments_.includes("--renderer-probe") ? 7 : 0,
        stderr: "",
        stdout: arguments_.includes("--contract-probe")
          ? expectedProbeStdout
          : arguments_.includes("--renderer-probe")
            ? '{"ok":false,"code":"RENDERER_PROBE_FAILED"}'
            : expectedStdout,
      }),
      systemRoot: "C:\\Windows",
      expectedStdout,
      expectedProbeStdout,
      expectedRendererProbeStdout,
    }),
    /SEA renderer probe failed/u,
  );
});

test("rejects an executable whose embedded output contract probe fails", async () => {
  await assert.rejects(
    verifySeaExecutable("C:\\release\\harness-mrtool.exe", {
      createEmptyWorkingDirectory: async () => "C:\\empty-self-test-cwd",
      removeWorkingDirectory: async () => undefined,
      runProcess: (
        _executable: string,
        arguments_: readonly string[],
      ) => ({
        error: undefined,
        status: arguments_.includes("--contract-probe") ? 7 : 0,
        stderr: "",
        stdout: arguments_.includes("--contract-probe")
          ? '{"ok":false,"code":"INTERNAL_ERROR"}'
          : expectedStdout,
      }),
      systemRoot: "C:\\Windows",
      expectedStdout,
      expectedProbeStdout,
    }),
    /SEA output contract probe failed/,
  );
});

test("rejects otherwise successful self-test output with extra text", async () => {
  await assert.rejects(
    verifySeaExecutable("C:\\release\\harness-mrtool.exe", {
      createEmptyWorkingDirectory: async () => "C:\\empty-self-test-cwd",
      removeWorkingDirectory: async () => undefined,
      runProcess: () => ({
        error: undefined,
        status: 0,
        stderr: "",
        stdout: `log line\n${expectedStdout}\n`,
      }),
      systemRoot: "C:\\Windows",
      expectedStdout,
    }),
    /SEA self-test failed/,
  );
});

test("removes the canonical artifact when injected output fails verification", async () => {
  const events: string[] = [];
  const executablePath = "C:\\dist\\harness-mrtool.exe";

  await assert.rejects(
    finalizeSeaExecutable(executablePath, {
      injectBlob: async () => events.push("injected"),
      removeArtifact: async (path: string) => events.push(`removed:${path}`),
      verifyExecutable: async () => {
        events.push("verified");
        throw new Error("broken self-test");
      },
    }),
    /broken self-test/,
  );

  assert.deepEqual(events, [
    "injected",
    "verified",
    `removed:${executablePath}`,
  ]);
});
