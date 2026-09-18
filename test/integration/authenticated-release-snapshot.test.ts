import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,lstat,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {canonicalizeJson} from '../../src/contracts/jcs.ts';
import {verifyChannelEnvelope} from '../../src/update/manifest.ts';
import {UpdateCache} from '../../src/update/cache.ts';
import {activateReleaseSet,recoverReleaseSet} from '../../src/update/activation.ts';
import {createAuthenticatedReleaseSnapshot,authenticateReleaseSnapshot,createReleaseSetSnapshotVerifier} from '../../src/update/release-set-verifier.ts';
import {nativeReleaseFixture as fixture} from '../helpers/native-release-fixture.ts';
import {canonicalPayload,signedEnvelope} from '../helpers/signing.ts';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const platform='darwin-arm64' as const;


test('signed release archives become deterministic, restart-verifiable cache snapshots',async()=>{
 const f=await fixture();const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 const again=await createAuthenticatedReleaseSnapshot(f.options);assert.deepEqual(snapshot.record,again.record);
 const copy=structuredClone(snapshot); // No weak-set brands survive this boundary.
 const authenticated=await authenticateReleaseSnapshot(copy,{platform,trustConfig:f.signed.trustConfig});
 assert.equal(authenticated.verified.manifest.components.cli.version,'0.1.6');
 assert.equal(authenticated.bundle.manifest.version,'1.1.0');
 assert.equal(authenticated.executableName,'harness-mrtool');
 assert.deepEqual(Buffer.from(authenticated.executableBytes),f.native);
});

test('real activation/cache recovery re-verifies signed provenance after restart',async(t)=>{
 const f=await fixture();const root=await mkdtemp(resolve(await realpath(tmpdir()),'release-snapshot-'));
 t.after(async()=>{
  // Test teardown only: release directories are deliberately sealed by cache.
  const pending=[root];while(pending.length){const path=pending.pop()!;const info=await lstat(path);
   if(info.isSymbolicLink()||!info.isDirectory())continue;await chmod(path,0o700);
   for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())pending.push(resolve(path,entry.name));
  }
  await rm(root,{recursive:true,force:true});
 });const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 const options={platform,trustConfig:f.signed.trustConfig};const acl={verify:async()=>{}};
 const stored=await activateReleaseSet({stateDirectory:root,next:snapshot,verifySnapshot:createReleaseSetSnapshotVerifier(options),windowsAclVerifier:acl});
 assert.equal(stored.record.cliVersion,'0.1.6');
 const loaded=await recoverReleaseSet(root,{verifySnapshot:createReleaseSetSnapshotVerifier(options),windowsAclVerifier:acl});
 assert.deepEqual(loaded?.record,snapshot.record);
 // Cache remains data, not an executable installer. Installation/handoff comes later.
 assert.deepEqual(Buffer.from(loaded!.cliBytes),Buffer.from(f.options.cliArchive));
 const replay=await activateReleaseSet({stateDirectory:root,next:await createAuthenticatedReleaseSnapshot(f.options),verifySnapshot:createReleaseSetSnapshotVerifier(options),windowsAclVerifier:acl});
 assert.deepEqual(replay.record,snapshot.record);
});

for(const attack of ['cli-bytes','template-bytes','record-version','record-sequence','platform','untrusted-proof','receipt'] as const){
 test(`snapshot authenticity rejects ${attack} even with self-consistent local hashes`,async()=>{
  const f=await fixture();const snapshot:any=structuredClone(await createAuthenticatedReleaseSnapshot(f.options));
  if(attack==='cli-bytes'){snapshot.cliBytes[35]^=1;snapshot.record.cliSha256=hash(snapshot.cliBytes);}
  else if(attack==='template-bytes'){snapshot.templateBytes[35]^=1;snapshot.record.templateSha256=hash(snapshot.templateBytes);}
  else if(attack==='record-version')snapshot.record.cliVersion='0.1.7';
  else if(attack==='record-sequence')snapshot.record.manifestSequence++;
  else {const proof=JSON.parse(Buffer.from(snapshot.receiptBytes).toString());
   if(attack==='platform')proof.platform='windows-x64';
   if(attack==='untrusted-proof')proof.acceptedTrustState.acceptedChannelEnvelope='{}';
   if(attack==='receipt')proof.templateReceiptEnvelope='{}';
   snapshot.receiptBytes=Buffer.from(canonicalizeJson(proof)+'\n');snapshot.record.receiptSha256=hash(snapshot.receiptBytes);
  }
  await assert.rejects(authenticateReleaseSnapshot(snapshot,{platform,trustConfig:f.signed.trustConfig}),{code:'UPDATE_SECURITY_ERROR'});
 });
}

test('unbranded channel objects and wrong platform fail before accepting candidate bytes',async()=>{
 const f=await fixture();await assert.rejects(createAuthenticatedReleaseSnapshot({...f.options,verified:structuredClone(f.options.verified)}),{code:'UPDATE_SECURITY_ERROR'});
 await assert.rejects(createAuthenticatedReleaseSnapshot({...f.options,platform:'windows-x64'}),{code:'UPDATE_SECURITY_ERROR'});
});

test('Template receipt requires the exact signed channel history anchor at runtime',async()=>{
 const f=await fixture();f.payload.templateHistory[0].receiptPayloadSha256='d'.repeat(64);
 await assert.rejects(createAuthenticatedReleaseSnapshot({...f.options,verified:f.verify()}),{code:'UPDATE_SECURITY_ERROR'});
});

test('a different branded signing root cannot authenticate a cached release',async()=>{
 const f=await fixture(),other=await fixture();const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 await assert.rejects(authenticateReleaseSnapshot(snapshot,{platform,trustConfig:other.signed.trustConfig}),{code:'UPDATE_SECURITY_ERROR'});
});


test('Windows signed PE-x64 archives retain the existing executable naming contract',async()=>{
 const f=await fixture('windows-x64');const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 const checked=await authenticateReleaseSnapshot(snapshot,{platform:'windows-x64',trustConfig:f.signed.trustConfig});
 assert.equal(checked.executableName,'harness-mrtool.exe');assert.deepEqual(Buffer.from(checked.executableBytes),f.native);
 await assert.rejects(authenticateReleaseSnapshot(snapshot,{platform:'darwin-arm64',trustConfig:f.signed.trustConfig}),{code:'UPDATE_SECURITY_ERROR'});
});

for(const policy of ['revoked-cli','revoked-set','minimum-cli','unsupported-schema'] as const){
 test(`candidate construction enforces signed ${policy} policy before activation`,async()=>{
  const f=await fixture();
  if(policy==='revoked-cli')f.payload.security.revokedCliVersions=['0.1.6'];
  if(policy==='revoked-set')f.payload.security.revokedReleaseSetIds=[f.payload.releaseSet.id];
  if(policy==='minimum-cli')f.payload.security.minimumAllowedCliVersion='0.2.0';
  if(policy==='unsupported-schema'){f.payload.components.templates.inputSchema=2;f.payload.components.cli.inputSchemas=[1,2];}
  await assert.rejects(createAuthenticatedReleaseSnapshot({...f.options,verified:f.verify()}),{code:'UPDATE_SECURITY_ERROR'});
 });
}

test('production preparation downloads signed assets, rechecks channel and leaves installation untouched',async(t)=>{
 const {createProductionReleasePreparer}=await import('../../src/update/production-release-preparation.ts');
 const f=await fixture();const root=await mkdtemp(resolve(await realpath(tmpdir()),'release-preparation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));const requests:string[]=[];let channelChecks=0;
 const candidate=createProductionReleasePreparer({stateDirectory:root,platform,trustConfig:f.signed.trustConfig,
  channelUrl:'https://fixture.example.test/stable.envelope.json',
  transport:{async request(){channelChecks++;return{status:200,headers:{},body:Buffer.from(signedEnvelope(canonicalPayload(f.payload),[f.signed.signingKey]))};}},
  fetch:async(url)=>{requests.push(String(url));return new Response(Buffer.from(String(url).endsWith('harness-mrtool-darwin-arm64.zip')?f.options.cliArchive:String(url).endsWith('harness-mr-templates.zip')?f.options.templateArchive:f.options.templateReceipt));},
 });
 const prepared=await candidate.prepare(false);assert.equal(prepared.snapshot.record.cliVersion,'0.1.6');
 assert.equal(prepared.authenticated.executableName,'harness-mrtool');assert.equal(requests.length,3);assert.equal(channelChecks,2);
 const {access}=await import('node:fs/promises');await assert.rejects(access(resolve(root,'active-release-set.json')),{code:'ENOENT'});
 assert.deepEqual((await readdir(root)).filter(p=>p!=='update-state.json'&&p!=='.update.lock'),[]);
});

test('production preparation rejects channel advancement after asset download before activation',async(t)=>{
 const {createProductionReleasePreparer}=await import('../../src/update/production-release-preparation.ts');
 const f=await fixture();const root=await mkdtemp(resolve(await realpath(tmpdir()),'release-drift-'));
 t.after(()=>rm(root,{recursive:true,force:true}));let channelChecks=0;
 const candidate=createProductionReleasePreparer({stateDirectory:root,platform,trustConfig:f.signed.trustConfig,
  channelUrl:'https://fixture.example.test/stable.envelope.json',
  transport:{async request(){channelChecks++;const payload=channelChecks===1?f.payload:{...f.payload,sequence:43};return{status:200,headers:{},body:Buffer.from(signedEnvelope(canonicalPayload(payload),[f.signed.signingKey]))};}},
  fetch:async(url)=>new Response(Buffer.from(String(url).endsWith('harness-mrtool-darwin-arm64.zip')?f.options.cliArchive:String(url).endsWith('harness-mr-templates.zip')?f.options.templateArchive:f.options.templateReceipt)),
 });
 await assert.rejects(candidate.prepare(false),{code:'CONCURRENT_UPDATE'});
 const {access}=await import('node:fs/promises');await assert.rejects(access(resolve(root,'active-release-set.json')),{code:'ENOENT'});
});


test('identical signed release retries are idempotent across independently authenticated trust histories',async(t)=>{
 const f=await fixture();const root=await mkdtemp(resolve(await realpath(tmpdir()),'release-history-retry-'));
 t.after(async()=>{
  const pending=[root];while(pending.length){const path=pending.pop()!;const info=await lstat(path);
   if(info.isSymbolicLink()||!info.isDirectory())continue;await chmod(path,0o700);
   for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())pending.push(resolve(path,entry.name));
  }await rm(root,{recursive:true,force:true});
 });
 const payload={...f.payload,sequence:43};const envelope=signedEnvelope(canonicalPayload(payload),[f.signed.signingKey]);
 const direct=f.verify(payload);
 const transitioned=verifyChannelEnvelope(envelope,f.options.verified.nextTrustState,f.signed.trustConfig.repository,f.signed.bootstrapKeys);
 assert.equal(direct.payloadSha256,transitioned.payloadSha256);
 const first=await createAuthenticatedReleaseSnapshot({...f.options,verified:direct});
 const second=await createAuthenticatedReleaseSnapshot({...f.options,verified:transitioned});
 assert.notEqual(first.record.receiptSha256,second.record.receiptSha256,'the two valid provenance histories remain distinct');
 const options={stateDirectory:root,verifySnapshot:createReleaseSetSnapshotVerifier({platform,trustConfig:f.signed.trustConfig}),windowsAclVerifier:{verify:async()=>{}}};
 const installed=await activateReleaseSet({...options,next:first});
 const retried=await activateReleaseSet({...options,next:second});
 assert.deepEqual(retried.record,installed.record,'idempotency retains the installed authenticated provenance');
 const changed=f.verify({...payload,security:{...payload.security,minimumAllowedCliVersion:'0.1.1'}});
 const equivocation=await createAuthenticatedReleaseSnapshot({...f.options,verified:changed});
 await assert.rejects(activateReleaseSet({...options,next:equivocation}),{code:'UPDATE_SECURITY_ERROR'},'same sequence with a different signed policy must still fail');
 const recovered=await recoverReleaseSet(root,options);assert.deepEqual(recovered!.record,installed.record);
});
