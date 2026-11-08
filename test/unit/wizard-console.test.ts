import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeWizardConsole,
  type WizardQuestionPort,
} from "../../src/cli/wizard-console.ts";

function questions(...answers: string[]): {
  readonly calls: string[];
  readonly closes: () => number;
  readonly port: WizardQuestionPort;
} {
  const calls: string[] = [];
  let closeCalls = 0;
  return {
    calls,
    closes: () => closeCalls,
    port: {
      question: async (prompt) => {
        calls.push(prompt);
        const answer = answers.shift();
        if (answer === undefined) throw new Error("unexpected question");
        return answer;
      },
      close: () => { closeCalls += 1; },
    },
  };
}

test("node wizard console accepts only numeric indexes for enumerated choices", async () => {
  const fixture = questions("code", "2", "opaque-token", "1, 3");
  const console = createNodeWizardConsole({ questionPort: fixture.port });
  const one = await console.selectOne({
    id: "profile",
    prompt: "Profile",
    choices: [{ label: "Code" }, { label: "Docs" }],
  });
  const many = await console.selectMany({
    id: "labels",
    prompt: "Labels",
    choices: [{ label: "Bug" }, { label: "Feature" }, { label: "Docs" }],
    min: 1,
    max: 2,
  });

  assert.equal(one, 1);
  assert.deepEqual(many, [0, 2]);
  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.calls.every((prompt) => !prompt.includes("opaque-token")), true);
  await console.close?.();
  assert.equal(fixture.closes(), 1);
});

test("node wizard console preserves exact text and handles defaults without pre-reading", async () => {
  const fixture = questions("  exact summary  ", "", "n");
  const console = createNodeWizardConsole({ questionPort: fixture.port });

  assert.equal(await console.text({ id: "summary", prompt: "Summary" }), "  exact summary  ");
  assert.equal(await console.text({ id: "default", prompt: "Default", defaultValue: "value" }), "value");
  assert.equal(await console.text({ id: "literal", prompt: "Literal" }), "n");
  assert.equal(Object.hasOwn(console, "confirm"), false);
  assert.equal(fixture.calls.length, 3);
});
