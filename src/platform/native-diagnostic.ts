const DIAGNOSTIC = /^ERR:([a-z][a-z0-9-]{0,31})$/u;
const MAX_DIAGNOSTIC_BYTES = 128;

/** Converts only controlled native-helper stage tokens into CI-safe diagnostics. */
export function parseNativeStoreDiagnostic(output: string): string | undefined {
  if (typeof output !== "string" || output.length > MAX_DIAGNOSTIC_BYTES) return undefined;
  for (const line of output.split(/\r?\n/u)) {
    const match = DIAGNOSTIC.exec(line.trim());
    if (match !== null) return `native-store:${match[1]}`;
  }
  return undefined;
}
