import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolError } from '../contracts/errors.ts';
import { resolveWindowsPowerShellPath } from './state-path.ts';

export interface AnchoredFileWriteOptions {
  readonly directory: string;
  readonly expectedIdentity: { readonly dev: bigint; readonly ino: bigint };
  readonly name: 'harness-mrtool' | 'harness-mrtool.exe' | 'harness-mrtool.exe.new' | '.harness-mrtool-install.json' | '.harness-mrtool-install.json.new';
  readonly bytes: Uint8Array;
}

const MAX_BYTES = 256 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 60_000;
const MAX_HELPER_OUTPUT_BYTES = 512;
const MAX_IDENTITY = (1n << 64n) - 1n;
function failure(actual = 'windows-helper:anchored-write'): ToolError<'UPDATE_SECURITY_ERROR'> {
  return new ToolError('UPDATE_SECURITY_ERROR', 'Anchored executable write rejected', {
    field: 'update.executable', expected: 'exclusive bounded creation in the pinned directory',
    actual, safeNextStep: 'Keep the installed release and inspect the incomplete private native directory.',
  });
}

// Inherited fd 3 is the only directory authority. No parent pathname is passed
// to Perl. chdir(FILEHANDLE) uses fchdir; the final fixed name is relative to it.
const POSIX_HELPER = String.raw`
use strict; use warnings; use Config; use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW); use IO::Handle;
$Config{d_fchdir} eq 'define' or die 'unsupported';
my ($dev,$ino,$name,$length)=@ARGV;
$dev =~ /\A([0-9]+)\z/ or die 'identity'; $dev=$1;
$ino =~ /\A([0-9]+)\z/ or die 'identity'; $ino=$1;
$name =~ /\A(harness-mrtool(?:\.exe)?(?:\.new)?|\.harness-mrtool-install\.json(?:\.new)?)\z/ or die 'name'; $name=$1;
$length =~ /\A([0-9]+)\z/ or die 'length'; $length=0+$1;
$length > 0 && $length <= 268435456 or die 'length';
open(my $dir,'<&=3') or die 'descriptor';
my @s=stat($dir);
@s && -d $dir && "$s[0]" eq $dev && "$s[1]" eq $ino && $s[4] == $< && ($s[2]&07777)==0700 or die 'identity';
chdir($dir) or die 'fchdir';
umask(0077); binmode(STDIN) or die 'input';
sysopen(my $out,$name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600) or die 'create';
binmode($out) or die 'output';
my @created=stat($out); @created && -f $out && $created[3]==1 && $created[4]==$< && ($created[2]&07777)==0600 or die 'file';
my $remaining=$length;
while($remaining>0){
 my $buffer=''; my $n=sysread(STDIN,$buffer,$remaining>65536?65536:$remaining);
 defined($n) && $n>0 or die 'truncated';
 my $offset=0;
 while($offset<$n){my $written=syswrite($out,$buffer,$n-$offset,$offset); defined($written) && $written>0 or die 'write'; $offset+=$written;}
 $remaining-=$n;
}
my $extra=''; my $n=sysread(STDIN,$extra,1); defined($n) && $n==0 or die 'extra';
$out->sync or die 'sync';
my @finished=stat($out); @finished && $finished[0]==$created[0] && $finished[1]==$created[1] && $finished[3]==1 && $finished[7]==$length && ($finished[2]&07777)==0600 or die 'file';
close($out) or die 'close'; $dir->sync or die 'directory sync';
print STDOUT "OK\n" or die 'status';
`;

// Windows path opens are safe only while EVERY ancestor is held without
// FILE_SHARE_DELETE. Reparse points are opened themselves and rejected. Keep all
// handles until exclusive creation, streaming and Flush(true) have completed.
const WINDOWS_HELPER = String.raw`
$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AnchoredNativeWriter {
 [StructLayout(LayoutKind.Sequential)] struct Info {
  public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
  public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)]
 static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 static Info Inspect(SafeFileHandle h) {
  Info i; if(h.IsInvalid || !GetFileInformationByHandle(h,out i)) throw new IOException(); return i;
 }
 public static bool Write(string directory,string devText,string inoText,string name,string lengthText) {
  string stage="validate";
  try {
   ulong dev,ino; long length;
   stage="identity-parse";
   if(devText==null || !UInt64.TryParse(devText,out dev) || inoText==null || !UInt64.TryParse(inoText,out ino) || lengthText==null || !Int64.TryParse(lengthText,out length)) throw new IOException();
   stage="input";
   if(length<1 || length>268435456 || (name!="harness-mrtool" && name!="harness-mrtool.exe" && name!="harness-mrtool.exe.new" && name!=".harness-mrtool-install.json" && name!=".harness-mrtool-install.json.new")) throw new IOException();
   stage="path";
   string root=Path.GetPathRoot(directory);
   if(root==null || root.Length!=3 || root[1]!=':' || root[2]!='\\' || !String.Equals(Path.GetFullPath(directory),directory,StringComparison.OrdinalIgnoreCase)) throw new IOException();
   var pins=new List<SafeFileHandle>();
   try {
    stage="pin-ancestors";
    var paths=new List<string>(); paths.Add(root); string current=root;
    foreach(string part in directory.Substring(root.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries)) {
     if(part=="." || part==".." || part.IndexOf(':')>=0 || part.EndsWith(".") || part.EndsWith(" ")) throw new IOException();
     current=Path.Combine(current,part); paths.Add(current);
    }
    Info target=new Info(); ulong volume=0; bool haveVolume=false;
    foreach(string path in paths) {
     var h=CreateFileW(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
     pins.Add(h); target=Inspect(h);
     if((target.Attributes&0x10)==0 || (target.Attributes&0x400)!=0) throw new IOException();
     if(!haveVolume) { volume=target.Volume; haveVolume=true; }
     else if(target.Volume!=volume) throw new IOException();
    }
    ulong index=((ulong)target.IndexHigh<<32)|target.IndexLow;
    // libuv's Windows st_dev is not the kernel volume serial on every
    // supported runner (and may be zero). Pin the volume from the held
    // ancestor handles instead, then compare the final directory's file
    // index to the identity captured by Node.
    if(index!=ino || !haveVolume) throw new IOException();
    stage="exclusive-create";
    using(var h=CreateFileW(Path.Combine(directory,name),0x40000000,0,IntPtr.Zero,1,0x80200000,IntPtr.Zero)) {
     Info created=Inspect(h);
     if((created.Attributes&(0x10|0x400))!=0 || created.Links!=1) throw new IOException();
     stage="stream-and-flush";
     using(var output=new FileStream(h,FileAccess.Write,65536,false)) {
      var input=Console.OpenStandardInput(); var buffer=new byte[65536]; long remaining=length;
      while(remaining>0) {int count=input.Read(buffer,0,(int)Math.Min(buffer.Length,remaining)); if(count<=0) throw new IOException(); output.Write(buffer,0,count); remaining-=count;}
      if(input.ReadByte()!=-1) throw new IOException(); output.Flush(true);
      Info finished=Inspect(h);
      if(finished.Links!=1 || (((ulong)finished.SizeHigh<<32)|finished.SizeLow)!=(ulong)length) throw new IOException();
     }
    }
    stage="complete";
    return true;
   } finally {for(int i=pins.Count-1;i>=0;i--) pins[i].Dispose();}
  } catch {
   try { Console.Out.Write("ERR:"+stage+"\n"); } catch {}
   return false;
  }
 }
}
'@ | Out-Null
} catch { [Console]::Out.Write("ERR:add-type"+[char]10); exit 1 }
try {
  $ok = [AnchoredNativeWriter]::Write($env:HMR_ANCHOR_DIRECTORY,$env:HMR_ANCHOR_DEV,$env:HMR_ANCHOR_INO,$env:HMR_ANCHOR_NAME,$env:HMR_ANCHOR_LENGTH)
} catch { [Console]::Out.Write("ERR:invoke"+[char]10); exit 1 }
if (-not $ok) { exit 1 }
[Console]::Out.Write("OK"+[char]10)
exit 0
`;

async function runHelper(executable: string, args: string[], env: NodeJS.ProcessEnv, bytes: Uint8Array, fd?: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let failed = false;
    let output = '';
    let failureDiagnostic: string | undefined;
    const timer = setTimeout(() => abort('timeout'), HELPER_TIMEOUT_MS);
    function settle(ok: boolean) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (ok) done();
      else {
        const diagnostic = /^ERR:[a-z-]{1,32}$/u.exec(output.trim())?.[0];
        reject(failure(failureDiagnostic ?? (diagnostic === undefined ? 'windows-helper:unavailable' : `windows-helper:${diagnostic.slice(4)}`)));
      }
    }
    function abort(stage: string = 'unavailable') {
      if (settled || failed) return;
      failed = true; failureDiagnostic = `windows-helper:${stage}`; clearTimeout(timer);
      child?.stdin?.destroy(); child?.stdout?.destroy();
      child?.kill('SIGKILL');
      // A kill request does not prove the writer has stopped. Only `close`
      // settles a spawned helper, including timeout/error paths. In particular
      // never add a grace-period rejection while the process can still write.
    }
    try {
      child = spawn(executable, args, {
        shell: false, windowsHide: true, env,
        stdio: fd === undefined ? ['pipe', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore', fd],
      });
      child.once('error', () => abort('spawn'));
      child.stdin!.on('error', () => abort('stream'));
      child.stdout!.on('error', () => abort('stream'));
      child.stdout!.on('data', (chunk: Buffer) => {
        if (failed || settled) return;
        if (chunk.length > MAX_HELPER_OUTPUT_BYTES - output.length) { abort('output'); return; }
        output += chunk.toString('ascii');
      });
      child.once('close', code => settle(!failed && code === 0 && output === 'OK\n'));
      child.stdin!.end(bytes);
    } catch {
      if (child === undefined) settle(false);
      else abort('spawn');
    }
  });
}

/**
 * Exclusive creation against a pinned directory identity. Never seals, replaces,
 * installs or executes the file. Failures can leave an incomplete file in the
 * pinned directory; deliberately do not unlink through a potentially raced path.
 * POSIX requires a current-user 0700 directory; Windows inherits its parent's ACL.
 */
export async function writeAnchoredFile(options: AnchoredFileWriteOptions): Promise<void> {
  try {
    const directory = options.directory, name = options.name;
    const { dev, ino } = options.expectedIdentity;
    if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory || directory.includes('\0') ||
        (name !== 'harness-mrtool' && name !== 'harness-mrtool.exe' && name !== 'harness-mrtool.exe.new' && name !== '.harness-mrtool-install.json' && name !== '.harness-mrtool-install.json.new') ||
        typeof dev !== 'bigint' || typeof ino !== 'bigint' || dev < 0n || ino < 1n || dev > MAX_IDENTITY || ino > MAX_IDENTITY ||
        !(options.bytes instanceof Uint8Array) || options.bytes.length < 1 || options.bytes.length > MAX_BYTES) throw failure();
    const bytes = Uint8Array.from(options.bytes);
    if (process.platform === 'win32') {
      // UNC/device namespaces are not supported by this narrowly scoped writer.
      if (!/^[A-Za-z]:\\/u.test(directory) || directory.includes('/') || directory.length > 240) throw failure();
      const executable = resolveWindowsPowerShellPath();
      const systemRoot = win32.dirname(win32.dirname(win32.dirname(win32.dirname(executable))));
      await runHelper(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_HELPER, 'utf16le').toString('base64')], {
        SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, 'System32'), TEMP: tmpdir(), TMP: tmpdir(),
        HMR_ANCHOR_DIRECTORY: directory, HMR_ANCHOR_DEV: String(dev), HMR_ANCHOR_INO: String(ino), HMR_ANCHOR_NAME: name, HMR_ANCHOR_LENGTH: String(bytes.length),
      }, bytes);
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      const handle = await open(directory, flags);
      try {
        const stat = await handle.stat({ bigint: true });
        const named = await lstat(directory, { bigint: true });
        if (!stat.isDirectory() || stat.dev !== dev || stat.ino !== ino || stat.uid !== BigInt(process.getuid!()) ||
            (Number(stat.mode) & 0o7777) !== 0o700 || named.isSymbolicLink() || named.dev !== dev || named.ino !== ino ||
            await realpath(directory) !== directory) throw failure();
        await runHelper('/usr/bin/perl', ['-T', '-e', POSIX_HELPER, String(dev), String(ino), name, String(bytes.length)], { PATH: '/usr/bin:/bin' }, bytes, handle.fd);
      } finally { await handle.close(); }
    } else throw failure();
  } catch (error) { throw error instanceof ToolError ? error : failure(); }
}
