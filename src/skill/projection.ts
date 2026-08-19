import { SemVer } from "semver";

import { ToolError } from "../contracts/errors.ts";

export interface SkillProjectionOptions {
  readonly skillVersion: string;
  readonly skillProtocol: number;
}

function projectionError(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Skill projection options are invalid", {
    field: "skill",
    expected: "a canonical Skill version and positive protocol",
    actual: "invalid Skill projection options",
    safeNextStep: "Use the signed Skill component version and protocol reported by the CLI.",
  });
}

/**
 * The standalone Skill is intentionally a thin adapter. It references the
 * CLI's live Schema, renderer and candidate-token resolver instead of copying
 * template text or label names into the Skill asset.
 */
export function renderSkillInstructions(options: SkillProjectionOptions): string {
  if (options === null || typeof options !== "object" || typeof options.skillVersion !== "string" ||
      options.skillVersion.trim() !== options.skillVersion || !Number.isSafeInteger(options.skillProtocol) ||
      options.skillProtocol < 1) {
    throw projectionError();
  }
  try {
    if (new SemVer(options.skillVersion, { loose: false }).version !== options.skillVersion) throw new Error("version");
  } catch {
    throw projectionError();
  }
  return [
    "# harness-mr",
    "",
    `Skill version: ${options.skillVersion}; protocol: ${String(options.skillProtocol)}.`,
    "",
    "For every invocation, keep the loaded Skill version and protocol fixed until the invocation ends.",
    "The first executable step is always:",
    "",
    "```text",
    "harness-mrtool context --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Use the returned Schema, diff evidence, and test output to build the Request. Ask the user for values that the repository cannot establish.",
    "Use the CLI renderer and candidate tokens; do not copy template sections, label names, or user IDs into this Skill.",
    "",
    "Run the read-only preview before a side effect:",
    "",
    "```text",
    "harness-mrtool preview --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "When the user has confirmed the JSON Request, stream it through stdin to exactly one of:",
    "",
    "```text",
    "harness-mrtool create --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "harness-mrtool update <iid> --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Report only the CLI JSON result. Preserve activationRequired and hostRefreshMayBeRequired exactly; an explicit activation may require a host refresh, and never changes this invocation's loaded instructions.",
    "",
  ].join("\n");
}
