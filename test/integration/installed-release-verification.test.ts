import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,link,lstat,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {withUpdateLock} from '../../src/platform/lock.ts';
import {createAuthenticatedReleaseSnapshot} from '../../src/update/release-set-verifier.ts';
import {verifyInstalledRelease} from '../../src/update/installed-release-verification.ts';
import {nativeReleaseFixture} from '../helpers/native-release-fixture.ts';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t:test.TestContext){
 const root=await mkdtemp(resolve(await realpath(tmpdir()),'installed-verification-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const f=await nativeReleaseFixture();const snapshot=await createAuthenticatedReleaseSnapshot(f.options);
 const installationDirectory=resolve(root,'install'),stateDirectory=resolve(root,'state');
 await mkdir(installationDirectory,{mode:0o700});await mkdir(stateDirectory,{mode:0o700});
 const executable=resolve(installationDirectory,'harness-mrtool'),markerPath=resolve(installationDirectory,'.harness-mrtool-install.json');
 const marker={schemaVersion:1,repository:`${f.signed.trustConfig.repository.owner}/${f.signed.trustConfig.repository.name}`,tag:'cli-v0.1.6',archiveSha256:snapshot.record.cliSha256,executableSha256:hash(f.native)};
 await writeFile(executable,f.native,{mode:0o755});await chmod(executable,0o755);
 await writeFile(markerPath,JSON.stringify(marker)+'\n',{mode:0o600});
 const options={installationDirectory,stateDirectory,platform:'darwin-arm64' as const,trustConfig:f.signed.trustConfig};
 return{root,f,snapshot,options,executable,markerPath,marker};
}
test('installed bytes must equal the authenticated native ZIP member, not merely the local marker',async t=>{
 const f=await fixture(t);const before=await readFile(f.markerPath);
 const observed=await withUpdateLock(f.options.stateDirectory,lease=>verifyInstalledRelease(f.snapshot,f.options,lease));
 assert.equal(observed.executablePath,f.executable);assert.equal(observed.cliVersion,'0.1.6');
 assert.equal(observed.releaseSetId,f.snapshot.record.releaseSetId);assert.equal(observed.executableSha256,hash(f.f.native));
 assert.equal(observed.verification,'signed-installed-bytes');
 assert.deepEqual(await readFile(f.markerPath),before);assert.equal('installed' in observed,false,'observation is not an activation/installation transaction result');
});
for(const damage of ['bytes-and-marker','missing-marker','wrong-tag','wrong-repository','wrong-archive','extra-marker-field','duplicate-marker-field','oversized-marker','hardlink','writable-executable','special-mode','writable-directory'] as const){
 test(`installed verification rejects ${damage}`,async t=>{
  if(process.platform==='win32'&&['writable-executable','special-mode','writable-directory'].includes(damage))return t.skip('POSIX permission assertions');
  const f=await fixture(t);
  if(damage==='bytes-and-marker'){await writeFile(f.executable,'tampered');await writeFile(f.markerPath,JSON.stringify({...f.marker,executableSha256:hash(Buffer.from('tampered'))}));}
  if(damage==='missing-marker')await rm(f.markerPath);
  if(damage==='wrong-tag')await writeFile(f.markerPath,JSON.stringify({...f.marker,tag:'cli-v0.1.5'}));
  if(damage==='wrong-repository')await writeFile(f.markerPath,JSON.stringify({...f.marker,repository:'other/repo'}));
  if(damage==='wrong-archive')await writeFile(f.markerPath,JSON.stringify({...f.marker,archiveSha256:'f'.repeat(64)}));
  if(damage==='extra-marker-field')await writeFile(f.markerPath,JSON.stringify({...f.marker,canonicalPath:f.executable}));
  if(damage==='duplicate-marker-field')await writeFile(f.markerPath,JSON.stringify(f.marker).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'));
  if(damage==='oversized-marker')await writeFile(f.markerPath,' '.repeat(8193));
  if(damage==='hardlink')await link(f.executable,resolve(f.root,'external-link'));
  if(damage==='writable-executable')await chmod(f.executable,0o777);
  if(damage==='special-mode')await chmod(f.executable,0o4755);
  if(damage==='writable-directory')await chmod(f.options.installationDirectory,0o777);
  await assert.rejects(verifyInstalledRelease(f.snapshot,f.options),{code:'UPDATE_SECURITY_ERROR'});
 });
}
for(const part of ['directory','executable','marker'] as const){
 test(`installed verification rejects linked ${part} without changing the target`,async t=>{
  if(process.platform==='win32')return t.skip('requires symlink privilege');
  const f=await fixture(t);const outside=resolve(f.root,'outside');
  await mkdir(outside,{mode:0o700});await writeFile(resolve(outside,'sentinel'),'preserved');
  const target=part==='directory'?f.options.installationDirectory:part==='executable'?f.executable:f.markerPath;
  if(part==='directory'){await rm(target,{recursive:true});await symlink(outside,target);}
  else{await rm(target);await symlink(resolve(outside,'sentinel'),target);}
  await assert.rejects(verifyInstalledRelease(f.snapshot,f.options),{code:'UPDATE_SECURITY_ERROR'});
  assert.equal(await readFile(resolve(outside,'sentinel'),'utf8'),'preserved');
 });
}
test('installed verification rejects untrusted proof and foreign leases before treating any marker as authority',async t=>{
 const f=await fixture(t),other=await nativeReleaseFixture();
 await assert.rejects(verifyInstalledRelease(f.snapshot,{...f.options,trustConfig:other.signed.trustConfig}),{code:'UPDATE_SECURITY_ERROR'});
 await withUpdateLock(resolve(f.root,'other-state'),async lease=>{
  await assert.rejects(verifyInstalledRelease(f.snapshot,f.options,lease),{code:'UPDATE_SECURITY_ERROR'});
 });
});
test('installed verification accepts the Windows installer marker whitespace without trusting its hashes',async t=>{
 const f=await fixture(t);await writeFile(f.markerPath,JSON.stringify(f.marker));
 assert.equal((await verifyInstalledRelease(f.snapshot,f.options)).executableSha256,hash(f.f.native));
});
