import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export interface ProcessResult {
  readonly error: Error | undefined;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export function runProcess(
  executable: string,
  arguments_: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
): ProcessResult {
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
