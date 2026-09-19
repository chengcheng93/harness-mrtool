import assert from 'node:assert/strict';
import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import {lstatSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {access, chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test, {type TestContext} from 'node:test';
import {zipSync} from 'fflate';
import {canonicalizeJson, sha256Utf8} from '../../src/contracts/jcs.ts';
import {createSuccessOutput, serializeOutput} from '../../src/contracts/output.ts';
import {withUpdateLock} from '../../src/platform/lock.ts';
import {createNativeExecutableStore} from '../../src/update/native-executable-store.ts';
import {createAuthenticatedReleaseSnapshot, type SupportedReleasePlatform} from '../../src/update/release-set-verifier.ts';
import {verifyNativeReadiness} from '../../src/update/native-readiness.ts';
import {nativeReleaseFixture} from '../helpers/native-release-fixture.ts';

const platform = process.platform === 'win32' ? 'windows-x64' : 'darwin-arm64';
const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type SpawnProbe = (path: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
async function cleanup(root: string) {
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    if (!(await lstat(path)).isDirectory()) continue;
    await chmod(path, 0o700);
    for (const entry of await readdir(path, {withFileTypes: true})) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(resolve(path, entry.name));
    }
  }
  await rm(root, {recursive: true, force: true});
}
async function setup(t: TestContext, realSea = false, target: SupportedReleasePlatform = platform) {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), 'native-readiness-test-'));
  t.after(() => cleanup(root));
  const f = await nativeReleaseFixture(target);
  if (realSea) {
    const executableName = target === 'windows-x64' ? 'harness-mrtool.exe' : 'harness-mrtool';
    const files: Record<string, Uint8Array> = {
      [executableName]: await readFile(resolve(import.meta.dirname, '../../dist/harness-mrtool.exe')),
      'bundle-receipt.envelope.json': f.options.templateReceipt,
      'THIRD_PARTY_NOTICES.md': Buffer.from('fixture notice'), 'licenses/Node.txt': Buffer.from('fixture license'),
    };
    files.SHA256SUMS = Buffer.from(Object.keys(files).sort().map(p => `${hash(files[p]!)}  ${p}`).join('\n') + '\n');
    f.options.cliArchive = zipSync(files, {level: 0});
    f.payload.components.cli.artifacts[target].sha256 = hash(f.options.cliArchive);
    f.payload.components.cli.artifacts[target].size = f.options.cliArchive.length;
    f.options.verified = f.verify();
  }
  const snapshot = await createAuthenticatedReleaseSnapshot(f.options);
  const options = {stateDirectory: root, platform: target, trustConfig: f.signed.trustConfig, windowsAclVerifier: allowTestAcl};
  const installed = target === platform ? await createNativeExecutableStore(options).materialize(snapshot) : undefined as never;
  const manifest = JSON.parse(Buffer.from(f.signed.assets.files.get('bundle-manifest.json')!).toString());
  const bundleManifestHash = sha256Utf8(canonicalizeJson(manifest) + '\n');
  const version = snapshot.record.cliVersion;
  const outputs = [
    JSON.stringify({ok: true, code: 'OK', sea: true, version}),
    JSON.stringify({ok: true, code: 'CONTRACT_PROBE_OK', sea: true, version, validOutputAccepted: true, invalidOutputRejected: true, requestValidAccepted: true, requestInvalidRejected: true}),
    JSON.stringify({ok: true, code: 'RENDERER_PROBE_OK', sea: true, version, titleAccepted: true, descriptionAccepted: true, markerVerified: true, projectTemplateAccepted: true, tamperRejected: true}),
    serializeOutput(createSuccessOutput({cliVersion: version, versions: {
      templateVersion: manifest.version, bundleHash: bundleManifestHash, inputSchema: manifest.inputSchema,
      policySchema: manifest.policySchema, releaseSetId: `embedded:${bundleManifestHash}`,
    }}, {data: {command: 'version', version, bundleId: manifest.bundleId, releaseTag: `templates-v${manifest.version}`}})),
  ];
  // Portable contract tests simulate the host only around the trusted spawn seam.
  // The separate target-mismatch and packaged-SEA tests use the real host.
  return {root, f, snapshot, options, installed, outputs, bundleManifestHash};
}
function simulatedHost(t: TestContext) {
  if (process.platform === 'linux') {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
    Object.defineProperty(process, 'arch', {...arch, value: 'arm64'});
    t.after(() => Object.defineProperty(process, 'arch', arch));
  }
}
function nodeChild(script: string, options: SpawnOptions) {
  return spawn(process.execPath, ['-e', script], options);
}

test('readiness derives the sealed executable and uses four fixed isolated readonly probes under a supplied lease', async t => {
  const f = await setup(t); simulatedHost(t);
  let calls = 0; let cwd = '';
  await writeFile(resolve(f.root, 'active-release-set.json'), 'existing-active-sentinel', {mode: 0o600});
  const expected = [
    ['self-test', '--output', 'json'], ['self-test', '--contract-probe', '--output', 'json'],
    ['self-test', '--renderer-probe', '--output', 'json'], ['version', '--offline', '--no-update', '--output', 'json'],
  ];
  const spawnProbe: SpawnProbe = (path, args, options) => {
    assert.equal(path, f.installed.path); assert.deepEqual(args, expected[calls]);
    assert.equal(options.shell, false); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.notEqual(options.cwd, f.root); cwd = String(options.cwd);
    assert.deepEqual(readdirSync(cwd), []);
    if (process.platform !== 'win32') assert.equal(lstatSync(cwd).mode & 0o777, 0o700);
    assert.ok(String(options.env?.XDG_STATE_HOME).startsWith(resolve(cwd, '..')));
    assert.deepEqual(readdirSync(String(options.env?.XDG_STATE_HOME)), []);
    assert.ok(options.env); assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.GITLAB_TOKEN, undefined); assert.equal(options.env.PATH, undefined);
    assert.notEqual(options.env.HOME, process.env.HOME);
    return nodeChild(`process.stdout.write(${JSON.stringify(f.outputs[calls++]!)});`, options);
  };
  await withUpdateLock(f.root, async lease => {
    assert.deepEqual(await verifyNativeReadiness(Object.assign({}, f.snapshot, {path: '/untrusted/executable', cliVersion: '99.0.0'}), {...f.options, nativeReadiness: {spawn: spawnProbe}}, lease), {
      cliVersion: '0.1.6', bundleManifestHash: f.bundleManifestHash,
    });
  });
  assert.equal(calls, 4); await assert.rejects(access(cwd), {code: 'ENOENT'}, 'native-readiness:cwd-cleanup');
  assert.equal(await readFile(resolve(f.root, 'active-release-set.json'), 'utf8'), 'existing-active-sentinel');
  await assert.rejects(access(resolve(f.root, 'releases')), {code: 'ENOENT'});
});

test('readiness rejects an authenticated archive for a different real OS/arch before spawn', async t => {
  const target = process.platform === 'win32' ? 'darwin-arm64' : 'windows-x64';
  const f = await setup(t, false, target); let calls = 0;
  await assert.rejects(verifyNativeReadiness(f.snapshot, {...f.options, nativeReadiness: {spawn: () => {calls++; throw Error('must not spawn');}}}), {code: 'UPDATE_SECURITY_ERROR'});
  assert.equal(calls, 0);
});

for (const damage of ['forged-snapshot', 'file-before', 'file-after', 'snapshot-during'] as const) {
  test(`readiness authenticates and reverifies real bytes: ${damage}`, async t => {
    const f = await setup(t); simulatedHost(t); let calls = 0;
    if (damage === 'forged-snapshot') f.snapshot.cliBytes[0] = f.snapshot.cliBytes[0]! ^ 1;
    if (damage === 'file-before') {await chmod(f.installed.path, 0o700); await writeFile(f.installed.path, 'bad'); await chmod(f.installed.path, 0o500);}
    const spawnProbe: SpawnProbe = (_path, _args, options) => {
      const index = calls++;
      if (damage === 'snapshot-during') f.snapshot.cliBytes.fill(0);
      const script = damage === 'file-after' ? `const fs=require('fs');fs.chmodSync(${JSON.stringify(f.installed.path)},0o700);fs.writeFileSync(${JSON.stringify(f.installed.path)},'tampered');fs.chmodSync(${JSON.stringify(f.installed.path)},0o500);` : '';
      return nodeChild(script + `process.stdout.write(${JSON.stringify(f.outputs[index])});`, options);
    };
    const operation = verifyNativeReadiness(f.snapshot, {...f.options, nativeReadiness: {spawn: spawnProbe}});
    if (damage === 'snapshot-during') {await operation; assert.equal(calls, 4);}
    else {await assert.rejects(operation, {code: 'UPDATE_SECURITY_ERROR'}); assert.equal(calls, damage === 'file-after' ? 1 : 0);}
  });
}

for (const failure of ['nonzero', 'signal', 'stderr', 'garbage', 'bom', 'sea-false', 'version', 'contract', 'renderer', 'bundle-hash', 'bundle-version', 'input-schema', 'policy-schema', 'duplicate-key', 'invalid-utf8', 'spawn-error', 'spawn-throw', 'timeout', 'stdout-limit', 'stderr-limit'] as const) {
  test(`readiness rejects ${failure}, sanitizes diagnostics and waits for child close`, async t => {
    const f = await setup(t); simulatedHost(t);
    let calls = 0; const children: ChildProcess[] = []; const closed: boolean[] = []; let cwd = '';
    const spawnProbe: SpawnProbe = (_path, _args, options) => {
      const index = calls++; cwd = String(options.cwd);
      if (failure === 'spawn-throw') throw Error('secret-child-output');
      let output = f.outputs[index]!;
      if (failure === 'bom') output = '\uFEFF' + output;
      if (failure === 'sea-false') output = output.replace('"sea":true', '"sea":false');
      if (failure === 'version') output = output.replaceAll('0.1.6', '9.9.9');
      if (failure === 'contract' && index === 1) output = output.replace('"invalidOutputRejected":true', '"invalidOutputRejected":false');
      if (failure === 'renderer' && index === 2) output = output.replace('"tamperRejected":true', '"tamperRejected":false');
      if (index === 3) {
        if (failure === 'bundle-hash') output = output.replaceAll(f.bundleManifestHash, 'f'.repeat(64));
        if (failure === 'bundle-version') output = output.replace(/"templateVersion":"[^"]+"/u, '"templateVersion":"9.9.9"');
        if (failure === 'input-schema') output = output.replace('"inputSchema":1', '"inputSchema":2');
        if (failure === 'policy-schema') output = output.replace('"policySchema":1', '"policySchema":2');
        if (failure === 'duplicate-key') output = output.replace('"ok":true', '"ok":false,"ok":true');
      }
      let script = `process.stdout.write(${JSON.stringify(output)});`;
      if (failure === 'nonzero') script = "process.stdout.write('secret-child-output');process.exitCode=3;";
      if (failure === 'signal') script = "process.kill(process.pid,'SIGKILL');";
      if (failure === 'stderr') script += "process.stderr.write('secret-child-output');";
      if (failure === 'garbage') script = "console.log('secret-child-output');";
      if (failure === 'invalid-utf8') script = 'process.stdout.write(Buffer.from([0xff]));';
      if (failure === 'timeout') script = "setInterval(()=>{},1000);";
      if (failure.endsWith('-limit')) script = `setInterval(()=>process.${failure === 'stdout-limit' ? 'stdout' : 'stderr'}.write('secret-child-output'.repeat(10000)),1);`;
      const child = failure === 'spawn-error' ? spawn(resolve(f.root, 'missing'), [], options) : nodeChild(script, options);
      children.push(child); closed.push(false); child.once('close', () => {closed[index] = true;}); return child;
    };
    const diagnostic = (suffix: string) => `native-readiness:${failure}-${suffix}`;
    const start = performance.now();
    await assert.rejects(verifyNativeReadiness(f.snapshot, {...f.options, nativeReadiness: {spawn: spawnProbe, timeoutMs: failure === 'timeout' ? 300 : 5000, maxOutputBytes: 4096}}), (error: any) => {
      assert.equal(error.code, 'UPDATE_SECURITY_ERROR', diagnostic('error-code')); assert.ok(!JSON.stringify(error).includes('secret-child-output'), diagnostic('diagnostic-redaction')); return true;
    });
    assert.ok(performance.now() - start < 7000, diagnostic('failure-timeout'));
    assert.equal(children.length > 0, failure !== 'spawn-throw', diagnostic('child-count'));
    assert.ok(closed.every(Boolean), diagnostic('child-close'));
    for (const child of children) if (child.pid) assert.throws(() => process.kill(child.pid!, 0));
    await assert.rejects(access(cwd), {code: 'ENOENT'});
  });
}

test('readiness shares one deadline across all probes rather than resetting each timeout', async t => {
  const f = await setup(t); simulatedHost(t); let calls = 0;
  const spawnProbe: SpawnProbe = (_path, _args, options) => nodeChild(`setTimeout(()=>process.stdout.write(${JSON.stringify(f.outputs[calls++]!)}),350);`, options);
  const start = performance.now();
  await assert.rejects(verifyNativeReadiness(f.snapshot, {...f.options, nativeReadiness: {spawn: spawnProbe, timeoutMs: 900}}), {code: 'UPDATE_SECURITY_ERROR'});
  assert.ok(calls >= 2, 'native-readiness:deadline-min-calls'); assert.ok(calls < 4, 'native-readiness:deadline-max-calls'); assert.ok(performance.now() - start < 1800, 'native-readiness:deadline-duration');
});


for (const controls of [{timeoutMs: 0}, {timeoutMs: 30_001}, {timeoutMs: NaN}, {maxOutputBytes: 0}, {maxOutputBytes: 65_537}]) {
  test(`readiness fails closed for invalid bounds ${JSON.stringify(controls)}`, async t => {
    const f = await setup(t); simulatedHost(t); let calls = 0;
    await assert.rejects(verifyNativeReadiness(f.snapshot, {...f.options, nativeReadiness: {
      ...controls, spawn: () => {calls++; throw Error('must not spawn');},
    }}), {code: 'UPDATE_SECURITY_ERROR'});
    assert.equal(calls, 0);
  });
}

test('readiness rejects untrusted signing roots and a lease for another state directory', async t => {
  const f = await setup(t); const other = await setup(t); simulatedHost(t); let calls = 0;
  const controls = {spawn: () => {calls++; throw Error('must not spawn');}};
  await assert.rejects(verifyNativeReadiness(f.snapshot, {...f.options, trustConfig: other.options.trustConfig, nativeReadiness: controls}), {code: 'UPDATE_SECURITY_ERROR'});
  await withUpdateLock(other.root, async lease => {
    await assert.rejects(verifyNativeReadiness(f.snapshot, {...f.options, nativeReadiness: controls}, lease), {code: 'UPDATE_SECURITY_ERROR'});
  });
  assert.equal(calls, 0);
});

test('readiness cannot materialize a missing candidate or follow a supplied executable path', async t => {
  const f = await setup(t); simulatedHost(t); await chmod(resolve(f.installed.path, '..'), 0o700); await rm(f.installed.path); await chmod(resolve(f.installed.path, '..'), 0o500); let calls = 0;
  await assert.rejects(verifyNativeReadiness(Object.assign({}, f.snapshot, {path: process.execPath}), {...f.options, nativeReadiness: {
    spawn: () => {calls++; throw Error('must not spawn');},
  }}), {code: 'UPDATE_SECURITY_ERROR'});
  assert.equal(calls, 0); await assert.rejects(access(f.installed.path), {code: 'ENOENT'});
});

test('actual packaged SEA authenticates an ephemeral-root signed archive and reports the embedded Bundle', async t => {
  const artifact = resolve(import.meta.dirname, '../../dist/harness-mrtool.exe');
  try {await access(artifact);} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return t.skip('packaged SEA unavailable; native CI builds it before the full suite');
    throw error;
  }
  const f = await setup(t, true);
  const ready = await verifyNativeReadiness(f.snapshot, f.options);
  assert.equal(ready.cliVersion, '0.1.6');
  assert.equal(ready.bundleManifestHash, f.bundleManifestHash);
});
