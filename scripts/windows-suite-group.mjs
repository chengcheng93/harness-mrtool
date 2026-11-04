import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TEST_ROOT = resolve(ROOT, "test");
const MAX_GROUPS = 16;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) fail(`Missing ${name}`);
  return process.argv[index + 1];
}

const group = Number(argument("--group"));
const groups = Number(argument("--groups"));
if (!Number.isSafeInteger(group) || !Number.isSafeInteger(groups) || groups < 1 || groups > MAX_GROUPS || group < 0 || group >= groups) {
  fail("Invalid Windows suite group selection");
}

function discover(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...discover(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) result.push(path);
  }
  return result;
}

function weight(path) {
  const relativePath = relative(ROOT, path).split(sep).join("/");
  const size = statSync(path).size;
  const multiplier = relativePath.includes("verification-receipt-store") ? 5
    : relativePath.includes("native-executable-store") ? 4
      : relativePath.includes("anchored-file-writer") || relativePath.includes("process-lock") ? 3 : 1;
  return Math.max(1, size) * multiplier;
}

const files = discover(TEST_ROOT).sort();
if (files.length < groups) fail("Windows suite has fewer files than requested groups");
const buckets = Array.from({ length: groups }, () => ({ files: [], weight: 0 }));
for (const path of [...files].sort((left, right) => weight(right) - weight(left) || left.localeCompare(right))) {
  const target = buckets.reduce((best, candidate) => candidate.weight < best.weight ? candidate : best);
  target.files.push(path);
  target.weight += weight(path);
}
const selected = buckets[group].files.sort();
if (selected.length === 0) fail("Windows suite group is empty");

const result = spawnSync(process.execPath, [
  resolve(ROOT, "scripts/test.mjs"),
  "--test-concurrency=1",
  "--test-reporter=./scripts/ci-test-progress-reporter.mjs",
  ...selected.map((path) => relative(ROOT, path).split(sep).join("/")),
], { cwd: ROOT, stdio: "inherit", windowsHide: true });
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
