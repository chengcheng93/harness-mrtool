import assert from "node:assert/strict";
import test from "node:test";

import { downloadBounded, type DownloadOptions } from "../../src/update/download.ts";

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

test("successful bounded downloads clear every per-chunk budget timer", async () => {
  const before = activeTimeouts();
  await downloadBounded((async function* () {
    yield new Uint8Array([1, 2, 3]);
  })(), { maxBytes: 8, budgetMs: 60_000 });
  await Promise.resolve();

  assert.equal(activeTimeouts(), before);
});

test("a timed-out bounded download closes its source iterator", async () => {
  let returns = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => {
          returns += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };

  await assert.rejects(
    downloadBounded(source, { maxBytes: 8, budgetMs: 10 }),
    /budget/u,
  );
  assert.equal(returns, 1);
});

test("bounded downloads classify a missing options object as an update security failure", async () => {
  await assert.rejects(
    downloadBounded((async function* () { yield new Uint8Array([1]); })(), null as unknown as DownloadOptions),
    /update/u,
  );
});
