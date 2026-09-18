import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
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
test('actual Node reporter with URL-significant filename preserves failing child exit without leaks',async(t)=>{
 const dir=await mkdtemp(resolve(tmpdir(),'ci-reporter-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(resolve(dir,'test'));await mkdir(resolve(dir,'scripts'));
 const fixture=resolve(dir,'test','assertion-failure.test.ts');
 const reporter=resolve(dir,'scripts','SECRET-reporter#%.mjs');
 await copyFile(resolve(root,'scripts/ci-test-progress-reporter.mjs'),reporter);
 await writeFile(fixture,"import test from 'node:test';import assert from 'node:assert/strict';test('SECRET-TITLE',()=>{console.log('SECRET-STDOUT');console.error('SECRET-STDERR');try{assert.equal('SECRET-A','SECRET-B');}catch(cause){throw new Error('SECRET-MESSAGE\\r\\n::error::SECRET-CONTROL',{cause});}});\n");
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const run=spawnSync(process.execPath,['--test','--test-reporter='+pathToFileURL(reporter).href,fixture],{encoding:'utf8',env,timeout:15000});
 assert.equal(run.error,undefined);assert.equal(run.status,1);
 assert.match(run.stdout,/Native suite TOTAL tests=1 passed=0 failed=1/);
 assert.match(run.stdout,/::error::Native suite FAIL test\/assertion-failure\.test\.ts line=1 failureType=testCodeFailure code=ERR_ASSERTION\n/);
 assert.doesNotMatch(run.stdout+run.stderr,/SECRET-|fixture.test|ci-reporter-contract/);
});
test('Windows CI keeps complete serial groups and adds safe live progress',async()=>{
 const workflow=parse(await readFile(resolve(root,'.github/workflows/ci.yml'),'utf8'));
 const steps=workflow.jobs['windows-sea'].steps as {run?:string}[];
 const full=steps.filter(s=>s.run?.includes('windows-suite-group.mjs'));
 assert.equal(full.length,1);
 assert.equal(full[0]!.run,'node scripts/windows-suite-group.mjs --group ${{ matrix.group }} --groups 4');
 assert.equal(workflow.jobs['windows-sea']['continue-on-error'],undefined);
});


test('native reporter with URL-significant filename names a file before import failure',async(t)=>{
 const dir=await mkdtemp(resolve(tmpdir(),'ci-reporter-import-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(resolve(dir,'test'));
 const fixture=resolve(dir,'test','import-failure.test.ts');
 await writeFile(fixture,"throw new Error('SECRET-IMPORT-ERROR');\n");
 const wrapper=resolve(dir,'SECRET-reporter#%.mjs');
 await writeFile(wrapper,`import {createProgressReporter} from ${JSON.stringify(pathToFileURL(resolve(root,'scripts/ci-test-progress-reporter.mjs')).href)}; export default createProgressReporter(${JSON.stringify(dir)});\n`);
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const run=spawnSync(process.execPath,['--test','--test-reporter='+pathToFileURL(wrapper).href,fixture],{encoding:'utf8',env,timeout:15000});
 assert.equal(run.error,undefined);assert.equal(run.status,1);
 assert.match(run.stdout,/::notice::Native suite START test\/import-failure.test.ts/);
 assert.match(run.stdout,/::error::Native suite FAIL test\/import-failure\.test\.ts line=1 failureType=testCodeFailure code=ERR_TEST_FAILURE\n/);
 assert.match(run.stdout,/Native suite TOTAL tests=1 passed=0 failed=1/);
 assert.doesNotMatch(run.stdout+run.stderr,/SECRET-|ci-reporter-import/);
});

const knownFile=resolve(import.meta.dirname,'ci-test-progress-reporter.test.ts');
const failPrefix='::error::Native suite FAIL test/contract/ci-test-progress-reporter.test.ts';
async function failure(error:unknown){
 return collect([{type:'test:fail',data:{file:knownFile,details:{error}}}]);
}

test('native CI reporter emits only fixed Node failure classifications',async()=>{
 const cases:[object,string][]=[
  [{failureType:'testTimeoutFailure',code:'ERR_TEST_FAILURE'},' failureType=testTimeoutFailure code=ERR_TEST_FAILURE'],
  [{failureType:'testCodeFailure',code:'ERR_ASSERTION'},' failureType=testCodeFailure code=ERR_ASSERTION'],
  [{failureType:'cancelledByParent',code:'ABORT_ERR'},' failureType=cancelledByParent code=ABORT_ERR'],
  [{failureType:'parentAlreadyFinished',code:'ETIMEDOUT'},' failureType=parentAlreadyFinished code=ETIMEDOUT'],
  [{failureType:'testAborted',code:'ENOENT'},' failureType=testAborted code=ENOENT'],
  [{failureType:'subtestsFailed',code:'EACCES'},' failureType=subtestsFailed code=EACCES'],
  [{failureType:'hookFailed',code:'EPERM'},' failureType=hookFailed code=EPERM'],
  [{failureType:'uncaughtException',code:'EBUSY'},' failureType=uncaughtException code=EBUSY'],
  [{failureType:'unhandledRejection',code:'ERR_MODULE_NOT_FOUND'},' failureType=unhandledRejection code=ERR_MODULE_NOT_FOUND'],
  [{code:'ERR_UNSUPPORTED_ESM_URL_SCHEME'},' code=ERR_UNSUPPORTED_ESM_URL_SCHEME'],
 ];
 for(const [error,suffix] of cases)assert.equal(await failure(error),failPrefix+suffix+'\n');
});

test('native CI reporter finds nested codes without reflecting unknown error metadata',async()=>{
 const nested=Object.assign(new Error('SECRET-MESSAGE',{cause:{code:'EPERM',message:'SECRET-CAUSE'}}),{
  code:'ERR_TEST_FAILURE',failureType:'testCodeFailure',stack:'SECRET-STACK',actual:'SECRET-A',expected:'SECRET-B',
 });
 assert.equal(await failure(nested),failPrefix+' failureType=testCodeFailure code=EPERM\n');
 assert.equal(await failure({details:{actual:'windows-helper:exclusive-create'}}),failPrefix+' diagnostic=windows-helper:exclusive-create\n');
 assert.equal(await failure({reason:'unavailable'}),failPrefix+' diagnostic=process-lock:unavailable\n');
 assert.equal(await failure({reason:'SECRET-REASON'}),failPrefix+'\n');
 assert.equal(await failure({details:{actual:'SECRET-PATH'}}),failPrefix+'\n');
 assert.equal(await failure({code:'ERR_ASSERTION',cause:{code:'EPERM'}}),failPrefix+' code=ERR_ASSERTION\n');
 assert.equal(await failure({code:'ERR_TEST_FAILURE',cause:{code:'ERR_SECRET_UNKNOWN',cause:{code:'ENOENT'}}}),failPrefix+' code=ENOENT\n');
 assert.equal(await failure({failureType:'SECRET-TYPE',cause:{failureType:'testTimeoutFailure',code:'ETIMEDOUT'}}),failPrefix+' failureType=testTimeoutFailure code=ETIMEDOUT\n');
});

test('native CI reporter rejects controls, unknown enums and coercible metadata',async()=>{
 const poison={toString(){throw new Error('SECRET-COERCION');},[Symbol.toPrimitive](){throw new Error('SECRET-COERCION');}};
 const values=[
  'SECRET-UNKNOWN','ERR_FUTURE_UNKNOWN','ERR_TEST_FAILURE\r\n::error::SECRET-CONTROL',
  'ERR_ASSERTION%0A::error::SECRET-CONTROL','testCodeFailure\u0000SECRET','testTimeoutFailure\u001b[31m',
  '/SECRET/path','C:\\SECRET\\path','ERR_ASSERTION ',42,NaN,null,undefined,poison,Symbol('SECRET'),1n,
 ];
 for(const value of values){
  assert.equal(await failure({failureType:value,code:value,message:'SECRET',stack:'SECRET'}),failPrefix+'\n');
  assert.equal(await failure({failureType:value,code:value,cause:{code:'EBUSY'}}),failPrefix+' code=EBUSY\n');
 }
});

test('native CI reporter bounds cause traversal to four objects including cycles',async()=>{
 const atLimit={cause:{cause:{cause:{failureType:'testTimeoutFailure',code:'ETIMEDOUT'}}}};
 assert.equal(await failure(atLimit),failPrefix+' failureType=testTimeoutFailure code=ETIMEDOUT\n');
 assert.equal(await failure({cause:atLimit}),failPrefix+'\n');
 const cyclic:{code:string;cause?:unknown}={code:'ERR_TEST_FAILURE'};cyclic.cause=cyclic;
 assert.equal(await failure(cyclic),failPrefix+' code=ERR_TEST_FAILURE\n');
 assert.equal(await failure({code:'ERR_TEST_FAILURE',cause:42}),failPrefix+' code=ERR_TEST_FAILURE\n');
});

test('native CI reporter reads only own data properties without invoking accessors',async()=>{
 let reads=0;
 const trap=()=>{reads++;throw new Error('SECRET-GETTER');};
 const inherited=Object.create({failureType:'testTimeoutFailure',code:'ETIMEDOUT',cause:{code:'EPERM'}});
 assert.equal(await failure(inherited),failPrefix+'\n');
 const accessor=Object.defineProperties({}, {failureType:{get:trap},code:{get:trap},cause:{get:trap}});
 assert.equal(await failure(accessor),failPrefix+'\n');
 const dataWithAccessor=Object.defineProperty({file:knownFile},'details',{get:trap});
 const detailsWithAccessor=Object.defineProperty({},'error',{get:trap});
 for(const data of [dataWithAccessor,{file:knownFile,details:detailsWithAccessor},Object.assign(Object.create({details:{error:{code:'EPERM'}}}),{file:knownFile}),{file:knownFile,details:Object.create({error:{code:'EPERM'}})}]){
  assert.equal(await collect([{type:'test:fail',data}]),failPrefix+'\n');
 }
 const hostile=new Proxy({}, {getOwnPropertyDescriptor(){throw new Error('SECRET-PROXY');}});
 assert.equal(await failure(hostile),failPrefix+'\n');
 assert.equal(reads,0);
 const own=Object.defineProperties(Object.create({code:'EPERM'}),{
  code:{value:'ERR_TEST_FAILURE'},cause:{value:Object.defineProperty({},'code',{value:'ENOENT'})},
 });
 assert.equal(await failure(own),failPrefix+' code=ENOENT\n');
});

test('native CI reporter emits one failure per file and keeps diagnostic summaries independent',async()=>{
 const text=await collect([
  {type:'test:fail',data:{file:knownFile,line:12,details:{error:{failureType:'testTimeoutFailure',code:'ERR_TEST_FAILURE'}}}},
  ...Array.from({length:50},()=>({type:'test:fail',data:{file:knownFile,name:'SECRET-TITLE',details:{error:{code:'ERR_ASSERTION'}}}})),
  {type:'test:summary',data:{counts:{tests:51,passed:0,failed:51,cancelled:0,skipped:0}}},
 ]);
 assert.equal(text,failPrefix+' line=12 failureType=testTimeoutFailure code=ERR_TEST_FAILURE\n'+'::notice::Native suite TOTAL tests=51 passed=0 failed=51 cancelled=0 skipped=0\n');
});
