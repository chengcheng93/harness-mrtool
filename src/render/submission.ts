import { canonicalizeJson } from "../contracts/jcs.ts";

export interface SubmissionIdentity {
  readonly cliVersion: string;
  readonly issueIid: number;
  readonly targetProjectPath: string;
  readonly sourceHeadSha: string;
}

const PREFIX = "<!-- harness-mrtool:submission:v1 ";
const MAX_ENCODED_BYTES = 2048;

function validIdentity(value: unknown): value is SubmissionIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "cliVersion,issueIid,sourceHeadSha,targetProjectPath" &&
    typeof record.cliVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(record.cliVersion) &&
    Number.isSafeInteger(record.issueIid) && (record.issueIid as number) > 0 &&
    typeof record.targetProjectPath === "string" && record.targetProjectPath.length <= 512 &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(record.targetProjectPath) &&
    typeof record.sourceHeadSha === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(record.sourceHeadSha);
}

/** Identifies a creation-response submission; it is never verification evidence. */
export function appendSubmissionMarker(body: string, identity: SubmissionIdentity): string {
  if (typeof body !== "string" || body.includes(PREFIX) || !validIdentity(identity)) {
    throw new TypeError("Submission marker inputs are invalid");
  }
  const encoded = Buffer.from(canonicalizeJson({ ...identity }), "utf8").toString("base64url");
  if (encoded.length > MAX_ENCODED_BYTES) throw new TypeError("Submission marker is too large");
  return body.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "\n") + PREFIX + encoded + " -->\n";
}

export function isSubmissionDescription(description: string): boolean {
  if (typeof description !== "string") return false;
  const tail = description.slice(-(MAX_ENCODED_BYTES + PREFIX.length + 6));
  const match = /(?:^|\n)<!-- harness-mrtool:submission:v1 ([A-Za-z0-9_-]{1,2048}) -->\n?$/u.exec(tail);
  if (match === null || description.indexOf(PREFIX) !== description.lastIndexOf(PREFIX)) return false;
  try {
    const decoded = Buffer.from(match[1]!, "base64url").toString("utf8");
    const identity: unknown = JSON.parse(decoded);
    return validIdentity(identity) && Buffer.from(canonicalizeJson({ ...identity }), "utf8").toString("base64url") === match[1];
  } catch { return false; }
}
