import { spawn } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { MAX_INPUT_BYTES } from "../input/load-input.ts";
import {
  ensurePrivateStateDirectory,
  type WindowsAclVerifier,
} from "../platform/state-path.ts";
import type { WizardLongFormEditor } from "./wizard.ts";

export interface WizardTempFile {
  readonly path: string;
}

export interface WizardTempStore {
  readonly create: (initialBytes: Uint8Array) => Promise<WizardTempFile>;
  readonly read: (file: WizardTempFile) => Promise<Uint8Array>;
  readonly remove: (file: WizardTempFile) => Promise<void>;
}

export interface WizardEditorProcessRunner {
  readonly run: (input: {
    readonly executable: string;
    readonly args: readonly string[];
  }) => Promise<{ readonly exitCode: number }>;
}

export interface SecureWizardLongFormEditorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly processRunner?: WizardEditorProcessRunner;
  readonly tempStore?: WizardTempStore;
}

export interface WizardEditorChildProcess {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type WizardEditorSpawn = (
  executable: string,
  args: readonly string[],
  options: { readonly shell: false; readonly stdio: "inherit"; readonly windowsHide: false },
) => WizardEditorChildProcess;

export interface NodeWizardEditorProcessRunnerOptions {
  readonly spawnProcess?: WizardEditorSpawn;
}

export interface NodeWizardTempStoreOptions {
  readonly tempRoot?: string;
  readonly windowsAclVerifier?: WindowsAclVerifier;
  readonly hooks?: {
    readonly afterOpenForRead?: (input: { readonly path: string }) => Promise<void>;
  };
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface NodeWizardTempRecord {
  readonly directoryPath: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly path: string;
}

function editorError(message: string, actual: string): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", message, {
    field: "editor",
    expected: "one configured editor process and a private bounded YAML temporary file",
    actual,
    safeNextStep: "Configure VISUAL or EDITOR, then restart the wizard; no remote write was attempted.",
  });
}

function parseEditorCommand(raw: string): { readonly executable: string; readonly args: readonly string[] } {
  if (raw.length > 4096 || /[\r\n\u0000]/u.test(raw)) {
    throw editorError("Interactive editor configuration is invalid", "invalid editor command");
  }
  const values: string[] = [];
  let current = "";
  let started = false;
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        started = true;
      } else {
        current += character;
        started = true;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        values.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== null) throw editorError("Interactive editor configuration is invalid", "invalid editor command");
  if (started) values.push(current);
  if (values.length === 0 || values.length > 32 || values.some((value) => value === "")) {
    throw editorError("Interactive editor configuration is invalid", "invalid editor command");
  }
  return Object.freeze({ executable: values[0]!, args: Object.freeze(values.slice(1)) });
}

function configuredEditor(environment: NodeJS.ProcessEnv): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  const visual = environment.VISUAL;
  const editor = environment.EDITOR;
  const selected = visual !== undefined && visual.trim() !== ""
    ? visual.trim()
    : editor !== undefined && editor.trim() !== ""
      ? editor.trim()
      : null;
  if (selected === null) {
    throw editorError("No interactive editor is configured", "VISUAL and EDITOR are unavailable");
  }
  return parseEditorCommand(selected);
}

function executionFailure(): ToolError<"INPUT_ERROR"> {
  return editorError("Interactive editor process failed", "editor did not complete successfully");
}

function readFailure(): ToolError<"INPUT_ERROR"> {
  return editorError("Interactive editor output could not be read safely", "edited temporary file is unavailable");
}

function cleanupFailure(): ToolError<"INPUT_ERROR"> {
  return editorError("Interactive editor temporary file cleanup failed", "private temporary file could not be removed");
}

function tempSecurityError(reason: string): ToolError<"INPUT_ERROR"> {
  return editorError("Interactive editor temporary file is unsafe", reason);
}

function tempTooLarge(): ToolError<"INPUT_TOO_LARGE"> {
  return new ToolError("INPUT_TOO_LARGE", "Structured input exceeds the 2 MiB limit", {
    field: "editor",
    expected: MAX_INPUT_BYTES,
    actual: "more than 2097152 bytes",
    safeNextStep: "Reduce the edited YAML payload to 2 MiB or less.",
  });
}

function directoryIdentity(info: BigIntStats): DirectoryIdentity {
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function sameDirectory(info: BigIntStats, identity: DirectoryIdentity): boolean {
  return info.dev === identity.dev && info.ino === identity.ino;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right) && left.size === right.size && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertPrivateDirectory(info: BigIntStats): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw tempSecurityError("private editor directory identity is invalid");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || info.uid !== BigInt(uid) || (info.mode & 0o077n) !== 0n) {
      throw tempSecurityError("private editor directory ownership or permissions changed");
    }
  }
}

function assertPrivateFile(info: BigIntStats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw tempSecurityError("edited YAML is not one private regular file");
  }
  if (info.size < 0n || info.size > BigInt(MAX_INPUT_BYTES)) throw tempTooLarge();
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || info.uid !== BigInt(uid) || (info.mode & 0o077n) !== 0n) {
      throw tempSecurityError("edited YAML ownership or permissions changed");
    }
  }
}

function ignoredMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeCreatedPath(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!ignoredMissing(error)) throw error;
  }
}

export function createNodeWizardTempStore(
  options: NodeWizardTempStoreOptions = {},
): WizardTempStore {
  const records = new WeakMap<object, NodeWizardTempRecord>();
  const tempRoot = options.tempRoot ?? tmpdir();
  return Object.freeze({
    create: async (initialBytes: Uint8Array): Promise<WizardTempFile> => {
      if (!(initialBytes instanceof Uint8Array)) {
        throw tempSecurityError("initial editor document is not a byte sequence");
      }
      if (initialBytes.byteLength > MAX_INPUT_BYTES) throw tempTooLarge();
      let directoryPath: string | undefined;
      let path: string | undefined;
      try {
        directoryPath = await mkdtemp(resolve(tempRoot, "harness-mrtool-editor-"));
        await ensurePrivateStateDirectory(directoryPath, {
          ...(options.windowsAclVerifier === undefined
            ? {}
            : { windowsAclVerifier: options.windowsAclVerifier }),
        });
        const directoryBefore = await lstat(directoryPath, { bigint: true });
        assertPrivateDirectory(directoryBefore);
        path = resolve(directoryPath, "request.yaml");
        const handle = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await handle.writeFile(initialBytes);
          if (process.platform !== "win32") await handle.chmod(0o600);
          await handle.sync();
          const opened = await handle.stat({ bigint: true });
          assertPrivateFile(opened);
          if (opened.size !== BigInt(initialBytes.byteLength)) {
            throw tempSecurityError("initial editor document was not written exactly");
          }
        } finally {
          await handle.close();
        }
        const [directoryAfter, fileAfter] = await Promise.all([
          lstat(directoryPath, { bigint: true }),
          lstat(path, { bigint: true }),
        ]);
        assertPrivateDirectory(directoryAfter);
        assertPrivateFile(fileAfter);
        if (!sameDirectory(directoryAfter, directoryIdentity(directoryBefore))) {
          throw tempSecurityError("private editor directory changed during creation");
        }
        const file = Object.freeze({ path });
        records.set(file, Object.freeze({
          directoryPath,
          directoryIdentity: directoryIdentity(directoryAfter),
          path,
        }));
        return file;
      } catch (error) {
        try {
          if (path !== undefined) await removeCreatedPath(path);
          if (directoryPath !== undefined) await rmdir(directoryPath);
        } catch {
          // A private leftover is safer than recursive cleanup of an untrusted replacement.
        }
        if (error instanceof ToolError &&
            (error.code === "INPUT_ERROR" || error.code === "INPUT_TOO_LARGE")) throw error;
        throw tempSecurityError("private editor file creation failed");
      }
    },
    read: async (file: WizardTempFile): Promise<Uint8Array> => {
      const record = records.get(file as object);
      if (record === undefined || file.path !== record.path) {
        throw tempSecurityError("editor temporary file handle is not recognized");
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const directoryBefore = await lstat(record.directoryPath, { bigint: true });
        assertPrivateDirectory(directoryBefore);
        if (!sameDirectory(directoryBefore, record.directoryIdentity)) {
          throw tempSecurityError("private editor directory identity changed");
        }
        if (process.platform === "win32") {
          await ensurePrivateStateDirectory(record.directoryPath, {
            ...(options.windowsAclVerifier === undefined
              ? {}
              : { windowsAclVerifier: options.windowsAclVerifier }),
          });
        }
        const pathBefore = await lstat(record.path, { bigint: true });
        assertPrivateFile(pathBefore);
        handle = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat({ bigint: true });
        assertPrivateFile(opened);
        if (!sameSnapshot(pathBefore, opened)) {
          throw tempSecurityError("edited YAML changed while it was opened");
        }
        await options.hooks?.afterOpenForRead?.({ path: record.path });

        const length = Number(opened.size);
        const bytes = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const result = await handle.read(bytes, offset, length - offset, offset);
          if (result.bytesRead === 0) throw tempSecurityError("edited YAML became shorter while reading");
          offset += result.bytesRead;
        }
        const extra = Buffer.alloc(1);
        if ((await handle.read(extra, 0, 1, length)).bytesRead !== 0) {
          throw tempSecurityError("edited YAML grew while reading");
        }
        const [handleAfter, pathAfter, directoryAfter] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(record.path, { bigint: true }),
          lstat(record.directoryPath, { bigint: true }),
        ]);
        assertPrivateFile(handleAfter);
        assertPrivateFile(pathAfter);
        assertPrivateDirectory(directoryAfter);
        if (
          !sameSnapshot(opened, handleAfter) || !sameSnapshot(handleAfter, pathAfter) ||
          !sameDirectory(directoryAfter, record.directoryIdentity)
        ) {
          throw tempSecurityError("edited YAML identity or contents changed during reading");
        }
        return bytes;
      } catch (error) {
        if (error instanceof ToolError &&
            (error.code === "INPUT_ERROR" || error.code === "INPUT_TOO_LARGE")) throw error;
        throw tempSecurityError("edited YAML could not be opened and verified");
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    remove: async (file: WizardTempFile): Promise<void> => {
      const record = records.get(file as object);
      if (record === undefined || file.path !== record.path) throw cleanupFailure();
      try {
        let directory: BigIntStats;
        try {
          directory = await lstat(record.directoryPath, { bigint: true });
        } catch (error) {
          if (ignoredMissing(error)) {
            records.delete(file as object);
            return;
          }
          throw error;
        }
        assertPrivateDirectory(directory);
        if (!sameDirectory(directory, record.directoryIdentity)) throw cleanupFailure();
        await removeCreatedPath(record.path);
        await rmdir(record.directoryPath);
        records.delete(file as object);
      } catch (error) {
        if (error instanceof ToolError && error.message === "Interactive editor temporary file cleanup failed") {
          throw error;
        }
        throw cleanupFailure();
      }
    },
  });
}

export function createNodeWizardEditorProcessRunner(
  options: NodeWizardEditorProcessRunnerOptions = {},
): WizardEditorProcessRunner {
  const spawnProcess: WizardEditorSpawn = options.spawnProcess ?? ((executable, args, spawnOptions) =>
    spawn(executable, [...args], spawnOptions));
  return Object.freeze({
    run: async ({
      executable,
      args,
    }: Parameters<WizardEditorProcessRunner["run"]>[0]): Promise<{ readonly exitCode: number }> => new Promise((resolve_, reject) => {
      let child: WizardEditorChildProcess;
      try {
        child = spawnProcess(executable, [...args], {
          shell: false,
          stdio: "inherit",
          windowsHide: false,
        });
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        resolve_({ exitCode: Number.isSafeInteger(code) ? code! : 1 });
      });
    }),
  });
}

export function createSecureWizardLongFormEditor(
  options: SecureWizardLongFormEditorOptions = {},
): WizardLongFormEditor {
  const processRunner = options.processRunner ?? createNodeWizardEditorProcessRunner();
  const tempStore = options.tempStore ?? createNodeWizardTempStore();
  return Object.freeze({
    edit: async ({ initialBytes }: Parameters<WizardLongFormEditor["edit"]>[0]): Promise<Uint8Array> => {
      const command = configuredEditor(options.environment ?? process.env);
      let file: WizardTempFile;
      try {
        file = await tempStore.create(initialBytes);
      } catch {
        throw editorError("Interactive editor temporary file could not be created", "private temporary file creation failed");
      }

      let primary: unknown;
      let output: Uint8Array | undefined;
      try {
        let result: { readonly exitCode: number };
        try {
          result = await processRunner.run({
            executable: command.executable,
            args: [...command.args, file.path],
          });
        } catch {
          throw executionFailure();
        }
        if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
          throw executionFailure();
        }
        try {
          const edited = await tempStore.read(file);
          if (!(edited instanceof Uint8Array)) throw new TypeError("invalid editor output");
          output = Buffer.from(edited);
        } catch {
          throw readFailure();
        }
      } catch (error) {
        primary = error;
      }

      try {
        await tempStore.remove(file);
      } catch {
        if (primary === undefined) throw cleanupFailure();
      }
      if (primary !== undefined) throw primary;
      return output!;
    },
  });
}
