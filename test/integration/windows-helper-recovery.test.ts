import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  recoverWindowsExecutable,
  rotateWindowsExecutable,
  windowsExecutableJournalPath,
  type WindowsExecutableFaultPoint,
  type WindowsExecutablePaths,
} from "../../src/update/windows-helper.ts";

async function fixture(t: test.TestContext): Promise<WindowsExecutablePaths> {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-win-update-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const paths: WindowsExecutablePaths = {
    canonical: resolve(directory, "harness-mrtool.exe"),
    staged: resolve(directory, "harness-mrtool.exe.new"),
    old: resolve(directory, "harness-mrtool.exe.old"),
  };
  await writeFile(paths.canonical, "old-cli");
  await writeFile(paths.staged, "new-cli");
  return paths;
}

test("Windows executable paths must be distinct under case-insensitive comparison", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-win-path-"));
  try {
    await assert.rejects(
      rotateWindowsExecutable({
        canonical: resolve(directory, "Tool.exe"),
        staged: resolve(directory, "tool.EXE"),
        old: resolve(directory, "tool.old"),
      }),
      /unsafe executable paths/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows executable paths reject trailing-dot, trailing-space, and ADS aliases", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-win-path-"));
  try {
    const canonical = resolve(directory, "tool.exe");
    for (const paths of [
      {
        canonical,
        staged: resolve(directory, "tool.exe.new"),
        old: `${canonical}.`,
      },
      {
        canonical,
        staged: `${canonical} `,
        old: resolve(directory, "tool.exe.old"),
      },
      {
        canonical,
        staged: `${canonical}:new`,
        old: resolve(directory, "tool.exe.old"),
      },
    ]) {
      await assert.rejects(rotateWindowsExecutable(paths), /unsafe executable paths/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const crashCases = [
  ["after-journal-prepared", "prepared"],
  ["after-canonical-rename", "prepared"],
  ["after-canonical-rotated", "canonical-rotated"],
  ["after-staged-rename", "canonical-rotated"],
  ["after-staged-installed", "staged-installed"],
] as const satisfies readonly (readonly [WindowsExecutableFaultPoint, string])[];

for (const [crashPoint, journalPhase] of crashCases) {
  test(`Windows executable recovery repairs ${crashPoint}`, async (t) => {
    const paths = await fixture(t);
    await assert.rejects(
      rotateWindowsExecutable(paths, {
        faultInjector: {
          hit(point) {
            if (point === crashPoint) throw new Error(`crash at ${point}`);
          },
        },
      }),
      /crash/u,
    );
    const journal = JSON.parse(await readFile(windowsExecutableJournalPath(paths), "utf8")) as { phase?: unknown };
    assert.equal(journal.phase, journalPhase);

    await recoverWindowsExecutable(paths);
    const recovered = await readFile(paths.canonical, "utf8");
    assert.ok(recovered === "old-cli" || recovered === "new-cli");
    await assert.rejects(readFile(windowsExecutableJournalPath(paths)), { code: "ENOENT" });

    if (recovered === "old-cli") {
      await rotateWindowsExecutable(paths);
      assert.equal(await readFile(paths.canonical, "utf8"), "new-cli");
    }
  });
}

test("Windows rotation rejects a journal path that aliases an executable path", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-win-path-"));
  try {
    const canonical = resolve(directory, "tool.exe");
    await writeFile(canonical, "old-cli");
    await writeFile(`${canonical}.update-journal.json`, "new-cli");
    await assert.rejects(
      rotateWindowsExecutable({
        canonical,
        staged: `${canonical}.update-journal.json`,
        old: resolve(directory, "tool.old"),
      }),
      /unsafe executable paths/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows rotation rejects staged and canonical hard-link aliases", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-win-link-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const paths: WindowsExecutablePaths = {
    canonical: resolve(directory, "tool.exe"),
    staged: resolve(directory, "tool.exe.new"),
    old: resolve(directory, "tool.exe.old"),
  };
  await writeFile(paths.canonical, "same-file");
  await link(paths.canonical, paths.staged);

  await assert.rejects(rotateWindowsExecutable(paths), /unsafe executable identity/u);
  assert.equal(await readFile(paths.canonical, "utf8"), "same-file");
});

test("recovery preserves the old executable when prepared staging was modified", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    rotateWindowsExecutable(paths, {
      faultInjector: {
        hit(point) {
          if (point === "after-journal-prepared") throw new Error("crash");
        },
      },
    }),
    /crash/u,
  );
  await writeFile(paths.staged, "modified-after-preparation");

  assert.equal(await recoverWindowsExecutable(paths), "old");
  assert.equal(await readFile(paths.canonical, "utf8"), "old-cli");
  await assert.rejects(readFile(windowsExecutableJournalPath(paths)), { code: "ENOENT" });
});

test("recovery rejects a modified old backup beside a newly installed executable", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    rotateWindowsExecutable(paths, {
      faultInjector: {
        hit(point) {
          if (point === "after-staged-installed") throw new Error("crash");
        },
      },
    }),
    /crash/u,
  );
  await writeFile(paths.old, "modified-old-backup");

  await assert.rejects(recoverWindowsExecutable(paths), /unsafe executable recovery state/u);
  assert.equal(await readFile(paths.canonical, "utf8"), "new-cli");
  assert.equal((await readFile(windowsExecutableJournalPath(paths), "utf8")).length > 0, true);
});

test("Windows rotation rechecks the staged handle identity immediately before rename", async (t) => {
  const paths = await fixture(t);
  let tampered = false;
  await assert.rejects(
    rotateWindowsExecutable(paths, {
      faultInjector: {
        async hit(point) {
          if (point === "before-staged-identity-check") {
            await writeFile(paths.staged, "tampered-cli-image");
            tampered = true;
          }
        },
      },
    }),
    /unsafe executable/u,
  );
  assert.equal(tampered, true);

  await recoverWindowsExecutable(paths);
  assert.equal(await readFile(paths.canonical, "utf8"), "old-cli");
});
