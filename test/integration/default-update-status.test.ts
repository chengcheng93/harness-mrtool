import assert from 'node:assert/strict';
import {chmod,lstat,mkdtemp,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {runProductionMain} from '../../src/production-main.ts';
import {activateReleaseSet} from '../../src/update/activation.ts';
import {createAuthenticatedReleaseSnapshot,createReleaseSetSnapshotVerifier} from '../../src/update/release-set-verifier.ts';
import {nativeReleaseFixture} from '../helpers/native-release-fixture.ts';
async function cleanup(root:string){
 const pending=[root];while(pending.length){const p=pending.pop()!;const s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory())continue;
  await chmod(p,0o700);for(const e of await readdir(p,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink())pending.push(resolve(p,e.name));
 }await rm(root,{recursive:true,force:true});
}
test('default status authenticates its configured cache without claiming the cached binary is installed or executed',async(t)=>{
 const root=await mkdtemp(resolve(await realpath(tmpdir()),'production-status-'));t.after(()=>cleanup(root));
 const stateDirectory=resolve(root,'selected');const f=await nativeReleaseFixture('darwin-arm64');
 const newer={...f.payload,components:{...f.payload.components,cli:{...f.payload.components.cli,version:'0.1.7',tag:'cli-v0.1.7'}},
  releaseSet:{...f.payload.releaseSet,id:'stable-0.1.7',cli:'0.1.7'}};
 const snapshot=await createAuthenticatedReleaseSnapshot({...f.options,verified:f.verify(newer)});
 await activateReleaseSet({stateDirectory,next:snapshot,verifySnapshot:createReleaseSetSnapshotVerifier(f.options),windowsAclVerifier:{verify:async()=>{}}});
 const oldXdg=process.env.XDG_STATE_HOME,oldLocal=process.env.LOCALAPPDATA;
 process.env.XDG_STATE_HOME=resolve(root,'fallback');process.env.LOCALAPPDATA=resolve(root,'fallback');
 let stdout='',stderr='';let requests=0;
 try{
  const defaults={stateDirectory,trustConfig:f.signed.trustConfig,platform:'darwin-arm64' as const,windowsAclVerifier:{verify:async()=>{}},
   transport:{async request(){requests++;throw Error('status must not use network');}}};
  const code=await runProductionMain(['self-update','status','--offline','--output','json'],{updateChannelDefaults:defaults,
   stdout:{write:s=>{stdout+=s;return true;}},stderr:{write:s=>{stderr+=s;return true;}}});
  assert.equal(code,0,stdout+stderr);const result=JSON.parse(stdout);
  assert.equal(result.data.releaseSetId,snapshot.record.releaseSetId);
  assert.equal(result.data.cliVersion,snapshot.record.cliVersion);
  assert.equal(result.update.executedVersion,'0.1.6');
  assert.equal(result.update.installedVersion,'unknown','signed cache data alone is not a native installation receipt');
  assert.equal(result.data.installationConfirmed,false);
  assert.equal(result.update.latestVersionConfirmed,false);assert.equal(requests,0);assert.equal(stderr,'');
 }finally{
  if(oldXdg===undefined)delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=oldXdg;
  if(oldLocal===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=oldLocal;
 }
});

test('default status rejects a signed cache from a different pinned root rather than reporting ready',async(t)=>{
 const root=await mkdtemp(resolve(await realpath(tmpdir()),'production-status-root-'));t.after(()=>cleanup(root));
 const f=await nativeReleaseFixture('darwin-arm64'),other=await nativeReleaseFixture('darwin-arm64');
 const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 await activateReleaseSet({stateDirectory:root,next:snapshot,verifySnapshot:createReleaseSetSnapshotVerifier(f.options),windowsAclVerifier:{verify:async()=>{}}});
 let stdout='';
 const defaults={stateDirectory:root,trustConfig:other.signed.trustConfig,platform:'darwin-arm64' as const,windowsAclVerifier:{verify:async()=>{}}};
 const code=await runProductionMain(['self-update','status','--offline','--output','json'],{updateChannelDefaults:defaults,
  stdout:{write:s=>{stdout+=s;return true;}},stderr:{write:()=>true}});
 assert.notEqual(code,0);assert.equal(JSON.parse(stdout).code,'UPDATE_SECURITY_ERROR');
 assert.equal(JSON.parse(stdout).ok,false);
});
