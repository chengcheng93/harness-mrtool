import {createHash} from 'node:crypto';
import {zipSync} from 'fflate';
import {createTrustState} from '../../src/update/envelope.ts';
import {verifyChannelEnvelope} from '../../src/update/manifest.ts';
import {exactReleaseFixture} from './default-historical-fixture.ts';
import {canonicalPayload,signedEnvelope} from './signing.ts';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');

export async function nativeReleaseFixture(releasePlatform: "darwin-arm64"|"windows-x64" = "darwin-arm64"){
  const signed=await exactReleaseFixture();
  const native=Buffer.alloc(512);
  if(releasePlatform==='darwin-arm64'){native.writeUInt32LE(0xfeedfacf,0);native.writeUInt32LE(0x0100000c,4);native.writeUInt32LE(2,12);}
  else {native.writeUInt16LE(0x5a4d,0);native.writeUInt32LE(128,0x3c);native.writeUInt32LE(0x4550,128);native.writeUInt16LE(0x8664,132);native.writeUInt16LE(0x20b,152);}
  const executableName=releasePlatform==='darwin-arm64'?'harness-mrtool':'harness-mrtool.exe';
  const templateReceipt=Buffer.from(String(signed.assets.receiptEnvelope));
  const cliFiles:Record<string,Uint8Array>={[executableName]:native,'bundle-receipt.envelope.json':templateReceipt,'THIRD_PARTY_NOTICES.md':Buffer.from('notice'),'licenses/Node.txt':Buffer.from('license')};
  cliFiles.SHA256SUMS=Buffer.from(Object.keys(cliFiles).sort().map(p=>hash(cliFiles[p]!)+'  '+p).join('\n')+'\n');
  const cliArchive=zipSync(cliFiles,{level:0}),templateArchive=zipSync(Object.fromEntries(signed.assets.files),{level:0});
  const payload:any=structuredClone(signed.channelPayload);
  payload.components.cli={...payload.components.cli,version:'0.1.6',tag:'cli-v0.1.6',artifacts:{[releasePlatform]:{name:`harness-mrtool-${releasePlatform}.zip`,sha256:hash(cliArchive),size:cliArchive.length}}};
  payload.components.templates={...payload.components.templates,minCliVersion:'0.1.6',sha256:hash(templateArchive),size:templateArchive.length};
  payload.components.skill={...payload.components.skill,version:'0.1.6',tag:'skill-v0.1.6',cliVersionRange:'>=0.1.6 <1.0.0'};
  payload.recommendedSkillVersion='0.1.6';payload.releaseSet={id:'stable-0.1.6',cli:'0.1.6',templates:signed.reference.bundleVersion};payload.security.minimumAllowedCliVersion='0.1.0';
  const verify=(p=payload)=>verifyChannelEnvelope(signedEnvelope(canonicalPayload(p),[signed.signingKey]),createTrustState(signed.bootstrapKeys),signed.trustConfig.repository,signed.bootstrapKeys);
  const options={verified:verify(),cliArchive,templateArchive,templateReceipt,platform:releasePlatform,trustConfig:signed.trustConfig};
  return {signed,payload,verify,options,native};
}
