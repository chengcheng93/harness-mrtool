import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { canonicalizeJson, copyJsonValue, sha256Utf8 } from "../../src/contracts/jcs.ts";
import {
  createLocalCommandHandlers,
  type TrustedBundleSelection,
} from "../../src/cli/commands/local.ts";
import { executeCliJson, type CliCommandHandlers } from "../../src/cli/execute.ts";
import { renderProjectTemplate } from "../../src/render/project-template.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const bundleDirectory = resolve(repositoryRoot, "template-bundle");

function captureSink(): {
  readonly chunks: string[];
  readonly sink: { write(chunk: string, callback: (error?: Error | null) => void): boolean };
} {
  const chunks: string[] = [];
  return {
    chunks,
    sink: {
      write(chunk, callback) {
        chunks.push(chunk);
        callback();
        return true;
      },
    },
  };
}

async function run(
  arguments_: readonly string[],
  handlers: CliCommandHandlers,
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown> }> {
  const captured = captureSink();
  const result = await executeCliJson(arguments_, {
    cliVersion: "0.1.0-test",
    stdout: captured.sink,
    handlers,
  });
  assert.equal(captured.chunks.length, 1);
  return {
    exitCode: result.exitCode,
    output: JSON.parse(captured.chunks[0]!) as Record<string, unknown>,
  };
}

function selection(
  bundle: Awaited<ReturnType<typeof loadTemplateBundle>>,
  overrides: Partial<Omit<TrustedBundleSelection, "bundle">> = {},
): TrustedBundleSelection {
  return {
    bundle,
    bundleManifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`),
    releaseSetId: "release-set:test",
    releaseTag: "templates-v1.0.0",
    ...overrides,
  };
}

test("local read-only handlers expose one verified Bundle contract", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const current = selection(bundle);
  const handlers = createLocalCommandHandlers({
    cliVersion: "0.1.0-test",
    current,
  });

  for (const [arguments_, expectedCommand] of [
    [["version", "--output", "json"], "version"],
    [["profiles", "list", "--output", "json"], "profiles.list"],
    [["schema", "show", "--output", "json"], "schema.show"],
    [["template", "show", "--output", "json"], "template.show"],
  ] as const) {
    const result = await run(arguments_, handlers);
    assert.equal(result.exitCode, 0, expectedCommand);
    assert.equal(result.output.ok, true, expectedCommand);
    const versions = result.output.versions as Record<string, unknown>;
    assert.equal(versions.cliVersion, "0.1.0-test");
    assert.equal(versions.templateVersion, bundle.manifest.version);
    assert.equal(versions.bundleHash, current.bundleManifestHash);
    assert.equal(versions.releaseSetId, current.releaseSetId);
    assert.equal(versions.inputSchema, bundle.manifest.inputSchema);
    assert.equal(versions.policySchema, bundle.manifest.policySchema);
    const data = result.output.data as Record<string, unknown>;
    assert.equal(data.command, expectedCommand);
  }
});

test("schema show from MR uses only the exact historical Bundle resolver", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const current = selection(bundle, { releaseSetId: "release-set:current" });
  const historical = selection(bundle, {
    releaseSetId: "release-set:historical",
    releaseTag: "templates-v0.9.0",
  });
  const resolved: number[] = [];
  const handlers = createLocalCommandHandlers({
    cliVersion: "0.1.0-test",
    current,
    loadHistoricalBundle: async (iid) => {
      resolved.push(iid);
      return historical;
    },
  });

  const result = await run(
    ["schema", "show", "--from-mr", "41", "--output", "json"],
    handlers,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(resolved, [41]);
  const versions = result.output.versions as Record<string, unknown>;
  assert.equal(versions.releaseSetId, "release-set:historical");
  const data = result.output.data as Record<string, unknown>;
  assert.equal(data.fromMrIid, 41);
  assert.deepEqual(data.schema, copyJsonValue(bundle.schema));

  const unavailable = await run(
    ["schema", "show", "--from-mr", "41", "--output", "json"],
    createLocalCommandHandlers({ cliVersion: "0.1.0-test", current }),
  );
  assert.equal(unavailable.exitCode, 2);
  assert.equal(unavailable.output.code, "TEMPLATE_ERROR");
});

test("template export delegates exact renderer bytes to the injected atomic writer", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const writes: Array<{ readonly destination: string; readonly contents: string }> = [];
  const handlers = createLocalCommandHandlers({
    cliVersion: "0.1.0-test",
    current: selection(bundle),
    writeProjection: async (destination, contents) => {
      writes.push({ destination, contents });
    },
  });

  const result = await run([
    "template", "export", "--profile", "docs", "--destination", "Docs.md",
    "--output", "json",
  ], handlers);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(writes, [{
    destination: "Docs.md",
    contents: renderProjectTemplate("docs", bundle),
  }]);
  const data = result.output.data as Record<string, unknown>;
  assert.deepEqual(data, {
    command: "template.export",
    releaseTag: "templates-v1.0.0",
    bundleId: "harness-mr-default",
    profile: "docs",
    bytes: Buffer.byteLength(writes[0]!.contents, "utf8"),
    sha256: sha256Utf8(writes[0]!.contents),
  });
});

test("template export has no implicit writer and rejects Bundle hash drift before writing", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const withoutWriter = await run([
    "template", "export", "--profile", "general", "--destination", "Default.md",
    "--output", "json",
  ], createLocalCommandHandlers({
    cliVersion: "0.1.0-test",
    current: selection(bundle),
  }));
  assert.equal(withoutWriter.exitCode, 7);
  assert.equal(withoutWriter.output.code, "INTERNAL_ERROR");

  let writes = 0;
  const drifted = await run([
    "template", "export", "--profile", "general", "--destination", "Default.md",
    "--output", "json",
  ], createLocalCommandHandlers({
    cliVersion: "0.1.0-test",
    current: selection(bundle, { bundleManifestHash: "f".repeat(64) }),
    writeProjection: () => {
      writes += 1;
    },
  }));
  assert.equal(drifted.exitCode, 2);
  assert.equal(drifted.output.code, "TEMPLATE_ERROR");
  assert.equal(writes, 0);
});

test("local handlers revalidate a supplied Bundle before exposing it", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const tampered = copyJsonValue(bundle) as unknown as typeof bundle;
  (tampered.profiles.general as { id: string }).id = "wrong-profile";
  const result = await run(
    ["profiles", "list", "--output", "json"],
    createLocalCommandHandlers({
      cliVersion: "0.1.0-test",
      current: selection(tampered),
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "TEMPLATE_ERROR");
});
