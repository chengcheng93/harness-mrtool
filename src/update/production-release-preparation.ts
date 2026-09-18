import {ToolError} from '../contracts/errors.ts';
import {createProductionChannelClient,type ProductionChannelClientOptions} from './production-channel.ts';
import {createProductionReleaseSource} from './production-release-source.ts';
import {createProductionUpdateTrustConfig} from './trust-config.ts';
import {evaluateReleaseCompatibility} from './compatibility.ts';
import {createAuthenticatedReleaseSnapshot,authenticateReleaseSnapshot,type AuthenticatedReleaseSnapshot,type SupportedReleasePlatform} from './release-set-verifier.ts';
import type {ReleaseSetSnapshot} from './cache.ts';

export interface ProductionReleasePreparationOptions extends ProductionChannelClientOptions {
 readonly platform?:SupportedReleasePlatform;
 readonly fetch?:typeof globalThis.fetch;
}
export interface PreparedReleaseCandidate {
 readonly snapshot:ReleaseSetSnapshot;
 readonly authenticated:AuthenticatedReleaseSnapshot;
}
function required(message:string):ToolError<'UPDATE_REQUIRED'>{return new ToolError('UPDATE_REQUIRED',message,{
 field:'update.candidate',expected:'a supported, currently authenticated release candidate',actual:'candidate is unavailable or incompatible',
 safeNextStep:'Keep the installed release and retry after checking the official channel and platform support.'});}
export function currentReleasePlatform():SupportedReleasePlatform{
 if(process.platform==='win32'&&process.arch==='x64')return'windows-x64';
 if(process.platform==='darwin'&&process.arch==='arm64')return'darwin-arm64';
 throw required('This platform has no supported native update target');
}

/** Acquires/authenticates bytes only; cache activation and executable installation are separate gates. */
export function createProductionReleasePreparer(options:ProductionReleasePreparationOptions={}){
 let resolved: {channel:ReturnType<typeof createProductionChannelClient>;source:ReturnType<typeof createProductionReleaseSource>;
  config:ReturnType<typeof createProductionUpdateTrustConfig>;platform:SupportedReleasePlatform}|undefined;
 function defaults(){
  if(resolved!==undefined)return resolved;
  const config=options.trustConfig??createProductionUpdateTrustConfig();const platform=options.platform??currentReleasePlatform();
  resolved={config,platform,channel:createProductionChannelClient({...options,trustConfig:config}),
   source:createProductionReleaseSource({repository:config.repository,...(options.fetch===undefined?{}:{fetch:options.fetch})})};
  return resolved;
 }
 return Object.freeze({async prepare(force:boolean):Promise<PreparedReleaseCandidate>{
  const {channel,source,config,platform}=defaults();
  const first=await channel.check(force);
  if(!first.latestVersionConfirmed)throw required('An install candidate requires a freshly confirmed signed channel');
  const manifest=first.verified.manifest;
  const compatibility=evaluateReleaseCompatibility(manifest,{platform,supportedManifestVersions:[1],supportedInputSchemas:[1],
   supportedPolicySchemas:[1],loadedSkillProtocol:null,activeCliVersion:manifest.components.cli.version,activeReleaseSetId:manifest.releaseSet.id});
  if(!compatibility.candidateCompatible)throw required('The signed candidate is not compatible or is revoked');
  const cli=manifest.components.cli.artifacts[platform]!;const template=manifest.components.templates;
  const repository=config.repository;
  const templateReceipt=await source.downloadTemplateReceipt({repository,tag:template.tag});
  const templateArchive=await source.downloadAsset({repository,tag:template.tag,asset:{name:template.asset,size:template.size,sha256:template.sha256}});
  const cliArchive=await source.downloadAsset({repository,tag:manifest.components.cli.tag,asset:cli});
  const snapshot=await createAuthenticatedReleaseSnapshot({verified:first.verified,cliArchive,templateArchive,templateReceipt,platform,trustConfig:config});
  const latest=await channel.check(false);
  if(!latest.latestVersionConfirmed||latest.verified.payloadSha256!==first.verified.payloadSha256){
   throw new ToolError('CONCURRENT_UPDATE','Signed channel changed while the candidate was downloaded',{
    field:'update.channel',expected:'the same freshly confirmed channel payload',actual:'candidate approval is stale',
    safeNextStep:'Run the update again to prepare the latest signed candidate; no installation was performed.'});
  }
  return Object.freeze({snapshot,authenticated:await authenticateReleaseSnapshot(snapshot,{platform,trustConfig:config})});
 }});
}
