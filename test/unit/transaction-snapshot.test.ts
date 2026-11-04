import assert from "node:assert/strict";
import test from "node:test";

import { mergeExternalContextSnapshot } from "../../src/cli/default-write-services.ts";
import type { ExternalContextSnapshot } from "../../src/render/marker.ts";
import type { GitLabMergeRequest } from "../../src/gitlab/types.ts";

const snapshot: ExternalContextSnapshot = {
  snapshotVersion: 1,
  targetProject: { id: "7", path: "group/project" },
  sourceProject: { id: "7", path: "group/project" },
  targetRefSha: "a".repeat(40),
  mergeBaseSha: "a".repeat(40),
  sourceHeadSha: "b".repeat(40),
  issue: { kind: "none" },
  labelCandidates: [
    { id: "gid://gitlab/ProjectLabel/1", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/2", name: "priority::p2" },
    { id: "gid://gitlab/ProjectLabel/3", name: "status::doing" },
  ],
  userCandidates: [
    { id: "42", username: "author", displayName: "Author" },
    { id: "43", username: "reviewer", displayName: "Reviewer" },
  ],
  mergeRequest: {
    iid: null,
    authorUserId: "42",
    lifecycle: "new",
    labelIds: [],
    assigneeUserId: null,
    reviewerUserIds: [],
  },
  localChecks: {
    commitConvention: { status: "passed", evidence: "checked" },
    secretScan: { status: "passed", evidence: "checked" },
    repositoryHygiene: { status: "passed", evidence: "checked" },
  },
  metadataRead: { status: "unavailable", evidence: "not read" },
  ci: { status: "unavailable" },
  review: {
    approvedByUserIds: [],
    qualifiedReviewerUserIds: ["42", "43"],
    unresolvedDiscussions: 0,
  },
};

const mergeRequest: GitLabMergeRequest = {
  iid: 88,
  webUrl: "https://gitlab.example.test/group/project/-/merge_requests/88",
  title: "Draft: [bug][runtime] Fast path",
  description: "body",
  draft: true,
  state: "opened",
  sourceProjectId: "7",
  sourceBranch: "feature/fast-path",
  targetProjectId: "7",
  targetBranch: "develop",
  sha: "b".repeat(40),
  author: { id: "42", username: "author", displayName: "Author", state: "active", accessLevel: 40 },
  assignees: [{ id: "42", username: "author", displayName: "Author", state: "active", accessLevel: 40 }],
  reviewers: [{ id: "43", username: "reviewer", displayName: "Reviewer", state: "active", accessLevel: 40 }],
  labels: [
    { restId: 1, name: "type::bug", archived: false },
    { restId: 2, name: "priority::p2", archived: false },
    { restId: 3, name: "status::doing", archived: false },
  ],
  squash: true,
  shouldRemoveSourceBranch: true,
  pipelineStatus: "passed",
};

test("merges a live MR read into the prepared context without another context discovery", () => {
  const next = mergeExternalContextSnapshot(snapshot, mergeRequest);
  assert.ok(next);
  assert.equal(next.mergeRequest.iid, 88);
  assert.equal(next.mergeRequest.lifecycle, "draft");
  assert.deepEqual(next.mergeRequest.labelIds, [
    "gid://gitlab/ProjectLabel/1",
    "gid://gitlab/ProjectLabel/2",
    "gid://gitlab/ProjectLabel/3",
  ]);
  assert.equal(next.mergeRequest.assigneeUserId, "42");
  assert.deepEqual(next.mergeRequest.reviewerUserIds, ["43"]);
  assert.equal(next.metadataRead.status, "available");
  assert.equal(next.ci.status, "passed");
  assert.deepEqual(next.review.qualifiedReviewerUserIds, ["42", "43"]);
});

test("falls back when a live MR label cannot be bound to the prepared context", () => {
  const next = mergeExternalContextSnapshot(snapshot, {
    ...mergeRequest,
    labels: [{ restId: 99, name: "unknown", archived: false }],
  });
  assert.equal(next, null);
});
