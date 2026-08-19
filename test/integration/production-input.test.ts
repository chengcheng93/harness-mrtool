import assert from "node:assert/strict";
import test from "node:test";

import { createProductionRequestSource } from "../../src/cli/production-input.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import {
  createInteractiveRequestWizard,
  type WizardCatalog,
  type WizardConsole,
  type WizardLongFormEditor,
} from "../../src/cli/wizard.ts";
import type { InputIo } from "../../src/input/load-input.ts";

const secretTokens = [
  "label-token:fixture-type",
  "assignee-token:fixture-owner",
  "reviewer-token:fixture-reviewer",
] as const;

const catalog: WizardCatalog = {
  contextId: "context:wizard-fixture",
  issueIid: 51,
  targetBranch: "develop",
  profiles: [
    { id: "code", label: "Code" },
    { id: "docs", label: "Documentation" },
  ],
  suggestedProfileIds: ["code", "docs"],
  titleTypes: ["feat", "fix", "docs"],
  impactAreas: [{ id: "app", label: "App" }],
  verificationItems: [
    { id: "local-build", label: "Local build completed" },
    { id: "unit-tests", label: "Relevant unit tests passed" },
    { id: "integration-tests", label: "Relevant integration tests passed" },
    { id: "core-behavior", label: "Core behavior verified" },
    { id: "docs-links-format", label: "Documentation links verified" },
  ],
  documentationItems: [{ id: "readme", label: "README updated" }],
  profileFields: [
    { id: "docs.target-audience", profileId: "docs", label: "Target Audience" },
    { id: "docs.content-impact", profileId: "docs", label: "Content Impact" },
  ],
  labelCategories: [{ id: "type", required: true, max: 1 }],
  labelCandidates: [{
    token: secretTokens[0],
    category: "type",
    name: "type::bug",
    description: "Bug fix",
    scopeKind: "project",
    scopePath: "group/project",
    currentlyApplied: false,
  }],
  userCandidates: [
    {
      token: secretTokens[1],
      kind: "assignee",
      username: "owner",
      displayName: "Fixture Owner",
      currentlyApplied: false,
      defaultSelected: true,
      qualifiedReviewer: false,
    },
    {
      token: secretTokens[2],
      kind: "reviewer",
      username: "reviewer",
      displayName: "Fixture Reviewer",
      currentlyApplied: false,
      defaultSelected: false,
      qualifiedReviewer: true,
    },
  ],
  confirmations: null,
};

const longForm = {
  changes: {
    summary: ["Keep the request transport deterministic."],
    technicalChanges: ["Normalize every transport at one boundary."],
    outOfScope: ["No remote write behavior changes."],
  },
  motivation: {
    background: ["Manual and automated inputs previously diverged."],
    whyNeeded: ["One canonical request prevents rendering drift."],
  },
  noIssueReason: null,
  impact: { details: ["The production CLI input boundary changes."] },
  verification: {
    items: Array.from({ length: 5 }, () => ({
      state: "checked",
      evidenceKind: "file-inspection",
      command: null,
      result: "Focused checks passed",
      evidence: "The focused test output was inspected.",
    })),
    acceptanceEvidence: ["All transport fixtures produced the same request."],
    knownGaps: ["A real terminal journey remains an end-to-end gate."],
  },
  documentation: { details: ["The README input examples remain valid."] },
  risk: {
    items: ["Editor interruption can leave no request, but no remote write occurs."],
    compatibilityImpact: ["Existing explicit input remains compatible."],
    rollbackPlan: ["Restore the prior production request source."],
  },
  profileFieldValues: [
    ["Developers using the manual CLI."],
    ["Input workflow documentation is updated."],
  ],
  review: {
    reviewerFocus: ["Verify stdin is never consumed implicitly."],
    additionalNotes: ["Candidate tokens are never editor content."],
  },
};

function consoleFixture(options: {
  readonly confirmationValues?: Readonly<Record<string, string>>;
  readonly confirmationCalls?: string[];
  readonly relationIndex?: number;
  readonly workItemIid?: string;
} = {}): WizardConsole {
  return {
    selectOne: async ({ id, choices }) => {
      const selected: Readonly<Record<string, number>> = {
        intent: 1,
        "title.type": 1,
        "workItem.relation": options.relationIndex ?? 1,
        "impact.nature": 1,
        "risk.level": 1,
        assignee: 1,
      };
      const index = selected[id];
      assert.notEqual(index, undefined, `unexpected single selection ${id}`);
      assert.ok(index! >= 0 && index! < choices.length);
      return index!;
    },
    selectMany: async ({ id, choices }) => {
      const selected: Readonly<Record<string, readonly number[]>> = {
        profiles: [0, 1],
        "impact.areaIds": [0],
        "verification.itemIds": [0, 1, 2, 3, 4],
        "documentation.itemIds": [0],
        "labels.type": [0],
        reviewers: [0],
      };
      const indexes = selected[id];
      assert.notEqual(indexes, undefined, `unexpected multiple selection ${id}`);
      assert.ok(indexes!.every((index) => index >= 0 && index < choices.length));
      return indexes!;
    },
    text: async ({ id }) => {
      const confirmation = options.confirmationValues?.[id];
      if (confirmation !== undefined) {
        options.confirmationCalls?.push(id);
        return confirmation;
      }
      const values: Readonly<Record<string, string>> = {
        "title.module": "harness-mrtool",
        "title.titleSummary": "Unify production request transports",
        "workItem.iid": options.workItemIid ?? "51",
      };
      const value = values[id];
      assert.notEqual(value, undefined, `unexpected text input ${id}`);
      return value!;
    },
    confirm: async () => true,
  };
}

test("TTY wizard derives candidate values only from enumerated choices and keeps them out of editor bytes", async () => {
  let stdinReads = 0;
  let editorCalls = 0;
  const catalogIssueIids: Array<number | null | undefined> = [];
  const stdin: InputIo["stdin"] = {
    [Symbol.asyncIterator]() {
      stdinReads += 1;
      return (async function* () { yield Buffer.from("must not be read"); })();
    },
  };
  const editor: WizardLongFormEditor = {
    edit: async ({ initialBytes }) => {
      editorCalls += 1;
      const initial = Buffer.from(initialBytes).toString("utf8");
      assert.match(initial, /^changes:\r?\n/u);
      assert.doesNotMatch(initial, /^\{/u);
      for (const token of secretTokens) assert.equal(initial.includes(token), false);
      for (const candidateId of [
        "code", "docs", "app", "local-build", "unit-tests", "integration-tests",
        "core-behavior", "docs-links-format", "readme", "docs.target-audience",
        "docs.content-impact",
      ]) {
        assert.equal(initial.includes(candidateId), false, candidateId);
      }
      return Buffer.from(JSON.stringify(longForm), "utf8");
    },
  };
  const wizard = createInteractiveRequestWizard({
    catalogSource: {
      load: async (input) => {
        catalogIssueIids.push(input.issueIid);
        return catalog;
      },
    },
    console: consoleFixture(),
    editor,
  });
  const source = createProductionRequestSource({
    inputIo: {
      statFile: async () => { throw new Error("file stat must not run"); },
      readFile: async () => { throw new Error("file read must not run"); },
      stdin,
    },
    stdinIsTerminal: () => true,
    wizard,
  });

  const request = await source.read(parseCliInvocation(["preview"]));

  assert.equal(stdinReads, 0);
  assert.equal(editorCalls, 1);
  assert.deepEqual(catalogIssueIids, [51]);
  assert.deepEqual(request.workItem, { relation: "related", iid: 51 });
  assert.deepEqual(request.profileIds, ["code", "docs"]);
  assert.deepEqual(request.impact.areaIds, ["app"]);
  assert.deepEqual(request.verification.items.map((item) => item.id), [
    "local-build", "unit-tests", "integration-tests", "core-behavior", "docs-links-format",
  ]);
  assert.deepEqual(request.documentation.itemIds, ["readme"]);
  assert.deepEqual(request.profileFields, {
    "docs.content-impact": ["Input workflow documentation is updated."],
    "docs.target-audience": ["Developers using the manual CLI."],
  });
  assert.deepEqual(request.mergeRequest.labelCandidateTokens, [secretTokens[0]]);
  assert.equal(request.mergeRequest.assigneeCandidateToken, secretTokens[1]);
  assert.deepEqual(request.review.reviewerCandidateTokens, [secretTokens[2]]);
});

test("TTY label choices display description, category, scope, and current state while allowing an empty description", async () => {
  const baseConsole = consoleFixture();
  const shownLabels: string[] = [];
  const emptyDescriptionCatalog: WizardCatalog = {
    ...catalog,
    labelCandidates: catalog.labelCandidates.map((candidate) => ({
      ...candidate,
      description: "",
      currentlyApplied: true,
    })),
  };
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => emptyDescriptionCatalog },
    console: {
      ...baseConsole,
      selectMany: async (input) => {
        if (input.id === "labels.type") {
          shownLabels.push(...input.choices.map((choice) => choice.label));
        }
        return baseConsole.selectMany(input);
      },
    },
    editor: { edit: async () => Buffer.from(JSON.stringify(longForm), "utf8") },
  });

  const request = await createProductionRequestSource({ stdinIsTerminal: () => true, wizard })
    .read(parseCliInvocation(["preview"]));

  assert.deepEqual(shownLabels, [
    "type::bug | (no description) | category=type | scope=project:group/project | currently applied",
  ]);
  assert.equal(shownLabels.some((label) => label.includes(secretTokens[0])), false);
  assert.deepEqual(request.mergeRequest.labelCandidateTokens, [secretTokens[0]]);
});

for (const kind of ["accessor", "unknown-key"] as const) {
  test(`TTY catalog rejects ${kind} fields before invoking accessors or the editor`, async () => {
    let getterCalls = 0;
    let editorCalls = 0;
    const invalid = { ...catalog } as Record<string, unknown>;
    if (kind === "accessor") {
      Object.defineProperty(invalid, "contextId", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return catalog.contextId;
        },
      });
    } else {
      invalid.unexpected = "unsupported catalog field";
    }
    const wizard = createInteractiveRequestWizard({
      catalogSource: { load: async () => invalid as unknown as WizardCatalog },
      console: consoleFixture(),
      editor: {
        edit: async () => {
          editorCalls += 1;
          return Buffer.from(JSON.stringify(longForm), "utf8");
        },
      },
    });

    await assert.rejects(
      createProductionRequestSource({ stdinIsTerminal: () => true, wizard })
        .read(parseCliInvocation(["preview"])),
      (error: unknown) => isToolError(error, "INPUT_ERROR") &&
        error.message === "Interactive request input is invalid",
    );
    assert.equal(getterCalls, 0);
    assert.equal(editorCalls, 0);
  });
}

test("TTY catalog is a detached snapshot unaffected by later source mutation", async () => {
  const mutable = structuredClone(catalog) as WizardCatalog;
  const baseConsole = consoleFixture();
  const replacementToken = `hmrc1_${"m".repeat(43)}`;
  let mutated = false;
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => mutable },
    console: {
      ...baseConsole,
      selectMany: async (input) => {
        if (!mutated && input.id === "profiles") {
          mutated = true;
          (mutable.titleTypes as string[])[1] = "mutated";
          (mutable.labelCandidates as unknown as { token: string }[])[0]!.token = replacementToken;
        }
        return baseConsole.selectMany(input);
      },
    },
    editor: {
      edit: async ({ initialBytes }) => {
        const initial = Buffer.from(initialBytes).toString("utf8");
        assert.equal(initial.includes(secretTokens[0]), false);
        assert.equal(initial.includes(replacementToken), false);
        return Buffer.from(JSON.stringify(longForm), "utf8");
      },
    },
  });

  const request = await createProductionRequestSource({ stdinIsTerminal: () => true, wizard })
    .read(parseCliInvocation(["preview"]));

  assert.equal(mutated, true);
  assert.equal(request.title.type, "fix");
  assert.deepEqual(request.mergeRequest.labelCandidateTokens, [secretTokens[0]]);
});

test("TTY catalog rejects a missing required label candidate before prompting or editing", async () => {
  const baseConsole = consoleFixture();
  let labelPrompts = 0;
  let editorCalls = 0;
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => ({ ...catalog, labelCandidates: [] }) },
    console: {
      ...baseConsole,
      selectMany: async (input) => {
        if (input.id === "labels.type") labelPrompts += 1;
        return baseConsole.selectMany(input);
      },
    },
    editor: {
      edit: async () => {
        editorCalls += 1;
        return Buffer.from(JSON.stringify(longForm), "utf8");
      },
    },
  });

  await assert.rejects(
    createProductionRequestSource({ stdinIsTerminal: () => true, wizard })
      .read(parseCliInvocation(["preview"])),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      error.message === "Interactive request input is invalid",
  );
  assert.equal(labelPrompts, 0);
  assert.equal(editorCalls, 0);
});

test("TTY wizard binds none to a null catalog issue and rejects catalog issue drift before editing", async () => {
  const noneIssueIids: Array<number | null> = [];
  const noneCatalog: WizardCatalog = { ...catalog, issueIid: null };
  const noneWizard = createInteractiveRequestWizard({
    catalogSource: {
      load: async ({ issueIid }) => {
        noneIssueIids.push(issueIid);
        return noneCatalog;
      },
    },
    console: consoleFixture({ relationIndex: 0 }),
    editor: {
      edit: async () => Buffer.from(JSON.stringify({
        ...longForm,
        noIssueReason: "No tracked issue applies to this change.",
      }), "utf8"),
    },
  });

  const request = await createProductionRequestSource({
    stdinIsTerminal: () => true,
    wizard: noneWizard,
  }).read(parseCliInvocation(["preview"]));

  assert.deepEqual(noneIssueIids, [null]);
  assert.deepEqual(request.workItem, {
    relation: "none",
    noIssueReason: "No tracked issue applies to this change.",
  });

  let editorCalls = 0;
  const driftedWizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => ({ ...catalog, issueIid: 52 }) },
    console: consoleFixture(),
    editor: {
      edit: async () => {
        editorCalls += 1;
        return Buffer.from(JSON.stringify(longForm), "utf8");
      },
    },
  });
  await assert.rejects(
    createProductionRequestSource({ stdinIsTerminal: () => true, wizard: driftedWizard })
      .read(parseCliInvocation(["preview"])),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      error.message === "Interactive request input is invalid",
  );
  assert.equal(editorCalls, 0);
});

test("TTY wizard rejects invalid work item IID syntax and range before catalog or editor access", async () => {
  const invalidIids = [
    "", "0", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ",
    "9007199254740992", "１２",
  ] as const;

  for (const workItemIid of invalidIids) {
    let catalogCalls = 0;
    let editorCalls = 0;
    const wizard = createInteractiveRequestWizard({
      catalogSource: {
        load: async () => {
          catalogCalls += 1;
          return catalog;
        },
      },
      console: consoleFixture({ workItemIid }),
      editor: {
        edit: async () => {
          editorCalls += 1;
          return Buffer.from(JSON.stringify(longForm), "utf8");
        },
      },
    });

    await assert.rejects(
      createProductionRequestSource({ stdinIsTerminal: () => true, wizard })
        .read(parseCliInvocation(["preview"])),
      (error: unknown) => isToolError(error, "INPUT_ERROR") &&
        error.message === "Interactive request input is invalid",
      workItemIid,
    );
    assert.equal(catalogCalls, 0, workItemIid);
    assert.equal(editorCalls, 0, workItemIid);
  }
});

test("TTY editor cannot see or inject the preselected work item relation and IID", async () => {
  let initial = "";
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => catalog },
    console: consoleFixture(),
    editor: {
      edit: async ({ initialBytes }) => {
        initial = Buffer.from(initialBytes).toString("utf8");
        return Buffer.from(JSON.stringify({
          ...longForm,
          workItem: { relation: "none", iid: 999 },
        }), "utf8");
      },
    },
  });

  await assert.rejects(
    createProductionRequestSource({ stdinIsTerminal: () => true, wizard })
      .read(parseCliInvocation(["preview"])),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );
  assert.doesNotMatch(initial, /workItem|relation|\biid\b/u);
});

test("TTY update requires exact marker, replacement, and migration confirmations", async () => {
  const markerDigest = "1".repeat(64);
  const descriptionDigest = "2".repeat(64);
  const migrationDigest = `${"3".repeat(64)}:${"4".repeat(64)}`;
  const confirmationCalls: string[] = [];
  let editorCalls = 0;
  const updateCatalog: WizardCatalog = {
    ...catalog,
    confirmations: { updateMarkerDigest: markerDigest, descriptionDigest, migrationDigest },
  };
  const editor: WizardLongFormEditor = {
    edit: async () => {
      editorCalls += 1;
      return Buffer.from(JSON.stringify(longForm), "utf8");
    },
  };
  const invocation = parseCliInvocation([
    "update",
    "123",
    "--migrate-template",
    "--force-replace-description",
  ]);
  const wizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => updateCatalog },
    console: consoleFixture({
      confirmationCalls,
      confirmationValues: {
        "confirmation.update-marker": markerDigest,
        "confirmation.force-replace": descriptionDigest,
        "confirmation.migration": migrationDigest,
      },
    }),
    editor,
  });

  const request = await createProductionRequestSource({
    stdinIsTerminal: () => true,
    wizard,
  }).read(invocation);

  assert.equal(request.contextId, catalog.contextId);
  assert.equal(editorCalls, 1);
  assert.deepEqual(confirmationCalls, [
    "confirmation.update-marker",
    "confirmation.force-replace",
    "confirmation.migration",
  ]);

  const wrongWizard = createInteractiveRequestWizard({
    catalogSource: { load: async () => updateCatalog },
    console: consoleFixture({
      confirmationValues: { "confirmation.update-marker": "wrong" },
    }),
    editor,
  });
  await assert.rejects(
    createProductionRequestSource({ stdinIsTerminal: () => true, wizard: wrongWizard }).read(invocation),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      error.message === "Interactive confirmation did not match",
  );
  assert.equal(editorCalls, 1, "mismatched confirmation must stop before editor handoff");
});

test("TTY wizard maps injected catalog, console, editor, and close failures to fixed secret-free errors", async () => {
  const secret = "Private-Token: wizard-port-canary";
  const workingEditor: WizardLongFormEditor = {
    edit: async () => Buffer.from(JSON.stringify(longForm), "utf8"),
  };
  const cases: readonly {
    readonly expectedMessage: string;
    readonly wizard: ReturnType<typeof createInteractiveRequestWizard>;
  }[] = [
    {
      expectedMessage: "Interactive request catalog is unavailable",
      wizard: createInteractiveRequestWizard({
        catalogSource: { load: async () => { throw new Error(secret); } },
        console: consoleFixture(),
        editor: workingEditor,
      }),
    },
    {
      expectedMessage: "Interactive request console is unavailable",
      wizard: createInteractiveRequestWizard({
        catalogSource: { load: async () => catalog },
        console: {
          ...consoleFixture(),
          selectOne: async () => { throw new Error(secret); },
        },
        editor: workingEditor,
      }),
    },
    {
      expectedMessage: "Interactive request editor is unavailable",
      wizard: createInteractiveRequestWizard({
        catalogSource: { load: async () => catalog },
        console: consoleFixture(),
        editor: { edit: async () => { throw new Error(secret); } },
      }),
    },
    {
      expectedMessage: "Interactive request console is unavailable",
      wizard: createInteractiveRequestWizard({
        catalogSource: { load: async () => catalog },
        console: {
          ...consoleFixture(),
          close: async () => { throw new Error(secret); },
        },
        editor: workingEditor,
      }),
    },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      createProductionRequestSource({ stdinIsTerminal: () => true, wizard: fixture.wizard })
        .read(parseCliInvocation(["preview"])),
      (error: unknown) => isToolError(error, "INPUT_ERROR") &&
        error.message === fixture.expectedMessage &&
        !`${error.message}\n${JSON.stringify(error.details)}`.includes(secret),
    );
  }
});
