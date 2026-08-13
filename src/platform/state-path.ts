import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
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

export const systemWindowsAclVerifier: WindowsAclVerifier = {
  async verify(path) {
    const script = [
      `$path = ${powershellSingleQuoted(path)}`,
      "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
      "$admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')",
      "$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
      "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
      "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
      "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
      "$acl = Get-Acl -LiteralPath $path",
      "$acl.SetAccessRuleProtection($true, $false)",
      "foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) | Out-Null }",
      "foreach ($sid in @($current, $system, $admins)) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inheritance, $propagation, $allow))) }",
      "$acl.SetOwner($current)",
      "Set-Acl -LiteralPath $path -AclObject $acl",
      "$acl = Get-Acl -LiteralPath $path",
      "if ($acl.Owner -ne $current.Value -and $acl.Owner -ne ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)) { exit 21 }",
      "$allowed = @($current.Value, [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, $system.Value, $admins.Value, 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators')",
      "$unsafe = $acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed }",
      "if ($unsafe) { exit 22 }",
      "if (-not $acl.AreAccessRulesProtected) { exit 23 }",
    ].join("; ");
    try {
      await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 5_000, encoding: "utf8" },
      );
    } catch {
      throw stateError("Windows ACL verification failed");
    }
  },
};

export async function ensurePrivateStateDirectory(
  path: string,
  options: PrivateStateDirectoryOptions = {},
): Promise<void> {
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
