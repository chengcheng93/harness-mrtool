import { createInterface } from "node:readline/promises";

import { ToolError } from "../contracts/errors.ts";
import type { WizardChoice, WizardConsole } from "./wizard.ts";

export interface WizardQuestionPort {
  readonly question: (prompt: string) => Promise<string>;
  readonly close: () => void | Promise<void>;
}

export interface NodeWizardConsoleOptions {
  readonly questionPort?: WizardQuestionPort;
}

function consoleError(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Interactive console input failed", {
    field: "wizard",
    expected: "a manual TTY answer using the displayed numeric choices",
    actual: "interactive answer unavailable",
    safeNextStep: "Restart from a TTY or pass an explicit JSON or YAML input.",
  });
}

function defaultQuestionPort(): WizardQuestionPort {
  let readline: ReturnType<typeof createInterface> | undefined;
  return Object.freeze({
    question: async (prompt: string): Promise<string> => {
      readline ??= createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      return readline.question(prompt);
    },
    close: () => { readline?.close(); },
  });
}

function renderedPrompt(prompt: string, choices: readonly WizardChoice[], suffix: string): string {
  return `${prompt}\n${choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n")}\n${suffix}`;
}

async function question(port: WizardQuestionPort, prompt: string): Promise<string> {
  try {
    const answer = await port.question(prompt);
    if (typeof answer !== "string") throw new TypeError("invalid console answer");
    return answer;
  } catch {
    throw consoleError();
  }
}

function oneBasedIndex(answer: string, length: number): number | null {
  if (!/^[1-9][0-9]*$/u.test(answer)) return null;
  const value = Number(answer) - 1;
  return Number.isSafeInteger(value) && value >= 0 && value < length ? value : null;
}

function manyIndexes(answer: string, length: number): readonly number[] | null {
  if (answer === "-") return [];
  const parts = answer.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === "")) return null;
  const indexes = parts.map((part) => oneBasedIndex(part, length));
  if (indexes.some((index) => index === null)) return null;
  const values = indexes as number[];
  return new Set(values).size === values.length ? values : null;
}

export function createNodeWizardConsole(
  options: NodeWizardConsoleOptions = {},
): WizardConsole {
  const port = options.questionPort ?? defaultQuestionPort();
  return Object.freeze({
    selectOne: async ({ prompt, choices, defaultIndex }: Parameters<WizardConsole["selectOne"]>[0]) => {
      for (;;) {
        const answer = (await question(
          port,
          renderedPrompt(prompt, choices, defaultIndex === undefined ? "Selection: " : `Selection [${defaultIndex + 1}]: `),
        )).trim();
        if (answer === "" && defaultIndex !== undefined && defaultIndex >= 0 && defaultIndex < choices.length) {
          return defaultIndex;
        }
        const selected = oneBasedIndex(answer, choices.length);
        if (selected !== null) return selected;
      }
    },
    selectMany: async ({
      prompt,
      choices,
      defaultIndexes = [],
      min = 0,
      max = choices.length,
    }: Parameters<WizardConsole["selectMany"]>[0]) => {
      for (;;) {
        const defaults = defaultIndexes.map((index) => index + 1).join(",");
        const answer = (await question(
          port,
          renderedPrompt(
            prompt,
            choices,
            defaults === "" ? "Selections (comma-separated, - for none): " : `Selections [${defaults}]: `,
          ),
        )).trim();
        const selected = answer === "" ? [...defaultIndexes] : manyIndexes(answer, choices.length);
        if (selected !== null && selected.length >= min && selected.length <= max) return selected;
      }
    },
    text: async ({ prompt, defaultValue }: Parameters<WizardConsole["text"]>[0]) => {
      const answer = await question(
        port,
        defaultValue === undefined ? `${prompt}: ` : `${prompt} [${defaultValue}]: `,
      );
      return answer === "" && defaultValue !== undefined ? defaultValue : answer;
    },
    confirm: async ({ prompt, defaultValue }: Parameters<WizardConsole["confirm"]>[0]) => {
      for (;;) {
        const answer = (await question(port, `${prompt} [${defaultValue ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
        if (answer === "") return defaultValue;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
      }
    },
    close: async () => {
      try {
        await port.close();
      } catch {
        throw consoleError();
      }
    },
  });
}
