import assert from 'node:assert/strict';
import {chmod,lstat,mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {UpdateCache} from '../../src/update/cache.ts';
import {activateReleaseSet} from '../../src/update/activation.ts';
import {withUpdateLock} from '../../src/platform/lock.ts';
import {createAuthenticatedReleaseSnapshot,createReleaseSetSnapshotVerifier} from '../../src/update/release-set-verifier.ts';
import {nativeReleaseFixture} from '../helpers/native-release-fixture.ts';
async function clean(root:string){const pending=[root];while(pending.length){const p=pending.pop()!,s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory())continue;await chmod(p,0o700);for(const e of await readdir(p,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink())pending.push(resolve(p,e.name));}await rm(root,{recursive:true,force:true});}
async function fixture(t:test.TestContext){
 const root=await mkdtemp(resolve(await realpath(tmpdir()),'release-staging-'));t.after(()=>clean(root));
 const f=await nativeReleaseFixture();const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 const verifySnapshot=createReleaseSetSnapshotVerifier(f.options),options={stateDirectory:root,verifySnapshot,windowsAclVerifier:{verify:async()=>{}}};
 return{root,f,snapshot,options,cache:new UpdateCache(options)};
}
test('signed staging persists sealed archives but never creates an active pointer',async(t)=>{
 const f=await fixture(t);const staged=await f.cache.stageVerifiedReleaseSet(f.snapshot);
 assert.equal(staged.kind,'staged-release-set');assert.equal('writesBlocked' in staged,false);
 assert.deepEqual(staged.record,f.snapshot.record);assert.deepEqual(await readFile(staged.cliPath),Buffer.from(f.snapshot.cliBytes));
 if(process.platform!=='win32'){assert.equal((await lstat(staged.releaseDirectory)).mode&0o7777,0o500);assert.equal((await lstat(staged.cliPath)).mode&0o7777,0o400);}
 await assert.rejects(readFile(resolve(f.root,'active-release-set.json')),{code:'ENOENT'});
 assert.equal(await f.cache.loadLastKnownGoodOrNull(),null);
});
test('staged signed bytes can be reauthenticated after restart without activation',async(t)=>{
 const f=await fixture(t);await f.cache.stageVerifiedReleaseSet(f.snapshot);
 const reopened=new UpdateCache(f.options);const staged=await reopened.loadStagedReleaseSet(f.snapshot.record);
 assert.ok(staged);assert.equal(staged.kind,'staged-release-set');assert.deepEqual(staged.cliBytes,f.snapshot.cliBytes);
 assert.equal(await reopened.loadLastKnownGoodOrNull(),null);
 const installed=await activateReleaseSet({...f.options,next:f.snapshot});
 assert.deepEqual(installed.record,f.snapshot.record);assert.deepEqual((await reopened.loadLastKnownGoodOrNull())!.record,installed.record);
});
test('newer staged candidate leaves previous active record byte-identical until explicit activation',async(t)=>{
 const f=await fixture(t);await activateReleaseSet({...f.options,next:f.snapshot});
 const pointer=resolve(f.root,'active-release-set.json'),before=await readFile(pointer);
 const next=await createAuthenticatedReleaseSnapshot({...f.f.options,verified:f.f.verify({...f.f.payload,sequence:f.f.payload.sequence+1})});
 await f.cache.stageVerifiedReleaseSet(next);
 assert.deepEqual(await readFile(pointer),before);assert.deepEqual((await f.cache.loadLastKnownGoodOrNull())!.record,f.snapshot.record);
 await activateReleaseSet({...f.options,next});assert.deepEqual((await f.cache.loadLastKnownGoodOrNull())!.record,next.record);
});
test('stage and staged reads reuse only their own branded lock lease',async(t)=>{
 const f=await fixture(t);
 await withUpdateLock(f.root,async lease=>{await f.cache.stageVerifiedReleaseSet(f.snapshot,lease);assert.ok(await f.cache.loadStagedReleaseSet(f.snapshot.record,lease));assert.equal(await f.cache.loadLastKnownGoodOrNull({},lease),null);});
 const other=resolve(f.root,'other');await withUpdateLock(other,async lease=>{await assert.rejects(f.cache.loadStagedReleaseSet(f.snapshot.record,lease));await assert.rejects(f.cache.stageVerifiedReleaseSet(f.snapshot,lease));});
});
test('staging rejects invalid signatures/local hashes and never touches the active pointer',async(t)=>{
 const f=await fixture(t);const forged=structuredClone(f.snapshot);forged.cliBytes[0]=forged.cliBytes[0]!^1;
 await assert.rejects(f.cache.stageVerifiedReleaseSet(forged),{code:'UPDATE_SECURITY_ERROR'});
 const untrusted=new UpdateCache({stateDirectory:f.root,windowsAclVerifier:f.options.windowsAclVerifier});
 await assert.rejects(untrusted.stageVerifiedReleaseSet(f.snapshot),{code:'UPDATE_SECURITY_ERROR'});
 await assert.rejects(readFile(resolve(f.root,'active-release-set.json')),{code:'ENOENT'});
});
test('loading staged files distinguishes missing directories from corrupted or linked entries',async(t)=>{
 const f=await fixture(t);assert.equal(await f.cache.loadStagedReleaseSet(f.snapshot.record),null);
 const staged=await f.cache.stageVerifiedReleaseSet(f.snapshot);
 await chmod(staged.cliPath,0o600);await writeFile(staged.cliPath,'corruption');await chmod(staged.cliPath,0o400);
 await assert.rejects(f.cache.loadStagedReleaseSet(f.snapshot.record),{code:'UPDATE_SECURITY_ERROR'});
 assert.equal(await f.cache.loadLastKnownGoodOrNull(),null);
});
test('staged loading rejects a linked release directory without following or modifying it',async(t)=>{
 if(process.platform==='win32')return t.skip('requires symlink privilege');
 const f=await fixture(t);const staged=await f.cache.stageVerifiedReleaseSet(f.snapshot);
 await chmod(staged.releaseDirectory,0o700);await rm(staged.releaseDirectory,{recursive:true});
 await symlink(f.root,staged.releaseDirectory);
 await assert.rejects(f.cache.loadStagedReleaseSet(f.snapshot.record),{code:'UPDATE_SECURITY_ERROR'});
 assert.equal(await f.cache.loadLastKnownGoodOrNull(),null);
});
test('stage does not use the active-pointer publication boundary, including injected failure',async(t)=>{
 const f=await fixture(t);let activeWrites=0;
 const cache=new UpdateCache({...f.options,faultInjector:{hit(point){if(point==='before-active-replace'){activeWrites++;throw Error('must not write pointer');}}}});
 await cache.stageVerifiedReleaseSet(f.snapshot);assert.equal(activeWrites,0);
 await assert.rejects(cache.commitStagedReleaseSet(f.snapshot.record));assert.equal(activeWrites,1);
 assert.equal(await cache.loadLastKnownGoodOrNull(),null);assert.ok(await cache.loadStagedReleaseSet(f.snapshot.record));
});
test('duplicate staging cannot overwrite an existing immutable release directory',async(t)=>{
 const f=await fixture(t);const staged=await f.cache.stageVerifiedReleaseSet(f.snapshot);const before=await readFile(staged.cliPath);
 await assert.rejects(f.cache.stageVerifiedReleaseSet(f.snapshot),{code:'UPDATE_SECURITY_ERROR'});
 assert.deepEqual(await readFile(staged.cliPath),before);assert.equal(await f.cache.loadLastKnownGoodOrNull(),null);
});
