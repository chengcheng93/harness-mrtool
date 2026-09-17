import {createHash, randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {access, link, lstat, mkdir, mkdtemp, open, realpath, rm} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalize} from 'json-canonicalize';
import {zipSync} from 'fflate';
import {prepareSkillTree} from './package-skill.mjs';

function fail(message) { throw new Error(`Skill archive packaging failed: ${message}`); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function readPrepared(path, expected) {
  const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(expected.size)) fail('prepared file identity is invalid');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try {
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.nlink!==1n) fail('prepared file changed');
    const bytes=Buffer.alloc(expected.size);let at=0;
    while(at<bytes.length){const read=await handle.read(bytes,at,bytes.length-at,at);if(!read.bytesRead)fail('prepared file truncated');at+=read.bytesRead;}
    const after=await handle.stat({bigint:true});const current=await lstat(path,{bigint:true});
    if(after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||current.dev!==before.dev||current.ino!==before.ino||hash(bytes)!==expected.sha256) fail('prepared file bytes changed');
    return bytes;
  } finally {await handle.close();}
}

/** Deterministic packaging only. A signed publication receipt remains mandatory. */
export async function packageSkillArchive({inputDirectory,outputPath,version,cliVersionRange}) {
  if(typeof inputDirectory!=='string'||!inputDirectory.trim()||typeof outputPath!=='string'||!outputPath.trim()) fail('input/output paths required');
  if(typeof cliVersionRange!=='string'||!cliVersionRange.trim()) fail('explicit CLI compatibility range required');
  const input=resolve(inputDirectory),output=resolve(outputPath);
  const normalized=(p)=>process.platform==='win32'?p.toLowerCase():p;
  const relation=relative(normalized(input),normalized(output));
  if(relation===''||(!relation.startsWith(`..${sep}`)&&relation!=='..'&&!relation.startsWith(sep)&&!relation.includes(':'))) fail('output must not be inside input');
  await mkdir(dirname(output),{recursive:true});
  if(normalized(await realpath(dirname(output)))!==normalized(dirname(output))) fail('output parent must be canonical');
  try {await access(output);fail('output exists; refusing overwrite');} catch(error){if(error?.code!=='ENOENT')throw error;}
  const work=await mkdtemp(resolve(dirname(output),'.harness-skill-archive-'));
  const temporary=resolve(work,`archive-${randomBytes(8).toString('hex')}.zip`);
  let handle;
  try {
    const tree=resolve(work,'tree');
    const manifest=await prepareSkillTree({inputDirectory:input,outputDirectory:tree,version,cliVersionRange});
    const manifestBytes=Buffer.from(`${canonicalize(manifest)}\n`);
    const records=[...manifest.files,{path:'.harness-skill-manifest.json',size:manifestBytes.length,sha256:hash(manifestBytes)}].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
    const entries=Object.create(null);
    for(const file of records) entries[file.path]=[await readPrepared(resolve(tree,file.path),file),{os:3,attrs:(0o100644<<16)>>>0}];
    const archive=zipSync(entries,{level:0,mtime:new Date(1980,0,1,0,0,0)});
    if(archive.length<1||archive.length>16*1024*1024) fail('archive exceeds bound');
    handle=await open(temporary,'wx',0o600);await handle.writeFile(archive);await handle.sync();await handle.close();handle=undefined;
    await link(temporary,output); // Same filesystem, atomic no-replace publication.
    return Object.freeze({archivePath:output,archiveSha256:hash(archive),archiveSize:archive.length,manifest});
  } finally {await handle?.close().catch(()=>undefined);await rm(work,{recursive:true,force:true});}
}
function args(argv){
  const fields=new Map([['--input','inputDirectory'],['--output','outputPath'],['--version','version'],['--cli-version-range','cliVersionRange']]);const value={};
  for(let i=0;i<argv.length;i+=2){const key=fields.get(argv[i]),item=argv[i+1];if(key===undefined||item===undefined||item.startsWith('--')||Object.hasOwn(value,key))fail('invalid arguments');value[key]=item;}
  if(Object.keys(value).length!==fields.size)fail('input, output, version and CLI compatibility are required');return value;
}
if(process.argv[1]!==undefined&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const r=await packageSkillArchive(args(process.argv.slice(2)));process.stdout.write(`${JSON.stringify({archiveSha256:r.archiveSha256,archiveSize:r.archiveSize,version:r.manifest.version})}\n`);}
  catch{process.stderr.write('Skill archive packaging failed: input or publication rejected\n');process.exitCode=1;}
}
