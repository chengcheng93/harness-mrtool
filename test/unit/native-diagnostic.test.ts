import assert from "node:assert/strict";
import test from "node:test";

import { parseNativeStoreDiagnostic } from "../../src/platform/native-diagnostic.ts";

test("native store diagnostics accept only bounded controlled stages", () => {
  assert.equal(parseNativeStoreDiagnostic("ERR:startup\n"), "native-store:startup");
  assert.equal(parseNativeStoreDiagnostic("noise\nERR:lock-open\n"), "native-store:lock-open");
  assert.equal(parseNativeStoreDiagnostic("ERR:bad stage\n"), undefined);
  assert.equal(parseNativeStoreDiagnostic("ERR:" + "x".repeat(33)), undefined);
  assert.equal(parseNativeStoreDiagnostic("C:\\secret\\token\n"), undefined);
});
