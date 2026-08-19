const SAFE_REQUEST_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
const SECRET_SHAPES = /(?:glpat-[A-Za-z0-9_-]+|hmr[ctx]1_[A-Za-z0-9_-]{43})/iu;

export interface RemoteMutationReceipt {
  readonly requestId: string | null;
}

export interface RemoteValueReceipt<T> extends RemoteMutationReceipt {
  readonly value: T;
}

export function safeRequestId(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): string | null {
  if (typeof value !== "string" || !SAFE_REQUEST_ID.test(value) || SECRET_SHAPES.test(value)) {
    return null;
  }
  const folded = value.toLowerCase();
  if (sensitiveValues.some((sensitive) =>
    typeof sensitive === "string" && sensitive !== "" &&
    folded.includes(sensitive.toLowerCase()))) {
    return null;
  }
  return value;
}

export function mutationReceipt(
  requestId: unknown = null,
  sensitiveValues: readonly string[] = [],
): RemoteMutationReceipt {
  return Object.freeze({ requestId: safeRequestId(requestId, sensitiveValues) });
}

export function valueReceipt<T>(
  value: T,
  requestId: unknown = null,
  sensitiveValues: readonly string[] = [],
): RemoteValueReceipt<T> {
  return Object.freeze({ requestId: safeRequestId(requestId, sensitiveValues), value });
}
