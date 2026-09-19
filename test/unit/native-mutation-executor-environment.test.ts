import assert from "node:assert/strict";
import test from "node:test";

import { windowsNativeExecutorEnvironment } from "../../src/platform/native-mutation-executor.ts";

test("Windows native executor keeps the trusted host environment needed by PowerShell", () => {
  const environment = windowsNativeExecutorEnvironment({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\custom",
    TEMP: "C:\\Temp",
    TMP: "C:\\Tmp",
    KEEP: "yes",
  });
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.WINDIR, "C:\\Windows");
  assert.equal(environment.PATH, "C:\\custom");
  assert.equal(environment.TEMP, "C:\\Temp");
  assert.equal(environment.TMP, "C:\\Tmp");
  assert.equal(environment.KEEP, "yes");
});

test("Windows native executor derives missing host variables without accepting an untrusted root", () => {
  const environment = windowsNativeExecutorEnvironment({SystemRoot: "D:\\Windows"});
  assert.equal(environment.WINDIR, "D:\\Windows");
  assert.equal(environment.PATH, "D:\\Windows\\System32");
  assert.equal(environment.TEMP, "D:\\Windows\\Temp");
  assert.equal(environment.TMP, "D:\\Windows\\Temp");
  assert.throws(() => windowsNativeExecutorEnvironment({SystemRoot: "D:\\Windows\\..\\Windows"}), /Private state path is unsafe/u);
});
