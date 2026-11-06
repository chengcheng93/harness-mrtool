import { verifyDiagnosticMarker } from "../render/marker.ts";

/** Restore the single terminal LF stripped by GitLab's description persistence. */
export function normalizeGitLabDescription(description: string): string {
  if (description.endsWith("\n") || !description.endsWith(" -->")) return description;
  const restored = `${description}\n`;
  try {
    // Only restore a complete managed description. Human prose, body edits and
    // malformed markers must retain their exact bytes and fail normal checks.
    verifyDiagnosticMarker(restored);
    return restored;
  } catch {
    return description;
  }
}
