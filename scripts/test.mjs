import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const testRoot = resolve(repositoryRoot, "test");
const matchReporterPath = resolve(import.meta.dirname, "test-match-reporter.mjs");

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
let hasNamePattern = false;
let hasCallerReporter = false;

for (let index = 0; index < forwardedArguments.length; index += 1) {
  const argument = forwardedArguments[index];
  if (argument === undefined) {
    continue;
  }
  if (argument.startsWith("-")) {
    if (
      argument === "--test-name-pattern" ||
      argument.startsWith("--test-name-pattern=")
    ) {
      hasNamePattern = true;
    }
    if (
      argument === "--test-reporter" ||
      argument.startsWith("--test-reporter=") ||
      argument === "--test-reporter-destination" ||
      argument.startsWith("--test-reporter-destination=")
    ) {
      hasCallerReporter = true;
    }
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

if (hasNamePattern && hasCallerReporter) {
  process.stderr.write(
    "--test-name-pattern cannot be combined with --test-reporter or --test-reporter-destination.\n",
  );
  process.exitCode = 2;
} else {
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
    const matchReportDirectory = hasNamePattern
      ? mkdtempSync(join(tmpdir(), "harness-mrtool-test-match-"))
      : undefined;
    const matchReportPath =
      matchReportDirectory === undefined
        ? undefined
        : resolve(matchReportDirectory, "report.json");

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--test",
          ...(hasNamePattern
            ? [`--test-reporter=${pathToFileURL(matchReporterPath).href}`]
            : []),
          ...runnerArguments,
          ...selectedTests,
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env:
            matchReportPath === undefined
              ? process.env
              : {
                  ...process.env,
                  HARNESS_MRTOOL_TEST_MATCH_REPORT: matchReportPath,
                },
          stdio: "inherit",
          windowsHide: true,
        },
      );

      if (result.error !== undefined) {
        throw result.error;
      }
      if (result.status !== 0 || matchReportPath === undefined) {
        process.exitCode = result.status ?? 1;
      } else {
        const report = JSON.parse(readFileSync(matchReportPath, "utf8"));
        if (report.schemaVersion !== 1 || report.matchedTests === 0) {
          console.error("No non-skipped test cases matched --test-name-pattern.");
          process.exitCode = 1;
        } else {
          process.exitCode = 0;
        }
      }
    } finally {
      if (matchReportDirectory !== undefined) {
        rmSync(matchReportDirectory, { recursive: true, force: true });
      }
    }
  }
}
