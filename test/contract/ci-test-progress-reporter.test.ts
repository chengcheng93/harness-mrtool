import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {parse} from 'yaml';
// @ts-expect-error The runtime reporter is an ESM build/CI helper.
import {createProgressReporter} from '../../scripts/ci-test-progress-reporter.mjs';
const root=resolve(import.meta.dirname,'../..');
async function collect(events:object[]){
 const reporter=createProgressReporter(root);
 let output='';for await(const value of reporter((async function*(){yield* events;})()))output+=value;
 return output;
}
test('native CI reporter prints only known repository test paths and bounded numerical summaries',async()=>{
 const file=resolve(import.meta.dirname,'ci-test-progress-reporter.test.ts');
 const text=await collect([
  {type:'test:dequeue',data:{file,name:'secret-name',nesting:0}},
  {type:'test:stdout',data:{file,message:'SECRET-OUTPUT'}},
  {type:'test:stderr',data:{file,message:'SECRET-ERROR'}},
  {type:'test:diagnostic',data:{message:'SECRET-DIAG'}},
  {type:'test:fail',data:{file,line:17,name:'SECRET-TITLE',details:{error:'SECRET-ASSERTION'}}},
  {type:'test:summary',data:{file,counts:{tests:3,passed:2,failed:1,cancelled:0,skipped:0},duration_ms:15.8}},
  {type:'test:summary',data:{counts:{tests:3,passed:2,failed:1,cancelled:0,skipped:0},duration_ms:15.8}},
 ]);
 assert.match(text,/::notice::Native suite START test\/contract\/ci-test-progress-reporter.test.ts/);
 assert.match(text,/::error::Native suite FAIL test\/contract\/ci-test-progress-reporter.test.ts line=17/);
 assert.match(text,/::notice::Native suite DONE test\/contract\/ci-test-progress-reporter.test.ts tests=3 passed=2 failed=1 cancelled=0 skipped=0/);
 assert.match(text,/::notice::Native suite TOTAL tests=3 passed=2 failed=1/);
 assert.doesNotMatch(text,/SECRET|secret-name|duration|Users/);
});
test('native CI reporter drops unknown paths, forged counts and repeat notices',async()=>{
 const file=resolve(import.meta.dirname,'ci-test-progress-reporter.test.ts');
 const text=await collect([
  ...Array.from({length:50},()=>({type:'test:dequeue',data:{file,nesting:0}})),
  {type:'test:dequeue',data:{file:'/tmp/PRIVATE-CANARY.test.ts'}},
  {type:'test:fail',data:{file:'/tmp/PRIVATE-CANARY.test.ts',line:1}},
  {type:'test:summary',data:{counts:{tests:'CANARY',passed:0,failed:0,cancelled:0,skipped:0}}},
  {type:'test:summary',data:{counts:{tests:NaN,passed:0,failed:0,cancelled:0,skipped:0}}},
  {type:'test:summary',data:{counts:{tests:3,passed:-1,failed:0,cancelled:0,skipped:0}}},
 ]);
 assert.equal(text.split('\n').filter(Boolean).length,1);assert.doesNotMatch(text,/CANARY|PRIVATE|TOTAL/);
});
test('actual Node reporter preserves failing child exit without leaking error details',async(t)=>{
 const dir=await mkdtemp(resolve(tmpdir(),'ci-reporter-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const fixture=resolve(dir,'fixture.test.mjs');
 await writeFile(fixture,"import test from 'node:test';import assert from 'node:assert/strict';test('SECRET-TITLE',()=>{console.log('SECRET-STDOUT');assert.equal('SECRET-A','SECRET-B');});\n");
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const run=spawnSync(process.execPath,['--test','--test-reporter='+resolve(root,'scripts/ci-test-progress-reporter.mjs'),fixture],{encoding:'utf8',env,timeout:15000});
 assert.equal(run.error,undefined);assert.equal(run.status,1);
 assert.match(run.stdout,/Native suite TOTAL tests=1 passed=0 failed=1/);
 assert.doesNotMatch(run.stdout+run.stderr,/SECRET-|fixture.test|ci-reporter-contract/);
});
test('Windows CI keeps the unfiltered serial test command and adds safe live progress',async()=>{
 const workflow=parse(await readFile(resolve(root,'.github/workflows/ci.yml'),'utf8'));
 const steps=workflow.jobs['windows-sea'].steps as {run?:string}[];
 const full=steps.filter(s=>s.run?.includes('--test-reporter=./scripts/ci-test-progress-reporter.mjs'));
 assert.equal(full.length,1);
 assert.equal(full[0]!.run,'npm test -- --test-concurrency=1 --test-reporter=./scripts/ci-test-progress-reporter.mjs');
 assert.equal(workflow.jobs['windows-sea']['continue-on-error'],undefined);
});


test('native reporter names a file-level task before its module imports or tests register',async(t)=>{
 const dir=await mkdtemp(resolve(tmpdir(),'ci-reporter-import-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {mkdir}=await import('node:fs/promises');await mkdir(resolve(dir,'test'));
 const fixture=resolve(dir,'test','import-failure.test.ts');
 await writeFile(fixture,"throw new Error('SECRET-IMPORT-ERROR');\n");
 const wrapper=resolve(dir,'reporter.mjs');
 const {pathToFileURL}=await import('node:url');
 await writeFile(wrapper,`import {createProgressReporter} from ${JSON.stringify(pathToFileURL(resolve(root,'scripts/ci-test-progress-reporter.mjs')).href)}; export default createProgressReporter(${JSON.stringify(dir)});\n`);
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const run=spawnSync(process.execPath,['--test','--test-reporter='+wrapper,fixture],{encoding:'utf8',env,timeout:15000});
 assert.equal(run.error,undefined);assert.equal(run.status,1);
 assert.match(run.stdout,/::notice::Native suite START test\/import-failure.test.ts/);
 assert.match(run.stdout,/::error::Native suite FAIL test\/import-failure.test.ts/);
 assert.doesNotMatch(run.stdout+run.stderr,/SECRET-|ci-reporter-import/);
});
