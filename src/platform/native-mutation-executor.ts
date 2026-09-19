import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { samePhysicalPath } from "./windows-path.ts";
import { resolveWindowsPowerShellPath } from "./state-path.ts";

import { ToolError } from "../contracts/errors.ts";

export const MUTATION_SLOT = "transaction" as const;
export const MUTATION_FILENAME = "installation-transaction.json" as const;

const MAX_MUTATION_BYTES = 256 * 1024;
const STARTUP_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
const NOFOLLOW = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const DIRECTORY = (constants as { readonly O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
const MAX_IDENTITY = (1n << 64n) - 1n;

export interface PreparedMutation {
  readonly slot: typeof MUTATION_SLOT;
  readonly operationId: string;
  readonly bytes: Uint8Array;
}

export interface InstallationEpoch {
  readonly attemptId: string;
}

export interface NativeMutationReceipt {
  readonly slot: typeof MUTATION_SLOT;
  readonly operationId: string;
  readonly epochId: string;
  readonly operationSequence: number;
  readonly bytesSha256: string;
}

export interface NativeMutationExecutor {
  readonly epoch: InstallationEpoch;
  reserve(mutation: PreparedMutation): Promise<void>;
  admit(mutation: PreparedMutation): Promise<NativeMutationReceipt>;
  revoke(mutation: PreparedMutation): Promise<void>;
  close(): Promise<void>;
}

interface PreparedState {
  readonly publicValue: PreparedMutation;
  readonly slot: typeof MUTATION_SLOT;
  readonly operationId: string;
  readonly bytes: Uint8Array;
  readonly bytesHex: string;
  readonly bytesSha256: string;
}

interface EpochState {
  readonly publicValue: InstallationEpoch;
  readonly attemptId: string;
  readonly executorToken: object;
  live: boolean;
}

const preparedStates = new WeakMap<object, PreparedState>();
const epochStates = new WeakMap<object, EpochState>();

function securityFailure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Native mutation authority is unavailable", {
    field: "update.nativeMutation",
    expected: "a live native executor with an authenticated fixed-slot protocol",
    actual: "native mutation authority rejected or became unavailable",
    safeNextStep: "Keep the installed release and inspect the private update state before retrying.",
  });
}

function assertAbsoluteNormalizedPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw securityFailure();
  }
}

function assertMutation(value: unknown): PreparedState {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw securityFailure();
  }
  const state = preparedStates.get(value);
  if (state === undefined || state.publicValue !== value) {
    throw securityFailure();
  }
  return state;
}

function assertEpoch(value: unknown, executorToken: object): EpochState {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw securityFailure();
  }
  const state = epochStates.get(value);
  if (state === undefined || state.publicValue !== value || state.executorToken !== executorToken || !state.live) {
    throw securityFailure();
  }
  return state;
}

function createPreparedMutation(bytes: Uint8Array): PreparedMutation {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_MUTATION_BYTES) {
    throw securityFailure();
  }
  let copy: Uint8Array;
  try {
    copy = Uint8Array.from(bytes);
  } catch {
    throw securityFailure();
  }
  const operationId = randomUUID();
  const bytesHex = Buffer.from(copy).toString("hex");
  const bytesSha256 = createHash("sha256").update(copy).digest("hex");
  const state = {} as PreparedState;
  const publicValue = Object.defineProperties(state, {
    slot: {
      configurable: false,
      enumerable: true,
      get(this: object): typeof MUTATION_SLOT {
        return assertMutation(this).slot;
      },
    },
    operationId: {
      configurable: false,
      enumerable: true,
      get(this: object): string {
        return assertMutation(this).operationId;
      },
    },
    bytes: {
      configurable: false,
      enumerable: true,
      get(this: object): Uint8Array {
        return Uint8Array.from(assertMutation(this).bytes);
      },
    },
  }) as unknown as PreparedMutation;
  const finalState: PreparedState = {
    publicValue,
    slot: MUTATION_SLOT,
    operationId,
    bytes: copy,
    bytesHex,
    bytesSha256,
  };
  preparedStates.set(publicValue, finalState);
  Object.freeze(publicValue);
  return publicValue;
}

export function prepareMutation(bytes: Uint8Array): PreparedMutation {
  return createPreparedMutation(bytes);
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

async function validateRoot(directory: string): Promise<{ handle: Awaited<ReturnType<typeof open>>; identity: FileIdentity }> {
  assertAbsoluteNormalizedPath(directory);
  if (NOFOLLOW === 0 || DIRECTORY === 0 || process.getuid === undefined) {
    throw securityFailure();
  }
  const handle = await open(directory, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const descriptor = await handle.stat({ bigint: true });
    const named = await lstat(directory, { bigint: true });
    const physical = await realpath(directory);
    const uid = BigInt(process.getuid());
    if (
      !descriptor.isDirectory() ||
      descriptor.uid !== uid ||
      (Number(descriptor.mode) & 0o7777) !== 0o700 ||
      named.isSymbolicLink() ||
      !named.isDirectory() ||
      named.dev !== descriptor.dev ||
      named.ino !== descriptor.ino ||
      physical !== directory ||
      descriptor.dev < 0n ||
      descriptor.ino < 1n ||
      descriptor.dev > MAX_IDENTITY ||
      descriptor.ino > MAX_IDENTITY
    ) {
      throw securityFailure();
    }
    return { handle, identity: { dev: descriptor.dev, ino: descriptor.ino } };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

const POSIX_NATIVE_EXECUTOR = String.raw`
use strict;
use warnings;
use Config;
use Fcntl qw(:flock O_RDWR O_WRONLY O_CREAT O_EXCL O_NOFOLLOW);
use IO::Handle;
use Digest::SHA qw(sha256_hex);

$Config{d_fchdir} eq 'define' or die 'unsupported';
my ($root_dev, $root_ino, $epoch_id) = @ARGV;
$root_dev =~ /\A([0-9]+)\z/ or die 'root';
$root_ino =~ /\A([0-9]+)\z/ or die 'root';
$epoch_id =~ /\A[0-9a-f-]{36}\z/ or die 'epoch';
$root_dev = 0 + $root_dev;
$root_ino = 0 + $root_ino;
open(my $root, '<&=3') or die 'root-fd';
my @root_stat = stat($root);
@root_stat && -d $root && $root_stat[0] == $root_dev && $root_stat[1] == $root_ino && $root_stat[4] == $< && ($root_stat[2] & 07777) == 0700 or die 'root-identity';
# The pinned directory inode is the stable native fence.  The marker pathname
# below may be unlinked and recreated by a successor, so the marker flock alone
# cannot serialize native executors across that replacement.
flock($root, LOCK_EX) or die 'root-flock';
chdir($root) or die 'fchdir';
my $lock;
if (sysopen($lock, '.update.lock', O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600)) {
  # The child created the lock relative to the already-pinned root descriptor.
} elsif ($!{EEXIST} && sysopen($lock, '.update.lock', O_RDWR | O_NOFOLLOW)) {
  # Existing lock files are reopened without following the final component.
} else {
  die 'lock-open';
}
my @lock_stat = stat($lock);
@lock_stat && -f $lock && $lock_stat[3] == 1 && $lock_stat[4] == $< && ($lock_stat[2] & 07777) == 0600 or die 'lock-identity';
flock($lock, LOCK_EX) or die 'flock';
@root_stat = stat($root);
@root_stat && -d $root && $root_stat[0] == $root_dev && $root_stat[1] == $root_ino && $root_stat[4] == $< && ($root_stat[2] & 07777) == 0700 or die 'root-identity';
@lock_stat = stat($lock);
@lock_stat && -f $lock && $lock_stat[3] == 1 && $lock_stat[4] == $< && ($lock_stat[2] & 07777) == 0600 or die 'lock-identity';
$| = 1;
binmode(STDIN) or die 'stdin';
binmode(STDOUT) or die 'stdout';
print STDOUT "READY\t$epoch_id\n" or die 'ready';
my $reserved;
my $admitted = 0;
sub token { my ($value, $pattern) = @_; defined($value) && $value =~ $pattern }
sub fail { print STDOUT "ERR\tprotocol\n"; exit 31; }
while (my $line = <STDIN>) {
  chomp($line);
  my @parts = split(/\t/, $line, -1);
  my $command = $parts[0] // '';
  if ($command eq 'RESERVE' && @parts == 6) {
    my ($received_epoch, $sequence, $operation, $length, $sha) = @parts[1..5];
    token($received_epoch, qr/\A[0-9a-f-]{36}\z/) && $received_epoch eq $epoch_id or fail();
    token($sequence, qr/\A[1-9][0-9]*\z/) or fail();
    token($operation, qr/\A[0-9a-f-]{36}\z/) or fail();
    token($length, qr/\A[1-9][0-9]*\z/) && $length <= 262144 or fail();
    token($sha, qr/\A[0-9a-f]{64}\z/) or fail();
    defined($reserved) && fail();
    $reserved = { epoch => $received_epoch, sequence => 0 + $sequence, operation => $operation, length => 0 + $length, sha => $sha };
    print STDOUT "OK\tRESERVE\t$sequence\t$operation\n" or die 'response';
    next;
  }
  if ($command eq 'ADMIT' && @parts == 7) {
    my ($received_epoch, $sequence, $operation, $length, $sha, $hex) = @parts[1..6];
    token($received_epoch, qr/\A[0-9a-f-]{36}\z/) && $received_epoch eq $epoch_id or fail();
    token($sequence, qr/\A[1-9][0-9]*\z/) or fail();
    token($operation, qr/\A[0-9a-f-]{36}\z/) or fail();
    token($length, qr/\A[1-9][0-9]*\z/) && $length <= 262144 or fail();
    token($sha, qr/\A[0-9a-f]{64}\z/) or fail();
    token($hex, qr/\A[0-9a-f]*\z/) && length($hex) == 2 * $length or fail();
    defined($reserved) or fail();
    $reserved->{epoch} eq $received_epoch && $reserved->{sequence} == $sequence && $reserved->{operation} eq $operation && $reserved->{length} == $length && $reserved->{sha} eq $sha or fail();
    $admitted == 0 or fail();
    my $bytes = pack('H*', $hex);
    length($bytes) == $length && sha256_hex($bytes) eq $sha or fail();
    chdir($root) or die 'fchdir';
    umask(0077);
    sysopen(my $out, 'installation-transaction.json', O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or die 'create';
    binmode($out) or die 'output';
    my $offset = 0;
    while ($offset < length($bytes)) {
      my $written = syswrite($out, $bytes, length($bytes) - $offset, $offset);
      defined($written) && $written > 0 or die 'write';
      $offset += $written;
    }
    $out->sync or die 'sync';
    my @created = stat($out);
    @created && -f $out && $created[3] == 1 && $created[4] == $< && ($created[2] & 07777) == 0600 && $created[7] == $length or die 'file';
    close($out) or die 'close';
    $root->sync or die 'directory-sync';
    $admitted = 1;
    print STDOUT "OK\tADMIT\t$sequence\t$operation\t$sha\n" or die 'response';
    next;
  }
  if ($command eq 'REVOKE' && @parts == 4) {
    my ($received_epoch, $sequence, $operation) = @parts[1..3];
    token($received_epoch, qr/\A[0-9a-f-]{36}\z/) && $received_epoch eq $epoch_id or fail();
    token($sequence, qr/\A[1-9][0-9]*\z/) or fail();
    token($operation, qr/\A[0-9a-f-]{36}\z/) or fail();
    defined($reserved) && $reserved->{sequence} == $sequence && $reserved->{operation} eq $operation or fail();
    $admitted == 0 or fail();
    undef $reserved;
    print STDOUT "OK\tREVOKE\t$sequence\t$operation\n" or die 'response';
    next;
  }
  if ($command eq 'CLOSE' && @parts == 1) {
    print STDOUT "OK\tCLOSE\n" or die 'response';
    exit 0;
  }
  fail();
}
exit 0;
`;

class LineProtocol {
  private buffer = "";
  private readonly lines: string[] = [];
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private closedError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
        this.buffer = this.buffer.slice(newline + 1);
        const waiter = this.waiters.shift();
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.resolve(line);
        } else {
          this.lines.push(line);
        }
      }
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => this.fail(new Error(`native child closed ${String(code)} ${String(signal)}`)));
  }

  private fail(error: unknown): void {
    if (this.closedError !== undefined) return;
    this.closedError = error instanceof Error ? error : new Error("native child unavailable");
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(this.closedError);
    }
  }

  nextLine(timeoutMs: number): Promise<string> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.closedError !== undefined) return Promise.reject(this.closedError);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolvePromise);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectPromise(new Error("native child response timeout"));
      }, timeoutMs);
      this.waiters.push({ resolve: resolvePromise, reject: rejectPromise, timer });
    });
  }
}

interface CloseObservation {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function closeObservation(child: ChildProcessWithoutNullStreams): Promise<CloseObservation> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

function writeLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => {
      child.stdin.off("error", onError);
      rejectPromise(error);
    };
    child.stdin.once("error", onError);
    child.stdin.write(`${line}\n`, (error) => {
      child.stdin.off("error", onError);
      if (error != null) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function terminateAndObserve(child: ChildProcessWithoutNullStreams, close: Promise<CloseObservation>): Promise<void> {
  child.stdin.destroy();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.race([close.catch(() => undefined), new Promise<void>((resolvePromise) => setTimeout(resolvePromise, CLOSE_TIMEOUT_MS))]);
}

class DarwinNativeMutationExecutor implements NativeMutationExecutor {
  readonly epoch: InstallationEpoch;
  private readonly epochState: EpochState;
  private readonly protocol: LineProtocol;
  private readonly closePromise: Promise<CloseObservation>;
  private commandChain: Promise<unknown> = Promise.resolve();
  private nextSequence = 1;
  private reserved: { readonly mutation: PreparedMutation; readonly sequence: number } | undefined;
  private admitted = false;
  private closeTask: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    epoch: InstallationEpoch,
    epochState: EpochState,
    protocol: LineProtocol,
  ) {
    this.epoch = epoch;
    this.epochState = epochState;
    this.protocol = protocol;
    this.closePromise = closeObservation(child);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandChain.then(operation, operation);
    this.commandChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async request(line: string): Promise<string[]> {
    await writeLine(this.child, line);
    const response = await this.protocol.nextLine(COMMAND_TIMEOUT_MS);
    const fields = response.split("\t");
    if (fields[0] !== "OK") throw securityFailure();
    return fields;
  }

  async reserve(mutation: PreparedMutation): Promise<void> {
    const state = assertMutation(mutation);
    assertEpoch(this.epoch, this.epochState.executorToken);
    return this.enqueue(async () => {
      if (!this.epochState.live || this.closeTask !== undefined || this.reserved !== undefined || this.admitted) throw securityFailure();
      const sequence = this.nextSequence;
      const fields = await this.request(["RESERVE", this.epoch.attemptId, String(sequence), state.operationId, String(state.bytes.length), state.bytesSha256].join("\t"));
      if (fields.length !== 4 || fields[1] !== "RESERVE" || fields[2] !== String(sequence) || fields[3] !== state.operationId) throw securityFailure();
      this.reserved = { mutation, sequence };
      this.nextSequence += 1;
    });
  }

  async admit(mutation: PreparedMutation): Promise<NativeMutationReceipt> {
    const state = assertMutation(mutation);
    assertEpoch(this.epoch, this.epochState.executorToken);
    return this.enqueue(async () => {
      if (!this.epochState.live || this.closeTask !== undefined || this.admitted || this.reserved?.mutation !== mutation) throw securityFailure();
      const sequence = this.reserved.sequence;
      const fields = await this.request(["ADMIT", this.epoch.attemptId, String(sequence), state.operationId, String(state.bytes.length), state.bytesSha256, state.bytesHex].join("\t"));
      if (fields.length !== 5 || fields[1] !== "ADMIT" || fields[2] !== String(sequence) || fields[3] !== state.operationId || fields[4] !== state.bytesSha256) throw securityFailure();
      this.admitted = true;
      return Object.freeze({
        slot: MUTATION_SLOT,
        operationId: state.operationId,
        epochId: this.epoch.attemptId,
        operationSequence: sequence,
        bytesSha256: state.bytesSha256,
      });
    });
  }

  async revoke(mutation: PreparedMutation): Promise<void> {
    const state = assertMutation(mutation);
    assertEpoch(this.epoch, this.epochState.executorToken);
    return this.enqueue(async () => {
      if (!this.epochState.live || this.closeTask !== undefined || this.admitted || this.reserved?.mutation !== mutation) throw securityFailure();
      const sequence = this.reserved.sequence;
      const fields = await this.request(["REVOKE", this.epoch.attemptId, String(sequence), state.operationId].join("\t"));
      if (fields.length !== 4 || fields[1] !== "REVOKE" || fields[2] !== String(sequence) || fields[3] !== state.operationId) throw securityFailure();
      this.reserved = undefined;
    });
  }

  async close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    this.closeTask = this.enqueue(async () => {
      if (!this.epochState.live) return;
      try {
        const fields = await this.request("CLOSE");
        if (fields.length !== 2 || fields[1] !== "CLOSE") throw securityFailure();
        const observed = await Promise.race([
          this.closePromise,
          new Promise<never>((_, rejectPromise) => setTimeout(() => rejectPromise(securityFailure()), CLOSE_TIMEOUT_MS)),
        ]);
        if (observed.code !== 0 || observed.signal !== null) throw securityFailure();
      } catch (error) {
        await terminateAndObserve(this.child, this.closePromise);
        throw error instanceof ToolError ? error : securityFailure();
      } finally {
        this.epochState.live = false;
      }
    }).catch((error) => {
      this.epochState.live = false;
      throw error;
    });
    return this.closeTask;
  }
}

async function startNativeExecutor(
  directory: string,
): Promise<NativeMutationExecutor> {
  const root = await validateRoot(directory);
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClose: Promise<CloseObservation> | undefined;
  try {
    const epochId = randomUUID();
    child = spawn(
      "/usr/bin/perl",
      ["-T", "-e", POSIX_NATIVE_EXECUTOR, root.identity.dev.toString(), root.identity.ino.toString(), epochId],
      {
        shell: false,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe", root.handle.fd],
      },
    ) as ChildProcessWithoutNullStreams;
    childClose = closeObservation(child);
    await root.handle.close();
    child.stderr.resume();
    const protocol = new LineProtocol(child);
    const ready = await protocol.nextLine(STARTUP_TIMEOUT_MS);
    const fields = ready.split("\t");
    if (fields.length !== 2 || fields[0] !== "READY" || fields[1] !== epochId) throw securityFailure();
    const executorToken = {};
    const epochState = {} as EpochState;
    const epoch = Object.defineProperties(epochState, {
      attemptId: {
        configurable: false,
        enumerable: true,
        get(this: object): string {
          return assertEpoch(this, executorToken).attemptId;
        },
      },
    }) as unknown as InstallationEpoch;
    const finalEpochState: EpochState = { publicValue: epoch, attemptId: epochId, executorToken, live: true };
    epochStates.set(epoch, finalEpochState);
    Object.freeze(epoch);
    // The executor installs its own protocol reader; the startup reader has consumed only READY.
    const executor = new DarwinNativeMutationExecutor(child, epoch, finalEpochState, protocol);
    return executor;
  } catch (error) {
    if (child !== undefined) {
      if (child.stdin !== null) child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await childClose?.catch(() => undefined);
    }
    await root.handle?.close().catch(() => undefined);
    throw error instanceof ToolError ? error : securityFailure();
  }
}

const WINDOWS_NATIVE_EXECUTOR = String.raw`
$ErrorActionPreference='Stop'
$root=$env:HMRTOOL_NATIVE_EXECUTOR_ROOT
$epoch=$env:HMRTOOL_NATIVE_EXECUTOR_EPOCH
if([string]::IsNullOrEmpty($root) -or [string]::IsNullOrEmpty($epoch)) { exit 31 }
if([IO.Path]::GetFullPath($root) -ne $root -or $epoch -notmatch '^[0-9a-f-]{36}$') { exit 31 }
$rootInfo=Get-Item -LiteralPath $root -Force
if(!$rootInfo.PSIsContainer -or (($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 31 }
$lockPath=[IO.Path]::Combine($root,'.update.lock')
$targetPath=[IO.Path]::Combine($root,'installation-transaction.json')
$lock=$null
try {
  $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
  $lockInfo=Get-Item -LiteralPath $lockPath -Force
  if($lockInfo.PSIsContainer -or (($lockInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 31 }
  [Console]::Out.WriteLine(('READY' + [char]9 + $epoch)); [Console]::Out.Flush()
  $reserved=$null
  $admitted=$false
  while($true) {
    $line=[Console]::In.ReadLine()
    if($null -eq $line) { exit 31 }
    if($line.Length -gt 600000) { exit 31 }
    $parts=$line.Split([char]9,[StringSplitOptions]::None)
    $command=$parts[0]
    if($command -eq 'RESERVE' -and $parts.Count -eq 6) {
      $receivedEpoch=$parts[1]; $sequence=$parts[2]; $operation=$parts[3]; $length=$parts[4]; $sha=$parts[5]
      if($receivedEpoch -ne $epoch -or $sequence -notmatch '^[1-9][0-9]*$' -or $operation -notmatch '^[0-9a-f-]{36}$' -or $length -notmatch '^[1-9][0-9]*$' -or [int64]$length -gt 262144 -or $sha -notmatch '^[0-9a-f]{64}$' -or $null -ne $reserved -or $admitted) { exit 31 }
      $reserved=@($receivedEpoch,[int64]$sequence,$operation,[int64]$length,$sha)
      [Console]::Out.WriteLine(('OK' + [char]9 + 'RESERVE' + [char]9 + $sequence + [char]9 + $operation)); [Console]::Out.Flush(); continue
    }
    if($command -eq 'ADMIT' -and $parts.Count -eq 7) {
      $receivedEpoch=$parts[1]; $sequence=$parts[2]; $operation=$parts[3]; $length=$parts[4]; $sha=$parts[5]; $hex=$parts[6]
      if($null -eq $reserved -or $admitted -or $receivedEpoch -ne $reserved[0] -or [int64]$sequence -ne $reserved[1] -or $operation -ne $reserved[2] -or [int64]$length -ne $reserved[3] -or $sha -ne $reserved[4] -or $hex -notmatch '^[0-9a-f]*$' -or $hex.Length -ne 2 * [int64]$length) { exit 31 }
      $bytes=New-Object byte[] ([int64]$length)
      for($index=0; $index -lt $bytes.Length; $index++) { $bytes[$index]=[Convert]::ToByte($hex.Substring($index * 2,2),16) }
      $shaProvider=[Security.Cryptography.SHA256]::Create()
      try { $actual=([BitConverter]::ToString($shaProvider.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $shaProvider.Dispose() }
      if($actual -ne $sha -or (Test-Path -LiteralPath $targetPath -PathType Any)) { exit 31 }
      $output=$null
      try {
        $output=[IO.File]::Open($targetPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        $output.Write($bytes,0,$bytes.Length)
        $output.Flush($true)
        $output.Dispose(); $output=$null
      } finally { if($null -ne $output) { $output.Dispose() } }
      $admitted=$true
      [Console]::Out.WriteLine(('OK' + [char]9 + 'ADMIT' + [char]9 + $sequence + [char]9 + $operation + [char]9 + $sha)); [Console]::Out.Flush(); continue
    }
    if($command -eq 'REVOKE' -and $parts.Count -eq 4) {
      $receivedEpoch=$parts[1]; $sequence=$parts[2]; $operation=$parts[3]
      if($null -eq $reserved -or $admitted -or $receivedEpoch -ne $reserved[0] -or [int64]$sequence -ne $reserved[1] -or $operation -ne $reserved[2]) { exit 31 }
      $reserved=$null
      [Console]::Out.WriteLine(('OK' + [char]9 + 'REVOKE' + [char]9 + $sequence + [char]9 + $operation)); [Console]::Out.Flush(); continue
    }
    if($command -eq 'CLOSE' -and $parts.Count -eq 1) {
      $lock.Dispose(); $lock=$null
      [Console]::Out.WriteLine(('OK' + [char]9 + 'CLOSE')); [Console]::Out.Flush(); exit 0
    }
    exit 31
  }
} catch { exit 31 } finally { if($null -ne $lock) { $lock.Dispose() } }
`;

class WindowsNativeMutationExecutor extends DarwinNativeMutationExecutor {}

async function validateWindowsRoot(directory: string): Promise<void> {
  assertAbsoluteNormalizedPath(directory);
  try {
    const descriptor = await lstat(directory, { bigint: true });
    const physical = await realpath(directory);
    if (!descriptor.isDirectory() || descriptor.isSymbolicLink() || !samePhysicalPath(physical, directory)) throw securityFailure();
  } catch (error) {
    throw error instanceof ToolError ? error : securityFailure();
  }
}

async function startWindowsNativeExecutor(directory: string): Promise<NativeMutationExecutor> {
  await validateWindowsRoot(directory);
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClose: Promise<CloseObservation> | undefined;
  try {
    const epochId = randomUUID();
    child = spawn(
      resolveWindowsPowerShellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_NATIVE_EXECUTOR, "utf16le").toString("base64")],
      {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          HMRTOOL_NATIVE_EXECUTOR_ROOT: directory,
          HMRTOOL_NATIVE_EXECUTOR_EPOCH: epochId,
        },
      },
    ) as ChildProcessWithoutNullStreams;
    childClose = closeObservation(child);
    child.stderr.resume();
    const protocol = new LineProtocol(child);
    const ready = await protocol.nextLine(STARTUP_TIMEOUT_MS);
    const fields = ready.split("\t");
    if (fields.length !== 2 || fields[0] !== "READY" || fields[1] !== epochId) throw securityFailure();
    const executorToken = {};
    const epochState = {} as EpochState;
    const epoch = Object.defineProperties(epochState, {
      attemptId: {
        configurable: false,
        enumerable: true,
        get(this: object): string { return assertEpoch(this, executorToken).attemptId; },
      },
    }) as unknown as InstallationEpoch;
    const finalEpochState: EpochState = { publicValue: epoch, attemptId: epochId, executorToken, live: true };
    epochStates.set(epoch, finalEpochState);
    Object.freeze(epoch);
    return new WindowsNativeMutationExecutor(child, epoch, finalEpochState, protocol);
  } catch (error) {
    if (child !== undefined) {
      if (child.stdin !== null) child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await childClose?.catch(() => undefined);
    }
    throw error instanceof ToolError ? error : securityFailure();
  }
}

export async function openNativeMutationExecutor(installationDirectory: string): Promise<NativeMutationExecutor> {
  try {
    if (process.platform === "darwin") return await startNativeExecutor(installationDirectory);
    if (process.platform === "win32") return await startWindowsNativeExecutor(installationDirectory);
    throw securityFailure();
  } catch (error) {
    throw error instanceof ToolError ? error : securityFailure();
  }
}
