import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";

export interface AnchoredMoveFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
}

export type AnchoredMoveName = string;

export interface AnchoredMoveOptions {
  readonly rootDirectory: string;
  readonly rootIdentity: { readonly dev: bigint; readonly ino: bigint };
  readonly sourceDirectory: string;
  readonly sourceDirectoryIdentity: { readonly dev: bigint; readonly ino: bigint };
  readonly sourceName: AnchoredMoveName;
  readonly sourceIdentity: AnchoredMoveFileIdentity;
  readonly destinationName: AnchoredMoveName;
  readonly destination:
    | { readonly kind: "absent" }
    | { readonly kind: "identity"; readonly identity: AnchoredMoveFileIdentity };
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const MAX_IDENTITY = (1n << 64n) - 1n;
const HELPER_TIMEOUT_MS = 60_000;
const STAGE_DIRECTORY = /^\.harness-mrtool-stage-[0-9a-f-]{36}$/u;
const POSIX_HELPER = String.raw`
use strict; use warnings; use Config; use Fcntl qw(O_RDONLY O_NOFOLLOW); use IO::Handle;
$Config{d_fchdir} eq 'define' or die 'unsupported';
my ($root_dev,$root_ino,$source_dir,$source_dir_dev,$source_dir_ino,$source_name,$sdev,$sino,$ssize,$smode,$suid,$destination_name,$destination_kind,@destination)=@ARGV;
for my $value ($root_dev,$root_ino,$source_dir_dev,$source_dir_ino,$sdev,$sino,$ssize,$smode,$suid) { defined($value) && $value =~ /\A[0-9]+\z/ or die 'identity'; }
$source_dir =~ /\A((?:\.|\.harness-mrtool-stage-[0-9a-f-]{36}))\z/ or die 'source directory'; $source_dir=$1;
$source_name =~ /\A((?:harness-mrtool|\.harness-mrtool-install\.json|harness-mrtool\.previous-(?:[0-9a-f]{32}|[0-9a-f-]{36})|\.harness-mrtool-install\.previous-(?:[0-9a-f]{32}|[0-9a-f-]{36})))\z/ or die 'source name'; $source_name=$1;
$destination_name =~ /\A((?:harness-mrtool|\.harness-mrtool-install\.json|harness-mrtool\.previous-(?:[0-9a-f]{32}|[0-9a-f-]{36})|\.harness-mrtool-install\.previous-(?:[0-9a-f]{32}|[0-9a-f-]{36})))\z/ or die 'destination name'; $destination_name=$1;
$destination_kind eq 'absent' || $destination_kind eq 'identity' or die 'destination kind';
$destination_kind eq 'identity' && @destination == 5 or $destination_kind eq 'absent' && @destination == 0 or die 'destination identity';
for my $value (@destination) { defined($value) && $value =~ /\A[0-9]+\z/ or die 'destination identity'; }
open(my $root,'<&=3') or die 'descriptor';
my @root_stat=stat($root);
@root_stat && -d $root && $root_stat[0] == $root_dev && $root_stat[1] == $root_ino && $root_stat[4] == $suid && ($root_stat[2] & 07777) == 0700 or die 'root identity';
chdir($root) or die 'fchdir';
my @source_dir_stat = lstat($source_dir);
@source_dir_stat && -d _ && $source_dir_stat[4] == $suid && ($source_dir_stat[2] & 07777) == 0700 or die 'source directory';
if ($source_dir eq '.') { @source_dir_stat = @root_stat; }
else { $source_dir_stat[0] == $source_dir_dev && $source_dir_stat[1] == $source_dir_ino && $source_dir_stat[0] == $root_stat[0] or die 'source directory'; }
my $source = $source_dir eq '.' ? $source_name : "$source_dir/$source_name";
sysopen(my $source_handle,$source,O_RDONLY|O_NOFOLLOW) or die 'source open';
my @source_stat=stat($source_handle);
@source_stat && -f $source_handle && $source_stat[3] == 1 && $source_stat[0] == $sdev && $source_stat[1] == $sino && $source_stat[7] == $ssize && ($source_stat[2] & 07777) == $smode && $source_stat[4] == $suid or die 'source identity';
my @destination_stat=lstat($destination_name);
if ($destination_kind eq 'absent') {
  @destination_stat && die 'destination present';
} else {
  @destination_stat && -f _ && $destination_stat[3] == 1 && $destination_stat[0] == $destination[0] && $destination_stat[1] == $destination[1] && $destination_stat[7] == $destination[2] && ($destination_stat[2] & 07777) == $destination[3] && $destination_stat[4] == $destination[4] or die 'destination identity';
}
rename($source,$destination_name) or die 'rename';
my @finished=lstat($destination_name);
@finished && -f _ && $finished[3] == 1 && $finished[0] == $sdev && $finished[1] == $sino && $finished[7] == $ssize && ($finished[2] & 07777) == $smode && $finished[4] == $suid or die 'destination result';
my @remaining=lstat($source); @remaining && die 'source remains';
$root->sync or die 'directory sync';
print STDOUT "OK\n" or die 'status';
`;

function failure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Anchored installation move rejected", {
    field: "update.installation",
    expected: "an identity-pinned same-volume move under the private installation root",
    actual: "anchored move failed",
    safeNextStep: "Preserve the staged and canonical evidence and run self-update repair.",
  });
}

function decimal(value: bigint): string {
  if (typeof value !== "bigint" || value < 0n || value > MAX_IDENTITY) throw failure();
  return String(value);
}

function identityArgs(identity: AnchoredMoveFileIdentity): string[] {
  return [decimal(identity.dev), decimal(identity.ino), decimal(identity.size), decimal(identity.mode & 0o7777n), decimal(identity.uid)];
}

function validIdentity(value: unknown): value is AnchoredMoveFileIdentity {
  return value !== null && typeof value === "object" &&
    typeof (value as AnchoredMoveFileIdentity).dev === "bigint" &&
    typeof (value as AnchoredMoveFileIdentity).ino === "bigint" &&
    typeof (value as AnchoredMoveFileIdentity).size === "bigint" &&
    typeof (value as AnchoredMoveFileIdentity).mode === "bigint" &&
    typeof (value as AnchoredMoveFileIdentity).uid === "bigint";
}

function validRootPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function validMoveName(value: unknown): value is string {
  return typeof value === "string" && /^(?:harness-mrtool|\.harness-mrtool-install\.json|harness-mrtool\.previous-(?:[0-9a-f]{32}|[0-9a-f-]{36})|\.harness-mrtool-install\.previous-(?:[0-9a-f]{32}|[0-9a-f-]{36}))$/u.test(value);
}

function assertIdentity(identity: AnchoredMoveFileIdentity): void {
  if (!validIdentity(identity) || identity.dev < 0n || identity.ino < 1n || identity.size < 1n ||
      identity.dev > MAX_IDENTITY || identity.ino > MAX_IDENTITY || identity.size > BigInt(256 * 1024 * 1024) ||
      identity.uid < 0n || identity.uid > MAX_IDENTITY) throw failure();
}

async function runHelper(args: string[], fd: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let failed = false;
    let output = "";
    const timer = setTimeout(() => {
      failed = true;
      child?.kill("SIGKILL");
    }, HELPER_TIMEOUT_MS);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined && !failed) resolvePromise();
      else rejectPromise(failure());
    };
    try {
      child = spawn("/usr/bin/perl", ["-T", "-e", POSIX_HELPER, ...args], {
        shell: false,
        windowsHide: true,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore", fd],
      });
      child.on("error", () => { failed = true; });
      child.stdout?.setEncoding("ascii");
      child.stdout?.on("data", (chunk: string) => {
        if (failed || settled) return;
        if (output.length + chunk.length > 3) {
          failed = true;
          child?.kill("SIGKILL");
          return;
        }
        output += chunk;
      });
      child.once("close", (code) => finish(code === 0 && output === "OK\n" ? undefined : failure()));
    } catch {
      failed = true;
      finish(failure());
    }
  });
}

export async function moveAnchoredFile(options: AnchoredMoveOptions): Promise<void> {
  if (process.platform !== "darwin") throw failure();
  try {
    if (!validRootPath(options.rootDirectory) || !validRootPath(options.sourceDirectory) ||
        !validMoveName(options.sourceName) || !validMoveName(options.destinationName) || options.rootDirectory === "/" ||
        typeof options.rootIdentity?.dev !== "bigint" || typeof options.rootIdentity?.ino !== "bigint" ||
        typeof options.sourceDirectoryIdentity?.dev !== "bigint" || typeof options.sourceDirectoryIdentity?.ino !== "bigint") throw failure();
    const rootRelative = relative(options.rootDirectory, options.sourceDirectory);
    if (rootRelative !== "" && (rootRelative.includes("/") || rootRelative === ".." || rootRelative.startsWith("../") || !STAGE_DIRECTORY.test(rootRelative))) throw failure();
    const rootHandle = await open(options.rootDirectory, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      const root = await rootHandle.stat({ bigint: true });
      const namedRoot = await lstat(options.rootDirectory, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== options.rootIdentity.dev || root.ino !== options.rootIdentity.ino ||
          root.uid !== BigInt(process.getuid!()) || (root.mode & 0o7777n) !== 0o700n || namedRoot.isSymbolicLink() ||
          namedRoot.dev !== root.dev || namedRoot.ino !== root.ino || await realpath(options.rootDirectory) !== options.rootDirectory) throw failure();
      const sourceDirectory = await lstat(options.sourceDirectory, { bigint: true });
      if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink() || sourceDirectory.dev !== options.sourceDirectoryIdentity.dev ||
          sourceDirectory.ino !== options.sourceDirectoryIdentity.ino || sourceDirectory.uid !== BigInt(process.getuid!()) ||
          (sourceDirectory.mode & 0o7777n) !== 0o700n || await realpath(options.sourceDirectory) !== options.sourceDirectory) throw failure();
      assertIdentity(options.sourceIdentity);
      const destinationArgs = options.destination.kind === "absent" ? ["absent"] : ["identity", ...identityArgs(options.destination.identity)];
      if (options.destination.kind === "identity") assertIdentity(options.destination.identity);
      await runHelper([
        decimal(root.dev), decimal(root.ino), rootRelative === "" ? "." : rootRelative,
        decimal(sourceDirectory.dev), decimal(sourceDirectory.ino), options.sourceName,
        ...identityArgs(options.sourceIdentity), options.destinationName, ...destinationArgs,
      ], rootHandle.fd);
    } finally {
      await rootHandle.close();
    }
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
}
