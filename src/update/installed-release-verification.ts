import {createHash} from 'node:crypto';
import {constants, type BigIntStats} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {samePhysicalPath} from '../platform/windows-path.ts';
import {ToolError} from '../contracts/errors.ts';
import {parseStrictJson} from '../input/strict-json.ts';
import {assertUpdateLockLease,withUpdateLock} from '../platform/lock.ts';
import type {ProcessLockLease} from '../platform/process-lock.ts';
import {validateReleaseSetSnapshot,type ReleaseSetSnapshot} from './cache.ts';
import {authenticateReleaseSnapshot,type ReleaseSnapshotOptions} from './release-set-verifier.ts';

export interface InstalledReleaseVerificationOptions extends ReleaseSnapshotOptions {
 readonly installationDirectory:string;
 readonly stateDirectory:string;
}
/** A point-in-time signed byte observation, not permission to replace or run it. */
export interface InstalledReleaseObservation {
 readonly verification:'signed-installed-bytes';
 readonly executablePath:string;
 readonly executableSha256:string;
 readonly cliVersion:string;
 readonly releaseSetId:string;
 readonly channelPayloadSha256:string;
 readonly executableIdentity:{readonly dev:string;readonly ino:string;readonly size:string;readonly mtimeNs:string;readonly ctimeNs:string};
}
const MAX_MARKER_BYTES=8192;
const FLAGS=constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0);
const MARKER='.harness-mrtool-install.json';
function fail():never {throw new ToolError('UPDATE_SECURITY_ERROR','Installed release verification failed',{
 field:'update.installation',expected:'a plain managed executable matching the authenticated release archive',
 actual:'installation evidence rejected',safeNextStep:'Keep the last-known-good release and repair the managed installation before updating.'});}
function samePath(a:string,b:string){return samePhysicalPath(a,b);}
function same(a:BigIntStats,b:BigIntStats){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.nlink===b.nlink&&(process.platform==='win32'||(a.mode===b.mode&&a.uid===b.uid&&a.gid===b.gid&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs));}
function privateOwner(s:BigIntStats){return process.platform==='win32'||(s.uid===BigInt(process.getuid!())&&(Number(s.mode)&0o7022)===0);}
function plain(s:BigIntStats,directory:boolean){return !s.isSymbolicLink()&&(directory?s.isDirectory():s.isFile()&&s.nlink===1n)&&privateOwner(s);}
function absolute(path:string){if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||path.includes('\0'))fail();return path;}
async function ancestors(path:string){
 let at=path;
 for(;;){
  const info=await lstat(at,{bigint:true});
  // Ancestors may be system-owned (for example /Users or /private/var),
  // but must be real directories with no writable group/other bits and no
  // symlink/reparse substitution. The manager-owned root is checked separately.
  if(!info.isDirectory()||info.isSymbolicLink()||!samePath(await realpath(at),at)||
    (process.platform!=='win32'&&(Number(info.mode)&0o002)!==0&&(Number(info.mode)&0o1000)===0))fail();
  const parent=dirname(at);if(parent===at)break;at=parent;
 }
}
async function directory(path:string){
 const before=await lstat(path,{bigint:true});const physical=await realpath(path);const after=await lstat(path,{bigint:true});
 if(!plain(before,true)||!plain(after,true)||!same(before,after)||!samePath(physical,path))fail();return after;
}
async function pinnedFile(path:string,maximum:number,executable:boolean){
 const before=await lstat(path,{bigint:true});
 if(!plain(before,false)||before.size<1n||before.size>BigInt(maximum)||!samePath(await realpath(path),path)||
  (executable&&process.platform!=='win32'&&(Number(before.mode)&0o100)===0))fail();
 const handle=await open(path,FLAGS);
 try{
  const opened=await handle.stat({bigint:true});
  if(!plain(opened,false)||!same(before,opened))fail();
  return{handle,identity:opened,path};
 }catch(e){await handle.close();throw e;}
}
async function unchanged(file:Awaited<ReturnType<typeof pinnedFile>>){
 const actual=await file.handle.stat({bigint:true});const named=await lstat(file.path,{bigint:true});
 if(!plain(actual,false)||!plain(named,false)||!same(file.identity,actual)||!same(file.identity,named)||!samePath(await realpath(file.path),file.path))fail();
}
async function digest(file:Awaited<ReturnType<typeof pinnedFile>>){
 const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(65536,Number(file.identity.size)));let offset=0;
 while(offset<Number(file.identity.size)){const read=await file.handle.read(buffer,0,Math.min(buffer.length,Number(file.identity.size)-offset),offset);if(read.bytesRead===0)fail();hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;}
 await unchanged(file);return hash.digest('hex');
}

/**
 * Authenticates the real canonical file against a signed snapshot and the existing
 * versioned-installer marker. Marker hashes alone are NEVER trust. No subprocess,
 * native file/marker mutation, cache activation or latest-policy grant occurs.
 * POSIX checks owner/mode; Windows checks identity/reparse/link/content only.
 * A Windows writer must separately enforce native ACLs before any mutation.
 */
export async function verifyInstalledRelease(snapshot:ReleaseSetSnapshot,input:InstalledReleaseVerificationOptions,lease?:ProcessLockLease):Promise<InstalledReleaseObservation>{
 try{
  const options={...input};const root=absolute(options.installationDirectory),state=absolute(options.stateDirectory);
  if(dirname(root)===root)fail();
  if(lease!==undefined)assertUpdateLockLease(lease,state);
  if(snapshot===null||typeof snapshot!=='object')fail();
  for(const key of ['record','cliBytes','templateBytes','receiptBytes']){const descriptor=Object.getOwnPropertyDescriptor(snapshot,key);if(!descriptor||!('value' in descriptor))fail();}
  const owned=validateReleaseSetSnapshot({record:snapshot.record,cliBytes:snapshot.cliBytes,templateBytes:snapshot.templateBytes,receiptBytes:snapshot.receiptBytes});
  const authenticated=await authenticateReleaseSnapshot(owned,options);
  const expectedHash=createHash('sha256').update(authenticated.executableBytes).digest('hex');
  const manifest=authenticated.verified.manifest;
  const work=async(held:ProcessLockLease):Promise<InstalledReleaseObservation>=>{
   assertUpdateLockLease(held,state);await ancestors(root);const rootIdentity=await directory(root);
   const executablePath=resolve(root,authenticated.executableName);
   const marker=await pinnedFile(resolve(root,MARKER),MAX_MARKER_BYTES,false);
   let executable:Awaited<ReturnType<typeof pinnedFile>>|undefined;
   try{
    const markerBytes=Buffer.alloc(Number(marker.identity.size));let position=0;
    while(position<markerBytes.length){const r=await marker.handle.read(markerBytes,position,markerBytes.length-position,position);if(r.bytesRead===0)fail();position+=r.bytesRead;}
    const value=parseStrictJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(markerBytes));
    if(value===null||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).sort().join(',')!=='archiveSha256,executableSha256,repository,schemaVersion,tag'||
     value.schemaVersion!==1||value.repository!==`${manifest.repository.owner}/${manifest.repository.name}`||
     value.tag!==manifest.components.cli.tag||value.archiveSha256!==owned.record.cliSha256||value.executableSha256!==expectedHash)fail();
    executable=await pinnedFile(executablePath,authenticated.executableBytes.length,true);
    if(executable.identity.size!==BigInt(authenticated.executableBytes.length)||await digest(executable)!==expectedHash)fail();
    await unchanged(marker);await unchanged(executable);await ancestors(root);
    if(!same(rootIdentity,await directory(root)))fail();held.assertHeld();
    const s=executable.identity;
    return Object.freeze({verification:'signed-installed-bytes',executablePath,executableSha256:expectedHash,
     cliVersion:manifest.components.cli.version,releaseSetId:manifest.releaseSet.id,channelPayloadSha256:authenticated.verified.payloadSha256,
     executableIdentity:Object.freeze({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)})});
   }finally{await executable?.handle.close();await marker.handle.close();}
  };
  return lease===undefined?await withUpdateLock(state,work):await work(lease);
 }catch{return fail();}
}
