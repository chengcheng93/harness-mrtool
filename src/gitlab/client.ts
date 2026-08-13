import { ToolError } from "../contracts/errors.ts";
import type { JsonObject, JsonValue } from "../contracts/jcs.ts";
import { GitLabHttpClient, type GitLabHttpClientOptions, type GitLabJsonResponse } from "./http.ts";
import { CAPABILITIES_QUERY, LABEL_GLOBAL_IDS_QUERY, SET_LABELS_MUTATION } from "./queries.ts";
import type {
  GitLabCapabilities,
  GitLabAppliedLabel,
  GitLabGroup,
  GitLabIssue,
  GitLabLabel,
  GitLabMergeRequest,
  GitLabProject,
  GitLabRequestAudit,
  GitLabReviewState,
  GitLabUser,
} from "./types.ts";

const MAX_REST_PAGES = 1_000;
const MAX_GRAPHQL_PAGES = 1_000;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

type AnyObject = Record<string, JsonValue>;

function apiError(subject: string, actual = "malformed GitLab response"): ToolError<"GITLAB_ERROR"> {
  return new ToolError("GITLAB_ERROR", `GitLab ${subject} validation failed`, {
    field: "gitlab",
    expected: `a complete ${subject} response`,
    actual,
    safeNextStep: "Run doctor and verify the GitLab server version and API compatibility.",
  });
}

function labelError(message: string, actual: string): ToolError<"LABEL_ERROR"> {
  return new ToolError("LABEL_ERROR", message, {
    field: "labels",
    expected: "one active effective label per exact name and policy category",
    actual,
    safeNextStep: "Resolve duplicate or archived labels in GitLab, then refresh context.",
  });
}

function object(value: JsonValue | undefined, subject: string): AnyObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw apiError(subject);
  }
  return value;
}

function array(value: JsonValue | undefined, subject: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw apiError(subject);
  }
  return value;
}

function string(value: JsonValue | undefined, subject: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "") || /[\u0000]/u.test(value)) {
    throw apiError(subject);
  }
  return value;
}

function nullableString(value: JsonValue | undefined, subject: string): string | null {
  return value === null ? null : string(value, subject, true);
}

function integer(value: JsonValue | undefined, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw apiError(subject);
  }
  return value as number;
}

function boolean(value: JsonValue | undefined, subject: string): boolean {
  if (typeof value !== "boolean") {
    throw apiError(subject);
  }
  return value;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeId(value: string): string {
  return encodeURIComponent(value);
}

function query(path: string, values: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams(values);
  return `${path}?${params.toString()}`;
}

function splitLinkHeader(value: string): readonly string[] {
  const result: string[] = [];
  let start = 0;
  let inTarget = false;
  let inQuote = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (inQuote && character === "\\") {
      escaped = true;
    } else if (!inQuote && character === "<") {
      if (inTarget) throw apiError("pagination", "malformed Link header");
      inTarget = true;
    } else if (!inQuote && character === ">") {
      if (!inTarget) throw apiError("pagination", "malformed Link header");
      inTarget = false;
    } else if (!inTarget && character === '"') {
      inQuote = !inQuote;
    } else if (!inTarget && !inQuote && character === ",") {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (inTarget || inQuote || escaped) throw apiError("pagination", "malformed Link header");
  result.push(value.slice(start).trim());
  if (result.some((part) => part === "")) throw apiError("pagination", "malformed Link header");
  return result;
}

function linkParameters(value: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const raw of value.split(";").slice(1)) {
    const parameter = raw.trim();
    const equals = parameter.indexOf("=");
    if (equals < 1) throw apiError("pagination", "malformed Link parameter");
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const encodedValue = parameter.slice(equals + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || result.has(name)) {
      throw apiError("pagination", "malformed Link parameter");
    }
    let decodedValue: string;
    if (encodedValue.startsWith('"')) {
      if (!encodedValue.endsWith('"') || encodedValue.length < 2) {
        throw apiError("pagination", "malformed Link parameter");
      }
      decodedValue = encodedValue.slice(1, -1).replace(/\\([\\"])/gu, "$1");
      if (/\\/u.test(decodedValue)) throw apiError("pagination", "malformed Link parameter");
    } else {
      if (!/^[!#$%&'*+.^_`|~0-9a-z:/?@\[\]-]+$/iu.test(encodedValue)) {
        throw apiError("pagination", "malformed Link parameter");
      }
      decodedValue = encodedValue;
    }
    result.set(name, decodedValue);
  }
  return result;
}

function sortedQueryEntries(value: URL): readonly string[] {
  return [...value.searchParams]
    .map(([name, entry]) => `${encodeURIComponent(name)}=${encodeURIComponent(entry)}`)
    .sort(ordinal);
}

function nextPageFromLink(
  header: string,
  current: URL,
  expectedPage: number,
): number | null {
  let nextTarget: string | null = null;
  for (const part of splitLinkHeader(header)) {
    const targetEnd = part.indexOf(">");
    if (!part.startsWith("<") || targetEnd < 2 || part.slice(targetEnd + 1).trim().startsWith(";") === false) {
      throw apiError("pagination", "malformed Link header");
    }
    const parameters = linkParameters(part.slice(targetEnd + 1));
    const relations = (parameters.get("rel") ?? "").split(/\s+/u).filter(Boolean);
    if (!relations.includes("next")) continue;
    if (nextTarget !== null) throw apiError("pagination", "multiple next Link relations");
    nextTarget = part.slice(1, targetEnd);
  }
  if (nextTarget === null) return null;

  let parsed: URL;
  try {
    parsed = new URL(nextTarget, current);
  } catch {
    throw apiError("pagination", "invalid next Link URL");
  }
  const expected = new URL(current);
  expected.searchParams.set("page", String(expectedPage));
  if (parsed.origin !== current.origin || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
      parsed.pathname !== expected.pathname || parsed.searchParams.getAll("page").length !== 1 ||
      parsed.searchParams.get("page") !== String(expectedPage) ||
      JSON.stringify(sortedQueryEntries(parsed)) !== JSON.stringify(sortedQueryEntries(expected))) {
    throw apiError("pagination", "untrusted next Link URL");
  }
  return expectedPage;
}

function user(value: JsonValue, subject: string, accessLevel: number | null = null): GitLabUser {
  const record = object(value, subject);
  const state = string(record.state, `${subject}.state`);
  if (state !== "active" && state !== "blocked" && state !== "deactivated") {
    throw apiError(subject);
  }
  return Object.freeze({
    id: String(integer(record.id, `${subject}.id`)),
    username: string(record.username, `${subject}.username`),
    displayName: string(record.name, `${subject}.name`),
    state,
    accessLevel,
  });
}

interface RestLabel {
  readonly restId: number;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly archived: boolean;
  readonly scopeKind: "project" | "group";
  readonly scopeId: string;
  readonly scopePath: string;
}

interface LabelInventory {
  readonly all: readonly GitLabLabel[];
  readonly effective: readonly GitLabLabel[];
  readonly audit: GitLabRequestAudit;
}

function restLabel(
  value: JsonValue,
  scope: { readonly kind: "project" | "group"; readonly id: string; readonly path: string },
): RestLabel {
  const record = object(value, `${scope.kind} label`);
  return Object.freeze({
    restId: integer(record.id, "label.id"),
    name: string(record.name, "label.name"),
    description: nullableString(record.description, "label.description") ?? "",
    color: string(record.color, "label.color"),
    archived: boolean(record.archived, "label.archived"),
    scopeKind: scope.kind,
    scopeId: scope.id,
    scopePath: scope.path,
  });
}

function expectedGlobalId(label: RestLabel): string {
  return `gid://gitlab/${label.scopeKind === "project" ? "ProjectLabel" : "GroupLabel"}/${String(label.restId)}`;
}

function pipelineStatus(value: JsonValue | undefined, expectedSha: string): GitLabMergeRequest["pipelineStatus"] {
  if (value === null || value === undefined) {
    return "unavailable";
  }
  const record = object(value, "merge request pipeline");
  if (string(record.sha, "merge request pipeline sha") !== expectedSha) {
    throw apiError("merge request pipeline", "pipeline SHA mismatch");
  }
  const raw = string(record.status, "merge request pipeline status");
  if (raw === "success") return "passed";
  if (raw === "pending" || raw === "created" || raw === "waiting_for_resource" || raw === "preparing") return "pending";
  if (raw === "running") return "running";
  if (raw === "failed") return "failed";
  if (raw === "canceled") return "canceled";
  if (raw === "skipped") return "skipped";
  return "unavailable";
}

function appliedLabels(value: JsonValue | undefined, subject: string): readonly GitLabAppliedLabel[] {
  const result = array(value, `${subject} labels`).map((entry) => {
    const record = object(entry, `${subject} label`);
    return Object.freeze({
      restId: integer(record.id, `${subject} label.id`),
      name: string(record.name, `${subject} label.name`),
      archived: boolean(record.archived, `${subject} label.archived`),
    });
  });
  const identities = new Set<number>();
  for (const label of result) {
    if (identities.has(label.restId)) throw apiError(`${subject} labels`, "duplicate applied label ID");
    identities.add(label.restId);
  }
  return Object.freeze(result.sort((left, right) => ordinal(left.name, right.name) || left.restId - right.restId));
}

export class GitLabClient {
  readonly origin: string;
  private readonly http: GitLabHttpClient;
  private readonly requestIds = new Set<string>();

  constructor(options: GitLabHttpClientOptions) {
    this.http = new GitLabHttpClient(options);
    this.origin = this.http.origin;
  }

  private remember(response: GitLabJsonResponse): void {
    if (response.requestId !== null) this.requestIds.add(response.requestId);
  }

  audit(): GitLabRequestAudit {
    const requestIds = [...this.requestIds]
      .map((requestId) => this.http.sanitizeRequestId(requestId))
      .filter((requestId): requestId is string => requestId !== null)
      .sort(ordinal);
    return Object.freeze({ requestIds: Object.freeze(requestIds) });
  }

  private async get(endpoint: string): Promise<GitLabJsonResponse> {
    const response = await this.http.requestJson("GET", endpoint);
    this.remember(response);
    return response;
  }

  private async graphql(document: string, variables: JsonObject): Promise<AnyObject> {
    const response = await this.http.requestJson("POST", "/api/graphql", { query: document, variables });
    this.remember(response);
    const envelope = object(response.data, "GraphQL envelope");
    if (envelope.errors !== undefined && array(envelope.errors, "GraphQL errors").length > 0) {
      throw apiError("GraphQL", "GraphQL errors were returned");
    }
    return object(envelope.data, "GraphQL data");
  }

  private async restPages(endpoint: string): Promise<readonly JsonValue[]> {
    const result: JsonValue[] = [];
    const seen = new Set<number>();
    let page = 1;
    for (let count = 0; count < MAX_REST_PAGES; count += 1) {
      if (seen.has(page)) throw apiError("pagination", "pagination cycle");
      seen.add(page);
      const separator = endpoint.includes("?") ? "&" : "?";
      const pageEndpoint = `${endpoint}${separator}per_page=100&page=${String(page)}`;
      const response = await this.get(pageEndpoint);
      result.push(...array(response.data, "paginated response"));
      const nextHeader = response.headers["x-next-page"];
      const linkHeader = response.headers.link;
      const linkNext = linkHeader === undefined
        ? undefined
        : nextPageFromLink(linkHeader, new URL(pageEndpoint, this.origin), page + 1);
      if (nextHeader === undefined) {
        if (linkNext === undefined) throw apiError("pagination", "missing continuation metadata");
        if (linkNext === null) return Object.freeze(result);
        page = linkNext;
        continue;
      }
      const nextRaw = nextHeader.trim();
      if (nextRaw === "") {
        if (linkNext !== undefined && linkNext !== null) throw apiError("pagination", "conflicting continuation metadata");
        return Object.freeze(result);
      }
      if (!/^\d+$/u.test(nextRaw)) throw apiError("pagination", "invalid next page");
      const next = Number(nextRaw);
      if (!Number.isSafeInteger(next) || next !== page + 1) throw apiError("pagination", "non-consecutive next page");
      if (linkNext !== undefined && linkNext !== next) throw apiError("pagination", "conflicting continuation metadata");
      page = next;
    }
    throw apiError("pagination", "page limit exceeded");
  }

  async getProject(project: string): Promise<GitLabProject> {
    const response = await this.get(`/api/v4/projects/${encodeId(project)}`);
    const record = object(response.data, "project");
    const id = String(integer(record.id, "project.id"));
    const fullPath = string(record.path_with_namespace, "project.path_with_namespace");
    if (/^[1-9]\d*$/u.test(project) ? id !== project : fullPath !== project) {
      throw apiError("project", "project identity mismatch");
    }
    return Object.freeze({
      id,
      fullPath,
      defaultBranch: string(record.default_branch, "project.default_branch"),
      webUrl: string(record.web_url, "project.web_url"),
    });
  }

  async listAncestorGroups(projectId: string): Promise<readonly GitLabGroup[]> {
    const values = await this.restPages(query(`/api/v4/projects/${encodeId(projectId)}/groups`, { with_shared: "false" }));
    const groups = values.map((value) => {
      const record = object(value, "ancestor group");
      return Object.freeze({
        id: String(integer(record.id, "group.id")),
        fullPath: string(record.full_path, "group.full_path"),
      });
    });
    const ids = new Set<string>();
    for (const group of groups) {
      if (ids.has(group.id)) throw apiError("ancestor groups", "duplicate group ID");
      ids.add(group.id);
    }
    return Object.freeze(groups.sort((a, b) => ordinal(a.fullPath, b.fullPath)));
  }

  private async labelGlobalIds(project: GitLabProject): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let count = 0; count < MAX_GRAPHQL_PAGES; count += 1) {
      const data = await this.graphql(LABEL_GLOBAL_IDS_QUERY, { fullPath: project.fullPath, after });
      const graphqlProject = object(data.project, "GraphQL project");
      if (string(graphqlProject.id, "GraphQL project.id") !== `gid://gitlab/Project/${project.id}` ||
          string(graphqlProject.fullPath, "GraphQL project.fullPath") !== project.fullPath) {
        throw apiError("GraphQL project", "project identity mismatch");
      }
      const labels = object(graphqlProject.labels, "GraphQL labels");
      for (const value of array(labels.nodes, "GraphQL label nodes")) {
        const node = object(value, "GraphQL label");
        const id = string(node.id, "GraphQL label.id");
        const title = string(node.title, "GraphQL label.title");
        const existing = result.get(id);
        if (existing !== undefined && existing !== title) throw apiError("labels", "global label ID changed title");
        result.set(id, title);
      }
      const pageInfo = object(labels.pageInfo, "GraphQL labels pageInfo");
      const hasNextPage = boolean(pageInfo.hasNextPage, "GraphQL labels hasNextPage");
      const endCursor = pageInfo.endCursor;
      if (!hasNextPage) return result;
      if (typeof endCursor !== "string" || endCursor === "" || cursors.has(endCursor)) {
        throw apiError("GraphQL pagination", "invalid or repeated cursor");
      }
      cursors.add(endCursor);
      after = endCursor;
    }
    throw apiError("GraphQL pagination", "cursor page limit exceeded");
  }

  async labelInventory(projectReference: string): Promise<LabelInventory> {
    const project = await this.getProject(projectReference);
    const groups = await this.listAncestorGroups(project.id);
    const projectValues = await this.restPages(query(`/api/v4/projects/${encodeId(project.id)}/labels`, {
      include_ancestor_groups: "false",
    }));
    const rest: RestLabel[] = projectValues.map((value) => restLabel(value, {
      kind: "project", id: project.id, path: project.fullPath,
    }));
    for (const group of groups) {
      const values = await this.restPages(query(`/api/v4/groups/${encodeId(group.id)}/labels`, {
        include_ancestor_groups: "false",
        include_descendant_groups: "false",
        only_group_labels: "true",
      }));
      rest.push(...values.map((value) => restLabel(value, { kind: "group", id: group.id, path: group.fullPath })));
    }
    const gids = await this.labelGlobalIds(project);
    const seenScopeIds = new Set<string>();
    const all = rest.map((label): GitLabLabel => {
      const key = `${label.scopeKind}:${label.scopeId}:${String(label.restId)}`;
      if (seenScopeIds.has(key)) throw apiError("labels", "duplicate REST label identity");
      seenScopeIds.add(key);
      const globalId = expectedGlobalId(label);
      if (!label.archived && gids.get(globalId) !== label.name) {
        throw apiError("labels", "REST and GraphQL label identities do not match");
      }
      return Object.freeze({ ...label, globalId });
    }).sort((a, b) => ordinal(a.name, b.name) || ordinal(a.globalId, b.globalId));

    const byName = new Map<string, GitLabLabel[]>();
    for (const label of all) {
      if (!label.archived) {
        const values = byName.get(label.name) ?? [];
        values.push(label);
        byName.set(label.name, values);
      }
    }
    const effective: GitLabLabel[] = [];
    for (const [name, values] of byName) {
      const projectLabels = values.filter((label) => label.scopeKind === "project");
      const chosen = projectLabels.length > 0 ? projectLabels : values;
      if (chosen.length !== 1) throw labelError("GitLab label name is ambiguous", name);
      effective.push(chosen[0] as GitLabLabel);
    }
    effective.sort((a, b) => ordinal(a.name, b.name) || ordinal(a.globalId, b.globalId));
    return Object.freeze({ all: Object.freeze(all), effective: Object.freeze(effective), audit: this.audit() });
  }

  async listLabels(projectReference: string): Promise<readonly GitLabLabel[]> {
    return (await this.labelInventory(projectReference)).effective;
  }

  async listUsers(projectReference: string): Promise<readonly GitLabUser[]> {
    const project = await this.getProject(projectReference);
    const values = await this.restPages(`/api/v4/projects/${encodeId(project.id)}/members/all?state=active`);
    const users = values.map((value) => {
      const record = object(value, "project member");
      return user(value, "project member", integer(record.access_level, "project member.access_level"));
    }).filter((entry) => entry.state === "active");
    const ids = new Set<string>();
    for (const entry of users) {
      if (ids.has(entry.id)) throw apiError("project members", "duplicate user ID");
      ids.add(entry.id);
    }
    return Object.freeze(users.sort((a, b) => ordinal(a.username, b.username) || ordinal(a.id, b.id)));
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return user((await this.get("/api/v4/user")).data, "current user");
  }

  async getBranchHead(projectReference: string, branch: string): Promise<string> {
    if (branch === "" || branch !== branch.trim() || /[\r\n\u0000]/u.test(branch)) {
      throw new TypeError("Branch name must be a non-empty scalar");
    }
    const record = object((await this.get(
      `/api/v4/projects/${encodeId(projectReference)}/repository/branches/${encodeId(branch)}`,
    )).data, "repository branch");
    if (string(record.name, "repository branch.name") !== branch) throw apiError("repository branch", "branch name mismatch");
    const sha = string(object(record.commit, "repository branch commit").id, "repository branch commit.id");
    if (!OBJECT_ID.test(sha)) throw apiError("repository branch", "invalid branch head SHA");
    return sha;
  }

  async getIssue(projectReference: string, iid: number): Promise<GitLabIssue> {
    if (!Number.isSafeInteger(iid) || iid < 1) throw new TypeError("Issue IID must be positive");
    const project = await this.getProject(projectReference);
    const record = object((await this.get(
      `/api/v4/projects/${encodeId(project.id)}/issues/${String(iid)}?with_labels_details=true`,
    )).data, "issue");
    const milestone = record.milestone === null ? null : string(object(record.milestone, "issue milestone").title, "issue milestone title");
    const dueDate = nullableString(record.due_date, "issue due_date");
    if (dueDate !== null && !DATE.test(dueDate)) throw apiError("issue", "invalid due date");
    const actualIid = integer(record.iid, "issue.iid");
    if (actualIid !== iid) throw apiError("issue", "Issue IID mismatch");
    return Object.freeze({
      iid: actualIid,
      milestone,
      assignees: Object.freeze(array(record.assignees, "issue assignees").map((value) => user(value, "issue assignee"))),
      dueDate,
      labels: appliedLabels(record.labels, "issue"),
    });
  }

  async getMergeRequest(projectReference: string, iid: number): Promise<GitLabMergeRequest> {
    if (!Number.isSafeInteger(iid) || iid < 1) throw new TypeError("MR IID must be positive");
    const project = await this.getProject(projectReference);
    const record = object((await this.get(
      `/api/v4/projects/${encodeId(project.id)}/merge_requests/${String(iid)}?with_labels_details=true`,
    )).data, "merge request");
    const state = string(record.state, "merge request state");
    if (state !== "opened" && state !== "closed" && state !== "merged" && state !== "locked") throw apiError("merge request");
    const sha = string(record.sha, "merge request sha");
    if (!OBJECT_ID.test(sha)) throw apiError("merge request", "invalid source SHA");
    const actualIid = integer(record.iid, "merge request.iid");
    if (actualIid !== iid) throw apiError("merge request", "MR IID mismatch");
    return Object.freeze({
      iid: actualIid,
      webUrl: string(record.web_url, "merge request.web_url"),
      title: string(record.title, "merge request.title"),
      description: nullableString(record.description, "merge request.description") ?? "",
      draft: boolean(record.draft, "merge request.draft"),
      state,
      sourceProjectId: String(integer(record.source_project_id, "merge request.source_project_id")),
      sourceBranch: string(record.source_branch, "merge request.source_branch"),
      targetProjectId: String(integer(record.target_project_id, "merge request.target_project_id")),
      targetBranch: string(record.target_branch, "merge request.target_branch"),
      sha,
      author: user(record.author as JsonValue, "merge request author"),
      assignees: Object.freeze(array(record.assignees, "merge request assignees").map((value) => user(value, "merge request assignee"))),
      reviewers: Object.freeze(array(record.reviewers, "merge request reviewers").map((value) => user(value, "merge request reviewer"))),
      labels: appliedLabels(record.labels, "merge request"),
      squash: boolean(record.squash, "merge request.squash"),
      shouldRemoveSourceBranch: boolean(record.should_remove_source_branch, "merge request.should_remove_source_branch"),
      pipelineStatus: pipelineStatus(record.head_pipeline, sha),
    });
  }

  private async reviewFence(
    project: GitLabProject,
    iid: number,
    expectedSha: string,
    expectedMergeRequestId: number | null,
  ): Promise<number> {
    const record = object((await this.get(
      `/api/v4/projects/${encodeId(project.id)}/merge_requests/${String(iid)}`,
    )).data, "merge request review fence");
    const mergeRequestId = integer(record.id, "merge request review fence.id");
    const detailedMergeStatus = string(
      record.detailed_merge_status,
      "merge request review fence.detailed_merge_status",
    );
    if (integer(record.project_id, "merge request review fence.project_id") !== Number(project.id) ||
        integer(record.iid, "merge request review fence.iid") !== iid ||
        string(record.sha, "merge request review fence.sha") !== expectedSha ||
        (expectedMergeRequestId !== null && mergeRequestId !== expectedMergeRequestId)) {
      throw apiError("merge request review fence", "project, MR, or source SHA mismatch");
    }
    if (detailedMergeStatus === "checking" || detailedMergeStatus === "approvals_syncing") {
      throw apiError("merge request review fence", "approval state is still synchronizing");
    }
    return mergeRequestId;
  }

  async getReviewState(projectReference: string, iid: number, expectedSha: string): Promise<GitLabReviewState> {
    if (!Number.isSafeInteger(iid) || iid < 1) throw new TypeError("MR IID must be positive");
    if (!OBJECT_ID.test(expectedSha)) throw new TypeError("Expected MR source SHA must be a Git object ID");
    const project = await this.getProject(projectReference);
    const fencedMergeRequestId = await this.reviewFence(project, iid, expectedSha, null);
    const approvals = object((await this.get(
      `/api/v4/projects/${encodeId(project.id)}/merge_requests/${String(iid)}/approvals`,
    )).data, "merge request approvals");
    const mergeRequestId = integer(approvals.id, "merge request approvals.id");
    if (mergeRequestId !== fencedMergeRequestId ||
        integer(approvals.project_id, "merge request approvals.project_id") !== Number(project.id) ||
        integer(approvals.iid, "merge request approvals.iid") !== iid) {
      throw apiError("merge request approvals", "project or MR identity mismatch");
    }
    const approved = array(approvals.approved_by, "merge request approvals approved_by").map((value) => {
      const record = object(value, "merge request approval");
      return user(record.user as JsonValue, "merge request approver").id;
    });
    const discussions = await this.restPages(`/api/v4/projects/${encodeId(project.id)}/merge_requests/${String(iid)}/discussions`);
    let unresolved = 0;
    for (const value of discussions) {
      const record = object(value, "merge request discussion");
      const notes = array(record.notes, "discussion notes");
      if (notes.length === 0) throw apiError("merge request discussion", "discussion has no notes");
      let discussionUnresolved = false;
      for (const note of notes) {
        const noteRecord = object(note, "discussion note");
        if (integer(noteRecord.project_id, "discussion note.project_id") !== Number(project.id) ||
            integer(noteRecord.noteable_id, "discussion note.noteable_id") !== mergeRequestId ||
            string(noteRecord.noteable_type, "discussion note.noteable_type") !== "MergeRequest" ||
            (noteRecord.noteable_iid !== undefined && noteRecord.noteable_iid !== null &&
              integer(noteRecord.noteable_iid, "discussion note.noteable_iid") !== iid)) {
          throw apiError("merge request discussion", "project or noteable identity mismatch");
        }
        const resolvable = boolean(noteRecord.resolvable, "discussion note.resolvable");
        const resolved = boolean(noteRecord.resolved, "discussion note.resolved");
        if (resolvable && !resolved) discussionUnresolved = true;
      }
      if (discussionUnresolved) unresolved += 1;
    }
    await this.reviewFence(project, iid, expectedSha, mergeRequestId);
    return Object.freeze({
      approvedUserIds: Object.freeze([...new Set(approved)].sort(ordinal)),
      unresolvedDiscussions: unresolved,
    });
  }

  async probeCapabilities(): Promise<GitLabCapabilities> {
    const versionRecord = object((await this.get("/api/v4/version")).data, "GitLab version");
    const version = string(versionRecord.version, "GitLab version.version");
    const revision = versionRecord.revision === undefined || versionRecord.revision === null
      ? null : string(versionRecord.revision, "GitLab version.revision");
    const data = await this.graphql(CAPABILITIES_QUERY, {});
    const mutationNames = array(object(data.mutation, "Mutation type").fields, "Mutation fields")
      .map((value) => string(object(value, "Mutation field").name, "Mutation field name"));
    const inputNames = array(object(data.input, "MergeRequestSetLabelsInput type").inputFields, "input fields")
      .map((value) => string(object(value, "input field").name, "input field name"));
    const modes = array(object(data.mode, "MutationOperationMode type").enumValues, "operation modes")
      .map((value) => string(object(value, "operation mode").name, "operation mode name"));
    if (!mutationNames.includes("mergeRequestSetLabels") ||
        !["projectPath", "iid", "labelIds", "operationMode"].every((name) => inputNames.includes(name)) ||
        !["ADD", "REMOVE"].every((name) => modes.includes(name))) {
      throw apiError("capability probe", "label ID ADD/REMOVE mutation is unavailable");
    }
    return Object.freeze({
      version,
      revision,
      mergeRequestSetLabels: true,
      labelOperationModes: ["ADD", "REMOVE"] as const,
    });
  }

  async mutateLabels(
    projectPath: string,
    iid: number,
    labelIds: readonly string[],
    operationMode: "ADD" | "REMOVE",
  ): Promise<void> {
    if (operationMode !== "ADD" && operationMode !== "REMOVE") {
      throw new TypeError("Label mutation operation must be ADD or REMOVE");
    }
    if (!Number.isSafeInteger(iid) || iid < 1 || labelIds.length === 0 ||
        new Set(labelIds).size !== labelIds.length || labelIds.some((id) => !/^gid:\/\/gitlab\/(?:Project|Group)Label\/\d+$/u.test(id))) {
      throw new TypeError("Label mutation requires unique GitLab global label IDs");
    }
    const project = await this.getProject(projectPath);
    const data = await this.graphql(SET_LABELS_MUTATION, {
      input: { projectPath: project.fullPath, iid: String(iid), labelIds: [...labelIds], operationMode },
    });
    const mutation = object(data.mergeRequestSetLabels, "mergeRequestSetLabels mutation");
    const errors = array(mutation.errors, "mergeRequestSetLabels errors").map((value) => string(value, "mutation error"));
    if (errors.length > 0 || mutation.mergeRequest === null) {
      throw apiError("label mutation", "GitLab rejected the ID mutation");
    }
    const mergeRequest = object(mutation.mergeRequest, "mutated merge request");
    const targetProject = object(mergeRequest.targetProject, "mutated merge request target project");
    if (string(mergeRequest.iid, "mutated merge request.iid") !== String(iid) ||
        string(targetProject.id, "mutated merge request target project.id") !== `gid://gitlab/Project/${project.id}` ||
        string(targetProject.fullPath, "mutated merge request target project.fullPath") !== project.fullPath) {
      throw apiError("label mutation", "mutation target identity mismatch");
    }
  }
}
