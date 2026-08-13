import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { spec } from "node:test/reporters";

export default async function* reportTestEvents(source) {
  let matchedTests = 0;
  let globalMatchedTests = 0;
  let sawFileSummary = false;

  async function* observeTestEvents() {
    for await (const event of source) {
      if (event.type === "test:summary" && event.data.file !== undefined) {
        sawFileSummary = true;
        matchedTests += event.data.counts.tests - event.data.counts.skipped;
      } else if (event.type === "test:summary") {
        globalMatchedTests = event.data.counts.tests - event.data.counts.skipped;
      }
      yield event;
    }
  }

  try {
    yield* Readable.from(observeTestEvents()).pipe(new spec());
  } finally {
    const reportPath = process.env.HARNESS_MRTOOL_TEST_MATCH_REPORT;
    if (reportPath === undefined) {
      throw new Error("HARNESS_MRTOOL_TEST_MATCH_REPORT is required.");
    }
    writeFileSync(
      reportPath,
      `${JSON.stringify({
        schemaVersion: 1,
        matchedTests: sawFileSummary ? matchedTests : globalMatchedTests,
      })}\n`,
      "utf8",
    );
  }
}
