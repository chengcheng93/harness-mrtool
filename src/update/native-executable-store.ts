import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,mkdir,open,opendir,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {samePhysicalPath} from '../platform/windows-path.ts';
import {ToolError} from '../contracts/errors.ts';
import {assertUpdateLockLease,withUpdateLock} from '../platform/lock.ts';
import {writeAnchoredFile} from '../platform/anchored-file-writer.ts';
import type {ProcessLockLease} from '../platform/process-lock.ts';
import {ensurePrivateStateDirectory,systemWindowsAclVerifier,type WindowsAclVerifier} from '../platform/state-path.ts';
import type {ReleaseSetSnapshot} from './cache.ts';
import {authenticateReleaseSnapshot,type ReleaseSnapshotOptions} from './release-set-verifier.ts';

export interface NativeExecutableStoreOptions extends ReleaseSnapshotOptions {
 readonly stateDirectory:string;
 readonly windowsAclVerifier?:WindowsAclVerifier;
}
export interface MaterializedNativeExecutable {
 readonly path:string;
 readonly sha256:string;
 readonly size:number;
 readonly cliVersion:string;
 readonly releaseSetId:string;
}
const READ_FLAGS=constants.O_RDONLY|((constants as {O_NOFOLLOW?:number}).O_NOFOLLOW??0);
function fail(actual='native-store:operation'):never{throw new ToolError('UPDATE_SECURITY_ERROR','Native executable materialization is unsafe',{
 field:'update.executable',expected:'a private, sealed executable matching authenticated release bytes',actual,
 safeNextStep:'Keep the installed release; inspect the private native staging directory before retrying.'});}
function same(a:BigIntStats,b:BigIntStats){return a.dev===b.dev&&a.ino===b.ino;}
function pathEqual(a:string,b:string){return samePhysicalPath(a,b);}
function sealedFile(stat:BigIntStats,size:number){return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&owned(stat)&&stat.size===BigInt(size)&&(process.platform==='win32'||(Number(stat.mode)&0o7777)===0o500);}
function owned(stat:BigIntStats){return process.platform==='win32'||stat.uid===BigInt(process.getuid!());}
async function directory(path:string,mode:number):Promise<BigIntStats>{
 const before=await lstat(path,{bigint:true});const physical=await realpath(path);const after=await lstat(path,{bigint:true});
 if(!before.isDirectory()||before.isSymbolicLink()||!after.isDirectory()||after.isSymbolicLink()||!same(before,after)||
  !owned(after)||!pathEqual(physical,path)||(process.platform!=='win32'&&(Number(after.mode)&0o7777)!==mode))fail();
 return after;
}
async function flushDirectory(path:string){
 if(process.platform==='win32')return; // Native Windows file handles are flushed separately.
 const handle=await open(path,READ_FLAGS);try{await handle.sync();}finally{await handle.close();}
}

/**
 * Authenticated bytes -> private executable file, never an active installation.
 * Callers must enforce current policy and reverify under the same branded lease
 * immediately before a future handoff; this module never spawns a process.
 */
export function createNativeExecutableStore(input:NativeExecutableStoreOptions){
 const options={...input};const root=options.stateDirectory;
 if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root)fail();
 const nativeRoot=resolve(root,'native');
 const acl=options.windowsAclVerifier??systemWindowsAclVerifier;
 async function underLock<T>(lease:ProcessLockLease|undefined,fn:(held:ProcessLockLease)=>Promise<T>):Promise<T>{
  if(lease!==undefined){assertUpdateLockLease(lease,root);return fn(lease);}
  return withUpdateLock(root,fn);
 }
 async function operation(snapshot:ReleaseSetSnapshot,create:boolean,lease?:ProcessLockLease):Promise<MaterializedNativeExecutable>{
  // Authentication also copies caller-owned archive/provenance buffers. Never
  // read the caller's mutable record after this asynchronous boundary.
  const authenticated=await authenticateReleaseSnapshot(snapshot,options);
  const artifact=authenticated.verified.manifest.components.cli.artifacts[options.platform];if(artifact===undefined)fail();
  const bytes=authenticated.executableBytes;const digest=createHash('sha256').update(bytes).digest('hex');
  const releaseDirectory=resolve(nativeRoot,artifact.sha256);const executablePath=resolve(releaseDirectory,authenticated.executableName);
  const result=Object.freeze({path:executablePath,sha256:digest,size:bytes.length,
   cliVersion:authenticated.verified.manifest.components.cli.version,releaseSetId:authenticated.verified.manifest.releaseSet.id});
  return underLock(lease,async held=>{
   held.assertHeld();
   // The lock checked all ancestors before private-directory preparation.
   if(create)await ensurePrivateStateDirectory(root,{windowsAclVerifier:acl});
   const rootIdentity=await directory(root,0o700);
   if(create){try{await mkdir(nativeRoot,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
   const nativeIdentity=await directory(nativeRoot,0o700);
   if(process.platform==='win32')await acl.verify(nativeRoot);
   async function stableParents(){
    held.assertHeld();
    if(!same(rootIdentity,await directory(root,0o700))||!same(nativeIdentity,await directory(nativeRoot,0o700)))fail();
   }
   let created=false;
   if(create){await stableParents();try{await mkdir(releaseDirectory,{mode:0o700});created=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
   if(created){
    // Exclusive directory creation is the no-replace boundary. A crash leaves
    // an unsealed incomplete directory which is rejected, never auto-executed.
    const identity=await directory(releaseDirectory,0o700);
    if(process.platform==='win32')await acl.verify(releaseDirectory);
    await stableParents();
    // The helper writes relative to an inherited directory descriptor on
    // POSIX, or deletion-pinned ancestor handles on Windows. O_NOFOLLOW on
    // an absolute final filename alone would not protect parent components.
    await writeAnchoredFile({directory:releaseDirectory,expectedIdentity:{dev:identity.dev,ino:identity.ino},
     name:authenticated.executableName as 'harness-mrtool'|'harness-mrtool.exe',bytes});
    if(!same(identity,await directory(releaseDirectory,0o700)))fail();await stableParents();
    const file=await open(executablePath,READ_FLAGS);
    try{
     const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||!owned(before)||before.size!==BigInt(bytes.length))fail();
     const named=await lstat(executablePath,{bigint:true});if(named.isSymbolicLink()||!same(before,named)||named.nlink!==1n)fail();
     if(!same(identity,await directory(releaseDirectory,0o700)))fail();await stableParents();
     if(process.platform!=='win32')await file.chmod(0o500);else await acl.verify(executablePath);
     // Windows content durability was already established by the writer's
     // write-capable handle. FlushFileBuffers requires GENERIC_WRITE.
     if(process.platform!=='win32')await file.sync();
    }finally{await file.close();}
    if(process.platform!=='win32'){
     const dir=await open(releaseDirectory,READ_FLAGS);
     try{if(!same(identity,await dir.stat({bigint:true}))||!same(identity,await directory(releaseDirectory,0o700)))fail();await dir.chmod(0o500);await dir.sync();}
     finally{await dir.close();}
    }
    await flushDirectory(nativeRoot);
   }
   await stableParents();const releaseIdentity=await directory(releaseDirectory,0o500);
   if(process.platform==='win32')await acl.verify(releaseDirectory);
   // Bounded exact contents; never read arbitrary entries or follow links.
   let entryCount=0;
   const entries=await opendir(releaseDirectory);
   for await(const entry of entries){
    if(++entryCount!==1||entry.name!==authenticated.executableName||!entry.isFile()||entry.isSymbolicLink())fail();
   }
   if(entryCount!==1)fail();
   if(process.platform==='win32')await acl.verify(executablePath);
   const before=await lstat(executablePath,{bigint:true});
   if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||!owned(before)||before.size!==BigInt(bytes.length)||
    !pathEqual(await realpath(executablePath),executablePath)||(process.platform!=='win32'&&(Number(before.mode)&0o7777)!==0o500))fail();
   const file=await open(executablePath,READ_FLAGS);
   try{
    const opened=await file.stat({bigint:true});if(!same(before,opened)||!sealedFile(opened,bytes.length)||opened.mode!==before.mode||opened.ctimeNs!==before.ctimeNs)fail();
    const hash=createHash('sha256');const buffer=Buffer.alloc(Math.min(64*1024,bytes.length));let offset=0;
    while(offset<bytes.length){const read=await file.read(buffer,0,Math.min(buffer.length,bytes.length-offset),offset);if(read.bytesRead===0)fail();hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;}
    const after=await file.stat({bigint:true});const named=await lstat(executablePath,{bigint:true});
    if(hash.digest('hex')!==digest||!same(opened,after)||!same(opened,named)||!sealedFile(after,bytes.length)||!sealedFile(named,bytes.length)||
     after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||named.mode!==after.mode)fail();
   }finally{await file.close();}
   if(!same(releaseIdentity,await directory(releaseDirectory,0o500)))fail();await stableParents();return result;
  });
 }
 async function safely(snapshot:ReleaseSetSnapshot,create:boolean,lease?:ProcessLockLease){
  try{return await operation(snapshot,create,lease);}catch(error){if(error instanceof ToolError)throw error;return fail();}
 }
 return Object.freeze({materialize:(snapshot:ReleaseSetSnapshot,lease?:ProcessLockLease)=>safely(snapshot,true,lease),
  verify:(snapshot:ReleaseSetSnapshot,lease?:ProcessLockLease)=>safely(snapshot,false,lease)});
}
