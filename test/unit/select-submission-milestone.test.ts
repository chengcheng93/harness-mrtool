import assert from "node:assert/strict";
import test from "node:test";
import { selectSubmissionMilestone } from "../../src/app/select-submission-milestone.ts";
import type { GitLabMilestone } from "../../src/gitlab/types.ts";
const m = (id: number, dueDate: string | null, state: "active" | "closed" = "active"): GitLabMilestone => ({ id, title: "Milestone " + id, state, dueDate });
for (const [name, candidates, date, id] of [
  ["past and today excluded", [m(1,"2026-11-10"),m(2,"2026-11-11"),m(3,"2026-11-12")],"2026-11-11",3],
  ["closed and missing dates excluded", [m(1,"2026-11-12","closed"),m(2,null),m(3,"2026-11-13")],"2026-11-11",3],
  ["strict Gregorian dates", [m(1,"2027-02-29"),m(2,"2026-11-31"),m(3,"2026-12-1"),m(4,"2026-12-01junk"),m(5,"0000-01-01"),m(6,"2026-12-02")],"2026-11-11",6],
  ["valid leap day", [m(8,"2028-03-01"),m(7,"2028-02-29")],"2028-02-28",7],
  ["century leap rules", [m(1,"2100-02-29"),m(2,"2100-03-01")],"2100-02-28",2],
  ["same day numeric ID tie", [m(100,"2026-11-12"),m(20,"2026-11-12"),m(3,"2026-11-13")],"2026-11-11",20],
  ["no future", [m(1,"2026-11-11"),m(2,null)],"2026-11-11",null],
  ["empty", [],"2026-11-11",null],
] as const) test(name, () => {
  const before = JSON.stringify(candidates);
  const result = selectSubmissionMilestone(candidates, date);
  assert.equal(result.milestone?.id ?? null, id);
  assert.equal(result.reason, id === null ? "no-future-milestone" : "nearest-future");
  assert.equal(result.submissionDate, date);
  assert.equal(JSON.stringify(candidates), before);
});
for (const date of ["2026-02-29","0000-01-01","2026-1-01","junk"]) test("invalid submission date " + date, () => assert.throws(() => selectSubmissionMilestone([], date)));
