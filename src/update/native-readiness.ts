import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {ToolError} from '../contracts/errors.ts';
import {canonicalizeJson, sha256Utf8} from '../contracts/jcs.ts';
import {serializeOutput, type OutputEnvelope} from '../contracts/output.ts';
import {parseStrictJson} from '../input/strict-json.ts';
import {assertUpdateLockLease, withUpdateLock} from '../platform/lock.ts';
import type {ProcessLockLease} from '../platform/process-lock.ts';
import {ensurePrivateStateDirectory} from '../platform/state-path.ts';
import {validateReleaseSetSnapshot, type ReleaseSetSnapshot} from './cache.ts';
import {createNativeExecutableStore, type NativeExecutableStoreOptions} from './native-executable-store.ts';
import {authenticateReleaseSnapshot} from './release-set-verifier.ts';

// Trusted in-process controls only. Never sourced from CLI flags or environment.
// The seam replaces spawning, NOT authentication, path derivation or host checks.
interface ReadinessControls {
  readonly nativeReadiness?: {
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly spawn?: (path: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  };
}
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
function rejected(): ToolError<'UPDATE_SECURITY_ERROR'> {
  return new ToolError('UPDATE_SECURITY_ERROR', 'Native candidate readiness verification failed', {
    field: 'update.executable', expected: 'authenticated native SEA and embedded Bundle passing bounded readonly probes',
    actual: 'native candidate rejected', safeNextStep: 'Keep the installed release; rebuild or restore the candidate before retrying.',
  });
}
function remaining(deadline: number): number {
  const value = Math.floor(deadline - performance.now());
  if (value < 1) throw rejected();
  return value;
}
function boundedInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw rejected();
  return value;
}
function hostMatches(platform: NativeExecutableStoreOptions['platform']): boolean {
  return (platform === 'darwin-arm64' && process.platform === 'darwin' && process.arch === 'arm64') ||
    (platform === 'windows-x64' && process.platform === 'win32' && process.arch === 'x64');
}

/** Bounded memory and one shared deadline; failure never leaves a live child. */
async function probe(
  executable: string, args: readonly string[], options: SpawnOptions,
  run: NonNullable<NonNullable<ReadinessControls['nativeReadiness']>['spawn']>,
  deadline: number, maxOutputBytes: number,
): Promise<string> {
  const timeout = remaining(deadline);
  return new Promise((resolveResult, reject) => {
    let child: ChildProcess;
    try {child = run(executable, args, options);} catch {reject(rejected()); return;}
    let failed = false;
    let bytes = 0;
    const output: Buffer[] = [];
    const terminate = () => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      // Do not let inherited pipe handles delay close after the direct child exits.
      child.stdout?.destroy(); child.stderr?.destroy();
    };
    const timer = setTimeout(terminate, timeout);
    child.once('error', terminate);
    child.stdout?.on('error', terminate);
    child.stderr?.on('error', terminate);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {terminate(); return;}
      output.push(chunk);
    });
    child.stderr?.on('data', () => {terminate();}); // Exact contract: stderr must be empty.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failed || code !== 0 || signal !== null || performance.now() >= deadline) {reject(rejected()); return;}
      try {resolveResult(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(Buffer.concat(output)));}
      catch {reject(rejected());}
    });
    if (!child.stdout || !child.stderr) terminate();
  });
}
function exact(stdout: string, expected: object): void {
  const text = JSON.stringify(expected);
  if (stdout !== text && stdout !== text + '\n' && stdout !== text + '\r\n') throw rejected();
}

/**
 * Readiness is not installation or latest-policy authorization. The caller still
 * owns its overall pre-business deadline and policy decision. timeoutMs can only
 * shorten this gate's 30-second budget, which includes all probes and lock wait.
 * Filesystem/authentication work is checked at each async boundary (not abandoned
 * via Promise.race); a killed child is always reaped before rejection/cleanup.
 */
export async function verifyNativeReadiness(
  snapshot: ReleaseSetSnapshot,
  input: NativeExecutableStoreOptions & ReadinessControls,
  lease?: ProcessLockLease,
): Promise<{cliVersion: string; bundleManifestHash: string}> {
  let isolation: string | undefined;
  try {
    const timeout = boundedInteger(input.nativeReadiness?.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxOutputBytes = boundedInteger(input.nativeReadiness?.maxOutputBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const deadline = performance.now() + timeout;
    const run = input.nativeReadiness?.spawn ?? spawn;
    const options: NativeExecutableStoreOptions = {...input};
    // Reject accessors before copying; never reread caller-owned byte buffers
    // after an async boundary, including between successive store verifications.
    for (const field of ['record', 'cliBytes', 'templateBytes', 'receiptBytes']) {
      const descriptor = Object.getOwnPropertyDescriptor(snapshot, field);
      if (!descriptor || !('value' in descriptor)) throw rejected();
    }
    const owned = validateReleaseSetSnapshot({record: snapshot.record, cliBytes: snapshot.cliBytes,
      templateBytes: snapshot.templateBytes, receiptBytes: snapshot.receiptBytes});
    const authenticated = await authenticateReleaseSnapshot(owned, options);
    remaining(deadline);
    if (!hostMatches(options.platform)) throw rejected();
    const cliVersion = authenticated.verified.manifest.components.cli.version;
    const manifest = authenticated.bundle.manifest;
    const bundleManifestHash = sha256Utf8(canonicalizeJson(manifest) + '\n');
    const store = createNativeExecutableStore(options);
    const verify = async (held: ProcessLockLease) => {
      assertUpdateLockLease(held, options.stateDirectory);
      remaining(deadline);
      isolation = await mkdtemp(resolve(await realpath(tmpdir()), 'harness-native-readiness-'));
      await ensurePrivateStateDirectory(isolation, options);
      const cwd = resolve(isolation, 'cwd');
      const state = resolve(isolation, 'state');
      const home = resolve(isolation, 'home');
      const temp = resolve(isolation, 'tmp');
      for (const path of [cwd, state, home, temp]) {
        await ensurePrivateStateDirectory(path, options); remaining(deadline);
      }
      // Explicit allowlist: no PATH, Node options, proxy settings, auth, Git or
      // application environment inherited from the invoking business process.
      const env: NodeJS.ProcessEnv = {NO_COLOR: '1', HOME: home, USERPROFILE: home,
        XDG_STATE_HOME: state, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
        LOCALAPPDATA: state, APPDATA: home, TMPDIR: temp, TMP: temp, TEMP: temp};
      if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
      const spawnOptions: SpawnOptions = {cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']};
      const runVerified = async (args: readonly string[]) => {
        held.assertHeld(); remaining(deadline);
        const executable = await store.verify(owned, held);
        remaining(deadline);
        if (!hostMatches(options.platform)) throw rejected();
        let stdout: string;
        try {stdout = await probe(executable.path, args, spawnOptions, run, deadline, maxOutputBytes);}
        finally {
          // Also verify after failed probes, only AFTER close has reaped the child.
          await store.verify(owned, held);
          held.assertHeld();
        }
        remaining(deadline);
        return stdout;
      };
      exact(await runVerified(['self-test', '--output', 'json']), {ok: true, code: 'OK', sea: true, version: cliVersion});
      exact(await runVerified(['self-test', '--contract-probe', '--output', 'json']), {
        ok: true, code: 'CONTRACT_PROBE_OK', sea: true, version: cliVersion,
        validOutputAccepted: true, invalidOutputRejected: true, requestValidAccepted: true, requestInvalidRejected: true,
      });
      exact(await runVerified(['self-test', '--renderer-probe', '--output', 'json']), {
        ok: true, code: 'RENDERER_PROBE_OK', sea: true, version: cliVersion,
        titleAccepted: true, descriptionAccepted: true, markerVerified: true, projectTemplateAccepted: true, tamperRejected: true,
      });
      const output = parseStrictJson(await runVerified(['version', '--offline', '--no-update', '--output', 'json'])) as unknown as OutputEnvelope;
      serializeOutput(output); // Reuse the public schema validator, not build scripts.
      if (!output.ok || output.code !== 'OK' || output.versions.cliVersion !== cliVersion ||
        output.versions.bundleHash !== bundleManifestHash || output.versions.templateVersion !== manifest.version ||
        output.versions.inputSchema !== manifest.inputSchema || output.versions.policySchema !== manifest.policySchema ||
        output.versions.releaseSetId !== `embedded:${bundleManifestHash}` || output.data?.command !== 'version' ||
        output.data.version !== cliVersion || output.data.bundleId !== manifest.bundleId ||
        output.update.checked || output.update.latestVersionConfirmed || output.remoteWrite.operations.length !== 0) throw rejected();
      remaining(deadline);
      return {cliVersion, bundleManifestHash};
    };
    return lease === undefined
      ? await withUpdateLock(options.stateDirectory, verify, {timeoutMs: remaining(deadline)})
      : await verify(lease);
  } catch {throw rejected();}
  finally {
    if (isolation !== undefined) {
      try {await rm(isolation, {recursive: true, force: true});} catch {throw rejected();}
    }
  }
}
