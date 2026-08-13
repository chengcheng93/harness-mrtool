import { rm } from "node:fs/promises";

import {
  createSeaBuildInputSnapshot,
  createSeaBuildReceiptFromSnapshot,
  writeSeaBuildReceipt,
} from "./sea-build-receipt.mjs";

function snapshotsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function orchestrateSeaBuild({
  artifactPath,
  buildArtifact,
  collectBuildInputPaths,
  receiptPath,
  repositoryRoot,
}) {
  const inputSnapshot = createSeaBuildInputSnapshot(
    repositoryRoot,
    collectBuildInputPaths(),
  );

  try {
    await buildArtifact();
    const finalInputSnapshot = createSeaBuildInputSnapshot(
      repositoryRoot,
      collectBuildInputPaths(),
    );
    if (!snapshotsMatch(inputSnapshot, finalInputSnapshot)) {
      throw new Error("SEA build inputs changed during build.");
    }
    writeSeaBuildReceipt(
      receiptPath,
      createSeaBuildReceiptFromSnapshot(
        repositoryRoot,
        artifactPath,
        inputSnapshot,
      ),
    );
  } catch (error) {
    await Promise.all([
      rm(artifactPath, { force: true }),
      rm(receiptPath, { force: true }),
    ]);
    throw error;
  }
}
