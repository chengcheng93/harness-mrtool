import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, win32 } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";




import { ToolError } from "../contracts/errors.ts";




const execFileAsync = promisify(execFile);




export interface WindowsAclVerifier {
  verify(path: string): Promise<void>;
}




export interface PrivateStateDirectoryOptions {
  readonly windowsAclVerifier?: WindowsAclVerifier;
}




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




function powershellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}




export function resolveWindowsPowerShellPath(environment: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = environment.SystemRoot;
  if (systemRoot === undefined ||
      !/^[A-Za-z]:\\[^\\/:*?"<>|]+(?:\\[^\\/:*?"<>|]+)*$/u.test(systemRoot) ||
      win32.normalize(systemRoot) !== systemRoot ||
      !win32.isAbsolute(systemRoot)) {
    throw stateError("SystemRoot is unavailable or untrusted");
  }
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}




export const systemWindowsAclVerifier: WindowsAclVerifier = {
  async verify(path) {
    const script = [
      `$path = ${powershellSingleQuoted(path)}`,
      "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
      "$current = $identity.User",
      "$currentName = $identity.Name",
      "$tokenOwner = $identity.Owner",
      "$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
      "$admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')",
      "$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
      "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
      "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
      "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
      "$currentValue = $current.Value",
      "$args = @($path, '/inheritance:r', '/grant:r', \"*$currentValue`:(OI)(CI)(F)\", '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)')",
      "& icacls.exe @args | Out-Null",
      "if ($LASTEXITCODE -ne 0) { exit 24 }",
      "& icacls.exe $path /setowner $currentName | Out-Null",
      "if ($LASTEXITCODE -ne 0) { exit 25 }",

      "$acl = Get-Acl -LiteralPath $path",
      "$allowed = @($current.Value, $tokenOwner.Value, $system.Value, $admins.Value)",
      "$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
      "if ($owner -notin $allowed) { exit 21 }",
      "$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
      "$unsafe = $rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed }",
      "if ($unsafe) { exit 22 }",
      "if (-not $acl.AreAccessRulesProtected) { exit 23 }",
    ].join("; ");
    try {
      await execFileAsync(
        resolveWindowsPowerShellPath(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 5_000, encoding: "utf8" },
      );
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      const stage = code === 21 || code === "21"
        ? "owner"
        : code === 22 || code === "22"
          ? "rules"
          : code === 23 || code === "23"
            ? "inheritance"
            : code === 24 || code === "24"
              ? "setup"
              : code === 25 || code === "25"
                ? "owner-setup"
                : "execution";
      throw stateError(`Windows ACL verification failed at ${stage} stage`);
    }
  },
};




async function assertNoReparseAncestors(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw stateError("state directory has a symbolic-link or reparse-point ancestor");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}




export async function ensurePrivateStateDirectory(
  path: string,
  options: PrivateStateDirectoryOptions = {},
): Promise<void> {
  if (typeof path !== "string" || path.trim() === "") {
    throw stateError("state directory is missing");
  }
  try {
    await assertNoReparseAncestors(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertNoReparseAncestors(path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw stateError("state directory is a symbolic link or reparse point");
    }
    if (!info.isDirectory()) {
      throw stateError("state path is not a directory");
    }
    if (process.platform !== "win32") {
      await chmod(path, 0o700);
    } else {
      await (options.windowsAclVerifier ?? systemWindowsAclVerifier).verify(path);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw stateError("state directory cannot be securely prepared");
  }
}
