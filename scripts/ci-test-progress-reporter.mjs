import {readdirSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MAX_FILES = 512;
const MAX_LINE = 1_000_000;
const MAX_COUNT = 1_000_000;

// Only source-controlled-shaped test paths discovered in this checkout may be
// emitted. Never include test titles, diagnostics, errors, stdout or stderr.
function testPaths(root) {
  const result = new Map();
  let scanned = 0;
  function walk(path, depth) {
    if (depth > 8) throw new Error('Test inventory exceeds its bounds');
    for (const entry of readdirSync(path, {withFileTypes:true})) {
      if (++scanned > 4096) throw new Error('Test inventory exceeds its bounds');
      if (entry.isSymbolicLink()) continue;
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) {walk(full, depth+1); continue;}
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
      const name = relative(root,full).split(sep).join('/');
      if (!/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.test\.ts$/u.test(name) || name.length > 256) continue;
      if (result.size >= MAX_FILES) throw new Error('Test inventory exceeds its bounds');
      result.set(full,name);
    }
  }
  walk(resolve(root,'test'),0);
  return result;
}
function counts(data) {
  const c = data?.counts;
  const fields = ['tests','passed','failed','cancelled','skipped'];
  if (c === null || typeof c !== 'object' || fields.some(key =>
    !Number.isSafeInteger(c[key]) || c[key] < 0 || c[key] > MAX_COUNT)) return null;
  return fields.map(key => `${key}=${c[key]}`).join(' ');
}

/** Streaming CI diagnostics only. Node's test runner retains exit-code authority. */
export function createProgressReporter(root = ROOT) {
  const paths = testPaths(resolve(root));
  return async function* progress(source) {
    const started = new Set();
    const failed = new Set();
    const finished = new Set();
    let total = false;
    for await (const event of source) {
      const data = event?.data;
      const path = typeof data?.file === 'string' ? paths.get(data.file) : undefined;
      if (event?.type === 'test:dequeue' && path !== undefined && !started.has(path)) {
        started.add(path);
        yield `::notice::Native suite START ${path}\n`;
      } else if (event?.type === 'test:fail' && path !== undefined && !failed.has(path)) {
        failed.add(path);
        const line = Number.isSafeInteger(data.line) && data.line > 0 && data.line <= MAX_LINE ? ` line=${data.line}` : '';
        yield `::error::Native suite FAIL ${path}${line}\n`;
      } else if (event?.type === 'test:summary') {
        const summary = counts(data);
        if (summary === null) continue;
        if (path !== undefined && !finished.has(path)) {
          finished.add(path);
          yield `::notice::Native suite DONE ${path} ${summary}\n`;
        } else if (data.file === undefined && !total) {
          total = true;
          yield `::notice::Native suite TOTAL ${summary}\n`;
        }
      }
    }
  };
}
export default createProgressReporter();
