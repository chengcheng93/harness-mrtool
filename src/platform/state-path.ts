import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";

function stateError(reason: string): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", `Private state path is unsafe: ${reason}`, {
    field: null,
    expected: "a private current-user directory without symbolic links or reparse points",
    actual: reason,
    safeNextStep: "Inspect or remove the unsafe state path, then retry.",
  });
}

export function defaultStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.trim() === "") {
      throw stateError("LOCALAPPDATA is unavailable");
    }
    return resolve(localAppData, "harness-mrtool", "state");
  }
  const base = environment.XDG_STATE_HOME?.trim() || resolve(homedir(), ".local", "state");
  return resolve(base, "harness-mrtool");
}

export async function ensurePrivateStateDirectory(path: string): Promise<void> {
  if (typeof path !== "string" || path.trim() === "") {
    throw stateError("state directory is missing");
  }
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw stateError("state directory is a symbolic link or reparse point");
    }
    if (!info.isDirectory()) {
      throw stateError("state path is not a directory");
    }
    if (process.platform !== "win32") {
      await chmod(path, 0o700);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw stateError("state directory cannot be securely prepared");
  }
}
