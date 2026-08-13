import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { canonicalize } from "json-canonicalize";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function portableRelativePath(repositoryRoot, path) {
  const portablePath = relative(repositoryRoot, resolve(path)).split(sep).join("/");
  if (
    portablePath.length === 0 ||
    portablePath === ".." ||
    portablePath.startsWith("../")
  ) {
    throw new Error(`SEA build receipt path is outside the repository: ${path}`);
  }
  return portablePath;
}

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

export function collectSeaBuildInputs(repositoryRoot) {
  return [
    ...filesUnder(resolve(repositoryRoot, "src")),
    ...filesUnder(resolve(repositoryRoot, "schemas")),
    ...filesUnder(resolve(repositoryRoot, "template-bundle")),
    resolve(repositoryRoot, "scripts/build.mjs"),
    resolve(repositoryRoot, "scripts/build-sea.mjs"),
    resolve(repositoryRoot, "scripts/sea-build-orchestrator.mjs"),
    resolve(repositoryRoot, "scripts/sea-build-receipt.mjs"),
    resolve(repositoryRoot, "scripts/sea-verification.mjs"),
    resolve(repositoryRoot, "sea-config.json"),
    resolve(repositoryRoot, "package.json"),
    resolve(repositoryRoot, "package-lock.json"),
  ].sort((left, right) =>
    portableRelativePath(repositoryRoot, left).localeCompare(
      portableRelativePath(repositoryRoot, right),
    ),
  );
}

export function createSeaBuildReceipt(
  repositoryRoot,
  artifactPath,
  buildInputPaths,
) {
  return createSeaBuildReceiptFromSnapshot(
    repositoryRoot,
    artifactPath,
    createSeaBuildInputSnapshot(repositoryRoot, buildInputPaths),
  );
}

export function createSeaBuildInputSnapshot(repositoryRoot, buildInputPaths) {
  return buildInputPaths
    .map((path) => ({
      path: portableRelativePath(repositoryRoot, path),
      sha256: sha256(path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function createSeaBuildReceiptFromSnapshot(
  repositoryRoot,
  artifactPath,
  inputSnapshot,
) {
  return {
    artifact: {
      path: portableRelativePath(repositoryRoot, artifactPath),
      sha256: sha256(artifactPath),
    },
    inputs: inputSnapshot,
    schemaVersion: 1,
  };
}

export function writeSeaBuildReceipt(receiptPath, receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${canonicalize(receipt)}\n`, "utf8");
}

function assertExactKeys(value, expectedKeys, subject) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid SEA build receipt ${subject}.`);
  }
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error(`Invalid SEA build receipt ${subject} fields.`);
  }
}

function readAndValidateReceipt(receiptPath) {
  let receipt;
  let serializedReceipt;
  try {
    serializedReceipt = readFileSync(receiptPath, "utf8");
    receipt = JSON.parse(serializedReceipt);
  } catch (error) {
    throw new Error(
      `SEA build receipt is missing or invalid at ${receiptPath}. Run npm run build:sea before npm test.`,
      { cause: error },
    );
  }

  if (serializedReceipt !== `${canonicalize(receipt)}\n`) {
    throw new Error("SEA build receipt is not canonical JSON with an LF terminator.");
  }

  assertExactKeys(receipt, ["artifact", "inputs", "schemaVersion"], "root");
  if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.inputs)) {
    throw new Error("Invalid SEA build receipt schema version or inputs.");
  }
  assertExactKeys(receipt.artifact, ["path", "sha256"], "artifact");
  if (
    typeof receipt.artifact.path !== "string" ||
    !SHA256_PATTERN.test(receipt.artifact.sha256)
  ) {
    throw new Error("Invalid SEA build receipt artifact values.");
  }
  for (const input of receipt.inputs) {
    assertExactKeys(input, ["path", "sha256"], "input");
    if (typeof input.path !== "string" || !SHA256_PATTERN.test(input.sha256)) {
      throw new Error("Invalid SEA build receipt input values.");
    }
  }
  return receipt;
}

export function verifySeaBuildReceipt(
  repositoryRoot,
  artifactPath,
  buildInputPaths,
  receiptPath,
) {
  const receipt = readAndValidateReceipt(receiptPath);
  const expected = createSeaBuildReceipt(
    repositoryRoot,
    artifactPath,
    buildInputPaths,
  );

  if (receipt.artifact.path !== expected.artifact.path) {
    throw new Error("SEA build receipt artifact path mismatch.");
  }
  if (receipt.artifact.sha256 !== expected.artifact.sha256) {
    throw new Error("SEA build receipt artifact SHA-256 mismatch.");
  }
  if (receipt.inputs.length !== expected.inputs.length) {
    throw new Error("SEA build receipt input set mismatch.");
  }
  for (let index = 0; index < expected.inputs.length; index += 1) {
    const actualInput = receipt.inputs[index];
    const expectedInput = expected.inputs[index];
    if (actualInput.path !== expectedInput.path) {
      throw new Error("SEA build receipt input path or ordering mismatch.");
    }
    if (actualInput.sha256 !== expectedInput.sha256) {
      throw new Error(
        `SEA build receipt input SHA-256 mismatch for ${expectedInput.path}.`,
      );
    }
  }
}
