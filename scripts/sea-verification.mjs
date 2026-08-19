import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPackageVersion } from "./build.mjs";

export function expectedSeaSelfTestStdout(version) {
  return JSON.stringify({ ok: true, code: "OK", sea: true, version });
}

export function expectedSeaContractProbeStdout(version) {
  return JSON.stringify({
    ok: true,
    code: "CONTRACT_PROBE_OK",
    sea: true,
    version,
    validOutputAccepted: true,
    invalidOutputRejected: true,
    requestValidAccepted: true,
    requestInvalidRejected: true,
  });
}

export function expectedSeaRendererProbeStdout(version) {
  return JSON.stringify({
    ok: true,
    code: "RENDERER_PROBE_OK",
    sea: true,
    version,
    titleAccepted: true,
    descriptionAccepted: true,
    markerVerified: true,
    projectTemplateAccepted: true,
    tamperRejected: true,
  });
}

function defaultRunProcess(executable, arguments_, options) {
  const result = spawnSync(executable, arguments_, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function diagnosticFor(result) {
  return JSON.stringify(
    {
      error:
        result.error === undefined
          ? undefined
          : { message: result.error.message, name: result.error.name },
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    },
    undefined,
    2,
  );
}

function stdoutMatchesContract(stdout, expectedStdout) {
  return (
    stdout === expectedStdout ||
    stdout === `${expectedStdout}\n` ||
    stdout === `${expectedStdout}\r\n`
  );
}

export async function verifySeaExecutable(
  executablePath,
  dependencies = {},
) {
  const createEmptyWorkingDirectory =
    dependencies.createEmptyWorkingDirectory ??
    (() => mkdtemp(join(tmpdir(), "harness-mrtool-build-verify-")));
  const removeWorkingDirectory =
    dependencies.removeWorkingDirectory ??
    ((path) => rm(path, { recursive: true, force: true }));
  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  const systemRoot = dependencies.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const expectedStdout =
    dependencies.expectedStdout ?? expectedSeaSelfTestStdout(readPackageVersion());
  const expectedProbeStdout =
    dependencies.expectedProbeStdout ??
    expectedSeaContractProbeStdout(readPackageVersion());
  const expectedRendererProbeStdout =
    dependencies.expectedRendererProbeStdout ??
    expectedSeaRendererProbeStdout(readPackageVersion());
  const workingDirectory = await createEmptyWorkingDirectory();

  try {
    const result = runProcess(
      executablePath,
      ["self-test", "--output", "json"],
      {
        cwd: workingDirectory,
        env: { NO_COLOR: "1", SystemRoot: systemRoot },
      },
    );

    if (
      result.error !== undefined ||
      result.status !== 0 ||
      result.stderr !== "" ||
      !stdoutMatchesContract(result.stdout, expectedStdout)
    ) {
      throw new Error(`SEA self-test failed:\n${diagnosticFor(result)}`);
    }

    const probeResult = runProcess(
      executablePath,
      ["self-test", "--contract-probe", "--output", "json"],
      {
        cwd: workingDirectory,
        env: { NO_COLOR: "1", SystemRoot: systemRoot },
      },
    );

    if (
      probeResult.error !== undefined ||
      probeResult.status !== 0 ||
      probeResult.stderr !== "" ||
      !stdoutMatchesContract(probeResult.stdout, expectedProbeStdout)
    ) {
      throw new Error(
        `SEA output contract probe failed:\n${diagnosticFor(probeResult)}`,
      );
    }

    const rendererProbeResult = runProcess(
      executablePath,
      ["self-test", "--renderer-probe", "--output", "json"],
      {
        cwd: workingDirectory,
        env: { NO_COLOR: "1", SystemRoot: systemRoot },
      },
    );

    if (
      rendererProbeResult.error !== undefined ||
      rendererProbeResult.status !== 0 ||
      rendererProbeResult.stderr !== "" ||
      !stdoutMatchesContract(rendererProbeResult.stdout, expectedRendererProbeStdout)
    ) {
      throw new Error(
        `SEA renderer probe failed:\n${diagnosticFor(rendererProbeResult)}`,
      );
    }
  } finally {
    await removeWorkingDirectory(workingDirectory);
  }
}

export async function finalizeSeaExecutable(executablePath, dependencies) {
  try {
    await dependencies.injectBlob();
    await dependencies.verifyExecutable(executablePath);
  } catch (error) {
    try {
      await dependencies.removeArtifact(executablePath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "SEA build failed and the invalid artifact could not be removed.",
      );
    }
    throw error;
  }
}
