import type { Request } from "../contracts/request.ts";
import { canonicalizeJson, type JsonValue } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import type { InputIo } from "../input/load-input.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";
import { loadCliInput } from "./input.ts";
import { mayPrompt } from "./options.ts";
import type { CliInvocation } from "./program.ts";

export interface InteractiveRequestWizard {
  readonly collect: (input: {
    readonly invocation: CliInvocation;
  }) => Promise<unknown>;
}

export interface ProductionRequestSourceOptions {
  readonly inputIo?: InputIo;
  readonly stdinIsTerminal?: () => boolean;
  readonly wizard?: InteractiveRequestWizard;
}

export interface ProductionRequestSource {
  readonly read: (invocation: CliInvocation) => Promise<Request>;
}

const normalizedRequests = new WeakSet<object>();
const canonicalRequests = new WeakMap<object, string>();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function structuredInputRequired(): ToolError<"INPUT_ERROR"> {
  return new ToolError(
    "INPUT_ERROR",
    "Structured input is required for non-interactive execution",
    {
      field: "--input",
      expected: "an explicit JSON or YAML file, explicit formatted stdin, or a manual TTY wizard",
      actual: "structured input missing",
      safeNextStep: "Pass --input with a JSON or YAML request; use --input - only when intentionally consuming stdin.",
    },
  );
}

function interactiveWizardUnavailable(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Interactive request collection is unavailable", {
    field: "wizard",
    expected: "a configured manual TTY request wizard",
    actual: "interactive wizard unavailable",
    safeNextStep: "Configure an editor and retry from a TTY, or pass an explicit JSON or YAML input.",
  });
}

function automationMigrationConfirmationRequired(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Template migration confirmation is required for automation", {
    field: "--confirm-migration",
    expected: "the exact <old-sha256>:<new-sha256> pair with --migrate-template",
    actual: "migration confirmation missing",
    safeNextStep: "Pass the exact confirmation pair returned by migration context, then retry.",
  });
}

export function normalizeProductionRequest(value: unknown): Request {
  if (value !== null && typeof value === "object" && normalizedRequests.has(value)) {
    return value as Request;
  }
  const request = deepFreeze(normalizeAndValidateRequest(value));
  normalizedRequests.add(request);
  canonicalRequests.set(request, `${canonicalizeJson(request as unknown as JsonValue)}\n`);
  return request;
}

export function canonicalRequestBytes(request: Request): Uint8Array {
  const canonical = canonicalRequests.get(request as object) ??
    `${canonicalizeJson(normalizeProductionRequest(request) as unknown as JsonValue)}\n`;
  return Buffer.from(canonical, "utf8");
}

export function createProductionRequestSource(
  options: ProductionRequestSourceOptions = {},
): ProductionRequestSource {
  const stdinIsTerminal = options.stdinIsTerminal ?? (() => process.stdin.isTTY === true);
  return Object.freeze({
    read: async (invocation: CliInvocation): Promise<Request> => {
      if (
        invocation.command.kind === "update" && invocation.command.migrateTemplate &&
        invocation.command.confirmation === null && invocation.options.input !== null
      ) {
        throw automationMigrationConfirmationRequired();
      }
      if (invocation.options.input !== null) {
        const value = options.inputIo === undefined
          ? await loadCliInput(invocation.options)
          : await loadCliInput(invocation.options, options.inputIo);
        if (value === null) throw structuredInputRequired();
        return normalizeProductionRequest(value);
      }

      if (!mayPrompt(invocation.options, stdinIsTerminal())) {
        throw structuredInputRequired();
      }
      if (options.wizard === undefined) throw interactiveWizardUnavailable();
      return normalizeProductionRequest(await options.wizard.collect({ invocation }));
    },
  });
}
