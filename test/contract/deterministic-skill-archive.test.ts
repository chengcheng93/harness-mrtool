import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath, utimes, access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {unzipSync} from 'fflate';
// @ts-expect-error JS packaging helper.
import {packageSkillArchive} from '../../scripts/package-skill-archive.mjs';

test('Skill archives are reproducible across directories and source timestamps', async (t) => {
  const root=await mkdtemp(resolve(await realpath(tmpdir()),'deterministic-skill-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const input=resolve(root,'source');await mkdir(input);await writeFile(resolve(input,'SKILL.md'),'# Example\n');
  const common={inputDirectory:input,version:'0.1.6',cliVersionRange:'>=0.1.6 <1.0.0'};
  const first=resolve(root,'first.zip'), second=resolve(root,'second.zip');
  await packageSkillArchive({...common,outputPath:first});
  await utimes(resolve(input,'SKILL.md'),new Date('2001-01-01'),new Date('2001-01-01'));
  await packageSkillArchive({...common,outputPath:second});
  assert.deepEqual(await readFile(first),await readFile(second));
  const entries=unzipSync(await readFile(first));
  assert.deepEqual(Object.keys(entries).sort(),['.harness-skill-manifest.json','SKILL.md']);
  const manifest=JSON.parse(Buffer.from(entries['.harness-skill-manifest.json']!).toString());
  assert.equal(manifest.version,'0.1.6');assert.equal(manifest.cliVersionRange,common.cliVersionRange);
  await assert.rejects(packageSkillArchive({...common,outputPath:first}), /exist|overwrite/);
});

test('failed Skill packaging does not publish a partial archive',async(t)=>{
  const root=await mkdtemp(resolve(await realpath(tmpdir()),'skill-archive-fail-'));
  t.after(()=>rm(root,{recursive:true,force:true}));const input=resolve(root,'source');await mkdir(input);
  await writeFile(resolve(input,'not-a-skill.txt'),'missing SKILL.md');const output=resolve(root,'bad.zip');
  await assert.rejects(packageSkillArchive({inputDirectory:input,outputPath:output,version:'0.1.6',cliVersionRange:'>=0.1.6 <1.0.0'}));
  await assert.rejects(access(output),{code:'ENOENT'});
});

test('Skill archive bytes are identical across publisher and local signing timezones',async(t)=>{
  const {spawnSync}=await import('node:child_process');
  const root=await mkdtemp(resolve(await realpath(tmpdir()),'skill-timezone-'));
  t.after(()=>rm(root,{recursive:true,force:true}));const input=resolve(root,'source');await mkdir(input);await writeFile(resolve(input,'SKILL.md'),'# Skill\n');
  const archives:Buffer[]=[];
  for(const [index,TZ] of ['UTC','Asia/Shanghai','America/Los_Angeles'].entries()){
    const output=resolve(root,`${index}.zip`);
    const p=spawnSync(process.execPath,[resolve(import.meta.dirname,'../../scripts/package-skill-archive.mjs'),'--input',input,'--output',output,'--version','0.1.6','--cli-version-range','>=0.1.6 <1.0.0'],{env:{...process.env,TZ},encoding:'utf8',timeout:15000});
    assert.equal(p.status,0,`${TZ}: ${p.stderr}`);archives.push(await readFile(output));
  }
  assert.deepEqual(archives[0],archives[1]);assert.deepEqual(archives[0],archives[2]);
});

test('Skill archive cap includes ZIP overhead and does not publish an oversized signed asset',async(t)=>{
  const root=await mkdtemp(resolve(await realpath(tmpdir()),'skill-archive-cap-'));
  t.after(()=>rm(root,{recursive:true,force:true}));const input=resolve(root,'source');await mkdir(input);
  // The tree fits the 16MiB payload+manifest bound, but stored ZIP headers make
  // the final compressed asset exceed the verifier/bootstrap 16MiB limit.
  await writeFile(resolve(input,'SKILL.md'),'# Skill\n');
  for(let i=0;i<3;i++) await writeFile(resolve(input,`part${i}.bin`),Buffer.alloc(4*1024*1024,65+i));
  let finalSize=4*1024*1024-1024;
  await writeFile(resolve(input,'part3.bin'),Buffer.alloc(finalSize,68));
  // Determine exact manifest overhead from the real tree packager before
  // creating the boundary fixture (hash lengths are constant).
  // @ts-expect-error JS packaging helper.
  const {prepareSkillTree}=await import('../../scripts/package-skill.mjs');
  const {canonicalize}=await import('json-canonicalize');
  const manifest=await prepareSkillTree({inputDirectory:input,outputDirectory:resolve(root,'probe'),version:'0.1.6',cliVersionRange:'>=0.1.6 <1.0.0'});
  const overhead=Buffer.byteLength(canonicalize(manifest)+'\n')+Buffer.byteLength('# Skill\n');
  finalSize=4*1024*1024-overhead-64;
  await writeFile(resolve(input,'part3.bin'),Buffer.alloc(finalSize,68));
  const output=resolve(root,'too-big.zip');
  await assert.rejects(packageSkillArchive({inputDirectory:input,outputPath:output,version:'0.1.6',cliVersionRange:'>=0.1.6 <1.0.0'}),/archive exceeds bound/);
  await assert.rejects(access(output),{code:'ENOENT'});
});
