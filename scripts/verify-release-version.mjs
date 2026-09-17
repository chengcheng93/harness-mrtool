import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SemVer } from "semver";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const components = new Set(["cli", "templates", "skill", "plugin"]);

function fail(message) {
  throw new Error(`Release version validation failed: ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} metadata must be an object`);
  }
  return value;
}

async function readMetadata(root, path) {
  let value;
  try {
    value = JSON.parse(await readFile(join(root, path), "utf8"));
  } catch {
    fail(`${path} metadata must be readable JSON`);
  }
  return record(value, path);
}

function canonicalVersion(value, label) {
  if (typeof value !== "string") fail(`${label} must be a canonical SemVer string`);
  let parsed;
  try {
    parsed = new SemVer(value, { loose: false });
  } catch {
    fail(`${label} must be a canonical SemVer string`);
  }
  const canonical = `${parsed.version}${parsed.build.length === 0 ? "" : `+${parsed.build.join(".")}`}`;
  if (value !== canonical) fail(`${label} must be a canonical SemVer string`);
  return value;
}

function equalVersion(actual, expected, label, expectedLabel) {
  if (actual !== expected) {
    fail(`${label} version ${actual} does not match ${expectedLabel} version ${expected}`);
  }
}

// Read-only metadata coherence gate. This does not authenticate release artifacts,
// signed receipts, tag ownership, or the provenance of the supplied local root.
export async function verifyReleaseVersion({ component, tag, root = repoRoot }) {
  if (!components.has(component)) fail("component must be cli, templates, skill, or plugin");
  if (typeof root !== "string" || root.trim() === "") fail("root must be a non-empty local path");
  const prefix = `${component}-v`;
  if (typeof tag !== "string" || !tag.startsWith(prefix)) fail(`tag must use the ${prefix} prefix`);
  const version = canonicalVersion(tag.slice(prefix.length), "tag version");
  const directory = resolve(root);
  const metadata = await readMetadata(directory, "package.json");
  const packageVersion = canonicalVersion(metadata.version, "package.json version");
  const lock = await readMetadata(directory, "package-lock.json");
  equalVersion(canonicalVersion(lock.version, "package-lock.json version"), packageVersion, "package-lock.json", "package.json");
  const packages = record(lock.packages, "package-lock.json packages");
  const lockedPackage = record(packages[""], 'package-lock.json packages[""]');
  equalVersion(canonicalVersion(lockedPackage.version, 'package-lock.json packages[""] version'), packageVersion,
    'package-lock.json packages[""]', "package.json");

  let selectedVersion = packageVersion;
  let selectedLabel = "package.json";
  if (component === "plugin" || component === "templates") {
    selectedLabel = component === "plugin"
      ? "plugins/harness-mrtool/.codex-plugin/plugin.json"
      : "template-bundle/bundle-manifest.json";
    const manifest = await readMetadata(directory, selectedLabel);
    selectedVersion = canonicalVersion(manifest.version, `${selectedLabel} version`);
    if (component === "plugin") equalVersion(selectedVersion, packageVersion, selectedLabel, "package.json");
  }
  equalVersion(version, selectedVersion, "tag", selectedLabel);
  return Object.freeze({ component, tag, version, packageVersion });
}

function cliArguments(argv) {
  const allowed = new Map([["--component", "component"], ["--tag", "tag"], ["--root", "root"]]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = allowed.get(argv[index]);
    if (key === undefined) fail("unknown argument; use --component, --tag, and optional --root");
    if (Object.hasOwn(options, key)) fail(`duplicate --${key} argument`);
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) fail(`--${key} requires a value`);
    options[key] = value;
  }
  if (!Object.hasOwn(options, "component") || !Object.hasOwn(options, "tag")) fail("--component and --tag are required");
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyReleaseVersion(cliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
