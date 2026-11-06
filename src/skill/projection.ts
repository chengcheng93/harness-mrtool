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
    "MR diffs and pushes use committed HEAD only. Staged, unstaged, and untracked files, including .superpowers reports, may remain; a clean worktree is not required. Do not automatically add, stash, clean, or delete local files to run push, create, update, or manual handoff.",
    "The default path is API automation for creating, updating, and verifying MRs. Begin with local Bundle inspection:",
    "",
    "```text",
    "harness-mrtool schema show --output json",
    "harness-mrtool profiles list --output json",
    "```",
    "",
    "Obtain API context before constructing the Request. For an existing MR, add --mr <iid> and use its pinned Bundle and schema:",
    "",
    "```text",
    "harness-mrtool context --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Build the Request only after API context succeeds, using the returned Schema, CLI-issued candidate identities, and repository evidence. Ask the user for values that the repository cannot establish.",
    "GitLab supports HTTP and HTTPS. Explicit HTTP/HTTPS remotes preserve their scheme; SSH/scp/git remotes infer HTTP first and try same-host HTTPS when HTTP is unavailable.",
    "If API credentials are missing or API requests fail, stop and explain the API blocker and required next step. Never automatically fall back to manual mode, SSH MR creation, or a web handoff.",
    "API mode may still use ordinary Git SSH transport for branch pushes; API authentication controls GitLab MR operations.",
    "Use the CLI renderer; do not copy template sections, label names, or user IDs into this Skill.",
    "Mandatory labels are selected by the CLI from the committed diff: one type, p2 by default, and lifecycle status. Week labels are retired. SSH-only MR creation is blocked.",
    "Stream the structured Request through stdin for the read-only preview:",
    "",
    "```text",
    "harness-mrtool preview --auth api --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Show the preview and obtain required confirmation before writing. Preserve the exact normalized Request and any diff-bound confirmation; stream it through stdin to exactly one of:",
    "",
    "```text",
    "harness-mrtool create --auth api --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "harness-mrtool update <iid> --auth api --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Verify the resulting stored MR state before reporting completion:",
    "",
    "```text",
    "harness-mrtool verify <iid> --auth api --level structure --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Respect CLI receipt verification and the exact historical Bundle for existing MRs; follow context --mr <iid> and update <iid> or explicitly confirmed template migration when directed. Never substitute the current Bundle for a historical one.",
    "Manual mode is disabled by default. Use it only when the human explicitly requests an SSH manual handoff, with explicit --auth ssh:",
    "",
    "```text",
    "harness-mrtool manual --auth ssh --input - --input-format json --output json",
    "```",
    "",
    "Show the title, body, target branch, and push plan. After confirmation, rerun with --push. The user creates the MR in GitLab and selects live labels and reviewers. Ordinary handoff is not verified MR creation. --ssh-mr is disabled and returns LABEL_ERROR before push planning or execution, even with --push; never use SSH push options to bypass mandatory API label verification.",
    "Report only the CLI JSON result. Preserve failed or partial transaction state, activationRequired, and hostRefreshMayBeRequired exactly; an explicit activation may require a host refresh, and never changes this invocation's loaded instructions.",
    "",
  ].join("\n");
}
