import assert from "node:assert/strict";
import type { GitLabHttpRequest, GitLabHttpResponse, GitLabHttpTransport } from "../../src/gitlab/http.ts";

const names = ["type::bug", "priority::p2", "status::doing", "status::review"] as const;
const author = { id: 42, username: "author", name: "Author", state: "active", access_level: 40 };
const reviewer = { id: 43, username: "reviewer", name: "Reviewer", state: "active", access_level: 40 };
type WireObject = Record<string, unknown>;

/** Stateful HTTP boundary only: the actual GitLabClient parses inventory, mutations and readback. */
export class RealGitLabelTransport implements GitLabHttpTransport {
  readonly origin = "https://gitlab.example.test";
  readonly project = { id: "7", fullPath: "group/project", defaultBranch: "main", webUrl: `${this.origin}/group/project` };
  readonly requests: { method: string; path: string; body: WireObject }[] = [];
  readonly writes: string[] = [];
  readonly unexpected: string[] = [];
  readonly labels = names.map((name, index) => ({ id: index + 1, name, description: name, color: "#123456", archived: false }));
  mr: WireObject | null = null;
  beforeFind: (() => Promise<void>) | undefined;
  private sequence = 0;

  constructor(readonly sourceSha: string, readonly targetSha: string, readonly sourceBranch: string) {}

  private current(): WireObject {
    assert.ok(this.mr, "MR readback must follow an actual create request");
    return this.mr;
  }

  async request(request: GitLabHttpRequest): Promise<GitLabHttpResponse> {
    const url = new URL(request.url);
    assert.equal(url.origin, this.origin);
    const path = decodeURIComponent(url.pathname);
    const body = request.body === null ? {} : JSON.parse(Buffer.from(request.body).toString("utf8")) as WireObject;
    this.requests.push({ method: request.method, path, body });
    const respond = (value: unknown): GitLabHttpResponse => ({
      status: 200, headers: { "x-request-id": `real-git-http-${++this.sequence}`, "x-next-page": "" },
      body: Buffer.from(JSON.stringify(value)),
    });
    if (request.method === "GET") {
      if (path === "/api/v4/projects/7" || path === "/api/v4/projects/group/project") return respond({
        id: 7, path_with_namespace: this.project.fullPath, default_branch: "main", web_url: this.project.webUrl,
      });
      if (path === "/api/v4/user") return respond(author);
      if (path === "/api/v4/projects/7/groups") return respond([]);
      if (path === "/api/v4/projects/7/labels") return respond(this.labels);
      if (path === "/api/v4/projects/7/members/all") return respond([author, reviewer]);
      if (path === "/api/v4/projects/7/repository/branches/main") return respond({ name: "main", commit: { id: this.targetSha } });
      if (path === "/api/v4/version") return respond({ version: "18.0.0", revision: "fixture" });
      if (path === "/api/v4/projects/7/merge_requests") {
        const hook = this.beforeFind;
        this.beforeFind = undefined;
        await hook?.();
        return respond(this.mr === null ? [] : [this.mr]);
      }
      if (path === "/api/v4/projects/7/merge_requests/88") return respond(this.current());
      if (path === "/api/v4/projects/7/merge_requests/88/approvals") return respond({
        id: 888, project_id: 7, iid: 88, approved_by: [{ user: reviewer }],
      });
      if (path === "/api/v4/projects/7/merge_requests/88/discussions") return respond([]);
    }
    if (request.method === "POST" && path === "/api/graphql") {
      const query = String(body.query);
      if (query.includes("query HarnessMrtoolLabelGlobalIds")) return respond({ data: { project: {
        id: "gid://gitlab/Project/7", fullPath: this.project.fullPath,
        labels: { nodes: this.labels.map((label) => ({ id: `gid://gitlab/ProjectLabel/${label.id}`, title: label.name })),
          pageInfo: { hasNextPage: false, endCursor: null } },
      } } });
      if (query.includes("query HarnessMrtoolCapabilities")) return respond({ data: {
        mutation: { fields: [{ name: "mergeRequestSetLabels" }] },
        input: { inputFields: ["projectPath", "iid", "labelIds", "operationMode"].map((name) => ({ name })) },
        mode: { enumValues: ["ADD", "REMOVE"].map((name) => ({ name })) },
      } });
      if (query.includes("mutation HarnessMrtoolSetLabels")) {
        const input = (body.variables as { input: { labelIds: string[]; operationMode: string; projectPath: string; iid: string } }).input;
        assert.equal(input.projectPath, this.project.fullPath);
        assert.equal(input.iid, "88");
        this.writes.push(`labels:${input.operationMode}`);
        const selected = this.labels.filter((label) => input.labelIds.includes(`gid://gitlab/ProjectLabel/${label.id}`));
        assert.equal(selected.length, input.labelIds.length);
        const mr = this.current();
        const applied = mr.labels as typeof this.labels;
        mr.labels = input.operationMode === "ADD"
          ? [...applied.filter((label) => !selected.some((item) => item.id === label.id)), ...selected]
          : applied.filter((label) => !selected.some((item) => item.id === label.id));
        return respond({ data: { mergeRequestSetLabels: { errors: [], mergeRequest: {
          iid: "88", targetProject: { id: "gid://gitlab/Project/7", fullPath: this.project.fullPath },
        } } } });
      }
    }
    if (request.method === "POST" && path === "/api/v4/projects/7/merge_requests") {
      this.writes.push("create");
      this.mr = { ...body, id: 888, project_id: 7, iid: 88, web_url: `${this.project.webUrl}/-/merge_requests/88`,
        source_project_id: 7, target_project_id: 7, sha: this.sourceSha, state: "opened", draft: true,
        author, assignees: [], reviewers: [], labels: [], detailed_merge_status: "mergeable",
        should_remove_source_branch: body.remove_source_branch,
        head_pipeline: { sha: this.sourceSha, status: "success" },
      };
      assert.equal(body.source_branch, this.sourceBranch);
      return respond(this.mr);
    }
    if (request.method === "PUT" && path === "/api/v4/projects/7/merge_requests/88") {
      this.writes.push("update");
      const mr = this.current();
      Object.assign(mr, body);
      if (typeof body.title === "string") mr.draft = body.title.startsWith("Draft:");
      if (Array.isArray(body.assignee_ids)) mr.assignees = [author, reviewer].filter((user) => (body.assignee_ids as number[]).includes(user.id));
      if (Array.isArray(body.reviewer_ids)) mr.reviewers = [author, reviewer].filter((user) => (body.reviewer_ids as number[]).includes(user.id));
      if (body.remove_source_branch !== undefined) mr.should_remove_source_branch = body.remove_source_branch;
      return respond(mr);
    }
    this.unexpected.push(`${request.method} ${path}`);
    throw new Error(`Unexpected GitLab transport request: ${request.method} ${path}`);
  }
}
