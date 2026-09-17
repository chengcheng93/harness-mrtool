import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SIGNED_ENVELOPE_BYTES, requireCanonicalSemVer } from "../src/update/envelope.ts";
import { MAX_SKILL_ARCHIVE_BYTES, verifySkillPublicationReceipt } from "../src/skill/publication-receipt.ts";

function fail() { throw new Error("Skill publication input rejected"); }
const key = (path) => process.platform === "win32" ? path.toLowerCase() : path;
function same(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function boundedFile(input, maximum) {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) fail();
  const path = resolve(input), before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum) ||
      key(await realpath(path)) !== key(path)) fail();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !same(before, opened)) fail();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) fail();
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (!same(opened, after) || !same(opened, current) || current.isSymbolicLink() || current.nlink !== 1n ||
        key(await realpath(path)) !== key(path)) fail();
    return bytes;
  } finally { await handle.close(); }
}

/** Read-only bounded acquisition; authentication still requires verifySkillPublicationReceipt. */
export async function readSkillPublicationInputs({ archive, receipt, tag }) {
  if (typeof tag !== "string" || !tag.startsWith("skill-v")) fail();
  const version = requireCanonicalSemVer(tag.slice("skill-v".length));
  return { expectedTag: tag, expectedVersion: version,
    envelope: await boundedFile(receipt, MAX_SIGNED_ENVELOPE_BYTES),
    archiveBytes: await boundedFile(archive, MAX_SKILL_ARCHIVE_BYTES) };
}
function args(argv) {
  const fields = new Map([["--archive", "archive"], ["--receipt", "receipt"], ["--tag", "tag"]]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = fields.get(argv[index]), value = argv[index + 1];
    if (field === undefined || Object.hasOwn(result, field) || value === undefined || value.trim() === "" || value.startsWith("--")) fail();
    result[field] = value;
  }
  if (Object.keys(result).length !== fields.size) fail();
  return result;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // No key/trust/URL override or environment-derived roots: production configuration only.
    const checked = verifySkillPublicationReceipt(await readSkillPublicationInputs(args(process.argv.slice(2))));
    process.stdout.write(`${JSON.stringify({ purpose: checked.purpose, tag: checked.receipt.releaseTag,
      version: checked.receipt.version, skillProtocol: checked.receipt.skillProtocol, cliVersionRange: checked.receipt.cliVersionRange,
      signingKeyId: checked.signingKeyId, signingSequence: checked.receipt.signingSequence,
      receiptPayloadSha256: checked.payloadSha256, archiveSha256: checked.receipt.asset.sha256,
      archiveSize: checked.receipt.asset.size, treeSha256: checked.receipt.treeSha256 })}\n`);
  } catch {
    // Never echo paths, envelope contents, or arbitrary command-line values.
    process.stderr.write("Skill publication verification failed: input or authentication rejected\n");
    process.exitCode = 1;
  }
}
