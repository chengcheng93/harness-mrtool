import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const REQUIRED_NODE_VERSION = "24.16.0";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "src/main.ts");
const outputPath = resolve(repositoryRoot, "dist/main.cjs");
const packagePath = resolve(repositoryRoot, "package.json");
const templateBundlePath = resolve(repositoryRoot, "template-bundle");

// Node 24 strips the erasable TypeScript syntax in the production loader. Loading the
// Bundle here keeps the on-disk validation path as the single source for SEA bootstrap data.
const { loadTemplateBundle } = await import("../src/bundle/load.ts");
const bootstrapTemplateBundle = await loadTemplateBundle(templateBundlePath);

export function assertExactNodeVersion(actualVersion = process.versions.node) {
  if (actualVersion !== REQUIRED_NODE_VERSION) {
    throw new Error(
      `Node ${REQUIRED_NODE_VERSION} is required to build harness-mrtool; found ${actualVersion}.`,
    );
  }
}

export function readPackageVersion(metadataPath = packagePath) {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error(`Package metadata at ${metadataPath} has no valid version.`);
  }
  return metadata.version;
}

export function createApplicationBuildOptions(version) {
  return {
    entryPoints: [sourcePath],
    outfile: outputPath,
    bundle: true,
    packages: "bundle",
    mainFields: ["module", "main"],
    platform: "node",
    format: "cjs",
    target: "node24.16",
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    define: {
      __HARNESS_MRTOOL_VERSION__: JSON.stringify(version),
      __HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__: JSON.stringify(bootstrapTemplateBundle),
    },
  };
}

export async function buildApplication() {
  assertExactNodeVersion();
  await mkdir(dirname(outputPath), { recursive: true });
  await build(createApplicationBuildOptions(readPackageVersion()));
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildApplication();
}
