import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
const root = resolve(import.meta.dirname, "../..");
async function request() { return JSON.parse(await readFile(resolve(root, "examples/request.json"), "utf8")); }
test("new submission is accepted without a legacy Issue reason or IID", async () => {
 const raw = await request(); raw.workItem = { relation: "new" };
 assert.deepEqual(normalizeAndValidateRequest(raw).workItem, { relation: "new" });
});
test("omitted workItem defaults to creating a new Issue", async () => {
 const raw = await request(); delete raw.workItem;
 assert.deepEqual(normalizeAndValidateRequest(raw).workItem, { relation: "new" });
});
test("explicit legacy workItem retains its caller-selected meaning", async () => {
 const raw = await request(); const previous = structuredClone(raw.workItem);
 assert.deepEqual(normalizeAndValidateRequest(raw).workItem, previous);
 raw.workItem = { relation: "closes", iid: 42 };
 assert.deepEqual(normalizeAndValidateRequest(raw).workItem, { relation: "closes", iid: 42 });
});
test("new Issue mode cannot smuggle an existing IID", async () => {
 const raw = await request(); raw.workItem = { relation: "new", iid: 42 };
 assert.throws(() => normalizeAndValidateRequest(raw));
});
