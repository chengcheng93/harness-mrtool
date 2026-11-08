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
    "Initialize GitLab access immediately after CLI/plugin installation or when connecting a new host; do not defer the check until MR submission.",
    "Run harness-mrtool auth check --host <http-or-https-origin> --output json. Reuse existing host-bound credentials; on Windows use the plugin scripts/setup-gitlab.ps1 hidden-input setup if configuration is missing. Never request tokens in chat or place them in argv or repository files. A PAT needs api scope. Browser login and Git SSH authentication do not establish API authorization.",
    "Plugin SessionStart checks require trusted hooks; otherwise perform initialization explicitly. Report initialization incomplete until auth check succeeds. An instance-only check does not establish project access: run harness-mrtool auth check --output json when binding a repository. Authorization checks never create an MR.",
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
    "A user request to submit, create, or update an MR authorizes the normal API write.",
    "Run automatic checks and proceed directly to create/update; do not add a preview or repeat human confirmation for an already authorized submission. Ask only for required factual information that cannot be established. Do not add human approval, type selection, digest/hash entry, or confirmation steps to any MR workflow.",
    "Documentation and source-comment-only changes are automatically doc. Other recognized changes use their detected type; unknown or ambiguous changes automatically use chore. Do not ask the user to choose or confirm a type or labels. Diff and migration hashes are bound and verified automatically.",
    "Stream the structured Request through stdin; never put request contents, candidate tokens, credentials, or long text in arguments. Preserve the exact normalized Request and its automatically derived diff binding; use exactly one of:",
    "",
    "```text",
    "harness-mrtool create --auth api --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "harness-mrtool update <iid> --auth api --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "After create/update succeeds, verify the resulting stored MR state automatically before reporting completion, then return the verified MR link. Keep routine checks internal; explain a real blocker or partial failure instead of presenting it as a completed submission:",
    "",
    "```text",
    "harness-mrtool verify <iid> --auth api --level structure --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Run the read-only preview only when the user explicitly requests it; it is not a prerequisite for ordinary API create/update. If the user asks to review a preview before submission, return the preview without submitting an MR:",
    "",
    "```text",
    "harness-mrtool preview --auth api --input - --input-format json --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json",
    "```",
    "",
    "Respect CLI receipt verification and the exact historical Bundle for existing MRs; follow context --mr <iid> and update <iid> or explicitly requested template migration with automatic old:new hash binding when directed. Never substitute the current Bundle for a historical one.",
    "Manual mode is disabled by default. Use it only when the human explicitly requests an SSH manual handoff, with explicit --auth ssh:",
    "",
    "```text",
    "harness-mrtool manual --auth ssh --input - --input-format json --output json",
    "```",
    "",
    "Show the title, body, target branch, and push plan. If the user requested the branch push, run with --push directly; do not ask for another confirmation. The user creates the MR in GitLab and selects live labels and reviewers. Ordinary handoff is not verified MR creation. --ssh-mr is disabled and returns LABEL_ERROR before push planning or execution, even with --push; never use SSH push options to bypass mandatory API label verification.",
    "On verified success, return a concise Markdown MR link, with at most one short summary sentence. Keep CLI calls on --output json; show raw JSON only when the user explicitly requests it.",
    "On failure or partial write, faithfully report the CLI's ok, code, actual remote state, transaction audit, and applicable activationRequired or hostRefreshMayBeRequired fields. Do not rewrite these values or present a failed or partial transaction as success. An explicit activation may require a host refresh, and never changes this invocation's loaded instructions.",
    "",
  ].join("\n");
}
