import {createHash} from 'node:crypto';
import {canonicalizeJson,copyJsonValue,type JsonObject,type JsonValue} from '../contracts/jcs.ts';
import {parseStrictJson} from '../input/strict-json.ts';
import {MAX_BUNDLE_MANIFEST_BYTES,MAX_BUNDLE_PAYLOAD_BYTES,MAX_BUNDLE_TOTAL_PAYLOAD_BYTES,type LoadedTemplateBundle} from '../bundle/load.ts';
import {TEMPLATE_BUNDLE_PAYLOAD_PATHS} from '../bundle/types.ts';
import {copyTrustState,MAX_SIGNED_ENVELOPE_BYTES,updateSecurityError,type UpdateTrustState} from './envelope.ts';
import {isVerifiedChannelManifest,verifyChannelEnvelope,type VerifiedChannelManifest} from './manifest.ts';
import {createProductionUpdateTrustConfig,updateTrustConfigSha256,type UpdateTrustConfig} from './trust-config.ts';
import {MAX_CACHE_CLI_BYTES,MAX_CACHE_TEMPLATE_BYTES,MAX_CACHE_RECEIPT_BYTES,validateReleaseSetSnapshot,type ReleaseSetSnapshot,type ReleaseSetSnapshotVerifier,type ReleaseSetRecord} from './cache.ts';
import {unpackTemplatePublicationArchive} from './production-historical-source.ts';
import {verifyBundleReceiptEnvelope} from './bundle-receipt.ts';
import {loadTemplateBundleSnapshot} from './historical-bundle-loader.ts';
import {evaluateReleaseCompatibility} from './compatibility.ts';

export type SupportedReleasePlatform='windows-x64'|'darwin-arm64';
export interface ReleaseSnapshotOptions { readonly platform:SupportedReleasePlatform; readonly trustConfig?:UpdateTrustConfig; }
export interface ReleaseSnapshotInputs extends ReleaseSnapshotOptions {
 readonly verified:VerifiedChannelManifest;
 readonly cliArchive:Uint8Array;
 readonly templateArchive:Uint8Array;
 readonly templateReceipt:Uint8Array;
}
export interface AuthenticatedReleaseSnapshot {
 readonly verified:VerifiedChannelManifest;
 readonly bundle:LoadedTemplateBundle;
 readonly executableName:string;
 readonly executableBytes:Uint8Array;
}
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const encode=(v:JsonValue)=>new TextEncoder().encode(canonicalizeJson(v)+'\n');
function fail():never {throw updateSecurityError('signature validation failed');}
function target(platform:SupportedReleasePlatform){
 if(platform!=='windows-x64'&&platform!=='darwin-arm64')fail();
 return {executableName:platform==='windows-x64'?'harness-mrtool.exe':'harness-mrtool',archiveName:`harness-mrtool-${platform}.zip`};
}
function canonicalObject(bytes:Uint8Array,keys:readonly string[]):JsonObject{
 const text=decoder.decode(bytes),value=parseStrictJson(text);
 if(value===null||typeof value!=='object'||Array.isArray(value)||text!==canonicalizeJson(value)+'\n'||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail();
 return value;
}
function transactionId(record:Omit<ReleaseSetRecord,'transactionId'>){return `release-${hash(encode(copyJsonValue(record))).slice(0,32)}`;}
function nativeHeader(bytes:Uint8Array,platform:SupportedReleasePlatform){
 const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(platform==='darwin-arm64'){
  if(b.length<32||b.readUInt32LE(0)!==0xfeedfacf||b.readUInt32LE(4)!==0x0100000c||b.readUInt32LE(12)!==2)fail();
 }else{
  if(b.length<64||b.readUInt16LE(0)!==0x5a4d)fail();const pe=b.readUInt32LE(0x3c);
  if(pe<64||pe+26>b.length||b.readUInt32LE(pe)!==0x4550||b.readUInt16LE(pe+4)!==0x8664||b.readUInt16LE(pe+24)!==0x20b)fail();
 }
}
function cliFiles(bytes:Uint8Array,platform:SupportedReleasePlatform):ReadonlyMap<string,Uint8Array>{
 const {executableName}=target(platform);
 const paths=['SHA256SUMS','THIRD_PARTY_NOTICES.md','bundle-receipt.envelope.json',executableName,'licenses/Node.txt'];
 const files=unpackTemplatePublicationArchive(bytes,{filePaths:paths,limits:{receiptEnvelopeBytes:MAX_SIGNED_ENVELOPE_BYTES,
  manifestBytes:MAX_BUNDLE_MANIFEST_BYTES,payloadBytes:MAX_CACHE_CLI_BYTES,totalPayloadBytes:MAX_CACHE_CLI_BYTES}});
 const sums=decoder.decode(files.get('SHA256SUMS')!);if(!sums.endsWith('\n')||sums.includes('\r'))fail();
 const lines=sums.slice(0,-1).split('\n');if(lines.length!==4)fail();const seen=new Set<string>();
 for(const line of lines){const match=/^([a-f0-9]{64})  (.+)$/u.exec(line);if(match===null)fail();const name=match[2]!;
  if(!paths.includes(name)||name==='SHA256SUMS'||seen.has(name)||hash(files.get(name)!)!==match[1])fail();seen.add(name);
 }
 for(const path of paths){const value=files.get(path);if(value===undefined||value.length===0)fail();}
 if(files.get('bundle-receipt.envelope.json')!.length>MAX_SIGNED_ENVELOPE_BYTES)fail();
 nativeHeader(files.get(executableName)!,platform);return files;
}

/** Authenticates retained archives and proof; never installs, launches or grants latest-policy permission. */
export async function authenticateReleaseSnapshot(snapshot:ReleaseSetSnapshot,options:ReleaseSnapshotOptions):Promise<AuthenticatedReleaseSnapshot>{
 try{
  const config=options.trustConfig??createProductionUpdateTrustConfig();const configHash=updateTrustConfigSha256(config);
  const selected=target(options.platform);
  // LoadedReleaseSet adds local paths/policy diagnostics. They confer no trust
  // and must never redirect verification; authenticate the four byte fields only.
  if(snapshot===null||typeof snapshot!=="object"||Array.isArray(snapshot))fail();
  for(const field of ['record','cliBytes','templateBytes','receiptBytes']){
    const descriptor=Object.getOwnPropertyDescriptor(snapshot,field);
    if(descriptor===undefined||!('value' in descriptor))fail();
  }
  const value=validateReleaseSetSnapshot({record:snapshot.record,cliBytes:snapshot.cliBytes,
    templateBytes:snapshot.templateBytes,receiptBytes:snapshot.receiptBytes});
  const proof=canonicalObject(value.receiptBytes,['format','version','platform','trustConfigSha256','acceptedTrustState','templateReceiptEnvelope']);
  if(proof.format!=='harness-release-provenance'||proof.version!==1||proof.platform!==options.platform||proof.trustConfigSha256!==configHash||typeof proof.templateReceiptEnvelope!=='string')fail();
  const trust=copyTrustState(proof.acceptedTrustState as unknown as UpdateTrustState,config.bootstrapKeys);
  if(trust.acceptedChannelEnvelope===null)fail();
  const verified=verifyChannelEnvelope(trust.acceptedChannelEnvelope,trust,config.repository,config.bootstrapKeys);
  const manifest=verified.manifest,cli=manifest.components.cli.artifacts[options.platform],template=manifest.components.templates;
  if(cli===undefined||cli.name!==selected.archiveName||cli.size!==value.cliBytes.length||cli.sha256!==hash(value.cliBytes)||
      template.asset!=='harness-mr-templates.zip'||template.size!==value.templateBytes.length||template.sha256!==hash(value.templateBytes))fail();
  const record=value.record;
  if(record.releaseSetId!==manifest.releaseSet.id||record.cliVersion!==manifest.components.cli.version||record.templateVersion!==template.version||
      record.manifestVersion!==manifest.manifestVersion||record.manifestSequence!==manifest.sequence||record.inputSchema!==template.inputSchema||record.policySchema!==template.policySchema)fail();
  const {transactionId:actualTransaction,...identity}=record;if(actualTransaction!==transactionId(identity))fail();
  const files=unpackTemplatePublicationArchive(value.templateBytes,{filePaths:['bundle-manifest.json',...TEMPLATE_BUNDLE_PAYLOAD_PATHS],limits:{
    receiptEnvelopeBytes:MAX_SIGNED_ENVELOPE_BYTES,manifestBytes:MAX_BUNDLE_MANIFEST_BYTES,payloadBytes:MAX_BUNDLE_PAYLOAD_BYTES,totalPayloadBytes:MAX_BUNDLE_TOTAL_PAYLOAD_BYTES}});
  const anchor=trust.bundleReceiptAnchors.find(a=>a.releaseTag===template.tag&&a.repositoryOwner===config.repository.owner&&a.repositoryName===config.repository.name);
  if(anchor===undefined)fail();
  const receipt=verifyBundleReceiptEnvelope(proof.templateReceiptEnvelope,trust,{repository:config.repository,releaseTag:template.tag,bundleManifestHash:anchor.bundleManifestHash},files,config.bootstrapKeys);
  if(receipt.receipt.bundleVersion!==template.version||receipt.receipt.inputSchema!==template.inputSchema||receipt.receipt.policySchema!==template.policySchema)fail();
  const bundle=await loadTemplateBundleSnapshot(files);
  const contents=cliFiles(value.cliBytes,options.platform);
  if(!Buffer.from(contents.get('bundle-receipt.envelope.json')!).equals(Buffer.from(proof.templateReceiptEnvelope,'utf8')))fail();
  const executable=Uint8Array.from(contents.get(selected.executableName)!);
  return Object.freeze({verified,bundle,executableName:selected.executableName,get executableBytes(){return Uint8Array.from(executable);}});
 }catch{return fail();}
}

/** A candidate must start from a branded signed channel, never caller-built versions/hashes. */
export async function createAuthenticatedReleaseSnapshot(input:ReleaseSnapshotInputs):Promise<ReleaseSetSnapshot>{
 if(!isVerifiedChannelManifest(input.verified))fail();
 for(const [bytes,limit] of [[input.cliArchive,MAX_CACHE_CLI_BYTES],[input.templateArchive,MAX_CACHE_TEMPLATE_BYTES],[input.templateReceipt,MAX_SIGNED_ENVELOPE_BYTES]] as const){
  if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>limit)fail();
 }
 const channel=input.verified.manifest;
 const compatibility=evaluateReleaseCompatibility(channel,{platform:input.platform,supportedManifestVersions:[1],supportedInputSchemas:[1],
  supportedPolicySchemas:[1],loadedSkillProtocol:null,activeCliVersion:channel.components.cli.version,activeReleaseSetId:channel.releaseSet.id});
 if(!compatibility.candidateCompatible)fail();
 const config=input.trustConfig??createProductionUpdateTrustConfig();
 const configHash=updateTrustConfigSha256(config);target(input.platform);
 const trust=copyTrustState(input.verified.nextTrustState,config.bootstrapKeys);
 const proof=encode(copyJsonValue({format:'harness-release-provenance',version:1,platform:input.platform,trustConfigSha256:configHash,
  acceptedTrustState:trust,templateReceiptEnvelope:decoder.decode(input.templateReceipt)}));
 if(proof.length>MAX_CACHE_RECEIPT_BYTES)fail();const manifest=input.verified.manifest;
 const record:Omit<ReleaseSetRecord,'transactionId'>={cacheVersion:1,recordType:'active-release-set',releaseSetId:manifest.releaseSet.id,
  cliVersion:manifest.components.cli.version,cliSha256:hash(input.cliArchive),templateVersion:manifest.components.templates.version,
  templateSha256:hash(input.templateArchive),manifestVersion:1,inputSchema:manifest.components.templates.inputSchema,
  policySchema:manifest.components.templates.policySchema,manifestSequence:manifest.sequence,receiptSha256:hash(proof)};
 const snapshot=validateReleaseSetSnapshot({record:{...record,transactionId:transactionId(record)},cliBytes:input.cliArchive,templateBytes:input.templateArchive,receiptBytes:proof});
 await authenticateReleaseSnapshot(snapshot,{platform:input.platform,trustConfig:config});return snapshot;
}

export function createReleaseSetSnapshotVerifier(options:ReleaseSnapshotOptions):ReleaseSetSnapshotVerifier{
 return Object.freeze({
  async verify(snapshot:ReleaseSetSnapshot){await authenticateReleaseSnapshot(snapshot,options);},
  async isSameAuthenticatedRelease(left:ReleaseSetSnapshot,right:ReleaseSetSnapshot){
   const a=await authenticateReleaseSnapshot(left,options);
   const b=await authenticateReleaseSnapshot(right,options);
   // The exact signed payload binds the platform archive hashes and release
   // tuple. Both byte snapshots and receipt histories were verified above.
   return a.verified.payloadSha256===b.verified.payloadSha256;
  },
 });
}
