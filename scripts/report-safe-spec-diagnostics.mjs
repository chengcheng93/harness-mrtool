import { readFileSync } from "node:fs";

// Diagnostic-only redaction for native Windows CI. Never echo spec lines: the
// input can contain paths, assertion payloads, stdout, or credentials.
const path = process.argv[2];
if (typeof path !== "string" || path.length === 0) process.exit(0);
let text;
try { text = readFileSync(path, "utf8"); } catch { process.exit(0); }
const safe = /(?:windows-helper|windows-lock-helper|native-store|native-readiness|managed-installation|update-state|installation-journal):[a-z-]{1,32}/gu;
const seen = new Set();
for (const match of text.matchAll(safe)) {
  const value = match[0];
  if (seen.has(value)) continue;
  seen.add(value);
  process.stdout.write(`::notice::Native safe diagnostic ${value}\n`);
}
