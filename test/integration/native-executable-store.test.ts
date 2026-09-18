import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fsp from 'node:fs/promises';
import {constants} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {access,chmod,link,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import test from 'node:test';
import {withUpdateLock} from '../../src/platform/lock.ts';
import {createNativeExecutableStore} from '../../src/update/native-executable-store.ts';
import {createAuthenticatedReleaseSnapshot} from '../../src/update/release-set-verifier.ts';
import {nativeReleaseFixture} from '../helpers/native-release-fixture.ts';

async function cleanup(root:string){
 const pending=[root];while(pending.length){const p=pending.pop()!;const stat=await lstat(p);
  if(stat.isSymbolicLink()||!stat.isDirectory())continue;await chmod(p,0o700);
  for(const entry of await readdir(p,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())pending.push(resolve(p,entry.name));
 }await rm(root,{recursive:true,force:true});
}
async function setup(t:any,platform:'darwin-arm64'|'windows-x64'='darwin-arm64'){
 const root=await mkdtemp(resolve(await realpath(tmpdir()),'native-release-'));t.after(()=>cleanup(root));
 const f=await nativeReleaseFixture(platform);const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 const options={stateDirectory:root,platform,trustConfig:f.signed.trustConfig,windowsAclVerifier:{verify:async()=>{}}};
 return{root,f,snapshot,options,store:createNativeExecutableStore(options)};
}
for(const platform of ['darwin-arm64','windows-x64'] as const){
 test(`authenticated ${platform} materialization is sealed, restart-verifiable and does not activate`,async(t)=>{
  const {root,f,snapshot,options,store}=await setup(t,platform);
  const installed=await store.materialize(snapshot);
  assert.equal(installed.path,resolve(root,'native',snapshot.record.cliSha256,platform==='darwin-arm64'?'harness-mrtool':'harness-mrtool.exe'));
  assert.deepEqual(await readFile(installed.path),f.native);
  assert.equal(installed.sha256,createHash('sha256').update(f.native).digest('hex'));
  assert.equal(installed.size,f.native.length);assert.equal(installed.cliVersion,'0.1.6');
  if(process.platform!=='win32'){assert.equal((await lstat(installed.path)).mode&0o777,0o500);assert.equal((await lstat(dirname(installed.path))).mode&0o777,0o500);}
  assert.deepEqual(await store.materialize(snapshot),installed);
  assert.deepEqual(await createNativeExecutableStore(options).verify(snapshot),installed);
  await assert.rejects(access(resolve(root,'active-release-set.json')),{code:'ENOENT'});
  await assert.rejects(access(resolve(root,'releases')),{code:'ENOENT'});
 });
}
test('native materialization rejects forged signed input before writing a native tree',async(t)=>{
 const {root,snapshot,store}=await setup(t);const bad=structuredClone(snapshot);bad.cliBytes[0]=bad.cliBytes[0]!^1;
 await assert.rejects(store.materialize(bad),{code:'UPDATE_SECURITY_ERROR'});
 await assert.rejects(access(resolve(root,'native')),{code:'ENOENT'});
});
test('materialization reuses only the branded lease of its own state directory',async(t)=>{
 const {root,snapshot,store}=await setup(t);
 await withUpdateLock(root,async lease=>{const first=await store.materialize(snapshot,lease);assert.deepEqual(await store.verify(snapshot,lease),first);});
 const elsewhere=await mkdtemp(resolve(await realpath(tmpdir()),'native-other-'));t.after(()=>cleanup(elsewhere));
 await withUpdateLock(elsewhere,async lease=>{await assert.rejects(store.materialize(snapshot,lease));});
});
for(const damage of ['wrong-bytes','hardlink','extra-file','writable-file','special-mode','executable-symlink','directory-symlink'] as const){
 test(`native restart rejects ${damage} without replacing it or touching its target`,async(t)=>{
  if(process.platform==='win32'&&(damage.includes('symlink')||damage==='writable-file'||damage==='special-mode'))return t.skip('POSIX link/mode fixture; real Windows ACL checked by native CI');
  const {root,snapshot,store}=await setup(t);const good=await store.materialize(snapshot);
  await chmod(dirname(good.path),0o700);
  const external=resolve(root,'outside');await writeFile(external,'do not modify',{mode:0o600});
  if(damage==='wrong-bytes'){await chmod(good.path,0o700);await writeFile(good.path,'wrong');await chmod(good.path,0o500);}
  if(damage==='hardlink')await link(good.path,resolve(root,'linked'));
  if(damage==='extra-file')await writeFile(resolve(dirname(good.path),'extra'),'extra');
  if(damage==='writable-file')await chmod(good.path,0o700);
  if(damage==='special-mode')await chmod(good.path,0o4500);
  if(damage==='executable-symlink'){await rm(good.path);await symlink(external,good.path);}
  if(damage==='directory-symlink'){await rm(dirname(good.path),{recursive:true});await symlink(root,dirname(good.path));}
  else await chmod(dirname(good.path),0o500);
  await assert.rejects(store.verify(snapshot),{code:'UPDATE_SECURITY_ERROR'});
  await assert.rejects(store.materialize(snapshot),{code:'UPDATE_SECURITY_ERROR'});
  assert.equal(await readFile(external,'utf8'),'do not modify');
 });
}
test('a linked native root is rejected without changing external directory permissions',async(t)=>{
 if(process.platform==='win32')return t.skip('POSIX symlink fixture');
 const {root,snapshot,store}=await setup(t);const external=resolve(root,'external');await mkdir(external,{mode:0o755});
 // Set the owned fixture's starting permissions explicitly: CI's private
 // umask077 otherwise turns mkdir(mode0755) into0700 before the test begins.
 await chmod(external,0o755);await symlink(external,resolve(root,'native'));
 await assert.rejects(store.materialize(snapshot),{code:'UPDATE_SECURITY_ERROR'});
 assert.equal((await lstat(external)).mode&0o777,0o755);assert.deepEqual(await readdir(external),[]);
});
test('verification never silently creates a missing native executable',async(t)=>{
 const {root,snapshot,store}=await setup(t);await assert.rejects(store.verify(snapshot),{code:'UPDATE_SECURITY_ERROR'});
 await assert.rejects(access(resolve(root,'native')),{code:'ENOENT'});
});


test('an incomplete native publication stays rejected and cannot activate',async(t)=>{
 const {root,snapshot,store}=await setup(t);
 await mkdir(resolve(root,'native'),{mode:0o700});
 const incomplete=resolve(root,'native',snapshot.record.cliSha256);await mkdir(incomplete,{mode:0o700});
 await writeFile(resolve(incomplete,'harness-mrtool'),'interrupted',{mode:0o600});
 await assert.rejects(store.materialize(snapshot),{code:'UPDATE_SECURITY_ERROR'});
 await assert.rejects(access(resolve(root,'active-release-set.json')),{code:'ENOENT'});
 assert.equal(await readFile(resolve(incomplete,'harness-mrtool'),'utf8'),'interrupted');
});


test('native verification rejects a permission change between preliminary stat and open',async(t)=>{
 if(process.platform==='win32')return t.skip('POSIX mode race');
 const {snapshot,store}=await setup(t);const materialized=await store.materialize(snapshot);
 const original=fsp.open;let changed=false;
 try{
  fsp.open=(async(path:any,flags:any,...rest:any[])=>{
   if(String(path)===materialized.path&&flags===(constants.O_RDONLY|constants.O_NOFOLLOW)&&!changed){
    changed=true;await chmod(materialized.path,0o700);
   }
   return (original as any)(path,flags,...rest);
  }) as typeof fsp.open;syncBuiltinESMExports();
  await assert.rejects(store.verify(snapshot),{code:'UPDATE_SECURITY_ERROR'});assert.equal(changed,true);
 }finally{fsp.open=original;syncBuiltinESMExports();}
});

test('native verification rejects permissions changed after reading executable bytes',async(t)=>{
 if(process.platform==='win32')return t.skip('POSIX mode race');
 const {snapshot,store}=await setup(t);const materialized=await store.materialize(snapshot);
 const original=fsp.open;let changed=false;
 try{
  fsp.open=(async(path:any,flags:any,...rest:any[])=>{
   const handle=await (original as any)(path,flags,...rest);
   if(String(path)===materialized.path&&flags===(constants.O_RDONLY|constants.O_NOFOLLOW)){
    const read=handle.read.bind(handle);
    handle.read=async(...args:any[])=>{const result=await read(...args);if(!changed){changed=true;await chmod(materialized.path,0o700);}return result;};
   }
   return handle;
  }) as typeof fsp.open;syncBuiltinESMExports();
  await assert.rejects(store.verify(snapshot),{code:'UPDATE_SECURITY_ERROR'});assert.equal(changed,true);
 }finally{fsp.open=original;syncBuiltinESMExports();}
});


test('native publication rejects a replaced parent without creating anything in its symlink target',async(t)=>{
 if(process.platform==='win32')return t.skip('POSIX parent replacement; native Windows writer has separate handle tests');
 const {snapshot,store,root}=await setup(t);
 const outside=await mkdtemp(resolve(await realpath(tmpdir()),'native-outside-race-'));t.after(()=>cleanup(outside));
 const release=resolve(root,'native',snapshot.record.cliSha256);const executable=resolve(release,'harness-mrtool');
 const original=fsp.open;let redirected=false;
 try{
  fsp.open=(async(path:any,flags:any,...rest:any[])=>{
   if(!redirected&&(String(path)===release||(String(path)===executable&&(Number(flags)&constants.O_CREAT)!==0))){
    redirected=true;await rename(release,release+'.moved');await symlink(outside,release);
   }
   return (original as any)(path,flags,...rest);
  }) as typeof fsp.open;syncBuiltinESMExports();
  await assert.rejects(store.materialize(snapshot),{code:'UPDATE_SECURITY_ERROR'});
  assert.equal(redirected,true);assert.deepEqual(await readdir(outside),[],'no empty file or executable bytes may be created outside the pinned parent');
 }finally{fsp.open=original;syncBuiltinESMExports();}
});


test('native Windows materialization uses the real ACL adapter and write-through helper',async(t)=>{
 if(process.platform!=='win32')return t.skip('requires native Windows');
 const {snapshot,options}=await setup(t,'windows-x64');
 const {windowsAclVerifier:_fixtureAdapter,...realOptions}=options;
 const store=createNativeExecutableStore(realOptions);
 const installed=await store.materialize(snapshot);
 assert.deepEqual(await store.verify(snapshot),installed);
});
