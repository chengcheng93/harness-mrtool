import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Request } from "../../src/contracts/request.ts";
import { chinaDate, renderIssue } from "../../src/render/issue.ts";

async function request(): Promise<Request> {
  return JSON.parse(await readFile(new URL("../golden/fixtures/code-docs-request.json", import.meta.url), "utf8")) as Request;
}

const inputs = { projectPath: "group/apps", authorUserId: "7", date: "2026-11-10" };
const sections = ["基本信息", "背景与目标", "工作内容与交付物", "方案与影响范围", "验收标准", "验证记录", "风险与回滚", "关联信息"];

test("renders one deterministic eight-section Issue with the supplied title, actor and frozen dates", async () => {
  const value = { ...inputs, request: await request() };
  const rendered = renderIssue(value);
  assert.equal(rendered.title, "[luban-studio] Preserve WebEngine-compatible CSS output");
  assert.equal(rendered.dueDate, inputs.date);
  assert.deepEqual([...rendered.description.matchAll(/^## (.+)$/gmu)].map((match) => match[1]), sections);
  for (const text of ["group/apps", "luban-studio", "7", "fix", "源码变更", "阶段日期：2026-11-10", "计划日期：2026-11-10"]) {
    assert.ok(rendered.description.includes(text), text);
  }
  assert.deepEqual(renderIssue(value), rendered);
});

test("preserves specialty details, documentation, compatibility, rollback and every nonempty profile field", async () => {
  const base = await request();
  const profileFields = {
    "bug.reproduction": ["复现：点击保存\n实际：HTTP 500；预期：保存成功\n环境：Windows 11；日志：trace-42"],
    "feature.scope": ["包含：导出；不包含：导入"],
    "docs.paths": ["docs/guide.md；状态：待更新"],
    "ops.systems": ["影响系统：staging-worker；回滚：恢复旧镜像"],
    "tests.environment": ["环境：本地 Node 24；结果：尚未运行"],
    "release.artifacts": ["版本：v2.0；制品：app-v2.zip"],
    "custom.extra": ["自定义字段仍须保留"],
    "empty.optional": ["", "   "],
  };
  const value = { ...base, profileFields, verification: { ...base.verification, knownGaps: ["尚未覆盖 ARM64"] } };
  const body = renderIssue({ ...inputs, request: value }).description;
  const groups = [value.motivation.background, value.motivation.whyNeeded, value.changes.summary,
    value.changes.technicalChanges, value.changes.outOfScope, value.impact.areaIds, value.impact.details,
    value.documentation.itemIds, value.documentation.details, value.verification.acceptanceEvidence,
    value.verification.knownGaps, value.risk.items, value.risk.compatibilityImpact, value.risk.rollbackPlan,
    ...Object.values(profileFields)];
  for (const text of groups.flat().filter((text) => text.trim() !== "")) assert.ok(body.includes(text), text);
  assert.ok(!body.includes("empty.optional"));
  assert.equal(renderIssue({ ...inputs, request: { ...value, profileFields: Object.fromEntries(Object.entries(profileFields).reverse()) } }).description, body);
});

test("separates acceptance from observed checked, pending and not-applicable verification without claiming review or merge", async () => {
  const base = await request();
  const value: Request = { ...base, verification: { ...base.verification, items: [...base.verification.items,
    { id: "browser-tests", state: "not-applicable", evidenceKind: "not-applicable-reason", command: null, result: null, evidence: "仅 CLI，无浏览器界面" }],
  } };
  const body = renderIssue({ ...inputs, request: value }).description;
  const acceptance = body.split("## 验收标准\n")[1]!.split("## 验证记录")[0]!;
  assert.match(acceptance, /- \[ \] Review 待完成/u);
  assert.match(acceptance, /- \[ \] MR 合并待完成/u);
  assert.doesNotMatch(acceptance, /\[x\]/iu);
  for (const item of value.verification.items) {
    assert.ok(body.includes(item.id));
    assert.ok(body.includes(item.evidence));
    if (item.command) assert.ok(body.includes(item.command));
    if (item.result) assert.ok(body.includes(item.result));
  }
  assert.match(body, /\[x\] local-build（已验证/u);
  assert.match(body, /\[ \] integration-tests（待验证/u);
  assert.match(body, /browser-tests（不适用/u);
  assert.doesNotMatch(body, /\[x\].*(?:Review|MR 合并)/iu);
});

test("allows absent optional content and empty TAPD or milestone without inventing evidence", async (context) => {
  context.mock.method(globalThis, "fetch", () => { throw new Error("renderer must not use the network"); });
  const base = await request();
  const value: Request = { ...base, profileIds: ["docs"], impact: { areaIds: [], nature: "docs-only", details: [] },
    changes: { summary: [], technicalChanges: [], outOfScope: [] }, motivation: { background: [], whyNeeded: [] },
    verification: { items: [], acceptanceEvidence: [], knownGaps: [] }, documentation: { itemIds: [], details: [] },
    risk: { level: "low", items: [], compatibilityImpact: [], rollbackPlan: [] },
    profileFields: { TAPD: [], milestone: [""] }, workItem: { relation: "none", noIssueReason: "本次创建统一工作项" } };
  const body = renderIssue({ ...inputs, request: value }).description;
  assert.equal([...body.matchAll(/^## /gmu)].length, 8);
  assert.match(body, /源码变更：无（仅文档）/u);
  assert.match(body, /验证记录\n\n未提供验证记录/u);
  assert.doesNotMatch(body, /\[x\]|测试通过|TAPD|milestone|\| ---/iu);
});

test("keeps user Markdown readable while neutralizing standalone GitLab quick actions in all multiline fields", async () => {
  const base = await request();
  const text = "**复现**\n\n1. 打开页面\n/close\n  /label ~bug\n正常描述 /close 不应丢失\n## 用户小节";
  const value: Request = { ...base, motivation: { ...base.motivation, background: [text] },
    profileFields: { "/close": ["/assign @someone"] }, verification: { ...base.verification,
      items: [{ id: "manual", state: "checked", evidenceKind: "manual-verification", command: null, result: "结果\n/close", evidence: "证据\n/label ~bug" }] } };
  const body = renderIssue({ ...inputs, request: value }).description;
  assert.ok(body.includes("**复现**"));
  assert.ok(body.includes("1. 打开页面"));
  assert.ok(body.includes("正常描述 /close 不应丢失"));
  assert.doesNotMatch(body, /^\s*\/[a-z][a-z_-]*(?:\s|$)/gimu);
  assert.equal([...body.matchAll(/^## /gmu)].length, 8);
  assert.ok(body.includes("close"));
  assert.ok(body.includes("assign @someone"));
});

test("uses Asia/Shanghai calendar dates across the UTC day boundary and passes the same frozen date to both fields", async () => {
  assert.equal(chinaDate(new Date("2026-11-10T15:59:59.999Z")), "2026-11-10");
  const date = chinaDate(new Date("2026-11-10T16:00:00.000Z"));
  assert.equal(date, "2026-11-11");
  assert.equal(chinaDate(new Date("2026-12-31T23:59:59Z")), "2027-01-01");
  assert.match(chinaDate(), /^\d{4}-\d{2}-\d{2}$/u);
  const rendered = renderIssue({ ...inputs, date, request: await request() });
  assert.equal(rendered.dueDate, date);
  assert.ok(rendered.description.includes(`阶段日期：${date}`));
  assert.ok(rendered.description.includes(`计划日期：${date}`));
});

test("preserves fenced technical examples and neutralizes quick actions after matching fences close", async () => {
  const base = await request();
  const examples = [
    "```sh\n## setup comment\n/health\n```",
    "~~~sh\n## setup comment\n/close\n```\n/health\n~~~~",
    "````sh\n## setup comment\n```\n/health\n````",
  ];
  for (const example of examples) {
    const content = `${example}\n/close\n## outside heading`;
    const value: Request = { ...base, changes: { ...base.changes, technicalChanges: [content] },
      verification: { ...base.verification, acceptanceEvidence: [content], items: [{
        id: "example", state: "checked", evidenceKind: "command-output", command: content, result: content, evidence: content,
      }] },
    };
    const body = renderIssue({ ...inputs, request: value }).description;
    assert.equal(body.split(`\n\n${example}\n`).length - 1, 5, `technical example changed: ${example}`);
    assert.ok(body.includes("\n&#47;close\n\\## outside heading"));
  }
});
