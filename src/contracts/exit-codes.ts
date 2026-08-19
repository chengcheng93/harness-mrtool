import type { ResultCode } from "./errors.ts";

export type RemoteWriteState =
  | "not-attempted"
  | "not-written"
  | "written"
  | "compensated"
  | "unknown";

export interface RemoteWrite {
  readonly state: RemoteWriteState;
  readonly operations: readonly string[];
}

export interface ExitCodeContext {
  readonly code: ResultCode;
  readonly remoteWriteState: RemoteWriteState;
}

export function exitCodeFor({
  code,
  remoteWriteState,
}: ExitCodeContext): number {
  if (code === "OK" || code === "UPDATE_CHECK_WARNING") {
    return 0;
  }
  if (
    remoteWriteState === "written" ||
    remoteWriteState === "compensated" ||
    remoteWriteState === "unknown"
  ) {
    return 6;
  }

  switch (code) {
    case "UPDATE_SECURITY_ERROR":
    case "UPDATE_REQUIRED":
      return 5;
    case "REPOSITORY_ERROR":
    case "AUTH_ERROR":
      return 3;
    case "GITLAB_ERROR":
    case "CONCURRENT_UPDATE":
      return 4;
    case "POSTCONDITION_ERROR":
    case "PARTIAL_DRAFT":
    case "PARTIAL_REMOTE_STATE":
      return 6;
    case "INTERNAL_ERROR":
      return 7;
    case "PROFILE_REQUIRED":
    case "TEMPLATE_ERROR":
    case "POLICY_ERROR":
    case "LABEL_ERROR":
    case "INPUT_ERROR":
    case "INPUT_TOO_LARGE":
    case "RENDER_ERROR":
    case "MANUAL_DESCRIPTION_CHANGE":
    case "UNMANAGED_MR":
      return 2;
  }

  const unhandled: never = code;
  throw new TypeError(`Unhandled result code: ${String(unhandled)}`);
}
