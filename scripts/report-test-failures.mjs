import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// This is diagnostic-only. The caller, never this parser, owns the test exit code.
const WINDOW_BYTES = 1024 * 1024;
const MAX_NAMES = 20;
const MAX_NAME_LENGTH = 200;
const MAX_LINE_LENGTH = 8192;
const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;

export function escapeWorkflowData(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function readWindow(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let used = 0;
  while (used < length) {
    const count = readSync(fd, buffer, used, length - used, position + used);
    if (count === 0) break;
    used += count;
  }
  return buffer.subarray(0, used).toString("utf8");
}

function openRegularFile(path) {
  // Do not follow a symlink or block on a FIFO supplied in place of a log.
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const nonBlock = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Not a regular file");
    return { fd, size: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readBoundedLog(path) {
  const { fd, size } = openRegularFile(path);
  try {
    if (size <= 2 * WINDOW_BYTES) return [readWindow(fd, 0, size)];
    const head = readWindow(fd, 0, WINDOW_BYTES);
    const tail = readWindow(fd, size - WINDOW_BYTES, WINDOW_BYTES);
    // Never splice windows or interpret partial records at their boundaries.
    return [
      head.slice(0, head.lastIndexOf("\n") + 1),
      tail.includes("\n") ? tail.slice(tail.indexOf("\n") + 1) : "",
    ];
  } finally {
    closeSync(fd);
  }
}

async function staticTestNames() {
  // A spec header alone is not trustworthy: assertion values and test stdout can
  // forge one. Only literal names in the checked-out test source may be emitted.
  // Dynamic names and file-level crashes intentionally fall back to a fixed error.
  const ts = await import("typescript");
  const names = new Set();
  let files = 0;
  let bytes = 0;
  let entries = 0;
  function visitDirectory(directory, depth = 0) {
    if (depth > 16) throw new Error("Source depth limit");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 4096) throw new Error("Source entry limit");
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        if (++files > MAX_SOURCE_FILES) throw new Error("Source file limit");
        const { fd, size } = openRegularFile(path);
        let source;
        try {
          bytes += size;
          if (size > MAX_SOURCE_FILE_BYTES || bytes > MAX_SOURCE_BYTES) {
            throw new Error("Source byte limit");
          }
          source = readWindow(fd, 0, size);
        } finally {
          closeSync(fd);
        }
        const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        function visit(node) {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const isTest = ts.isIdentifier(callee)
              ? ["test", "it", "describe"].includes(callee.text)
              : ts.isPropertyAccessExpression(callee) && (
                ["test", "it", "describe"].includes(callee.name.text) ||
                (ts.isIdentifier(callee.expression) &&
                  ["test", "it", "describe"].includes(callee.expression.text) &&
                  ["skip", "todo", "only"].includes(callee.name.text))
              );
            const name = node.arguments[0];
            if (isTest && name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) {
              names.add(name.text);
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(tree);
      }
    }
  }
  visitDirectory(resolve(import.meta.dirname, "../test"));
  return names;
}

export function parseFailureReport(chunks, knownNames) {
  const names = [];
  const seen = new Set();
  const counts = new Map();
  let invalidCounts = false;
  for (const chunk of chunks) {
    for (const rawLine of chunk.split("\n")) {
      if (rawLine.length > MAX_LINE_LENGTH) continue;
      const line = stripVTControlCharacters(rawLine).replace(/\r$/, "");
      const failure = /^[ \t]*✖ (.+) \(\d{1,10}(?:\.\d{1,10})?ms\)$/.exec(line);
      if (failure) {
        const name = failure[1];
        if (!/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(name) &&
            knownNames.has(name) && !seen.has(name) && names.length < MAX_NAMES) {
          seen.add(name);
          names.push(name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name);
        }
      }
      if (/^ℹ (tests|pass|fail)\b/.test(line)) {
        const count = /^ℹ (tests|pass|fail) ([0-9]{1,9})$/.exec(line);
        if (!count || (counts.has(count[1]) && counts.get(count[1]) !== line)) {
          invalidCounts = true;
        } else {
          counts.set(count[1], line);
        }
      }
    }
  }
  let summary = [];
  if (!invalidCounts && counts.size === 3) {
    const value = (key) => Number(counts.get(key).split(" ").at(-1));
    if (value("pass") + value("fail") <= value("tests")) {
      summary = [counts.get("tests"), counts.get("pass"), counts.get("fail")];
    }
  }
  return { names, summary };
}

async function main() {
  const [path, status] = process.argv.slice(2);
  if (status === "0") return;
  try {
    if (!path || !/^[1-9][0-9]{0,2}$/.test(status ?? "") || Number(status) > 255) {
      throw new Error("Invalid diagnostic arguments");
    }
    const { names, summary } = parseFailureReport(readBoundedLog(path), await staticTestNames());
    for (const name of names) {
      process.stdout.write(`::error::Test failed: ${escapeWorkflowData(name)}\n`);
    }
    if (names.length === 0) {
      process.stdout.write("::error::Test command failed; no allowlisted failure names found in bounded spec diagnostics.\n");
    }
    if (summary.length > 0) {
      process.stdout.write(`::error::${escapeWorkflowData(`Test command failed; safe numeric spec summary:\n${summary.join("\n")}`)}\n`);
    }
  } catch {
    // Never print an exception, input path, assertion, stack, or environment.
    process.stdout.write("::error::Test command failed; bounded spec diagnostics unavailable.\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
