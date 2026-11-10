import type { Request, VerificationItem } from "../contracts/request.ts";

export interface RenderIssueInputs {
  readonly request: Request;
  readonly projectPath: string;
  readonly authorUserId: string;
  readonly date: string;
}

/** Compute once at the submission boundary, then pass the date to renderIssue. */
export function chinaDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Keep supplied Markdown, but never emit a user-provided GitLab quick action. */
function descriptiveText(value: string): string {
  let fence: { marker: string; length: number } | undefined;
  return value.replace(/\r\n?/gu, "\n").split("\n").map((line) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== undefined) {
      if (delimiter !== null && delimiter[1]![0] === fence.marker &&
          delimiter[1]!.length >= fence.length && /^[ \t]*$/u.test(delimiter[2]!)) {
        fence = undefined;
      }
      return line;
    }
    if (delimiter !== null && (delimiter[1]![0] === "~" || !delimiter[2]!.includes("`"))) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      return line;
    }
    return line.replace(/^([ \t]*)\/(?=[a-z][a-z_-]*(?:\s|$))/giu, "$1&#47;")
      .replace(/^( {0,3})##(?=\s|$)/gu, "$1\\##");
  }).join("\n");
}

function nonempty(values: readonly string[]): string[] {
  return values.filter((value) => value.trim() !== "");
}

function details(label: string, values: readonly string[]): string {
  const content = nonempty(values);
  return content.length === 0 ? "" : `### ${descriptiveText(label)}\n\n${content.map(descriptiveText).join("\n\n")}`;
}

function section(title: string, blocks: readonly string[]): string {
  return `## ${title}\n\n${blocks.filter((value) => value !== "").join("\n\n")}`.trimEnd();
}

function verificationRecord(item: VerificationItem): string {
  const states = { checked: "已验证", pending: "待验证", "not-applicable": "不适用" };
  const marker = item.state === "checked" ? "[x]" : "[ ]";
  return [
    `- ${marker} ${descriptiveText(item.id)}（${states[item.state]}；${descriptiveText(item.evidenceKind)}）`,
    item.command ? `命令：\n\n${descriptiveText(item.command)}` : "",
    item.result ? `结果：\n\n${descriptiveText(item.result)}` : "",
    item.evidence.trim() ? `证据 / 原因：\n\n${descriptiveText(item.evidence)}` : "",
  ].filter(Boolean).join("\n\n");
}

export function renderIssue(inputs: RenderIssueInputs): { title: string; description: string; dueDate: string } {
  const { request, projectPath, authorUserId, date } = inputs;
  const sourceChange = request.impact.nature === "docs-only"
    ? "无（仅文档）" : request.profileIds.includes("code") ? "有（code）" : "未明确";
  const workItem = request.workItem;
  const related = "iid" in workItem
    ? `关联工作项：#${workItem.iid}（${workItem.relation}）`
    : "noIssueReason" in workItem ? details("工作项说明", [workItem.noIssueReason]) : "";
  const acceptance = nonempty(request.verification.acceptanceEvidence)
    .map((value, index) => `- [ ] 验收依据 ${index + 1}\n\n${descriptiveText(value)}`).join("\n\n");
  const specialty = Object.keys(request.profileFields).sort().map((key) =>
    details(`专项说明：${key}`, request.profileFields[key] ?? [])).filter(Boolean);
  const description = [
    section("基本信息", [
      `- 项目：${descriptiveText(projectPath)}\n- 模块：${descriptiveText(request.title.module)}\n- 负责人（当前用户 ID）：${descriptiveText(authorUserId)}\n- 阶段日期：${descriptiveText(date)}\n- 计划日期：${descriptiveText(date)}\n- 类型：${descriptiveText(request.title.type)}\n- 源码变更：${sourceChange}`,
      details("工作类型", request.profileIds),
    ]),
    section("背景与目标", [details("背景", request.motivation.background), details("目标与必要性", request.motivation.whyNeeded)]),
    section("工作内容与交付物", [
      details("工作内容", request.changes.summary), details("范围外", request.changes.outOfScope),
      details("文档项", request.documentation.itemIds), details("文档交付与状态", request.documentation.details), ...specialty,
    ]),
    section("方案与影响范围", [
      details("技术方案", request.changes.technicalChanges), details("影响区域", request.impact.areaIds),
      `影响性质：${descriptiveText(request.impact.nature)}`, details("影响说明", request.impact.details),
    ]),
    section("验收标准", [acceptance, "- [ ] Review 待完成\n- [ ] MR 合并待完成"]),
    section("验证记录", [
      request.verification.items.length === 0 ? "未提供验证记录" : request.verification.items.map(verificationRecord).join("\n\n"),
      details("已知缺口", request.verification.knownGaps),
    ]),
    section("风险与回滚", [
      `风险等级：${descriptiveText(request.risk.level)}`, details("风险说明", request.risk.items),
      details("兼容性影响", request.risk.compatibilityImpact), details("回滚方案", request.risk.rollbackPlan),
    ]),
    section("关联信息", [
      `目标分支：${descriptiveText(request.targetBranch)}`, related,
      details("评审关注点", request.review.reviewerFocus), details("补充说明", request.review.additionalNotes),
    ]),
  ].join("\n\n") + "\n";
  return { title: `[${request.title.module}] ${request.title.titleSummary}`, description, dueDate: date };
}
