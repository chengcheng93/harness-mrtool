import { statSync } from "node:fs";

export function assertArtifactIsFresh(
  artifactPath: string,
  buildInputPaths: readonly string[],
): void {
  let artifactModifiedAt: number;
  try {
    artifactModifiedAt = statSync(artifactPath).mtimeMs;
  } catch {
    throw new Error(
      `SEA executable is missing at ${artifactPath}. Run npm run build:sea before npm test.`,
    );
  }

  const newerInput = buildInputPaths.find(
    (inputPath) => statSync(inputPath).mtimeMs > artifactModifiedAt,
  );
  if (newerInput !== undefined) {
    throw new Error(
      `SEA executable is stale because ${newerInput} is newer. Run npm run build:sea before npm test.`,
    );
  }
}
