import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const testRoot = resolve(repositoryRoot, "test");

function discoverTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return discoverTests(path);
      }
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
    });
}

const forwardedArguments = process.argv.slice(2);
const pathFilters = [];
const runnerArguments = [];

for (let index = 0; index < forwardedArguments.length; index += 1) {
  const argument = forwardedArguments[index];
  if (argument === undefined) {
    continue;
  }
  if (argument.startsWith("-")) {
    runnerArguments.push(argument);
    if (
      ["--test-name-pattern", "--test-reporter", "--test-reporter-destination"].includes(
        argument,
      )
    ) {
      const value = forwardedArguments[index + 1];
      if (value !== undefined) {
        runnerArguments.push(value);
        index += 1;
      }
    }
    continue;
  }
  pathFilters.push(argument.replaceAll("\\", "/"));
}

const discoveredTests = discoverTests(testRoot);
const selectedTests = discoveredTests.filter((testPath) => {
  if (pathFilters.length === 0) {
    return true;
  }
  const portablePath = relative(repositoryRoot, testPath).replaceAll("\\", "/");
  return pathFilters.some((filter) => portablePath.includes(filter));
});

if (selectedTests.length === 0) {
  console.error(
    pathFilters.length === 0
      ? "No test files were discovered."
      : `No test files matched: ${pathFilters.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...runnerArguments, ...selectedTests],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "inherit",
      windowsHide: true,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
