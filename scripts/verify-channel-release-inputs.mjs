import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTrustState } from "../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../src/update/manifest.ts";
import { createProductionUpdateTrustConfig } from "../src/update/trust-config.ts";

const MAX_ENVELOPE_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message = "channel release input verification failed") {
  throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) fail(`missing ${name}`);
  return process.argv[index + 1];
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBounded(path, maxBytes) {
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) fail("channel release asset exceeds its bound");
  return bytes;
}

function assertAsset(name, bytes, expected) {
  if (expected === undefined || expected.name !== name || !SHA256.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) || expected.size < 1 ||
      expected.size !== bytes.length || expected.sha256 !== hash(bytes)) {
    fail("channel manifest asset does not match the verified release asset");
  }
}

export async function verifyChannelReleaseInputs({
  envelopePath,
  cliTag,
  templateTag,
  skillTag,
  windowsArchivePath,
  darwinArchivePath,
  templateArchivePath,
  skillArchivePath,
}) {
  const envelopeBytes = await readBounded(envelopePath, MAX_ENVELOPE_BYTES);
  const trustConfig = createProductionUpdateTrustConfig();
  const verified = verifyChannelEnvelope(
    envelopeBytes,
    createTrustState(trustConfig.bootstrapKeys),
    trustConfig.repository,
    trustConfig.bootstrapKeys,
  );
  const manifest = verified.manifest;
  if (manifest.components.cli.tag !== cliTag || manifest.releaseSet.cli !== cliTag ||
      manifest.components.templates.tag !== templateTag || manifest.releaseSet.templates !== templateTag ||
      manifest.components.skill.tag !== skillTag) {
    fail("channel manifest tags do not match the immutable release inputs");
  }

  const [windowsArchive, darwinArchive, templateArchive, skillArchive] = await Promise.all([
    readBounded(windowsArchivePath, 256 * 1024 * 1024),
    readBounded(darwinArchivePath, 256 * 1024 * 1024),
    readBounded(templateArchivePath, 32 * 1024 * 1024),
    readBounded(skillArchivePath, 16 * 1024 * 1024),
  ]);
  assertAsset(
    basename(windowsArchivePath),
    windowsArchive,
    manifest.components.cli.artifacts["windows-x64"],
  );
  assertAsset(
    basename(darwinArchivePath),
    darwinArchive,
    manifest.components.cli.artifacts["darwin-arm64"],
  );
  assertAsset(basename(templateArchivePath), templateArchive, {
    name: manifest.components.templates.asset,
    sha256: manifest.components.templates.sha256,
    size: manifest.components.templates.size,
  });
  assertAsset(basename(skillArchivePath), skillArchive, {
    name: manifest.components.skill.asset,
    sha256: manifest.components.skill.sha256,
    size: manifest.components.skill.size,
  });
  return verified;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  await verifyChannelReleaseInputs({
    envelopePath: argument("--envelope"),
    cliTag: argument("--cli-tag"),
    templateTag: argument("--template-tag"),
    skillTag: argument("--skill-tag"),
    windowsArchivePath: argument("--windows-archive"),
    darwinArchivePath: argument("--darwin-archive"),
    templateArchivePath: argument("--template-archive"),
    skillArchivePath: argument("--skill-archive"),
  });
}
