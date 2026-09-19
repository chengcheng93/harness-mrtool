import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { unzipSync } from "fflate";
// @ts-expect-error JS packaging helper.
import { packagePortableRelease, validateReleaseArchive, validateReleaseArchiveAndReceipt } from "../../scripts/package-portable.mjs";

// This fixture validates STRUCTURAL packaging only. A zero-filled signature is
// not trusted and must be rejected by the separate publication crypto verifier.
const receipt = Buffer.from(JSON.stringify({ payload: Buffer.from('{}\n').toString('base64url'),
  signatures: [{ algorithm: "Ed25519", keyId: "fixture-key", signature: Buffer.alloc(64).toString('base64url') }] })+'\n');
function macho(cpu = 0x0100000c, type = 2): Buffer {
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4);
  bytes.writeUInt32LE(type, 12); return bytes;
}
async function fixture(t: test.TestContext, bytes = macho()) {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), 'native-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { executablePath: resolve(root,'native'), receiptPath: resolve(root,'receipt.json'),
    noticesPath: resolve(root,'notices'), nodeLicensePath: resolve(root,'license'), outputPath: resolve(root,'release.zip') };
  for (const [p,b] of [[paths.executablePath,bytes],[paths.receiptPath,receipt],[paths.noticesPath,'notice'],[paths.nodeLicensePath,'license']] as const) await writeFile(p,b);
  return paths;
}

test('Darwin ARM64 package uses native executable name and exact checksums', async (t) => {
  const f = await fixture(t);
  await packagePortableRelease({ ...f, platform: 'darwin-arm64' });
  const bytes = await readFile(f.outputPath);
  const entries = unzipSync(bytes);
  assert.ok(entries['harness-mrtool']);
  assert.equal(entries['harness-mrtool.exe'], undefined);
  assert.equal(validateReleaseArchive(entries, { platform: 'darwin-arm64' }), true);
  assert.equal(validateReleaseArchiveAndReceipt(entries, receipt, { platform: 'darwin-arm64' }), true);
  assert.throws(() => validateReleaseArchive(entries), /archive tree/);
  assert.match(Buffer.from(entries.SHA256SUMS!).toString(), /  harness-mrtool\n/);
  // The central directory records Unix executable permissions, not mode0644.
  let found = false;
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
    const name = bytes.subarray(i+46,i+46+bytes.readUInt16LE(i+28)).toString();
    if (name === 'harness-mrtool') { assert.equal((bytes.readUInt32LE(i+38) >>> 16) & 0o777, 0o755); found = true; break; }
  }
  assert.equal(found, true);
});

for (const [name,bytes] of [['windows PE bytes',Buffer.from('MZ-not-Mach-O')], ['Intel Mach-O',macho(0x01000007)], ['dynamic library',macho(0x0100000c,6)], ['truncated',Buffer.alloc(8)]] as const) {
  test(`Darwin packaging refuses ${name} without publishing output`, async (t) => {
    const f = await fixture(t,bytes);
    await assert.rejects(packagePortableRelease({ ...f, platform:'darwin-arm64' }), /Mach-O|ARM64|executable/);
    await assert.rejects(access(f.outputPath), {code:'ENOENT'});
  });
}

test('unsupported targets fail rather than silently packaging Windows', async (t) => {
  const f = await fixture(t);
  await assert.rejects(packagePortableRelease({...f,platform:'linux-arm64'}), /platform|target/);
  await assert.rejects(access(f.outputPath), {code:'ENOENT'});
});

test('native checksum-consistent CPU substitution is rejected by format validation', async (t) => {
  const f=await fixture(t); await packagePortableRelease({...f,platform:'darwin-arm64'});
  const entries=unzipSync(await readFile(f.outputPath));
  const {createHash}=await import('node:crypto');
  entries['harness-mrtool']=Uint8Array.from(macho(0x01000007));
  const sums=Buffer.from(entries.SHA256SUMS!).toString().split('\n').map((l)=> l.endsWith('  harness-mrtool') ? createHash('sha256').update(entries['harness-mrtool']!).digest('hex')+'  harness-mrtool' : l).join('\n');
  entries.SHA256SUMS=Uint8Array.from(Buffer.from(sums));
  assert.throws(()=>validateReleaseArchive(entries,{platform:'darwin-arm64'}), /Mach-O|ARM64|executable/);
});

test('CI includes a real Darwin ARM64 build and no-exclusion suite without replacing Windows gates', async () => {
  const {parse} = await import('yaml');
  const workflow = parse(await readFile(resolve(import.meta.dirname,'../../.github/workflows/ci.yml'),'utf8'));
  const job = workflow.jobs['macos-arm64'];
  assert.ok(job, 'native macOS job is required');
  assert.equal(job['runs-on'], 'macos-15');
  const run = job.steps.map((s: {run?: string}) => s.run ?? '').join('\n');
  assert.match(run, /process\.arch.*arm64/s);
  assert.match(run, /npm run build:sea/);
  assert.match(run, /npm test -- --test-concurrency=1/);
  assert.match(run, /codesign --verify --strict/);
  assert.ok(workflow.jobs['windows-sea']);
  const windowsRun = workflow.jobs['windows-sea'].steps.map((s: {run?: string}) => s.run ?? '').join('\n');
  assert.match(windowsRun, /report-test-failures\.mjs/);
});
