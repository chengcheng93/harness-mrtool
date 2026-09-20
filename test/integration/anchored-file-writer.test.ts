import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { writeAnchoredFile } from '../../src/platform/anchored-file-writer.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(resolve(await fs.realpath(tmpdir()), 'anchored-writer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = resolve(root, 'native');
  await fs.mkdir(directory, { mode: 0o700 });
  const { dev, ino } = await fs.lstat(directory, { bigint: true });
  const bytes = Uint8Array.from([0, 1, 255, 0, 128, 10, 13]);
  return { root, directory, expectedIdentity: { dev, ino }, name: 'harness-mrtool' as const, bytes };
}

for (const name of ['harness-mrtool', 'harness-mrtool.exe'] as const) {
  test(`writes exact bytes exclusively to pinned directory: ${name}`, async t => {
    const f = await fixture(t);
    await writeAnchoredFile({ ...f, name });
    assert.deepEqual(await fs.readFile(resolve(f.directory, name)), Buffer.from(f.bytes));
    if (process.platform !== 'win32') assert.equal((await fs.lstat(resolve(f.directory, name))).mode & 0o7777, 0o600);
    await assert.rejects(writeAnchoredFile({ ...f, name }), { code: 'UPDATE_SECURITY_ERROR' });
    assert.deepEqual(await fs.readFile(resolve(f.directory, name)), Buffer.from(f.bytes));
  });
}

test('wrong pinned identity rejects before any child file creation', async t => {
  const f = await fixture(t);
  await assert.rejects(writeAnchoredFile({ ...f, expectedIdentity: { ...f.expectedIdentity, ino: f.expectedIdentity.ino + 1n } }), { code: 'UPDATE_SECURITY_ERROR' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('rejects unsafe names, empty/oversized bytes and invalid identity before filesystem writes', async t => {
  const f = await fixture(t);
  for (const value of [
    { ...f, name: '../escape' }, { ...f, name: 'other' }, { ...f, directory: 'relative' },
    { ...f, bytes: new Uint8Array() }, { ...f, bytes: { length: 268435457 } },
    { ...f, expectedIdentity: { dev: '1', ino: 1n } }, { ...f, expectedIdentity: { dev: 1n, ino: -1n } },
  ]) await assert.rejects(writeAnchoredFile(value as Parameters<typeof writeAnchoredFile>[0]), { code: 'UPDATE_SECURITY_ERROR' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('copies input bytes and identity before its first asynchronous boundary', async t => {
  const f = await fixture(t), expected = Buffer.from(f.bytes);
  const pending = writeAnchoredFile(f);
  f.bytes.fill(33); f.expectedIdentity.ino = 0n;
  await pending;
  assert.deepEqual(await fs.readFile(resolve(f.directory, f.name)), expected);
});

test('existing symlink never changes its target', async t => {
  if (process.platform === 'win32') return t.skip('requires symlink privilege');
  const f = await fixture(t), target = resolve(f.root, 'outside');
  await fs.writeFile(target, 'preserved');
  await fs.symlink(target, resolve(f.directory, f.name));
  await assert.rejects(writeAnchoredFile(f), { code: 'UPDATE_SECURITY_ERROR' });
  assert.equal(await fs.readFile(target, 'utf8'), 'preserved');
});

test('linked directory rejects without even creating an empty target file', async t => {
  if (process.platform === 'win32') return t.skip('requires symlink privilege');
  const f = await fixture(t), moved = resolve(f.root, 'moved'), outside = resolve(f.root, 'outside');
  await fs.mkdir(outside); await fs.rename(f.directory, moved); await fs.symlink(outside, f.directory);
  await assert.rejects(writeAnchoredFile(f), { code: 'UPDATE_SECURITY_ERROR' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('replacement just before directory open rejects and never creates outside file', async t => {
  if (process.platform === 'win32') return t.skip('POSIX descriptor-open boundary');
  const f = await fixture(t), outside = resolve(f.root, 'outside'); await fs.mkdir(outside);
  const original = fs.open; let replaced = false;
  fs.open = (async (path: Parameters<typeof fs.open>[0], ...args: [number, number?]) => {
    if (String(path) === f.directory && !replaced) {
      replaced = true; await fs.rename(f.directory, resolve(f.root, 'moved')); await fs.symlink(outside, f.directory);
    }
    return original(path, ...args);
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try { await assert.rejects(writeAnchoredFile(f), { code: 'UPDATE_SECURITY_ERROR' }); }
  finally { fs.open = original; syncBuiltinESMExports(); }
  assert.equal(replaced, true); assert.deepEqual(await fs.readdir(outside), []);
});

test('parent replacement after fd pinning cannot redirect any child file creation', async t => {
  if (process.platform === 'win32') return t.skip('POSIX inherited-descriptor boundary');
  const f = await fixture(t), moved = resolve(f.root, 'moved'), outside = resolve(f.root, 'outside');
  await fs.mkdir(outside);
  const original = childProcess.spawn; let intercepted = false;
  // Spawn is synchronous. Schedule the real helper after a real parent swap,
  // using a wrapper executable is unnecessary: move synchronously here.
  const { renameSync, symlinkSync } = await import('node:fs');
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    intercepted = true; renameSync(f.directory, moved); symlinkSync(outside, f.directory);
    return original(...args);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try { await writeAnchoredFile(f); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert.equal(intercepted, true);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readFile(resolve(moved, f.name)), Buffer.from(f.bytes));
});

test('same-path replacement by another ordinary directory rejects pinned identity', async t => {
  const f = await fixture(t);
  await fs.rename(f.directory, resolve(f.root, 'old')); await fs.mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(writeAnchoredFile(f), { code: 'UPDATE_SECURITY_ERROR' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('helper failure is sanitized and never accepts partial protocol output', async t => {
  if (process.platform === 'win32') return t.skip('POSIX helper injection');
  const f = await fixture(t);
  const original = childProcess.spawn; const privateText = 'PRIVATE-helper-diagnostic';
  childProcess.spawn = ((..._args: Parameters<typeof childProcess.spawn>) => original('/usr/bin/perl', ['-e', `print "${privateText}"; print STDERR "${privateText}"; exit 1`], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } })) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeAnchoredFile(f), error => {
      assert.equal((error as { code?: string }).code, 'UPDATE_SECURITY_ERROR');
      assert.doesNotMatch(String(error) + JSON.stringify(error), new RegExp(privateText)); return true;
    });
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('deadline requests kill but rejection waits for confirmed helper termination', async t => {
  if (process.platform === 'win32') return t.skip('POSIX helper boundary');
  const f = await fixture(t);
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const original = childProcess.spawn;
  let spawned!: () => void; const ready = new Promise<void>(resolveReady => { spawned = resolveReady; });
  const helper = new EventEmitter() as childProcess.ChildProcess;
  helper.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  helper.stdout = new PassThrough(); let killed: string | number | undefined;
  helper.kill = (signal) => { killed = signal; return true; };
  childProcess.spawn = (() => { spawned(); return helper; }) as typeof childProcess.spawn;
  syncBuiltinESMExports(); const realTimeout = globalThis.setTimeout; t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let rejected = false;
    const rejection = assert.rejects(writeAnchoredFile(f), { code: 'UPDATE_SECURITY_ERROR' }).then(() => { rejected = true; });
    await ready; t.mock.timers.tick(60_000);
    await new Promise<void>(resolveTick => realTimeout(resolveTick, 30));
    assert.equal(killed, 'SIGKILL');
    assert.equal(rejected, false, 'a kill request is not evidence that background writes have stopped');
    helper.emit('close', null, 'SIGKILL');
    await rejection; assert.equal(rejected, true);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('helper invocation has no ambient shell or inherited environment injection', async t => {
  if (process.platform === 'win32') return t.skip('POSIX helper invocation');
  const f = await fixture(t), original = childProcess.spawn;
  let invocation: unknown[] | undefined;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => { invocation = args; return original(...args); }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try { await writeAnchoredFile(f); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert.equal(invocation?.[0], '/usr/bin/perl');
  const options = invocation?.[2] as childProcess.SpawnOptions;
  assert.equal(options.shell, false); assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' });
  assert.equal(typeof (options.stdio as unknown[])[3], 'number');
});

const realSetImmediate = setImmediate;

class ControlledWindowsWriter extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    return true;
  }
}

test('Windows helper startup READY starts the full write budget after Add-Type', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const systemRoot = process.env.SystemRoot;
  const originalSpawn = childProcess.spawn;
  const helper = new ControlledWindowsWriter();
  t.after(() => {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    helper.stdin.destroy(); helper.stdout.destroy(); helper.stderr.destroy();
    t.mock.timers.reset(); t.mock.restoreAll();
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.SystemRoot = 'C:\\Windows';
  childProcess.spawn = (() => helper) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = writeAnchoredFile({
    directory: 'C:\\state\\native', expectedIdentity: { dev: 1n, ino: 2n },
    name: 'harness-mrtool.exe', bytes: Uint8Array.of(1),
  });
  await new Promise<void>(resolveTick => realSetImmediate(resolveTick));
  t.mock.timers.tick(1_000);
  helper.stdout.write('READY\n');
  t.mock.timers.tick(59_000);
  assert.deepEqual(helper.kills, [], 'startup must not consume the full write budget');
  helper.stdout.write('OK\n'); helper.emit('close', 0, null);
  await pending;
});

test('Windows helper missing READY is hard-bounded and reaped before rejection', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const systemRoot = process.env.SystemRoot;
  const originalSpawn = childProcess.spawn;
  const helper = new ControlledWindowsWriter();
  t.after(() => {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    helper.stdin.destroy(); helper.stdout.destroy(); helper.stderr.destroy();
    t.mock.timers.reset(); t.mock.restoreAll();
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.SystemRoot = 'C:\\Windows';
  childProcess.spawn = (() => helper) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let rejected = false;
  const pending = assert.rejects(writeAnchoredFile({
    directory: 'C:\\state\\native', expectedIdentity: { dev: 1n, ino: 2n },
    name: 'harness-mrtool.exe', bytes: Uint8Array.of(1),
  }), { code: 'UPDATE_SECURITY_ERROR' }).then(() => { rejected = true; });
  await new Promise<void>(resolveTick => realSetImmediate(resolveTick));
  t.mock.timers.tick(10_000);
  assert.deepEqual(helper.kills, ['SIGKILL']);
  assert.equal(rejected, false, 'a kill request is not confirmed helper termination');
  helper.emit('close', null, 'SIGKILL');
  await pending;
  assert.equal(rejected, true);
});

// These are native Windows gates, not PE-byte fixtures executed on POSIX.
test('Windows native gate: rejects a junction even when it resolves to the expected inode', async t => {
  if (process.platform !== 'win32') return t.skip('requires native Windows kernel and PowerShell');
  const f = await fixture(t), moved = resolve(f.root, 'moved');
  await fs.rename(f.directory, moved); await fs.symlink(moved, f.directory, 'junction');
  await assert.rejects(writeAnchoredFile(f), { code: 'UPDATE_SECURITY_ERROR' });
  assert.deepEqual(await fs.readdir(moved), []);
});

test('Windows native gate: rejects a reparse ancestor before exclusive file creation', async t => {
  if (process.platform !== 'win32') return t.skip('requires native Windows kernel and PowerShell');
  const f = await fixture(t), moved = resolve(f.root, 'moved'), junction = resolve(f.root, 'junction');
  await fs.mkdir(moved); await fs.rename(f.directory, resolve(moved, 'native'));
  await fs.symlink(moved, junction, 'junction');
  await assert.rejects(writeAnchoredFile({ ...f, directory: resolve(junction, 'native') }), { code: 'UPDATE_SECURITY_ERROR' });
  assert.deepEqual(await fs.readdir(resolve(moved, 'native')), []);
});

test('Windows native gate: target and ancestor pins deny rename until streaming finishes', async t => {
  if (process.platform !== 'win32') return t.skip('requires native Windows kernel and PowerShell');
  const f = await fixture(t), original = childProcess.spawn;
  let release: (() => void) | undefined;
  let helper: childProcess.ChildProcess | undefined;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = original(...args); helper = child;
    const stdin = child.stdin!;
    const end = stdin.end.bind(stdin);
    stdin.end = ((...endArgs: Parameters<typeof end>) => {
      release = () => { release = undefined; end(...endArgs); };
      return child.stdin!;
    }) as typeof stdin.end;
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const pending = writeAnchoredFile(f);
  void pending.catch(() => undefined);
  try {
    // Exclusive creation precedes the helper's blocking read of the held stdin.
    const deadline = Date.now() + 40_000;
    for (;;) {
      try { await fs.lstat(resolve(f.directory, f.name)); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error; }
      await new Promise<void>(resume => setTimeout(resume, 25));
    }
    await assert.rejects(fs.rename(f.directory, resolve(f.root, 'moved')));
    await assert.rejects(fs.rename(f.root, `${f.root}-moved`));
    assert.ok(release); release(); await pending;
    assert.deepEqual(await fs.readFile(resolve(f.directory, f.name)), Buffer.from(f.bytes));
  } finally {
    childProcess.spawn = original; syncBuiltinESMExports(); release?.();
    if (helper?.exitCode === null) helper.kill('SIGKILL');
    await pending.catch(() => undefined);
  }
});

test('writes the fixed Windows transaction staging names in the pinned directory', async t => {
  if (process.platform === 'win32') return t.skip('POSIX mode assertion is not portable; Windows gate covers native helper');
  for (const name of ['harness-mrtool.exe.new', '.harness-mrtool-install.json.new'] as const) {
    const f = await fixture(t);
    await writeAnchoredFile({ ...f, name });
    assert.deepEqual(await fs.readFile(resolve(f.directory, name)), Buffer.from(f.bytes));
    assert.equal((await fs.lstat(resolve(f.directory, name))).mode & 0o7777, 0o600);
  }
});
