import assert from "node:assert/strict";
import test from "node:test";
import { labelDiffDigest, selectMandatoryLabels } from "../../src/app/mandatory-labels.ts";
import { createNodeWizardConsole } from "../../src/cli/wizard-console.ts";
import { createProductionRequestSource } from "../../src/cli/production-input.ts";
import * as productionInvocation from "../../src/cli/production-invocation.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { createInteractiveRequestWizard, type WizardCatalog, type WizardConsole } from "../../src/cli/wizard.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";

const binding = { sourceHeadSha: "a".repeat(40), targetRefSha: "b".repeat(40), mergeBaseSha: "c".repeat(40) };
const diff = bugLabelDiff(binding);
const inventory = ["type::bug", "type::feature", "priority::p2", "priority::p1", "priority::p0", "status::doing", "status::review"]
  .map((name, index) => ({ id: String(index + 1), name }));
const catalog: WizardCatalog = {
  contextId: "context:wizard-labels", issueIid: null, targetBranch: "develop",
  profiles: [{ id: "code", label: "Code" }], suggestedProfileIds: ["code"], titleTypes: ["feat", "fix"],
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

function journey(options: {
  catalog?: WizardCatalog; args?: string[]; intent?: number; escalate?: boolean; priority?: number;
  reason?: string; type?: string; digest?: string; accept?: boolean; editorFails?: boolean; editorInvalid?: boolean;
  answerShownConfirmation?: boolean; confirmationValues?: Readonly<Record<string, string>>;
} = {}) {
  const shown: Array<{ id: string; prompt: string }> = [];
  const selections: string[] = [];
  let editorCalls = 0;
  let closes = 0;
  const console: WizardConsole = {
    selectOne: async (input) => {
      shown.push(input); selections.push(input.id);
      if (input.id === "labels.confirm-type") return input.choices.findIndex(({ label }) => label === (options.type ?? "bug"));
      if (input.id === "labels.priority") return options.priority ?? 0;
      if (input.id === "intent") return options.intent ?? 1;
      return 0;
    },
    selectMany: async (input) => {
      shown.push(input); selections.push(input.id);
      return ["profiles", "impact.areaIds"].includes(input.id) ? [0] : [];
    },
    text: async (input) => {
      shown.push(input);
      if (input.id.startsWith("confirmation.")) {
        return options.confirmationValues?.[input.id] ?? (options.answerShownConfirmation
          ? /Confirmation digest: ([a-f0-9:]+)/u.exec(input.prompt)?.[1] ?? ""
          : "wrong");
      }
      if (input.id === "labels.confirm-digest") return options.digest ?? labelDiffDigest((options.catalog ?? catalog).automaticLabels!.diff);
      if (input.id === "labels.priority-reason") return options.reason ?? "Customer outage";
      return "boundary";
    },
    confirm: async (input) => {
      shown.push(input);
      if (input.id === "labels.escalate") return options.escalate ?? false;
      if (input.id === "labels.accept") return options.accept ?? true;
      return input.defaultValue;
    },
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
  return { invocation, shown, selections, wizard,
    read: () => createProductionRequestSource({ stdinIsTerminal: () => true, wizard }).read(invocation),
    editorCalls: () => editorCalls, closes: () => closes };
}

for (const [intent, status] of [[0, "status::doing"], [1, "status::review"]] as const) {
  test(`wizard displays automatic bug/p2/${status} and never offers managed tokens or title type`, async () => {
    const run = journey({ intent, args: ["preview", "--type", "feat"] });
    const request = await run.read();
    assert.equal(request.title.type, "fix");
    assert.deepEqual(request.mergeRequest.labelCandidateTokens, []);
    assert.equal(run.selections.some((id) => id.startsWith("labels.") || id === "title.type"), false);
    const summary = run.shown.find(({ id }) => id === "labels.accept")?.prompt ?? "";
    for (const expected of ["type::bug", "priority::p2", status, labelDiffDigest(diff)]) assert.ok(summary.includes(expected), expected);
    assert.equal(run.closes(), 1);
  });
}

const unknownCatalog: WizardCatalog = { ...catalog, automaticLabels: {
  ...catalog.automaticLabels!, diff: { ...diff, items: [{ status: "modified", newPath: "src/value.ts", binary: false, submodule: false,
    before: "const x = 1;", after: "const x = 2;" }] },
} };

test("ambiguous wizard type is explicitly digest-confirmed and survives the production input boundary as options, not Request properties", async () => {
  const run = journey({ catalog: unknownCatalog, type: "feature" });
  const request = await run.read();
  assert.equal(request.title.type, "feat");
  assert.equal(run.selections.filter((id) => id === "labels.confirm-type").length, 1);
  assert.ok(run.shown.find(({ id }) => id === "labels.confirm-type")!.prompt.includes(labelDiffDigest(unknownCatalog.automaticLabels!.diff)));
  assert.equal(Object.hasOwn(request, "labelOptions"), false);
  assert.equal(Object.hasOwn(request, "confirmedType"), false);
  const effective = productionInvocation.labelOptionsForProductionInvocation(run.invocation);
  assert.deepEqual(effective, { confirmedType: "feature", confirmationDigest: labelDiffDigest(unknownCatalog.automaticLabels!.diff) });
  const selected = selectMandatoryLabels({ ...unknownCatalog.automaticLabels!, intent: request.intent, options: effective });
  assert.deepEqual(selected.names, ["type::feature", "priority::p2", "status::review"]);
});

for (const [priority, expected] of [[0, "p1"], [1, "p0"]] as const) {
  test(`wizard explicit escalation to ${expected} carries its reason without modifying frozen CLI options`, async () => {
    const run = journey({ escalate: true, priority, reason: "  Customer outage  " });
    const request = await run.read();
    const effective = productionInvocation.labelOptionsForProductionInvocation(run.invocation);
    assert.deepEqual(effective, { priority: expected, priorityReason: "Customer outage" });
    assert.equal(run.invocation.options.priority, null);
    assert.equal(Object.isFrozen(run.invocation.options), true);
    assert.equal(Object.isFrozen(effective), true);
    assert.deepEqual(selectMandatoryLabels({ ...catalog.automaticLabels!, intent: request.intent, options: effective }).names,
      ["type::bug", `priority::${expected}`, "status::review"]);
    assert.deepEqual(productionInvocation.labelOptionsForProductionInvocation(parseCliInvocation(["preview"])), {});
  });
}

const { automaticLabels: _evidence, ...legacyCatalog } = catalog;

for (const [name, options] of [
  ["stale type digest", { catalog: unknownCatalog, digest: "0".repeat(64) }],
  ["blank escalation reason", { escalate: true, reason: "  " }],
  ["declined automatic labels", { accept: false }],
  ["missing diff evidence", { catalog: legacyCatalog }],
  ["stale bound diff", { catalog: { ...catalog, automaticLabels: { ...catalog.automaticLabels!, binding: { ...binding, sourceHeadSha: "d".repeat(40) } } } }],
  ["missing p2 inventory", { catalog: { ...catalog, automaticLabels: { ...catalog.automaticLabels!, inventory: inventory.filter(({ name }) => name !== "priority::p2") } } }],
] as const) {
  test(`wizard fails closed before editing on ${name}`, async () => {
    const run = journey(options as Parameters<typeof journey>[0]);
    const reasons: Readonly<Record<string, string>> = {
      "stale type digest": "Interactive confirmation did not match",
      "blank escalation reason": "priority elevation requires an explicit choice and reason",
      "declined automatic labels": "automatic labels were not accepted",
      "missing diff evidence": "canonical automatic-label evidence is unavailable",
      "stale bound diff": "missing, empty or stale canonical diff",
      "missing p2 inventory": "required label missing or ambiguous in the live inventory",
    };
    await assert.rejects(run.read(), (error) =>
      (isToolError(error, "INPUT_ERROR") || isToolError(error, "LABEL_ERROR")) &&
      `${error.message} ${JSON.stringify(error.details.actual)}`.includes(reasons[name]!));
    assert.equal(run.editorCalls(), 0);
    assert.equal(run.closes(), 1);
  });
}

test("explicit CLI priority and bound confirmation are reused without redundant prompts", async () => {
  const digest = labelDiffDigest(unknownCatalog.automaticLabels!.diff);
  const run = journey({ catalog: unknownCatalog, args: ["preview", "--confirm-label-type", "feature", "--label-diff-digest", digest,
    "--priority", "p0", "--priority-reason", "Customer outage"] });
  await run.read();
  assert.equal(run.shown.some(({ id }) => ["labels.confirm-type", "labels.confirm-digest", "labels.escalate", "labels.priority"].includes(id)), false);
  assert.deepEqual(productionInvocation.labelOptionsForProductionInvocation(run.invocation), {
    confirmedType: "feature", confirmationDigest: digest, priority: "p0", priorityReason: "Customer outage",
  });
});

test("editor failure does not publish interactive escalation options", async () => {
  const run = journey({ escalate: true, editorFails: true });
  await assert.rejects(run.read());
  assert.deepEqual(productionInvocation.labelOptionsForProductionInvocation(run.invocation), {});
});


test("a new collection clears prior decisions and invalid editor documents never publish options", async () => {
  const options = { escalate: true, accept: true };
  const run = journey(options);
  await run.read();
  assert.equal(productionInvocation.labelOptionsForProductionInvocation(run.invocation).priority, "p1");
  options.accept = false;
  await assert.rejects(run.read());
  assert.deepEqual(productionInvocation.labelOptionsForProductionInvocation(run.invocation), {});
  const invalid = journey({ escalate: true, editorInvalid: true });
  await assert.rejects(invalid.read());
  assert.equal(invalid.editorCalls(), 1);
  assert.deepEqual(productionInvocation.labelOptionsForProductionInvocation(invalid.invocation), {});
});

test("stale explicit CLI confirmation is rejected rather than replaced by a wizard answer", async () => {
  const run = journey({ catalog: unknownCatalog, args: ["preview", "--confirm-label-type", "feature", "--label-diff-digest", "0".repeat(64)] });
  await assert.rejects(run.read(), (error) => isToolError(error, "LABEL_ERROR") && error.message.includes("invalid or stale type confirmation"));
  assert.equal(run.shown.some(({ id }) => id === "labels.confirm-type"), false);
  assert.equal(run.editorCalls(), 0);
});

test("numeric terminal journey confirms an ambiguous diff, escalates priority and produces effective write options", async () => {
  const digest = labelDiffDigest(unknownCatalog.automaticLabels!.diff);
  const answers: Array<[string, string]> = [
    ["Select work item relation", "1"], ["Select request profiles", "1"], ["Select merge request intent", "2"],
    ["Diff type is ambiguous", "1"], ["Type the exact diff digest", digest], ["Automatic labels", "y"],
    ["Select explicit priority escalation", "1"], ["Explain why", "Customer outage"], ["Automatic labels", ""],
    ["Enter title module", "boundary"], ["Enter title summary", "Add boundary handler"],
    ["Select impact areas", "1"], ["Select impact nature", "1"], ["Select verification items", "-"],
    ["Select documentation items", "-"], ["Select risk level", "1"], ["Select assignee", "1"],
    ["Select reviewers", "-"], ["Remove source branch", ""], ["Squash commits", ""],
  ];
  const transcript: string[] = [];
  let closed = false;
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => unknownCatalog },
    console: createNodeWizardConsole({ questionPort: {
      question: async (prompt) => {
        transcript.push(prompt);
        const answer = answers.shift();
        assert.ok(answer, "unexpected prompt");
        assert.ok(prompt.startsWith(answer[0]), prompt);
        return answer[1];
      },
      close: () => { closed = true; },
    } }),
    editor: { edit: async () => Buffer.from(JSON.stringify(longForm)) },
  });
  const invocation = parseCliInvocation(["create"]);
  const request = await createProductionRequestSource({ stdinIsTerminal: () => true, wizard }).read(invocation);
  const effective = productionInvocation.labelOptionsForProductionInvocation(invocation);
  assert.deepEqual(effective, { confirmedType: "feature", confirmationDigest: digest, priority: "p1", priorityReason: "Customer outage" });
  assert.deepEqual(selectMandatoryLabels({ ...unknownCatalog.automaticLabels!, intent: request.intent, options: effective }).names,
    ["type::feature", "priority::p1", "status::review"]);
  assert.equal(request.title.type, "feat");
  assert.deepEqual(request.mergeRequest.labelCandidateTokens, []);
  assert.ok(transcript.some((prompt) => prompt.includes("priority::p1") && prompt.includes(digest)));
  assert.deepEqual(answers, []);
  assert.equal(closed, true);
});


const updateEvidence = {
  updateMarkerDigest: "1".repeat(64), descriptionDigest: "2".repeat(64),
  migrationDigest: `${"3".repeat(64)}:${"4".repeat(64)}`,
};
for (const [name, flags, ids] of [
  ["ordinary update", [], ["confirmation.update-marker"]],
  ["forced replacement", ["--force-replace-description"], ["confirmation.update-marker", "confirmation.force-replace"]],
  ["migration and replacement", ["--migrate-template", "--force-replace-description"],
    ["confirmation.update-marker", "confirmation.force-replace", "confirmation.migration"]],
] as const) {
  test(`wizard ${name} displays exact verified digests and publishes accepted update evidence after collection`, async () => {
    const { migrationDigest, ...ordinaryEvidence } = updateEvidence;
    const confirmations = flags.some((flag) => flag === "--migrate-template") ? updateEvidence : ordinaryEvidence;
    const run = journey({ catalog: { ...catalog, confirmations }, args: ["update", "123", ...flags], answerShownConfirmation: true });
    const request = await run.read();
    assert.equal(run.editorCalls(), 1);
    assert.deepEqual(run.shown.filter(({ id }) => id.startsWith("confirmation.")).map(({ id }) => id), ids);
    assert.ok(run.shown.find(({ id }) => id === "confirmation.update-marker")!.prompt.includes(updateEvidence.descriptionDigest));
    assert.deepEqual(productionInvocation.updateConfirmationsForProductionInvocation(run.invocation), confirmations);
    assert.equal(Object.isFrozen(productionInvocation.updateConfirmationsForProductionInvocation(run.invocation)), true);
    assert.equal(Object.hasOwn(request, "confirmations"), false);
    assert.equal(productionInvocation.updateConfirmationsForProductionInvocation(parseCliInvocation(["update", "123"])), null);
  });
}

for (const [name, confirmations, flags] of [
  ["null update evidence", null, []],
  ["missing description digest", { updateMarkerDigest: updateEvidence.updateMarkerDigest }, ["--force-replace-description"]],
  ["missing migration pair", { updateMarkerDigest: updateEvidence.updateMarkerDigest, descriptionDigest: updateEvidence.descriptionDigest }, ["--migrate-template"]],
  ["conflicting CLI migration pair", updateEvidence, ["--migrate-template", "--confirm-migration", `${"5".repeat(64)}:${"6".repeat(64)}`]],
] as const) {
  test(`wizard preflights ${name} before any update confirmation or editor prompt`, async () => {
    const run = journey({ catalog: { ...catalog, confirmations } as WizardCatalog, args: ["update", "123", ...flags],
      confirmationValues: { "confirmation.update-marker": updateEvidence.updateMarkerDigest } });
    await assert.rejects(run.read(), (error) => isToolError(error, "INPUT_ERROR"));
    assert.equal(run.shown.some(({ id }) => id.startsWith("confirmation.")), false);
    assert.equal(run.editorCalls(), 0);
  });
}

test("unsuccessful update collection never leaves accepted evidence from a prior attempt", async () => {
  const { migrationDigest, ...confirmations } = updateEvidence;
  const options = { catalog: { ...catalog, confirmations }, args: ["update", "123"], answerShownConfirmation: true, editorFails: false };
  const run = journey(options);
  await run.read();
  assert.deepEqual(productionInvocation.updateConfirmationsForProductionInvocation(run.invocation), confirmations);
  options.editorFails = true;
  await assert.rejects(run.read());
  assert.equal(productionInvocation.updateConfirmationsForProductionInvocation(run.invocation), null);
});
