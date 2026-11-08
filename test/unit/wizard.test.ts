import assert from "node:assert/strict";
import test from "node:test";
import { selectMandatoryLabels } from "../../src/app/mandatory-labels.ts";
import { createNodeWizardConsole } from "../../src/cli/wizard-console.ts";
import { createProductionRequestSource } from "../../src/cli/production-input.ts";
import * as productionInvocation from "../../src/cli/production-invocation.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { createInteractiveRequestWizard, type WizardCatalog, type WizardConsole } from "../../src/cli/wizard.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";

const binding = { sourceHeadSha: "a".repeat(40), targetRefSha: "b".repeat(40), mergeBaseSha: "c".repeat(40) };
const diff = bugLabelDiff(binding);
const inventory = ["type::bug", "type::feature", "type::doc", "type::chore", "priority::p2", "priority::p1", "priority::p0", "status::review"]
  .map((name, index) => ({ id: String(index + 1), name }));
const catalog: WizardCatalog = {
  contextId: "context:wizard-labels", issueIid: null, targetBranch: "develop",
  profiles: [{ id: "code", label: "Code" }], suggestedProfileIds: ["code"], titleTypes: ["feat", "fix", "docs", "chore"],
  impactAreas: [{ id: "app", label: "App" }], verificationItems: [], documentationItems: [], profileFields: [],
  labelCategories: [], labelCandidates: [], userCandidates: [], confirmations: null,
  automaticLabels: { diff, binding, inventory },
};
const longForm = {
  changes: { summary: ["Fix boundary."], technicalChanges: [], outOfScope: [] },
  motivation: { background: ["Wrong boundary."], whyNeeded: ["Correct the comparison."] },
  noIssueReason: "No tracked issue applies.", impact: { details: [] },
  verification: { items: [], acceptanceEvidence: [], knownGaps: [] },
  documentation: { details: [] }, risk: { items: [], compatibilityImpact: [], rollbackPlan: [] },
  profileFieldValues: [], review: { reviewerFocus: [], additionalNotes: [] },
};

function journey(options: { catalog?: WizardCatalog; args?: string[]; editorFails?: boolean; editorInvalid?: boolean } = {}) {
  const shown: Array<{ id: string; prompt: string }> = [];
  let editorCalls = 0;
  let closes = 0;
  const console: WizardConsole = {
    selectOne: async (input) => { shown.push(input); return 0; },
    selectMany: async (input) => { shown.push(input); return ["profiles", "impact.areaIds"].includes(input.id) ? [0] : []; },
    text: async (input) => { shown.push(input); assert.equal(/confirm|digest/iu.test(input.id), false); return "boundary"; },
    close: () => { closes += 1; },
  };
  const invocation = parseCliInvocation(options.args ?? ["preview"]);
  Object.freeze(invocation.options);
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => options.catalog ?? catalog }, console,
    editor: { edit: async () => {
      editorCalls += 1;
      if (options.editorFails) throw new Error("editor failed");
      return Buffer.from(JSON.stringify(options.editorInvalid ? { ...longForm, labelOptions: {} } : longForm));
    } },
  });
  return { invocation, shown, wizard, read: () => createProductionRequestSource({ stdinIsTerminal: () => true, wizard }).read(invocation),
    editorCalls: () => editorCalls, closes: () => closes };
}

function assertNoApprovalPrompts(shown: readonly { id: string; prompt: string }[]): void {
  assert.equal(shown.some(({ id, prompt }) => /confirm|digest|labels\.|mergeRequest\.(?:removeSourceBranch|squash)/iu.test(id) || /confirm|exact.*hash|exact.*digest/iu.test(prompt)), false);
}

test("wizard create derives bug/p2/review and merge defaults without approval prompts", async () => {
  const run = journey({ args: ["create", "--type", "feat"] });
  const request = await run.read();
  assert.equal(request.title.type, "fix");
  assert.equal(Object.hasOwn(request, "intent"), false);
  assert.deepEqual(request.mergeRequest.labelCandidateTokens, []);
  assert.equal(request.mergeRequest.removeSourceBranch, true);
  assert.equal(request.mergeRequest.squash, true);
  assertNoApprovalPrompts(run.shown);
  assert.deepEqual(productionInvocation.labelOptionsForProductionInvocation(run.invocation), {});
  assert.equal(run.editorCalls(), 1);
  assert.equal(run.closes(), 1);
});

const unknownCatalog: WizardCatalog = { ...catalog, automaticLabels: {
  ...catalog.automaticLabels!, diff: { ...diff, items: [{ status: "modified", newPath: "src/value.ts", binary: false, submodule: false,
    before: "const x = 1;", after: "const x = 2;" }] },
} };

test("ambiguous source changes automatically use chore without type or digest input", async () => {
  const run = journey({ catalog: unknownCatalog });
  const request = await run.read();
  assert.equal(request.title.type, "chore");
  assertNoApprovalPrompts(run.shown);
  const effective = productionInvocation.labelOptionsForProductionInvocation(run.invocation);
  assert.deepEqual(effective, {});
  assert.deepEqual(selectMandatoryLabels({ ...unknownCatalog.automaticLabels!, options: effective }).names,
    ["type::chore", "priority::p2", "status::review"]);
});

test("WASM comment-only changes select doc without a confirmation step", async () => {
  const docCatalog: WizardCatalog = { ...catalog, automaticLabels: { ...catalog.automaticLabels!, diff: { ...diff, items: [{
    status: "modified", newPath: "luban-web-wasm/src/lb_web_runtime.ts", binary: false, submodule: false,
    before: "// This thin adapter owns JS/WASM copying and leaves command semantics in C++.\nexport const runtime = true;\n",
    after: "// This adapter handles JS/WASM data copying while command semantics stay in C++.\nexport const runtime = true;\n",
  }] } } };
  const run = journey({ catalog: docCatalog });
  const request = await run.read();
  assert.deepEqual(selectMandatoryLabels({ ...docCatalog.automaticLabels! }).names, ["type::doc", "priority::p2", "status::review"]);
  assertNoApprovalPrompts(run.shown);
  assert.equal(request.title.type, "docs");
});

for (const priority of ["p1", "p0"] as const) {
  test("explicit CLI priority " + priority + " keeps its reason without approval prompts", async () => {
    const run = journey({ args: ["create", "--priority", priority, "--priority-reason", "Customer outage"] });
    await run.read();
    const effective = productionInvocation.labelOptionsForProductionInvocation(run.invocation);
    assert.deepEqual(effective, { priority, priorityReason: "Customer outage" });
    assert.equal(Object.isFrozen(effective), true);
    assertNoApprovalPrompts(run.shown);
  });
}

const { automaticLabels: _evidence, ...legacyCatalog } = catalog;
for (const [name, badCatalog] of [
  ["missing diff evidence", legacyCatalog],
  ["stale bound diff", { ...catalog, automaticLabels: { ...catalog.automaticLabels!, binding: { ...binding, sourceHeadSha: "d".repeat(40) } } }],
  ["missing p2 inventory", { ...catalog, automaticLabels: { ...catalog.automaticLabels!, inventory: inventory.filter(({ name }) => name !== "priority::p2") } }],
] as const) {
  test("wizard rejects " + name + " before editing instead of asking for approval", async () => {
    const run = journey({ catalog: badCatalog as WizardCatalog });
    await assert.rejects(run.read(), error => isToolError(error, "INPUT_ERROR") || isToolError(error, "LABEL_ERROR"));
    assert.equal(run.editorCalls(), 0);
    assertNoApprovalPrompts(run.shown);
    assert.equal(run.closes(), 1);
  });
}

test("failed editor collection never publishes label decisions", async () => {
  const options = { catalog: unknownCatalog, editorFails: false };
  const run = journey(options);
  await run.read();
  options.editorFails = true;
  await assert.rejects(run.read());
  assert.deepEqual(productionInvocation.labelOptionsForProductionInvocation(run.invocation), {});
  const invalid = journey({ catalog: unknownCatalog, editorInvalid: true });
  await assert.rejects(invalid.read());
  assert.equal(invalid.editorCalls(), 1);
});

test("numeric terminal journey gathers request data without type, hash, or yes/no approval", async () => {
  const answers: Array<[string, string]> = [
    ["Select work item relation", "1"], ["Select request profiles", "1"],
    ["Enter title module", "boundary"], ["Enter title summary", "Add boundary handler"],
    ["Select impact areas", "1"], ["Select impact nature", "1"], ["Select verification items", "-"],
    ["Select documentation items", "-"], ["Select risk level", "1"], ["Select assignee", "1"], ["Select reviewers", "-"],
  ];
  const transcript: string[] = [];
  let closed = false;
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => unknownCatalog },
    console: createNodeWizardConsole({ questionPort: {
      question: async prompt => { transcript.push(prompt); const answer = answers.shift(); assert.ok(answer, "unexpected prompt"); assert.ok(prompt.startsWith(answer[0]), prompt); return answer[1]; },
      close: () => { closed = true; },
    } }),
    editor: { edit: async () => Buffer.from(JSON.stringify(longForm)) },
  });
  const invocation = parseCliInvocation(["create"]);
  const request = await createProductionRequestSource({ stdinIsTerminal: () => true, wizard }).read(invocation);
  assert.equal(request.title.type, "chore");
  assert.equal(transcript.some(prompt => /confirm|digest|Y\/n|y\/N/iu.test(prompt)), false);
  assert.deepEqual(answers, []);
  assert.equal(closed, true);
});

const updateEvidence = { updateMarkerDigest: "1".repeat(64), descriptionDigest: "2".repeat(64), migrationDigest: "3".repeat(64) + ":" + "4".repeat(64) };
for (const [name, flags] of [
  ["ordinary update", []], ["description replacement", ["--force-replace-description"]],
  ["migration and replacement", ["--migrate-template", "--force-replace-description"]],
] as const) {
  test("wizard " + name + " binds verified evidence automatically", async () => {
    const { migrationDigest, ...ordinaryEvidence } = updateEvidence;
    const confirmations = flags.some(flag => flag === "--migrate-template") ? updateEvidence : ordinaryEvidence;
    const run = journey({ catalog: { ...catalog, confirmations }, args: ["update", "123", ...flags] });
    await run.read();
    assertNoApprovalPrompts(run.shown);
    assert.deepEqual(productionInvocation.updateConfirmationsForProductionInvocation(run.invocation), confirmations);
    assert.equal(Object.isFrozen(productionInvocation.updateConfirmationsForProductionInvocation(run.invocation)), true);
  });
}

for (const [name, confirmations, flags] of [
  ["null update evidence", null, []],
  ["missing description digest", { updateMarkerDigest: updateEvidence.updateMarkerDigest }, ["--force-replace-description"]],
  ["missing migration pair", { updateMarkerDigest: updateEvidence.updateMarkerDigest, descriptionDigest: updateEvidence.descriptionDigest }, ["--migrate-template"]],
] as const) {
  test("wizard rejects " + name + " before any request editing", async () => {
    const run = journey({ catalog: { ...catalog, confirmations } as WizardCatalog, args: ["update", "123", ...flags] });
    await assert.rejects(run.read(), error => isToolError(error, "INPUT_ERROR"));
    assert.equal(run.editorCalls(), 0);
    assertNoApprovalPrompts(run.shown);
  });
}

test("failed update collection clears the prior automatic binding", async () => {
  const { migrationDigest, ...confirmations } = updateEvidence;
  const options = { catalog: { ...catalog, confirmations }, args: ["update", "123"], editorFails: false };
  const run = journey(options);
  await run.read();
  options.editorFails = true;
  await assert.rejects(run.read());
  assert.equal(productionInvocation.updateConfirmationsForProductionInvocation(run.invocation), null);
});

test("explicit priority escalation still requires request data before the wizard starts", () => {
  for (const args of [["create", "--priority", "p1"], ["create", "--priority", "p0", "--priority-reason", "  "]]) {
    assert.throws(() => journey({ args }), error => isToolError(error, "INPUT_ERROR"));
  }
});
