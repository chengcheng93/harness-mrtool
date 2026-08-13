import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EXPECTED_SEA_SELF_TEST_STDOUT =
  '{"ok":true,"code":"OK","sea":true,"version":"0.1.0-dev"}';

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

function stdoutMatchesContract(stdout) {
  return (
    stdout === EXPECTED_SEA_SELF_TEST_STDOUT ||
    stdout === `${EXPECTED_SEA_SELF_TEST_STDOUT}\n` ||
    stdout === `${EXPECTED_SEA_SELF_TEST_STDOUT}\r\n`
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
      !stdoutMatchesContract(result.stdout)
    ) {
      throw new Error(`SEA self-test failed:\n${diagnosticFor(result)}`);
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
