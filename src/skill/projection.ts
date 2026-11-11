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
    "# Harness MR",
    "",
    "The CLI is the authority for schemas, profiles, candidate identity, labels,",
    "rendering and GitLab writes. Do not invent IDs, labels or template fields.",
    `Skill version: ${options.skillVersion}; protocol: ${String(options.skillProtocol)}. Keep this invocation's loaded version/protocol fixed.`,
    "For installation/auth initialization, non-Windows direct CLI, explicit preview,",
    "or historical MRs, read [workflows](references/workflows.md) on demand.",
    "Initialize missing GitLab API authorization immediately; never collect tokens in chat/argv/repo.",
    "",
    "## Default Issue-first submission",
    "",
    "1. Inspect repository/project authorization, branch and the actual diff. MR uses committed",
    "   HEAD only. If authorized to submit uncommitted changes, select exact reviewed files,",
    "   stage only those paths, commit only that selection (exclude unrelated staged files),",
    "   then ordinary non-force push the selected source commit. API commands do not push;",
    "   Git may use SSH. A clean worktree is unnecessary; never add-all, stash, clean or delete.",
    "2. On Windows run the bundled [runner](scripts/run-flow.ps1) with native harness-mrtool.exe",
    "   and Windows PowerShell 5.1; no Node, Python or PowerShell 7 is required.",
    "   Use absolute repository/Request paths and the same loaded version/protocol throughout:",
    "",
    "~~~powershell",
    `& "<skill-root>/scripts/run-flow.ps1" -Phase context -Repository "<absolute-repo>" -ClientVersion ${options.skillVersion} -SkillProtocol ${String(options.skillProtocol)}`,
    "~~~",
    "",
    "Context runs schema show, profiles list, then API context exactly once; inspect its",
    "cliResult. Stop on any failed step. API credentials are missing or API requests fail, stop and explain",
    "the blocker. Never automatically fall back to manual mode, SSH MR creation or web handoff.",
    "",
    "3. Build the Request only after API context succeeds. Create one complete Request from",
    "   returned schema/context/candidate identities and the reviewed diff; use",
    "   workItem: { \"relation\": \"new\" }. Every new MR requires successful Issue creation first.",
    "   New submissions reject none/closes/related; do not select an existing Issue.",
    "   Use only the unique kind=assignee/defaultSelected=true candidate for assignee;",
    "   otherwise stop for the missing fact. Unspecified reviewers stay []; explicit usernames",
    "   must match real reviewer candidates; never select the author as self-reviewer.",
    "   Fill existing motivation/changes/verification/risk/profile text with problem/scenarios,",
    "   implementation/impact, tests, deployment/rollback and acceptance. Pending checks stay pending.",
    "   CLI renders the unified eight-section Issue; no extra template selection or AI call.",
    "4. A submit/create request authorizes the normal API write. Proceed to create without extra",
    "   preview, repeated confirmation, label/type selection or hash entry. CLI classifies the diff,",
    "   defaults priority to p2 (p0/p1 needs a reason), and requires existing labels. Exactly three",
    "   planned MR labels and selected personnel enter its initial POST; no labels are created.",
    "   CLI freezes today's Asia/Shanghai date for Issue dates and selects the nearest active",
    "   project/ancestor-group milestone with a valid due_date strictly after today (same date:",
    "   smallest numeric ID). Issue and MR share that milestone_id. No future candidate omits it",
    "   with structured no-future-milestone; read failure stops before POST/ticket consumption.",
    "",
    "~~~powershell",
    `& "<skill-root>/scripts/run-flow.ps1" -Phase create -Repository "<absolute-repo>" -ClientVersion ${options.skillVersion} -SkillProtocol ${String(options.skillProtocol)} -RequestPath "<absolute-request.json>"`,
    "~~~",
    "",
    "Runner passes Request raw bytes unchanged via stdin; CLI owns all parsing/validation.",
    "Never put Request text, candidate tokens or credentials in argv. Runner stdout is one JSON:",
    "runnerSchemaVersion/phase/elapsedMs/steps plus the complete CLI envelope in cliResult.",
    "Use safe stderr progress and Stopwatch step/total timings; show raw JSON only when explicitly requested.",
    "A running process can exceed 30 seconds: continue waiting on that same session, never restart create.",
    "Host termination cannot guarantee final JSON. If create started without a complete CLI result,",
    "report unknown and stop; do not retry or infer success from elapsed time.",
    "",
    "Write order is Issue POST then MR POST. After the first POST, no GET, PUT, GraphQL,",
    "readback, verify, retry, query recovery or rollback. Return the creation-response MR URL",
    "as a concise Markdown link, say created, and include runner total/step timings briefly.",
    "On failure/partial write preserve CLI ok/code/remoteWrite, known Issue URL, MR failure or",
    "unknown outcome, audit, activationRequired and hostRefreshMayBeRequired. Stop immediately.",
    "For existing historical MRs, follow the on-demand workflows; never use",
    "legacy update/verify/upsert/resume to recover a fast submission.",
    "",
  ].join("\n");
}
