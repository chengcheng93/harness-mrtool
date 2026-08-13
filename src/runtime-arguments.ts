/**
 * Node reserves argv[0] and argv[1] for runtime entrypoints. In the pinned
 * Node SEA runtime both slots contain the executable path; ordinary Node uses
 * the Node executable and script path respectively.
 */
export function normalizeRuntimeArguments(runtimeArgv: readonly string[]): string[] {
  return runtimeArgv.slice(2);
}
