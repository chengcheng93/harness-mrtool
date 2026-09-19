import { readFileSync } from "node:fs";

// Diagnostic-only redaction for native Windows CI. Never echo spec lines: the
// input can contain paths, assertion payloads, stdout, or credentials.
const path = process.argv[2];
if (typeof path !== "string" || path.length === 0) process.exit(0);
let text;
try { text = readFileSync(path, "utf8"); } catch { process.exit(0); }
const safe = /(?:windows-helper|windows-lock-helper|native-store|native-readiness|managed-installation|update-state|installation-journal):[a-z-]{1,32}/gu;
const safeAssertions = [
  [/nested update-lock acquisition/gu, 'assertion:nested-lock'],
  [/Private state path is unsafe: Windows ACL verification failed at (?:setup|owner-setup|owner-other|owner-local-account|owner-users|owner-service|rules|inheritance|execution) stage/gu, 'windows-acl:rejected'],
  [/Private state path is unsafe: state directory cannot be securely prepared/gu, 'state-directory:prepare'],
];
const seen = new Set();
for (const match of text.matchAll(safe)) {
  const value = match[0];
  if (seen.has(value)) continue;
  seen.add(value);
  process.stdout.write(`::notice::Native safe diagnostic ${value}\n`);
}
for (const [pattern, value] of safeAssertions) {
  if (!pattern.test(text) || seen.has(value)) continue;
  seen.add(value);
  process.stdout.write(`::notice::Native safe diagnostic ${value}\n`);
}
const safeLocations = [
  [/test[\\/]integration[\\/]update-transaction-lease\.test\.ts:(\d+):\d+/gu, 'assertion:update-lease-line-'],
  [/test[\\/]integration[\\/]production-migration-adapter\.test\.ts:(\d+):\d+/gu, 'assertion:production-migration-line-'],
  [/test[\\/]integration[\\/]native-executable-store\.test\.ts:(\d+):\d+/gu, 'assertion:native-store-line-'],
  [/test[\\/]integration[\\/]native-readiness\.test\.ts:(\d+):\d+/gu, 'assertion:native-readiness-line-'],
  [/test[\\/]contract[\\/]gitlab-client\.test\.ts:(\d+):\d+/gu, 'assertion:gitlab-client-line-'],
];
for (const [pattern, prefix] of safeLocations) {
  for (const match of text.matchAll(pattern)) {
    const line = Number(match[1]);
    const value = `${prefix}${line}`;
    if (!Number.isSafeInteger(line) || line < 1 || line > 2000 || seen.has(value)) continue;
    seen.add(value);
    process.stdout.write(`::notice::Native safe diagnostic ${value}\n`);
  }
}

const safeCodes = new Set(['OK', 'UPDATE_SECURITY_ERROR', 'INTERNAL_ERROR', 'TEMPLATE_ERROR', 'MANUAL_DESCRIPTION_CHANGE', 'INPUT_ERROR', 'UNMANAGED_MR', 'PARTIAL_DRAFT', 'PARTIAL_REMOTE_STATE']);
for (const match of text.matchAll(/"code":"([A-Z_]{2,48})"/gu)) {
  const code = match[1];
  if (!safeCodes.has(code)) continue;
  const value = `output-code:${code.toLowerCase().replaceAll('_', '-')}`;
  if (seen.has(value)) continue;
  seen.add(value);
  process.stdout.write(`::notice::Native safe diagnostic ${value}\n`);
}
